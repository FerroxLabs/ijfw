/**
 * test-orchestrator-worktree-provision.js — v1.5.0 W11-A2 / S2 tests.
 *
 * Covers:
 *   1. node detector happy path (network-dependent — DONE_WITH_CONCERNS if offline)
 *   2. no manifest in tmpdir → zero work, no failure
 *   3. lifecycle-script injection refusal (--ignore-scripts proof)
 *   4. symlinked package.json → skipped as not-regular-file
 *   5. per-install timeout
 *   6. wall-deadline (wallMs:0) — all detectors skipped before invocation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { provisionWorktree } from './src/orchestrator/worktree-provision.js';

function freshDir(label) {
  return mkdtempSync(join(tmpdir(), `ijfw-w11a2-${label}-`));
}

test('node detector installs a minimal package.json (network-dependent)', async () => {
  const dir = freshDir('node-ok');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  const result = await provisionWorktree(dir, { perInstallMs: 60_000, wallMs: 90_000 });
  const node = result.installed.find((x) => x.name === 'node');
  assert.ok(node, `expected node install entry, got ${JSON.stringify(result)}`);
  assert.equal(node.path, dir);
});

test('no manifest in tmpdir → zero installs, zero failures', async () => {
  const dir = freshDir('empty');
  const result = await provisionWorktree(dir);
  assert.equal(result.installed.length, 0);
  assert.equal(result.failed.length, 0);
});

test('lifecycle-script injection refused: preinstall must NOT execute', async () => {
  const dir = freshDir('inject');
  const sentinel = join(dir, 'injected.txt');
  // preinstall would create sentinel if --ignore-scripts were absent.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'inject-test',
      version: '1.0.0',
      scripts: { preinstall: `node -e "require('fs').writeFileSync('${sentinel.replace(/\\/g, '\\\\')}','INJECTED')"` },
    })
  );
  await provisionWorktree(dir, { perInstallMs: 60_000, wallMs: 90_000 });
  assert.equal(existsSync(sentinel), false, 'preinstall script executed despite --ignore-scripts');
});

test('symlinked package.json refused (not a regular file)', async () => {
  const dir = freshDir('symlink');
  // /etc/hosts is a stable symlink target on macOS/linux runners.
  try {
    symlinkSync('/etc/hosts', join(dir, 'package.json'));
  } catch (err) {
    // If symlink fails (e.g. unsupported FS), skip rather than fail.
    return;
  }
  const result = await provisionWorktree(dir);
  const skipped = result.skipped.find((s) => s.name === 'node' && s.reason === 'not-regular-file');
  assert.ok(skipped, `expected node skipped as not-regular-file, got ${JSON.stringify(result)}`);
  assert.equal(result.installed.find((x) => x.name === 'node'), undefined);
});

test('per-install timeout fires when perInstallMs is impossibly small', async () => {
  const dir = freshDir('timeout');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  const result = await provisionWorktree(dir, { perInstallMs: 1, wallMs: 30_000 });
  const failed = result.failed.find((f) => f.name === 'node');
  assert.ok(failed, `expected node failure, got ${JSON.stringify(result)}`);
  assert.ok(
    failed.reason === 'timeout' || failed.reason === 'ETIMEDOUT',
    `expected timeout reason, got ${failed.reason}`
  );
});

test('wall-deadline: wallMs=0 skips every detector with reason=wall-deadline', async () => {
  const dir = freshDir('walldeadline');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  const result = await provisionWorktree(dir, { wallMs: 0 });
  assert.equal(result.installed.length, 0);
  assert.equal(result.failed.length, 0);
  assert.ok(result.skipped.length >= 1, `expected at least 1 skipped, got ${JSON.stringify(result)}`);
  for (const s of result.skipped) {
    assert.equal(s.reason, 'wall-deadline', `unexpected skip reason: ${JSON.stringify(s)}`);
  }
});
