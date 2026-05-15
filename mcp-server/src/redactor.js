// --- Secret redactor (audit S5) ---
// Strips common credential patterns before any memory write. Conservative
// by design: pattern list is additive, never tries to classify "suspicious"
// strings. Better to miss a novel format than to corrupt legitimate prose.
//
// Wired into auto-memorize in Wave 3. Exported here so Wave 0 can land the
// library + tests ahead of the integration.

const PATTERNS = [
  // Anthropic -- must come BEFORE generic OpenAI so `sk-ant-...` gets labeled correctly.
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g,              label: 'anthropic' },
  // OpenAI -- `sk-proj-...` or `sk-...` with strong minimum length to avoid
  // eating prose references like "sk-learn" (scikit-learn).
  { re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,        label: 'openai'    },
  // GitHub classic PAT + fine-grained PAT + OAuth/App/User/Refresh tokens.
  { re: /ghp_[A-Za-z0-9]{20,}/g,                   label: 'github'    },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g,           label: 'github'    },
  { re: /gh[ousr]_[A-Za-z0-9]{30,}/g,              label: 'github'    }, // gho_/ghu_/ghs_/ghr_
  // AWS permanent access key ID (AKIA) + temporary (ASIA) key ID.
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,              label: 'aws'       },
  // Authorization: Bearer <token>.
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/g,       label: 'bearer'    },
  // Slack bot / user / legacy tokens.
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g,           label: 'slack'     },
  // Stripe live + test secret keys.
  { re: /sk_live_[A-Za-z0-9]{24,}/g,               label: 'stripe'    },
  { re: /sk_test_[A-Za-z0-9]{24,}/g,               label: 'stripe'    },
  // npm access tokens.
  { re: /npm_[A-Za-z0-9]{36}/g,                    label: 'npm'       },
  // HuggingFace user tokens.
  { re: /hf_[A-Za-z0-9]{34,}/g,                    label: 'huggingface' },
  // Azure Storage connection-string AccountKey (base64, 88 chars with padding).
  { re: /AccountKey=[A-Za-z0-9+/]{86,88}={0,2}/g,  label: 'azure'     },
  // GCP service-account private key PEM block.
  { re: /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/g, label: 'gcp' },
  // GCP / Google API keys -- `AIza...` (39 chars total).
  { re: /AIza[0-9A-Za-z_-]{35}/g,                  label: 'gcp'       },
  // Sentry DSN -- https://<key>@o<org>.ingest.sentry.io/<project>.
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output; this is an anchored secret pattern, not user-controlled matching logic.
  { re: /https?:\/\/[0-9a-f]{32,}(?::[0-9a-f]{32,})?@[\w.-]*sentry\.io\/[0-9]+/gi, label: 'sentry' },
  // Cloudflare API tokens (40 chars base64url). Conservative: only flag when
  // contextualized (CF_API_TOKEN=..., CLOUDFLARE_TOKEN=..., cf_auth_key=...)
  // so we don't eat bare git commit SHAs or content hashes.
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output and requires a Cloudflare context prefix before matching a token.
  { re: /(?:cf|cloudflare)[_-]?(?:api[_-]?)?(?:token|auth|key)s?[= :]+[A-Za-z0-9_-]{40,}/gi, label: 'cloudflare' },
  // Webhook URLs (Slack, Discord, MS Teams) -- include the secret path segment.
  { re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, label: 'webhook' },
  { re: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,           label: 'webhook' },
  { re: /https:\/\/[\w-]+\.webhook\.office\.com\/webhookb2\/[\w@/-]+/g,                  label: 'webhook' },
];

// INLINE rules match `key=value` style assignments. Value regex excludes
// `[` and `]` so we don't re-redact tokens already labeled by PATTERNS
// (e.g. `GOOGLE_API_KEY=[REDACTED:gcp]` must stay labeled, not get flattened
// to `[REDACTED]`).
const INLINE = [
  /(password\s*=\s*)[^\s[\]]+/gi,
  /(api[_-]?token\s*=\s*)[^\s[\]]+/gi,
  /(api[_-]?key\s*=\s*)[^\s[\]]+/gi,
  /(secret\s*=\s*)[^\s[\]]+/gi,
  /(client[_-]?secret\s*=\s*)[^\s[\]]+/gi,
  // JSON-style "clientSecret": "value" and similar.
  /("(?:client_?secret|api_?key|password|access_?token)"\s*:\s*")[^"]+(")/gi,
];

export function redactSecrets(s) {
  if (typeof s !== 'string' || !s) return '';
  let out = s;
  for (const { re, label } of PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  for (const re of INLINE) {
    if (re.source.startsWith('("')) {
      // JSON pattern: keep the opening and closing quotes/keys, redact value.
      out = out.replace(re, '$1[REDACTED]$2');
    } else {
      out = out.replace(re, '$1[REDACTED]');
    }
  }
  return out;
}

// classify(value) -> { clean: boolean, redacted_kind: string | null }
//
// D-PILLAR-SPEC section 3 surface used by D2 entity extraction. Passes the
// value through the same PATTERNS list redactSecrets uses; if any pattern
// matches the WHOLE value (anchor-equivalent: pattern consumes the entire
// trimmed string), the value is classified as a secret and `redacted_kind`
// carries the matched label. INLINE rules are not applied here -- they
// only fire on key=value assignments which would never reach the entity
// extractor as a bare entity name.
//
// Important: PATTERNS are anchored implicitly via length minimums (e.g.
// `sk-(?:proj-)?[A-Za-z0-9_-]{32,}`), but to avoid classifying a long file
// path that happens to contain a token-shaped substring, classify() rejects
// only when the pattern matches the FULL trimmed value. File paths and
// function/identifier names are always shorter than the secret patterns'
// minimum lengths, so the conservative cut-line is "match must equal the
// candidate" -- a substring match doesn't trigger classification.
export function classify(value) {
  if (typeof value !== 'string') return { clean: true, redacted_kind: null };
  const v = value.trim();
  if (!v) return { clean: true, redacted_kind: null };
  for (const { re, label } of PATTERNS) {
    // Build a fresh non-global RegExp per check; the source PATTERNS use /g
    // for redactSecrets but classify needs a single full-value match.
    const r = new RegExp(`^(?:${re.source})$`, re.flags.replace('g', ''));
    if (r.test(v)) return { clean: false, redacted_kind: label };
  }
  return { clean: true, redacted_kind: null };
}
