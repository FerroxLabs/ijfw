import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const INSTALLER_PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'installer/package.json'), 'utf8'));
const MCP_PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'mcp-server/package.json'), 'utf8'));

const EXPECTED_PROJECT = 'FerroxLabs/ijfw';

test('installer/package.json repository.url points at FerroxLabs/ijfw', () => {
  assert.ok(INSTALLER_PKG.repository, 'installer/package.json missing repository field');
  assert.match(INSTALLER_PKG.repository.url, new RegExp(EXPECTED_PROJECT.replace('/', '\\/') + '\\.git$'),
    `installer repository.url should end in ${EXPECTED_PROJECT}.git, got: ${INSTALLER_PKG.repository.url}`);
});

test('installer/package.json homepage matches', () => {
  assert.match(INSTALLER_PKG.homepage, new RegExp(EXPECTED_PROJECT.replace('/', '\\/') + '$'),
    `installer homepage should end in ${EXPECTED_PROJECT}, got: ${INSTALLER_PKG.homepage}`);
});

test('installer/package.json bugs.url matches', () => {
  assert.match(INSTALLER_PKG.bugs.url, new RegExp(EXPECTED_PROJECT.replace('/', '\\/')),
    `installer bugs.url should contain ${EXPECTED_PROJECT}, got: ${INSTALLER_PKG.bugs.url}`);
});

test('mcp-server/package.json (if it declares repository) matches', () => {
  // mcp-server/package.json may not declare repository — that's acceptable.
  // If it does declare one, it MUST point at the same project as installer.
  if (MCP_PKG.repository) {
    assert.match(MCP_PKG.repository.url, new RegExp(EXPECTED_PROJECT.replace('/', '\\/') + '\\.git$'),
      `mcp-server repository.url should end in ${EXPECTED_PROJECT}.git`);
  }
});
