/**
 * IJFW observation redaction (FerroxLabs/ijfw#31, sink 1).
 *
 * Every free-text field that can reach the observation ledger (prompts,
 * command lines, tool input, tool output, file paths, titles) passes through
 * redactObservationText() before it is written.
 *
 * Layer 1: the shared memory-path redactor (mcp-server/src/redactor.js) so the
 *          observability plane uses the SAME pattern list as memory ingest.
 * Layer 2: shapes that only show up in shell command lines and prompts:
 *          lowercase/Basic auth headers, URL credentials, `--password x`,
 *          `password: x`, and NAME_TOKEN= / NAME_SECRET= / NAME_KEY= env
 *          assignments with short or unknown-format values.
 *
 * Static import on purpose: if the shared redactor cannot be loaded the
 * capture process fails before writing anything (fail closed).
 */

import { redactSecrets } from '../../mcp-server/src/redactor.js';

const EXTRA = [
  // Authorization headers in any case, Bearer/Basic/Token schemes.
  [/(authorization\s*[:=]\s*["']?\s*(?:bearer|basic|token)\s+)[^\s"'[\]]+/gi, '$1[REDACTED]'],
  [/\b(bearer\s+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  // URL userinfo: scheme://user:secret@host
  [/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2'],
  // curl/wget style basic auth: -u user:secret, --user=user:secret
  [/((?:^|\s)(?:-u|--user|--proxy-user)(?:\s+|=)["']?[^\s:"']+:)(?!\[REDACTED)[^\s"']+/g, '$1[REDACTED]'],
  // CLI flags: --password x, --token=x, --api-key x, --secret x
  [/(--?(?:password|passwd|pass|token|api[-_]?key|secret|client[-_]?secret|access[-_]?token)(?:\s+|=))(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]'],
  // key: value / key=value for password-like keys (YAML, prose, env).
  [/(\b(?:password|passwd|pwd|passphrase)\s*[:=]\s*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]'],
  // ENV-style NAME_TOKEN= / NAME_SECRET= / NAME_KEY= / NAME_PASSWORD= assignments.
  [/(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)\s*=\s*)(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s]+)/g, '$1[REDACTED]'],
];

export function redactObservationText(value) {
  if (typeof value !== 'string' || !value) return '';
  let out = redactSecrets(value);
  for (const [re, rep] of EXTRA) out = out.replace(re, rep);
  return out;
}
