import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// The project migrated from GitLab CI to GitHub Actions (FerroxLabs/ijfw).
// This suite guards the CURRENT ship path: .github/workflows/publish.yml, which
// publishes to npm via Trusted Publishing (OIDC) with provenance, gated behind
// a preflight job. (Previously this asserted a now-removed .gitlab-ci.yml.)
const REPO_ROOT = join(import.meta.dirname, '..');
const PUBLISH_YML = join(REPO_ROOT, '.github', 'workflows', 'publish.yml');

test('publish workflow exists at .github/workflows/publish.yml', () => {
  assert.ok(existsSync(PUBLISH_YML), 'GitHub Actions publish workflow missing');
});

const CI = existsSync(PUBLISH_YML) ? readFileSync(PUBLISH_YML, 'utf8') : '';

test('publish triggers on v* tags only', () => {
  assert.match(CI, /tags:\s*\n\s*-\s*'?v\*'?/m, 'workflow must trigger on v* tags');
});

test('publish job is gated behind the preflight job', () => {
  // The release must not publish unless preflight is green.
  assert.match(CI, /^\s*preflight:/m, 'preflight job missing');
  assert.match(CI, /needs:\s*preflight/, 'publish must declare needs: preflight');
});

test('publish runs npm publish --provenance --access public', () => {
  assert.match(CI, /npm publish --provenance --access public/,
    'publish step must use --provenance --access public');
});

test('publish uses granular NPM_TOKEN auth WITH provenance attestation', () => {
  // Shipped trust model (v1.6.0+): a granular, 2FA-bypass NPM_TOKEN supplies the
  // publish credential (OIDC trusted-publishing setup never activated on the Free
  // tier), while id-token: write still lets npm attach a provenance attestation
  // alongside token auth. Strip YAML comments first so explanatory lines don't
  // trip the checks -- we care about actual usage, not documentation.
  const code = CI.split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
  assert.match(code, /id-token:\s*write/, 'publish job must request id-token: write so npm can attach provenance');
  assert.match(code, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/,
    'publish must wire NODE_AUTH_TOKEN from the NPM_TOKEN secret');
  assert.match(code, /npm publish --provenance/, 'publish must still attach provenance');
});

test('neither package.json declares publishConfig.provenance (flag path preferred)', () => {
  const installerPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer/package.json'), 'utf8'));
  const mcpPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'mcp-server/package.json'), 'utf8'));
  assert.equal(installerPkg.publishConfig?.provenance, undefined, 'installer should NOT set publishConfig.provenance');
  assert.equal(mcpPkg.publishConfig?.provenance, undefined, 'mcp-server should NOT set publishConfig.provenance');
});

test('release creates a GitHub Release from CHANGELOG notes', () => {
  assert.match(CI, /gh release create/, 'workflow must create a GitHub Release for the tag');
});
