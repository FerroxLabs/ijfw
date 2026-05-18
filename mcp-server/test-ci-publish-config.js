import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const CI = readFileSync(join(REPO_ROOT, '.gitlab-ci.yml'), 'utf8');

test('gitlab-ci.yml has both publish jobs', () => {
  assert.match(CI, /^publish:mcp-server:/m, 'publish:mcp-server job missing');
  assert.match(CI, /^publish:installer:/m, 'publish:installer job missing');
});

test('both publish jobs use strict v* tag pattern (no rc/beta slip-through)', () => {
  // Count occurrences of the strict pattern — must appear at least twice (once per publish job).
  const matches = CI.match(/\$CI_COMMIT_TAG\s*=~\s*\/\^v\\d\+\\\.\\d\+\\\.\\d\+\$\//g) ?? [];
  assert.ok(matches.length >= 2, `expected strict tag pattern on both publish jobs, got ${matches.length} match(es)`);
});

test('both publish jobs declare NPM_ID_TOKEN with npmjs audience', () => {
  // Look for the id_tokens NPM_ID_TOKEN block + aud field.
  assert.match(CI, /NPM_ID_TOKEN:/);
  assert.match(CI, /aud:\s*https:\/\/registry\.npmjs\.org/);
});

test('both publish jobs run npm publish --provenance --access public', () => {
  const matches = CI.match(/npm publish --provenance --access public/g) ?? [];
  assert.ok(matches.length >= 2, `expected --provenance on both publish jobs, got ${matches.length}`);
});

test('neither package.json declares publishConfig.provenance (flag path preferred)', () => {
  const installerPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'installer/package.json'), 'utf8'));
  const mcpPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'mcp-server/package.json'), 'utf8'));
  assert.equal(installerPkg.publishConfig?.provenance, undefined, 'installer should NOT set publishConfig.provenance');
  assert.equal(mcpPkg.publishConfig?.provenance, undefined, 'mcp-server should NOT set publishConfig.provenance');
});

test('publish stage is in stages list', () => {
  assert.match(CI, /^\s*-\s*publish\s*$/m, 'publish stage missing from stages: list');
});
