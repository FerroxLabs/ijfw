// test-v155-update-flow.js — V155-001 (BLOCKER) regression test.
//
// Proves the fix for `verifyInstallSucceeded` actually refuses to advance
// state.json when the on-disk @ijfw/install version does not match the
// expected version. The original bug: `ijfw update` trusted `npm install`
// exit-0 as proof of upgrade, so a no-op install or registry blip would
// silently bump state.json to a version that did not exist on disk; every
// subsequent `--check` then said "we're up to date" and refused to retry.
//
// Test cases:
//   1. mismatch refuses        — installer/package.json reports 1.0.0 vs expected 1.5.5
//   2. match accepts           — installer/package.json reports 1.5.5
//   3. unreadable refuses      — no package.json on disk
//   4. method mislabel still finds — manual + valid repoRoot tree still verifies
//
// The fix lives in mcp-server/src/cross-orchestrator-cli.js (verifyInstallSucceeded).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyInstallSucceeded } from './src/cross-orchestrator-cli.js';

function makeRepo(version) {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-v155-001-'));
  if (version != null) {
    const installer = join(root, 'installer');
    mkdirSync(installer, { recursive: true });
    writeFileSync(
      join(installer, 'package.json'),
      JSON.stringify({ name: '@ijfw/install', version }, null, 2),
      { mode: 0o600 },
    );
  }
  return root;
}

function rmAll(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

test('V155-001 mismatch refuses (git-clone, 1.0.0 vs 1.5.5)', () => {
  const root = makeRepo('1.0.0');
  try {
    const res = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, false, 'mismatch must refuse');
    assert.equal(res.actualVersion, null);
    assert.match(res.reason, /1\.5\.5/, 'reason must mention expected version');
    assert.match(res.reason, /v1\.0\.0|1\.0\.0/, 'reason must mention actual version');
  } finally { rmAll(root); }
});

test('V155-001 match accepts (git-clone, 1.5.5)', () => {
  const root = makeRepo('1.5.5');
  try {
    const res = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, true, 'matching version must accept');
    assert.equal(res.actualVersion, '1.5.5');
    assert.ok(res.source && res.source.endsWith('package.json'));
  } finally { rmAll(root); }
});

test('V155-001 unreadable refuses (no package.json)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-v155-001-empty-'));
  try {
    const res = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, false, 'missing package.json must refuse');
    assert.equal(res.actualVersion, null);
    // "unreadable" surfaces in seen-candidates listing; empty-candidates
    // is the alternate framing if the method path produces no candidates.
    assert.match(
      res.reason,
      /unreadable|no candidates|no package\.json/i,
      'reason must explain unreadable / no candidates',
    );
  } finally { rmAll(root); }
});

test('V155-001 method mislabel still finds via repoRoot fallback', () => {
  // method:'manual' would prefer the npm-global root (probably not v1.5.5
  // on the test machine), but the helper falls back to repoRoot/installer/
  // as a final candidate. This covers dev-mode installs where install_method
  // was recorded as 'manual' but the user actually has a git clone.
  const root = makeRepo('1.5.5');
  try {
    const res = verifyInstallSucceeded({
      method: 'manual',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, true, 'fallback must find repoRoot/installer/package.json');
    assert.equal(res.actualVersion, '1.5.5');
  } finally { rmAll(root); }
});
