// Cache unit tests -- ttlCache laziness, TTL expiry, mtime-bust, NO_CACHE bypass.
// Run: cd mcp-server && node --test test-cache.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ttlCache, clearCache } from './src/lib/cache.js';

function setup() {
  delete process.env.IJFW_DASHBOARD_NO_CACHE;
  clearCache();
}

// ============================================================
// Basic caching
// ============================================================

test('ttlCache caches value within TTL', () => {
  setup();
  let calls = 0;
  const compute = () => { calls++; return 'result-' + calls; };
  const mtime = () => 'stable-key';

  const v1 = ttlCache('k1', 60_000, mtime, compute);
  const v2 = ttlCache('k1', 60_000, mtime, compute);

  assert.equal(v1, 'result-1');
  assert.equal(v2, 'result-1', 'second call should return cached value');
  assert.equal(calls, 1, 'computeFn invoked exactly once');
});

test('ttlCache does NOT call mtimeKeyFn on within-TTL cache hit', () => {
  setup();
  let mtimeCalls = 0;
  const mtime = () => { mtimeCalls++; return 'key'; };
  const compute = () => 'value';

  ttlCache('k-lazy', 60_000, mtime, compute);       // miss -- mtime called once
  ttlCache('k-lazy', 60_000, mtime, compute);       // hit  -- mtime must NOT be called
  ttlCache('k-lazy', 60_000, mtime, compute);       // hit  -- mtime must NOT be called

  assert.equal(mtimeCalls, 1, 'mtimeKeyFn should only be called on miss/expiry');
});

// ============================================================
// mtime-based invalidation
// ============================================================

test('ttlCache busts on mtimeKey change', () => {
  setup();
  let calls = 0;
  let mtimeVal = 'v1';
  const compute = () => { calls++; return 'result-' + calls; };
  const mtime = () => mtimeVal;

  // First call: cold miss
  const v1 = ttlCache('k2', 0, mtime, compute); // TTL=0 forces expiry path every time
  assert.equal(v1, 'result-1');

  // Change mtime key -- should bust
  mtimeVal = 'v2';
  const v2 = ttlCache('k2', 0, mtime, compute);
  assert.equal(v2, 'result-2');
  assert.equal(calls, 2);
});

// ============================================================
// TTL expiry path: same mtime key = refresh cachedAt, no recompute
// ============================================================

test('ttlCache busts on TTL expiry with changed mtime', () => {
  setup();
  let calls = 0;
  let mtimeVal = 'before';
  const compute = () => { calls++; return calls; };
  const mtime = () => mtimeVal;

  // Populate with TTL=0 (immediately expired on next call)
  ttlCache('k3', 0, mtime, compute);
  assert.equal(calls, 1);

  // Change mtime -- expired TTL + different mtime = recompute
  mtimeVal = 'after';
  ttlCache('k3', 0, mtime, compute);
  assert.equal(calls, 2, 'should recompute after TTL expiry + mtime change');
});

// ============================================================
// NO_CACHE bypass
// ============================================================

test('IJFW_DASHBOARD_NO_CACHE=1 bypasses cache', () => {
  setup();
  process.env.IJFW_DASHBOARD_NO_CACHE = '1';
  let calls = 0;
  const compute = () => { calls++; return calls; };
  const mtime = () => 'stable';

  ttlCache('k4', 60_000, mtime, compute);
  ttlCache('k4', 60_000, mtime, compute);
  ttlCache('k4', 60_000, mtime, compute);

  assert.equal(calls, 3, 'computeFn called every time when NO_CACHE=1');
  delete process.env.IJFW_DASHBOARD_NO_CACHE;
});
