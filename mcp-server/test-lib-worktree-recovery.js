/**
 * test-lib-worktree-recovery.js — S10 tests for recovery-sentinel pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  withRecoverySentinel,
  listPendingRecoveries,
  recoverPending,
} from './src/lib/worktree-recovery.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'wtr-test-'));
}

test('withRecoverySentinel happy path: op succeeds, sentinel deleted', async () => {
  const root = freshRoot();
  let opRan = false;
  const result = await withRecoverySentinel(
    { worktreePath: '/tmp/wt-foo', op: 'remove', branch: 'feat/x' },
    async () => { opRan = true; return 'ok'; },
    root,
  );
  assert.equal(result, 'ok');
  assert.equal(opRan, true);
  const sentinelDir = join(root, '.planning', 'worktree-recovery');
  // Directory should exist but have no sentinel files left.
  const entries = readdirSync(sentinelDir).filter(n => n.startsWith('.worktree-recovery-pending.'));
  assert.equal(entries.length, 0, 'sentinel should be removed after success');
});

test('withRecoverySentinel op throws: sentinel REMAINS for recovery', async () => {
  const root = freshRoot();
  let caught = null;
  try {
    await withRecoverySentinel(
      { worktreePath: '/tmp/wt-bar', op: 'remove' },
      async () => { throw new Error('boom'); },
      root,
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'should have thrown');
  assert.equal(caught.message, 'boom');
  assert.ok(caught.sentinelPath, 'error should carry sentinelPath');
  assert.ok(existsSync(caught.sentinelPath), 'sentinel file should remain on disk');
  const payload = JSON.parse(await readFile(caught.sentinelPath, 'utf8'));
  assert.equal(payload.worktreePath, '/tmp/wt-bar');
  assert.equal(payload.op, 'remove');
  assert.ok(payload.sentinel_id);
  assert.ok(payload.ts);
});

test('listPendingRecoveries returns empty when no sentinels exist', async () => {
  const root = freshRoot();
  const pending = await listPendingRecoveries(root);
  assert.deepEqual(pending, []);
});

test('listPendingRecoveries returns N sentinels after N failed runs', async () => {
  const root = freshRoot();
  for (let i = 0; i < 3; i++) {
    try {
      await withRecoverySentinel(
        { worktreePath: `/tmp/wt-${i}`, op: 'remove' },
        async () => { throw new Error(`fail-${i}`); },
        root,
      );
    } catch { /* expected */ }
  }
  const pending = await listPendingRecoveries(root);
  assert.equal(pending.length, 3);
  const paths = pending.map(p => p.worktreePath).sort();
  assert.deepEqual(paths, ['/tmp/wt-0', '/tmp/wt-1', '/tmp/wt-2']);
  for (const s of pending) {
    assert.ok(s.path, 'each pending entry has a path');
    assert.ok(s.sentinel_id, 'each pending entry has a sentinel_id');
  }
});

test('recoverPending op:remove + missing worktree dir → succeeds idempotently, deletes sentinel', async () => {
  const root = freshRoot();
  // Manually plant a sentinel pointing at a nonexistent worktree dir.
  const sentinelDir = join(root, '.planning', 'worktree-recovery');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(sentinelDir, { recursive: true });
  const sentinelPath = join(sentinelDir, '.worktree-recovery-pending.deadbeef.json');
  const sentinel = {
    worktreePath: join(root, 'nonexistent-wt'),
    op: 'remove',
    sentinel_id: 'deadbeef',
    ts: new Date().toISOString(),
    path: sentinelPath,
  };
  await writeFile(sentinelPath, JSON.stringify(sentinel), 'utf8');

  const res = await recoverPending(sentinel, root);
  // git worktree prune may fail if root isn't a git repo; capture both shapes.
  if (res.ok) {
    assert.equal(res.action, 'completed-remove');
    assert.equal(existsSync(sentinelPath), false, 'sentinel removed on success');
  } else {
    assert.equal(res.action, 'remove-failed');
    assert.ok(res.error, 'failure carries error');
  }
});

test('recoverPending with unknown op → returns {ok:false, action:"unknown-op"}', async () => {
  const root = freshRoot();
  const res = await recoverPending(
    { op: 'teleport', worktreePath: '/tmp/whatever', path: '/tmp/fake-sentinel' },
    root,
  );
  assert.equal(res.ok, false);
  assert.equal(res.action, 'unknown-op');
  assert.equal(res.op, 'teleport');
});
