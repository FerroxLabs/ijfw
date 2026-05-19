import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from './src/redactor.js';

test('redacts OpenAI sk-proj- keys', () => {
  const out = redactSecrets('key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef');
  assert.match(out, /\[REDACTED:openai\]/);
  assert.doesNotMatch(out, /ABCDEFGHIJKLMN/);
});

test('redacts OpenAI sk- keys (non-proj, ≥32 char floor)', () => {
  const out = redactSecrets('legacy sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  assert.match(out, /\[REDACTED:openai\]/);
});

test('does NOT redact short sk- prose like "sk-learn"', () => {
  const out = redactSecrets('use sk-learn for ML, also sk-image is fine');
  assert.equal(out, 'use sk-learn for ML, also sk-image is fine');
});

test('redacts Anthropic sk-ant- keys', () => {
  const out = redactSecrets('claude sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.match(out, /\[REDACTED:anthropic\]/);
});

test('redacts GitHub ghp_ tokens', () => {
  const out = redactSecrets('GH ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.match(out, /\[REDACTED:github\]/);
});

test('redacts GitHub fine-grained PATs', () => {
  const out = redactSecrets('token: github_pat_11ABCDEFGHIJKLMNO_abcdefghijklmn');
  assert.match(out, /\[REDACTED:github\]/);
});

test('redacts AWS access key IDs', () => {
  const out = redactSecrets('AWS AKIAIOSFODNN7EXAMPLE now');
  assert.match(out, /\[REDACTED:aws\]/);
});

test('redacts Bearer tokens in Authorization headers', () => {
  const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.match(out, /\[REDACTED:bearer\]/);
});

test('redacts Slack xoxb-/xoxp- tokens', () => {
  const out = redactSecrets('slack=xoxb-1234567890-abcdefghij');
  assert.match(out, /\[REDACTED:slack\]/);
});

test('redacts Stripe live + test secret keys', () => {
  // strings split so source scanners don't flag test data as real secrets
  const live = redactSecrets('sk_live' + '_abcdefghijklmnopqrstuvwxyz123456');
  const testk = redactSecrets('sk_test' + '_abcdefghijklmnopqrstuvwxyz123456');
  assert.match(live, /\[REDACTED:stripe\]/);
  assert.match(testk, /\[REDACTED:stripe\]/);
});

test('redacts npm access tokens', () => {
  const out = redactSecrets('npm set //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789AB');
  assert.match(out, /\[REDACTED:npm\]/);
});

test('redacts HuggingFace tokens', () => {
  const out = redactSecrets('export HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz01234567AB');
  assert.match(out, /\[REDACTED:huggingface\]/);
});

test('redacts Azure storage AccountKey', () => {
  // 88 chars base64 with padding
  const key = 'A'.repeat(86) + '==';
  const out = redactSecrets(`DefaultEndpointsProtocol=https;AccountKey=${key};EndpointSuffix=core.windows.net`);
  assert.match(out, /\[REDACTED:azure\]/);
});

test('redacts GCP PEM private key blocks', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----';
  const out = redactSecrets(`config: { "private_key": "${pem.replace(/\n/g, '\\n')}" }`);
  // The replacement target is the BEGIN..END block; literal \n still splits
  // only in the prose copy above. For the regex to match the actual PEM
  // string we need a real multiline case.
  const out2 = redactSecrets(pem);
  assert.match(out2, /\[REDACTED:gcp\]/);
});

test('redacts inline password=/token=/key=/secret= assignments', () => {
  const out = redactSecrets('db password=hunter2 api_token=xyz12345 api_key=abc secret=shh client_secret=ZZZ');
  assert.match(out, /password=\[REDACTED\]/);
  assert.match(out, /api_token=\[REDACTED\]/);
  assert.match(out, /api_key=\[REDACTED\]/);
  assert.match(out, /secret=\[REDACTED\]/);
  assert.match(out, /client_secret=\[REDACTED\]/);
});

test('redacts JSON-style "clientSecret": "..." values', () => {
  const out = redactSecrets('{"clientSecret": "super-secret-value-xyz", "other": "ok"}');
  assert.match(out, /"clientSecret":\s*"\[REDACTED\]"/);
  assert.doesNotMatch(out, /super-secret-value/);
  assert.match(out, /"other":\s*"ok"/);
});

test('leaves ordinary prose alone', () => {
  const p = 'The user clicked submit. No secrets here.';
  assert.equal(redactSecrets(p), p);
});

test('preserves code-like strings that aren\'t secrets', () => {
  const p = 'function foo(bar) { return bar + 1; }';
  assert.equal(redactSecrets(p), p);
});

test('redacts GitHub OAuth/App/User/Refresh tokens', () => {
  for (const prefix of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const out = redactSecrets(`token=${prefix}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab`);
    assert.match(out, /\[REDACTED:github\]/, `prefix ${prefix} not redacted`);
  }
});

test('redacts AWS temporary (ASIA) access keys', () => {
  const out = redactSecrets('temp: ASIAIOSFODNN7EXAMPLE');
  assert.match(out, /\[REDACTED:aws\]/);
});

test('redacts Google/GCP API keys (AIza...)', () => {
  const out = redactSecrets('env: GOOGLE_API_KEY=AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz01234567');
  assert.match(out, /\[REDACTED:gcp\]/);
  assert.doesNotMatch(out, /AIzaSyAb/);
});

test('redacts Sentry DSNs', () => {
  const out = redactSecrets('dsn=https://abc123def456abc123def456abc123de@o12345.ingest.sentry.io/678901');
  assert.match(out, /\[REDACTED:sentry\]/);
});

test('redacts Cloudflare API tokens when contextualized', () => {
  const out = redactSecrets('CF_API_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  assert.match(out, /\[REDACTED:cloudflare\]/);
});

test('does NOT redact bare 40-char hex (commit SHAs) without cloudflare context', () => {
  const out = redactSecrets('commit abc123def456abc123def456abc123def456abc1');
  assert.doesNotMatch(out, /REDACTED:cloudflare/);
});

test('redacts Slack / Discord / Teams webhook URLs', () => {
  const slack  = redactSecrets('https://hooks.' + 'slack.com/services/T01ABCDEF/B02GHIJKL/abcDEFghiJKL1234567890ab');
  const disco  = redactSecrets('https://discord.com/api/webhooks/1234567890/abcdefghijklmnop_qrstuvwxyz-1234567890');
  const teams  = redactSecrets('https://tenant.webhook.office.com/webhookb2/abc@def/IncomingWebhook/xyz/token');
  assert.match(slack, /\[REDACTED:webhook\]/);
  assert.match(disco, /\[REDACTED:webhook\]/);
  assert.match(teams, /\[REDACTED:webhook\]/);
});

test('handles empty and non-string input', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(42), '');
});

// --- F-SEC-2 (v1.5.0 audit): 2026 secret-family coverage expansion ---

test('redacts GitLab personal access tokens (glpat-)', () => {
  const out = redactSecrets('GL_TOKEN=glpat-abcdefghij1234567890XY');
  assert.match(out, /\[REDACTED:gitlab\]/);
  assert.doesNotMatch(out, /glpat-abcd/);
});

test('does NOT redact unrelated "glpat" prose', () => {
  // No hyphen + short suffix → not a token shape
  const out = redactSecrets('the glpat algorithm and glpattern routine');
  assert.equal(out, 'the glpat algorithm and glpattern routine');
});

test('redacts GitLab CI build tokens (glcbt-) and deploy tokens (gldt-)', () => {
  const ci  = redactSecrets('JOB_TOKEN=glcbt-1A2B3C4D5E6F7G8H9I0J');
  const dep = redactSecrets('DEPLOY=gldt-abcdefghijklmnopqrstuvw');
  assert.match(ci,  /\[REDACTED:gitlab\]/);
  assert.match(dep, /\[REDACTED:gitlab\]/);
});

test('redacts AWS secret access keys when contextualized', () => {
  // 40-char base64-style synthetic, plus the AWS_SECRET_ACCESS_KEY= prefix
  const fortyChars = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const out = redactSecrets(`AWS_SECRET_ACCESS_KEY=${fortyChars}`);
  assert.match(out, /\[REDACTED:aws\]/);
  assert.doesNotMatch(out, /wJalrXUtn/);
});

test('does NOT redact bare 40-char base64 without AWS context', () => {
  // 40 chars but no AWS_SECRET_ACCESS_KEY prefix — must stay
  const fortyChars = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const out = redactSecrets(`some hash ${fortyChars} not aws`);
  assert.doesNotMatch(out, /\[REDACTED:aws\]/);
});

test('redacts Discord bot tokens (3-segment 24.6.27+)', () => {
  // Synthetic, non-eyJ first segment so it does not collide with JWT shape
  const tok = 'MTAyMzQ1Njc4OTAxMjM0NTY3.GhIjKl.MnOpQrStUvWxYz0123456789abcdef';
  const out = redactSecrets(`DISCORD_BOT=${tok}`);
  assert.match(out, /\[REDACTED:discord\]/);
  assert.doesNotMatch(out, /MnOpQrStUv/);
});

test('does NOT misclassify a JWT as a Discord token', () => {
  // Real JWT shape (eyJ header) must redact as jwt, not discord
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.abcdefghijklmnopqrstuvwxyz0123';
  const out = redactSecrets(`token=${jwt}`);
  assert.match(out, /\[REDACTED:jwt\]/);
  assert.doesNotMatch(out, /\[REDACTED:discord\]/);
});

test('redacts bare JWT tokens (eyJ.eyJ.sig)', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redactSecrets(`Supabase: ${jwt}`);
  assert.match(out, /\[REDACTED:jwt\]/);
});

