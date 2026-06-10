// P0.4 — Global profile lock. Separate from any per-repo dream lock; serializes
// concurrent writers so N per-project SessionEnd cycles can't lose updates.
//
// NOTE: node:test runs top-level async tests CONCURRENTLY by default, so each
// case uses its OWN tmp dir + injected lockPath (never a shared env var) to
// avoid cross-test interference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profileLockPath, withProfileLock } from '../src/profile/lock.js';

function freshLockPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-pstate-'));
  return { dir, lockPath: join(dir, '.profile.lock') };
}

test('profileLockPath is the global state .profile.lock, not a per-repo lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-pstate-'));
  const prev = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_STATE_DIR = dir;
  try {
    const p = profileLockPath();
    assert.equal(p, join(dir, '.profile.lock'));
    assert.ok(!/wave-/.test(p));
    assert.ok(/\.profile\.lock$/.test(p));
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_STATE_DIR;
    else process.env.IJFW_PROFILE_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withProfileLock runs fn and returns its value', async () => {
  const { dir, lockPath } = freshLockPath();
  try {
    const out = await withProfileLock(async () => 42, { lockPath });
    assert.equal(out, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two concurrent writers serialize — no lost update', async () => {
  const { dir, lockPath } = freshLockPath();
  try {
    const shared = { value: 0 };
    async function increment() {
      await withProfileLock(async () => {
        const v = shared.value;
        await new Promise((r) => setTimeout(r, 5));
        shared.value = v + 1;
      }, { lockPath });
    }
    await Promise.all([increment(), increment()]);
    assert.equal(shared.value, 2, 'both increments landed (serialized)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock is reusable across sequential calls (released after each)', async () => {
  const { dir, lockPath } = freshLockPath();
  try {
    await withProfileLock(async () => 'a', { lockPath });
    const second = await withProfileLock(async () => 'b', { lockPath });
    assert.equal(second, 'b', 'second acquisition succeeds — first released');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
