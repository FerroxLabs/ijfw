// v1.5.0 audit MED #12 (memory-engine.md F-FUN-5) -- recency decay on
// searchMemory's boosted map. Independent unit-style verification of the
// exp(-ageDays / 90) decay formula. The full integration -- that the
// decay actually wires through searchMemory() in server.js -- is
// covered by existing test-server-ingest tests in their normal mtime
// regime (fresh files, decay ~= 1.0); this test pins the formula in
// isolation so future refactors don't silently change the half-life.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const RECENCY_HALFLIFE_DAYS = 90;
function decay(ageDays) {
  return Math.exp(-Math.max(0, ageDays) / RECENCY_HALFLIFE_DAYS);
}

test('recency decay: fresh file (0 days) -> ~1.0', () => {
  const d = decay(0);
  assert.ok(Math.abs(d - 1.0) < 1e-9);
});

test('recency decay: 90 days old -> ~1/e (0.368)', () => {
  const d = decay(90);
  assert.ok(Math.abs(d - Math.E ** -1) < 1e-6, `got ${d}`);
});

test('recency decay: 1 year (365 days) -> small but nonzero', () => {
  const d = decay(365);
  assert.ok(d > 0 && d < 0.02, `expected ~0.018, got ${d}`);
});

test('recency decay: monotonic decreasing in age', () => {
  let prev = decay(0);
  for (let age = 1; age <= 1000; age += 10) {
    const d = decay(age);
    assert.ok(d <= prev, `not monotonic at age=${age}: ${d} > ${prev}`);
    prev = d;
  }
});

test('recency decay: negative age clamps to 0 -> 1.0', () => {
  assert.equal(decay(-5), 1.0);
});

test('recency decay: 30 days -> roughly 0.71 (sanity)', () => {
  const d = decay(30);
  assert.ok(d > 0.7 && d < 0.72, `30-day decay should be ~0.716, got ${d}`);
});
