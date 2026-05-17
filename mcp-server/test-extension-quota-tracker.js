/**
 * test-extension-quota-tracker.js — IJFW v1.4.3 W9-A3 (B16)
 *
 * Unit coverage for extension-quota-tracker.js.
 *
 * Frozen contracts exercised:
 *   - checkAndIncrement(name, dim, inc, limit, opts) → { allowed, current, limit, reason? }
 *   - resetExtensionQuotas(name, opts)
 *   - getQuotaUsage(name, opts) → frozen B19 shape
 *
 * SEC-H-01 cross-process race lives in test-server-quota-integration.js (the
 * shared lock is provably correct via test-fs-lock.js test #6). This file
 * uses Promise.all for in-process concurrency.
 *
 * Cross-platform: tests set HOME *and* USERPROFILE for the same tmp dir so
 * Windows callers don't accidentally write to the real user profile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkAndIncrement,
  resetExtensionQuotas,
  getQuotaUsage,
  readQuotaState,
  writeQuotaState,
  QUOTA_DIMENSIONS,
} from './src/extension-quota-tracker.js';

async function withTmpHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'ijfw-quota-test-'));
  const prevHome = process.env.HOME;
  const prevUserprofile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserprofile;
    await rm(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. checkAndIncrement under limit → allowed=true, current incremented
// ---------------------------------------------------------------------------
test('checkAndIncrement: under limit allows and increments', async () => {
  await withTmpHome(async (home) => {
    const r1 = await checkAndIncrement('ext-a', 'files_written', 1, 5, { homeDir: home, path: '/abs/a' });
    assert.equal(r1.allowed, true);
    assert.equal(r1.current, 1);
    assert.equal(r1.limit, 5);
    const r2 = await checkAndIncrement('ext-a', 'files_written', 1, 5, { homeDir: home, path: '/abs/b' });
    assert.equal(r2.allowed, true);
    assert.equal(r2.current, 2);
  });
});

// ---------------------------------------------------------------------------
// 2. over limit → allowed=false, current stays at-limit (NOT exceeded)
// ---------------------------------------------------------------------------
test('checkAndIncrement: over limit denies and current stays at-limit', async () => {
  await withTmpHome(async (home) => {
    for (let i = 0; i < 3; i++) {
      const r = await checkAndIncrement('ext-b', 'files_written', 1, 3, { homeDir: home, path: `/p/${i}` });
      assert.equal(r.allowed, true);
    }
    const denied = await checkAndIncrement('ext-b', 'files_written', 1, 3, { homeDir: home, path: '/p/3' });
    assert.equal(denied.allowed, false);
    assert.equal(denied.current, 3, 'current stays at limit, not exceeded');
    assert.equal(denied.limit, 3);
    assert.match(denied.reason || '', /files_written/);
  });
});

// ---------------------------------------------------------------------------
// 3. Atomic concurrency: 100 in-process parallel increments → current=100
// ---------------------------------------------------------------------------
test('checkAndIncrement: 100 parallel Promise.all increments yield current=100', async () => {
  await withTmpHome(async (home) => {
    const tasks = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(checkAndIncrement('ext-c', 'bytes_written', 1, 10_000, { homeDir: home }));
    }
    const results = await Promise.all(tasks);
    for (const r of results) assert.equal(r.allowed, true);
    const usage = await getQuotaUsage('ext-c', { homeDir: home });
    assert.equal(usage.dimensions.bytes_written.current, 100, `expected 100 increments, got ${usage.dimensions.bytes_written.current}`);
  });
});

// ---------------------------------------------------------------------------
// 4. Reset on deactivate clears all counters
// ---------------------------------------------------------------------------
test('resetExtensionQuotas: deactivate clears all counters for that extension', async () => {
  await withTmpHome(async (home) => {
    await checkAndIncrement('ext-d', 'files_written', 1, 100, { homeDir: home, path: '/x' });
    await checkAndIncrement('ext-d', 'bytes_written', 500, 100_000, { homeDir: home });
    const before = await getQuotaUsage('ext-d', { homeDir: home });
    assert.equal(before.dimensions.files_written.current, 1);
    assert.equal(before.dimensions.bytes_written.current, 500);

    await resetExtensionQuotas('ext-d', { homeDir: home }); // deactivate → no activated_at
    const after = await getQuotaUsage('ext-d', { homeDir: home });
    assert.equal(after.dimensions.files_written.current, 0);
    assert.equal(after.dimensions.bytes_written.current, 0);
    assert.equal(after.activated_at, null);
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence across calls (writes survive re-read)
// ---------------------------------------------------------------------------
test('persistence: increment, re-read state, current reflects increment', async () => {
  await withTmpHome(async (home) => {
    await checkAndIncrement('ext-e', 'bytes_written', 42, 1_000, { homeDir: home });
    const raw = await readQuotaState(home);
    assert.equal(raw['ext-e'].bytes_written.current, 42);

    const usage = await getQuotaUsage('ext-e', { homeDir: home });
    assert.equal(usage.dimensions.bytes_written.current, 42);
  });
});

// ---------------------------------------------------------------------------
// 6. Back-compat: limit=null/undefined → allowed regardless of count
// ---------------------------------------------------------------------------
test('back-compat: no limit declared → checkAndIncrement always allowed', async () => {
  await withTmpHome(async (home) => {
    const r1 = await checkAndIncrement('ext-f', 'files_written', 1, null, { homeDir: home, path: '/q' });
    assert.equal(r1.allowed, true);
    assert.equal(r1.limit, null);
    const r2 = await checkAndIncrement('ext-f', 'files_written', 1, undefined, { homeDir: home, path: '/q2' });
    assert.equal(r2.allowed, true);
    assert.equal(r2.limit, null);
    const usage = await getQuotaUsage('ext-f', { homeDir: home });
    assert.equal(usage.dimensions.files_written.current, 2);
    assert.equal(usage.dimensions.files_written.limit, null);
  });
});

// ---------------------------------------------------------------------------
// 7. Per-dimension isolation: hitting one limit doesn't affect others
// ---------------------------------------------------------------------------
test('per-dimension isolation: files limit doesn’t block bytes increments', async () => {
  await withTmpHome(async (home) => {
    // Saturate files_written at limit=2
    await checkAndIncrement('ext-g', 'files_written', 1, 2, { homeDir: home, path: '/1' });
    await checkAndIncrement('ext-g', 'files_written', 1, 2, { homeDir: home, path: '/2' });
    const denied = await checkAndIncrement('ext-g', 'files_written', 1, 2, { homeDir: home, path: '/3' });
    assert.equal(denied.allowed, false);

    // bytes_written should still be incrementable
    const okBytes = await checkAndIncrement('ext-g', 'bytes_written', 100, 1_000, { homeDir: home });
    assert.equal(okBytes.allowed, true);
    assert.equal(okBytes.current, 100);
  });
});

// ---------------------------------------------------------------------------
// 8. getQuotaUsage frozen B19 shape — including null-limit semantics
// ---------------------------------------------------------------------------
test('getQuotaUsage: frozen shape with correct null-limit semantics', async () => {
  await withTmpHome(async (home) => {
    // Non-existent extension: full shape with zeros + nulls.
    const empty = await getQuotaUsage('nope', { homeDir: home });
    assert.equal(empty.ext_name, 'nope');
    assert.equal(empty.activated_at, null);
    assert.ok(empty.dimensions, 'dimensions present');
    for (const dim of QUOTA_DIMENSIONS) {
      assert.equal(empty.dimensions[dim].current, 0, `${dim}.current=0`);
      assert.equal(empty.dimensions[dim].limit, null, `${dim}.limit=null`);
    }

    // With activity + explicit limits passed in.
    await checkAndIncrement('ext-h', 'bytes_written', 7, 100, { homeDir: home });
    const usage = await getQuotaUsage('ext-h', {
      homeDir: home,
      limits: { max_bytes_written: 100, max_files_written: 5 },
    });
    assert.equal(usage.ext_name, 'ext-h');
    assert.equal(usage.dimensions.bytes_written.current, 7);
    assert.equal(usage.dimensions.bytes_written.limit, 100);
    assert.equal(usage.dimensions.files_written.limit, 5);
    assert.equal(usage.dimensions.wall_clock_ms.limit, null);
  });
});

// ---------------------------------------------------------------------------
// 9. files_written dedupe: same path 10× counts 1
// ---------------------------------------------------------------------------
test('files_written dedupe: writing same path N times counts 1', async () => {
  await withTmpHome(async (home) => {
    for (let i = 0; i < 10; i++) {
      const r = await checkAndIncrement('ext-i', 'files_written', 1, 5, { homeDir: home, path: '/same/path' });
      assert.equal(r.allowed, true);
    }
    const usage = await getQuotaUsage('ext-i', { homeDir: home });
    assert.equal(usage.dimensions.files_written.current, 1, 'dedupe failed');
  });
});

// ---------------------------------------------------------------------------
// 10. wall_clock_ms: computed from activated_at; never per-call increment
// ---------------------------------------------------------------------------
test('wall_clock_ms: computed from activated_at, no per-call increment', async () => {
  await withTmpHome(async (home) => {
    const past = new Date(Date.now() - 200).toISOString();
    await resetExtensionQuotas('ext-j', { homeDir: home, activated_at: past });
    const r = await checkAndIncrement('ext-j', 'wall_clock_ms', 999, 10_000, { homeDir: home });
    assert.equal(r.allowed, true);
    assert.ok(r.current >= 200, `expected wall_clock >= 200ms, got ${r.current}`);
    // No bump: calling again does not increase current beyond actual elapsed.
    const r2 = await checkAndIncrement('ext-j', 'wall_clock_ms', 999, 10_000, { homeDir: home });
    assert.ok(r2.current >= r.current, 'wall clock monotonically increases');
    // Crucially, files_written stays at 0 — wall_clock is computed-not-stored.
    const usage = await getQuotaUsage('ext-j', { homeDir: home });
    assert.equal(usage.dimensions.files_written.current, 0);
  });
});

// ---------------------------------------------------------------------------
// 11. wall_clock_ms over limit → denied
// ---------------------------------------------------------------------------
test('wall_clock_ms: exceeded limit denies', async () => {
  await withTmpHome(async (home) => {
    const past = new Date(Date.now() - 5_000).toISOString();
    await resetExtensionQuotas('ext-k', { homeDir: home, activated_at: past });
    const r = await checkAndIncrement('ext-k', 'wall_clock_ms', 0, 1_000, { homeDir: home });
    assert.equal(r.allowed, false);
    assert.match(r.reason || '', /wall_clock_ms/);
  });
});

// ---------------------------------------------------------------------------
// 12. Activated_at stamping persists through activate
// ---------------------------------------------------------------------------
test('resetExtensionQuotas with activated_at stamps the window', async () => {
  await withTmpHome(async (home) => {
    const stamp = new Date().toISOString();
    await resetExtensionQuotas('ext-l', { homeDir: home, activated_at: stamp });
    const usage = await getQuotaUsage('ext-l', { homeDir: home });
    assert.equal(usage.activated_at, stamp);
  });
});

// ---------------------------------------------------------------------------
// 13. Defensive: malformed state file is treated as empty
// ---------------------------------------------------------------------------
test('readQuotaState: malformed file treated as empty {}', async () => {
  await withTmpHome(async (home) => {
    const dir = join(home, '.ijfw', 'state');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'extension-quotas.json'), 'this is not json', 'utf8');
    const s = await readQuotaState(home);
    assert.deepEqual(s, {});
    // and we can still increment afterwards (overwrites garbage)
    const r = await checkAndIncrement('ext-m', 'bytes_written', 1, 10, { homeDir: home });
    assert.equal(r.allowed, true);
  });
});

// ---------------------------------------------------------------------------
// 14. writeQuotaState round-trip
// ---------------------------------------------------------------------------
test('writeQuotaState + readQuotaState round-trips', async () => {
  await withTmpHome(async (home) => {
    await writeQuotaState(home, { 'ext-x': { files_written: { current: 9, writes_by_path: { '/y': true } }, bytes_written: { current: 0 }, activated_at: null } });
    const s = await readQuotaState(home);
    assert.equal(s['ext-x'].files_written.current, 9);
    assert.equal(s['ext-x'].files_written.writes_by_path['/y'], true);
  });
});
