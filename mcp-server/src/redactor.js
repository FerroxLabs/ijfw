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
  // GitLab Personal Access Tokens (glpat-) + CI job tokens (glcbt-).
  // GitLab PAT spec: `glpat-` + 20 base64url chars. We accept 20+ to be future-proof.
  { re: /glpat-[A-Za-z0-9_-]{20,}/g,               label: 'gitlab'    },
  { re: /glcbt-[A-Za-z0-9_-]{20,}/g,               label: 'gitlab'    }, // CI build token
  { re: /gldt-[A-Za-z0-9_-]{20,}/g,                label: 'gitlab'    }, // GitLab deploy token
  // AWS permanent access key ID (AKIA) + temporary (ASIA) key ID.
  { re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,              label: 'aws'       },
  // AWS secret access key — contextualized because bare 40-char base64 is
  // catastrophically false-positive. Match only when paired with a known key
  // name (AWS_SECRET_ACCESS_KEY=, aws_secret=, etc).
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output; pattern requires contextual prefix and is anchored to AWS secret key naming conventions.
  { re: /(?:AWS|aws)[_-]?(?:SECRET|secret)[_-]?(?:ACCESS[_-]?)?(?:KEY|key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/g, label: 'aws' },
  // Discord bot tokens — three base64url segments with fixed first-segment width (24).
  // Must come BEFORE the generic JWT pattern so the structural difference is preserved.
  // Format: <24 chars>.<6 chars>.<27+ chars>. Exclude any match whose first
  // segment starts with `eyJ` to avoid stealing JWT matches.
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output; this is an anchored secret pattern, not user-controlled matching logic.
  { re: /(?<![A-Za-z0-9_])(?!eyJ)[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}(?![A-Za-z0-9_])/g, label: 'discord' },
  // Authorization: Bearer <token>.
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/g,       label: 'bearer'    },
  // Generic JWT (three base64url segments). Catches Supabase service-role keys,
  // Auth0/Okta/Firebase ID tokens, and any bare JWT in tool output. Anchored on
  // `eyJ` header (base64url of `{`) which all JWTs share.
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output; the `eyJ` anchor and three-segment shape minimise false positives.
  { re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: 'jwt' },
  // Slack bot / user / legacy tokens.
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g,           label: 'slack'     },
  // Stripe live + test secret keys.
  { re: /sk_live_[A-Za-z0-9]{24,}/g,               label: 'stripe'    },
  { re: /sk_test_[A-Za-z0-9]{24,}/g,               label: 'stripe'    },
  // npm access tokens.
  { re: /npm_[A-Za-z0-9]{36}/g,                    label: 'npm'       },
  // HuggingFace user tokens.
  { re: /hf_[A-Za-z0-9]{34,}/g,                    label: 'huggingface' },
  // OpenAI organization IDs — `org-` followed by 24 alphanumeric chars.
  // Not a secret per se, but often pasted alongside the API key and a
  // valuable target identifier; redact in case of cross-tenant leakage.
  { re: /\borg-[A-Za-z0-9]{24}\b/g,                label: 'openai-org' },
  // Vercel API tokens — 24 hex/alnum chars after a `vrcl_` style prefix; the
  // newer (2026) Vercel CLI emits tokens prefixed with `vercel_pat_` or
  // contextualised env vars. Cover both the explicit prefix and the env-var
  // contextual form.
  { re: /vercel_pat_[A-Za-z0-9_]{20,}/gi,          label: 'vercel'    },
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output and requires a Vercel context prefix before matching a token.
  { re: /(?:VERCEL|vercel)[_-]?(?:API[_-]?)?TOKEN\s*[:=]\s*['"]?[A-Za-z0-9_-]{24,}['"]?/g, label: 'vercel' },
  // Supabase service-role / anon keys. The JWT pattern above already catches
  // the typical service-role JWT shape; this rule covers the legacy
  // `sbp_` (project access) and `sb_` style tokens distributed via the CLI.
  { re: /sbp_[A-Za-z0-9]{40,}/g,                   label: 'supabase'  },
  // Notion integration tokens — `secret_` + 43 chars (legacy) and `ntn_` + alnum (2026).
  { re: /secret_[A-Za-z0-9]{43}/g,                 label: 'notion'    },
  { re: /ntn_[A-Za-z0-9_]{40,}/g,                  label: 'notion'    },
  // Linear API keys — `lin_api_` + alnum, `lin_oauth_` + alnum.
  { re: /lin_api_[A-Za-z0-9]{32,}/g,               label: 'linear'    },
  { re: /lin_oauth_[A-Za-z0-9]{32,}/g,             label: 'linear'    },
  // Twilio Account SID + Auth Token. SID is `AC` + 32 hex; auth token is
  // 32 hex which is high-FP so we require contextual naming.
  { re: /AC[a-f0-9]{32}/g,                         label: 'twilio'    },
  // eslint-disable-next-line security/detect-unsafe-regex -- redactor scans bounded tool output; pattern requires a Twilio context prefix before matching.
  { re: /(?:TWILIO|twilio)[_-]?(?:AUTH[_-]?)?TOKEN\s*[:=]\s*['"]?[a-f0-9]{32}['"]?/g, label: 'twilio' },
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
