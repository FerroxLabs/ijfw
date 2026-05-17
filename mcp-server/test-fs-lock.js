/**
 * test-fs-lock.js — v1.4.3 W9-A0 shared lock primitive.
 *
 * Frozen contract tested:
 *   withFsLock(lockPath, fn, { staleMs, acquireTimeoutMs })
 *   FsLockBusyError, FsLockStaleError
 *
 * Most important test = #6 cross-process race via child_process.fork. That's
 * the proof SEC-H-01 is actually closed; Promise.all in one process can pass
 * with a broken mutex if both calls share the event loop.
 *
 * Run: node --test test-fs-lock.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  withFsLock,
  FsLockBusyError,
  FsLockStaleError,
} from './src/fs-lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(__dirname, 'test-fixtures', 'fs-lock-child.mjs');

async function makeTmp() {
  return await mkdtemp(join(tmpdir(), 'ijfw-fs-lock-test-'));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path: acquires + releases; lock dir gone after.
// ---------------------------------------------------------------------------
test('withFsLock: acquires, runs fn, releases lock dir', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    let inside = false;
    const result = await withFsLock(lockPath, async () => {
      inside = true;
      assert.equal(await exists(lockPath), true, 'lock dir exists during fn');
      return 42;
    });
    assert.equal(inside, true);
    assert.equal(result, 42);
    assert.equal(
      await exists(lockPath),
      false,
      'lock dir must be removed after release',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2 — Serial calls work (release/re-acquire cycle).
// ---------------------------------------------------------------------------
test('withFsLock: serial calls succeed', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    let counter = 0;
    for (let i = 0; i < 3; i++) {
      await withFsLock(lockPath, async () => {
        counter += 1;
      });
    }
    assert.equal(counter, 3);
    assert.equal(await exists(lockPath), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — Promise.all of two withFsLock calls runs sequentially.
// ---------------------------------------------------------------------------
test('withFsLock: Promise.all serializes (second waits for first)', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    const events = [];

    const taskA = withFsLock(lockPath, async () => {
      events.push('A:in');
      await new Promise((r) => setTimeout(r, 80));
      events.push('A:out');
    });
    const taskB = withFsLock(lockPath, async () => {
      events.push('B:in');
      events.push('B:out');
    });

    await Promise.all([taskA, taskB]);

    // The two critical sections must not interleave.
    assert.deepEqual(
      events,
      ['A:in', 'A:out', 'B:in', 'B:out'],
      'expected strict serial ordering, got: ' + JSON.stringify(events),
    );
    assert.equal(await exists(lockPath), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Stale lock recovery: pre-create lock dir with old holder.
// ---------------------------------------------------------------------------
test('withFsLock: recovers from stale lock (acquired_at older than staleMs)', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    await mkdir(lockPath, { recursive: false });
    await writeFile(
      join(lockPath, 'holder.json'),
      JSON.stringify({ pid: 999999, acquired_at: Date.now() - 60_000 }),
      'utf8',
    );

    let ran = false;
    const result = await withFsLock(
      lockPath,
      async () => {
        ran = true;
        return 'recovered';
      },
      { staleMs: 30_000, acquireTimeoutMs: 1000 },
    );
    assert.equal(ran, true);
    assert.equal(result, 'recovered');
    assert.equal(await exists(lockPath), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5 — Busy lock: fresh holder, short timeout → FsLockBusyError.
// ---------------------------------------------------------------------------
test('withFsLock: throws FsLockBusyError when holder is live', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    await mkdir(lockPath, { recursive: false });
    await writeFile(
      join(lockPath, 'holder.json'),
      JSON.stringify({ pid: process.pid, acquired_at: Date.now() }),
      'utf8',
    );

    let caught;
    try {
      await withFsLock(lockPath, async () => 'should not run', {
        staleMs: 30_000,
        acquireTimeoutMs: 100,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected an error');
    assert.ok(
      caught instanceof FsLockBusyError,
      `expected FsLockBusyError, got ${caught && caught.name}: ${caught}`,
    );
    assert.equal(caught.code, 'FS_LOCK_BUSY');
    // Cleanup the synthetic lock dir we created.
    await rm(lockPath, { recursive: true, force: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6 — Cross-process race: two forked children increment a counter
// inside withFsLock. The lock MUST serialize them. Final value must equal 2.
// This is the SEC-H-01 proof.
// ---------------------------------------------------------------------------
test('withFsLock: cross-process race via child_process.fork (SEC-H-01 proof)', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    const counterPath = join(tmp, 'counter.txt');
    await writeFile(counterPath, '0', 'utf8');

    function spawnHandle() {
      const child = fork(CHILD_SCRIPT, [lockPath, counterPath], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (b) => {
        stderr += b.toString();
      });
      const ready = new Promise((resolve) => {
        child.on('message', (msg) => {
          if (msg === 'ready') resolve();
        });
      });
      const exited = new Promise((resolve, reject) => {
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`child exited ${code}; stderr=${stderr}`));
        });
        child.on('error', reject);
      });
      return { child, ready, exited, send: (m) => child.send(m) };
    }

    const a = spawnHandle();
    const b = spawnHandle();

    // Wait for BOTH ready, then fire 'go' to both within the same tick.
    await Promise.all([a.ready, b.ready]);
    a.send('go');
    b.send('go');

    await Promise.all([a.exited, b.exited]);

    const finalRaw = await readFile(counterPath, 'utf8');
    const final = parseInt(finalRaw, 10);
    assert.equal(
      final,
      2,
      `cross-process lock failed to serialize: counter = ${finalRaw} (expected 2). ` +
        `This means withFsLock did NOT serialize across OS processes — SEC-H-01 is still open.`,
    );
    assert.equal(await exists(lockPath), false, 'lock dir leaked after race');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 7 — fn() throws: lock released, error propagates.
// ---------------------------------------------------------------------------
test('withFsLock: releases lock when fn throws and re-throws the error', async () => {
  const tmp = await makeTmp();
  try {
    const lockPath = join(tmp, 'lock');
    const boom = new Error('fn-blew-up');
    let caught;
    try {
      await withFsLock(lockPath, async () => {
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    assert.equal(caught, boom, 'must re-throw the original error');
    assert.equal(
      await exists(lockPath),
      false,
      'lock dir must be released even when fn throws',
    );

    // And the lock must be re-acquirable on the next call.
    let after = false;
    await withFsLock(lockPath, async () => {
      after = true;
    });
    assert.equal(after, true);

    // Sanity: stale-error type is exported and instantiable (defensive — A1
    // imports both classes).
    const staleSample = new FsLockStaleError('/tmp/x', new Error('cause'));
    assert.equal(staleSample.name, 'FsLockStaleError');
    assert.equal(staleSample.code, 'FS_LOCK_STALE');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