test('does NOT misclassify "eyJ" prose as a JWT', () => {
  const out = redactSecrets('the letters eyJ are common in base64 headers');
  assert.equal(out, 'the letters eyJ are common in base64 headers');
});

test('redacts OpenAI organization IDs (org-...)', () => {
  const out = redactSecrets('OpenAI org-abcdefghijklmnopqrstuvwx is mine');
  assert.match(out, /\[REDACTED:openai-org\]/);
});

test('does NOT redact ordinary "org-" prose', () => {
  // org-chart, org-wide etc. are shorter than 24 alphanumerics
  const out = redactSecrets('Discuss org-chart and org-wide policy');
  assert.equal(out, 'Discuss org-chart and org-wide policy');
});

test('redacts Vercel personal access tokens (vercel_pat_)', () => {
  const out = redactSecrets('VERCEL_TOKEN=vercel_pat_AbCdEfGh1234567890XyZ');
  assert.match(out, /\[REDACTED:vercel\]/);
});

test('redacts contextualized VERCEL_TOKEN=... env values', () => {
  const out = redactSecrets('export VERCEL_API_TOKEN=ABCDEF1234567890abcdef12');
  assert.match(out, /\[REDACTED:vercel\]/);
});

test('redacts Supabase project access tokens (sbp_)', () => {
  const out = redactSecrets('SUPABASE_TOKEN=sbp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
  assert.match(out, /\[REDACTED:supabase\]/);
});

test('redacts Notion integration secrets (secret_ + 43 chars)', () => {
  // 43-char synthetic
  const tok = 'A'.repeat(43);
  const out = redactSecrets(`NOTION=secret_${tok}`);
  assert.match(out, /\[REDACTED:notion\]/);
});

test('redacts Notion ntn_ tokens (2026 format)', () => {
  const out = redactSecrets('NOTION_API_KEY=ntn_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
  assert.match(out, /\[REDACTED:notion\]/);
});

test('does NOT redact bare "secret_" prefix without 43 chars', () => {
  // 10-char suffix, well below the 43-char min
  const out = redactSecrets('field secret_short_val matters');
  assert.doesNotMatch(out, /\[REDACTED:notion\]/);
});

test('redacts Linear API keys (lin_api_)', () => {
  const out = redactSecrets('LINEAR_KEY=lin_api_abcdefghijklmnopqrstuvwxyz012345');
  assert.match(out, /\[REDACTED:linear\]/);
});

test('redacts Linear OAuth keys (lin_oauth_)', () => {
  const out = redactSecrets('OAUTH=lin_oauth_abcdefghijklmnopqrstuvwxyz012345');
  assert.match(out, /\[REDACTED:linear\]/);
});

test('redacts Twilio Account SIDs (AC + 32 hex)', () => {
  // Synthetic: 32 hex chars after AC
  const out = redactSecrets('twilio sid AC0123456789abcdef0123456789abcdef now');
  assert.match(out, /\[REDACTED:twilio\]/);
});

test('redacts Twilio auth tokens when contextualized', () => {
  const out = redactSecrets('TWILIO_AUTH_TOKEN=0123456789abcdef0123456789abcdef');
  assert.match(out, /\[REDACTED:twilio\]/);
});

test('does NOT redact bare 32-char hex without Twilio context', () => {
  const out = redactSecrets('git sha 0123456789abcdef0123456789abcdef now');
  assert.doesNotMatch(out, /\[REDACTED:twilio\]/);
});
