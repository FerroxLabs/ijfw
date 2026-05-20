#!/usr/bin/env node
/**
 * test-memory-temporal.js -- T23: decay-on-retrieval gap-fill.
 *
 * Source authority: v1.5.0 gap-closure T23 (temporal / staleness gap-fill).
 *
 * PROBLEM (pre-T23): getValidAt returns facts with their raw stored confidence
 * regardless of age. A fact stored 90 days ago is indistinguishable from one
 * stored today. The retrieval path does not apply any time-based confidence
 * decay, so stale facts receive the same ranking weight as fresh ones.
 *
 * FIX: applyDecayToFacts(rows, now, options) in temporal.js. Returns each row
 * with two additional fields:
 *   staleness_days     -- float; age in days from valid_from to now
 *   decayed_confidence -- float; confidence * Math.exp(-staleness_days / halflife)
 *
 * Decay formula matches the existing searchMemory recency decay (server.js L821:
 * Math.exp(-ageDays / 90)). Halflives:
 *   project tier (default): 30 days
 *   session tier (source contains "session"): 1 day
 *
 * Facts are NOT filtered -- callers receive them all, downgraded. Server.js
 * handleRecall can rank by decayed_confidence; existing code that ignores the
 * field keeps working.
 *
 * Tests:
 *   1. [TDD seed] applyDecayToFacts does NOT exist on current HEAD -- proves gap.
 *      (Flip: after T23 lands, this test asserts it IS exported.)
 *   2. Fresh fact (stored now) has decayed_confidence ≈ original confidence.
 *   3. Old fact (stored 30 days ago) has decayed_confidence ≈ conf * e^(-1).
 *   4. Very old fact (stored 90 days ago) has decayed_confidence ≈ conf * e^(-3).
 *   5. Session-tier fact (source contains "session") uses 1-day halflife.
 *   6. Custom halflife option overrides default.
 *   7. staleness_days field is populated correctly.
 *   8. Input rows without valid_from fall back to created_at epoch.
 *   9. Empty array input returns empty array.
 *  10. applyDecayToFacts does not mutate the original row objects.
 *  11. getValidAt + applyDecayToFacts pipeline: insert + retrieve + decay.
 *  12. DECAY_HALFLIFE_DAYS and DECAY_HALFLIFE_SESSION_DAYS are exported
 *      constants so callers can render "this fact is N days old" UI.
 *
 * Run: node --test mcp-server/test-memory-temporal.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  openTemporalDb,
  applySchema,
  insertFact,
  getValidAt,
  applyDecayToFacts,
  DECAY_HALFLIFE_DAYS,
  DECAY_HALFLIFE_SESSION_DAYS,
} from './src/memory/temporal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO string N days in the past from `now`. */
function daysAgoIso(days, now = new Date()) {
  return new Date(now.getTime() - days * 86400 * 1000).toISOString();
}

/** Build a minimal fact row (simulating what getValidAt returns from SQLite). */
function makeRow(overrides = {}) {
  const now = new Date();
  return {
    id: 1,
    subject: 'user',
    predicate: 'uses',
    object: 'TypeScript',
    confidence: 1.0,
    memory_id: null,
    source: 'memory_store:project',
    valid_from: now.toISOString(),
    valid_to: null,
    created_at: now.getTime(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 -- TDD seed: applyDecayToFacts IS exported after T23 lands.
// On current HEAD (before T23), temporal.js does NOT export this function.
// This test is the falsifiable proof of the gap: if it fails, T23 is not done.
// ---------------------------------------------------------------------------
test('T23 -- applyDecayToFacts is exported from temporal.js', () => {
  assert.equal(
    typeof applyDecayToFacts,
    'function',
    'applyDecayToFacts must be a named export of temporal.js (gap: not present on pre-T23 HEAD)'
  );
});

// ---------------------------------------------------------------------------
// Test 2 -- DECAY_HALFLIFE_DAYS and DECAY_HALFLIFE_SESSION_DAYS are exported
// ---------------------------------------------------------------------------
test('T23 -- DECAY_HALFLIFE_DAYS and DECAY_HALFLIFE_SESSION_DAYS are exported constants', () => {
  assert.ok(
    typeof DECAY_HALFLIFE_DAYS === 'number' && DECAY_HALFLIFE_DAYS > 0,
    'DECAY_HALFLIFE_DAYS must be a positive number'
  );
  assert.ok(
    typeof DECAY_HALFLIFE_SESSION_DAYS === 'number' && DECAY_HALFLIFE_SESSION_DAYS > 0,
    'DECAY_HALFLIFE_SESSION_DAYS must be a positive number'
  );
  // Session halflife must be strictly shorter than project halflife.
  assert.ok(
    DECAY_HALFLIFE_SESSION_DAYS < DECAY_HALFLIFE_DAYS,
    'Session halflife must be shorter than project halflife'
  );
});

// ---------------------------------------------------------------------------
// Test 3 -- Fresh fact retains near-full confidence.
// ---------------------------------------------------------------------------
test('T23 -- fresh fact (age=0) has decayed_confidence ≈ original confidence', () => {
  const row = makeRow({ valid_from: new Date().toISOString(), confidence: 0.9 });
  const [out] = applyDecayToFacts([row]);
  // e^(0) = 1.0 so decayed_confidence should be 0.9
  assert.ok(
    Math.abs(out.decayed_confidence - 0.9) < 0.01,
    `Expected ~0.9, got ${out.decayed_confidence}`
  );
});

// ---------------------------------------------------------------------------
// Test 4 -- Fact stored 30 days ago: decayed_confidence ≈ conf * e^(-1).
// ---------------------------------------------------------------------------
test('T23 -- 30-day-old fact decays by e^(-1) using default project halflife', () => {
  const row = makeRow({ valid_from: daysAgoIso(30), confidence: 1.0 });
  const now = new Date();
  const [out] = applyDecayToFacts([row], now);
  const expected = Math.exp(-30 / DECAY_HALFLIFE_DAYS);
  assert.ok(
    Math.abs(out.decayed_confidence - expected) < 0.02,
    `Expected ~${expected.toFixed(4)}, got ${out.decayed_confidence}`
  );
});

// ---------------------------------------------------------------------------
// Test 5 -- Fact stored 90 days ago: decayed_confidence ≈ conf * e^(-3).
// ---------------------------------------------------------------------------
test('T23 -- 90-day-old fact is heavily decayed', () => {
  const row = makeRow({ valid_from: daysAgoIso(90), confidence: 1.0 });
  const now = new Date();
  const [out] = applyDecayToFacts([row], now);
  // e^(-90/30) = e^(-3) ≈ 0.0498
  const expected = Math.exp(-90 / DECAY_HALFLIFE_DAYS);
  assert.ok(
    Math.abs(out.decayed_confidence - expected) < 0.02,
    `Expected ~${expected.toFixed(4)}, got ${out.decayed_confidence}`
  );
  assert.ok(out.decayed_confidence < 0.1, 'Very old fact should have very low decayed_confidence');
});

// ---------------------------------------------------------------------------
// Test 6 -- Session-tier source uses 1-day halflife.
// A fact stored 1 day ago with source containing "session" should decay by e^(-1).
// ---------------------------------------------------------------------------
test('T23 -- session-source fact uses 1-day halflife', () => {
  const row = makeRow({
    valid_from: daysAgoIso(1),
    confidence: 1.0,
    source: 'memory_store:session',
  });
  const now = new Date();
  const [out] = applyDecayToFacts([row], now);
  const expected = Math.exp(-1 / DECAY_HALFLIFE_SESSION_DAYS);
  assert.ok(
    Math.abs(out.decayed_confidence - expected) < 0.02,
    `Expected ~${expected.toFixed(4)}, got ${out.decayed_confidence}`
  );
  // 1-day-old session fact should already be significantly decayed.
  assert.ok(out.decayed_confidence < 0.5, 'Session fact 1 day old should be < 50% confidence');
});

// ---------------------------------------------------------------------------
// Test 7 -- Custom halflife option overrides default.
// ---------------------------------------------------------------------------
test('T23 -- custom halflife option overrides default project halflife', () => {
  const row = makeRow({ valid_from: daysAgoIso(10), confidence: 1.0 });
  const now = new Date();
  const customHalflife = 10;
  const [out] = applyDecayToFacts([row], now, { halflife: customHalflife });
  const expected = Math.exp(-10 / customHalflife); // e^(-1) ≈ 0.368
  assert.ok(
    Math.abs(out.decayed_confidence - expected) < 0.02,
    `Expected ~${expected.toFixed(4)}, got ${out.decayed_confidence}`
  );
});

// ---------------------------------------------------------------------------
// Test 8 -- staleness_days field is populated correctly.
// ---------------------------------------------------------------------------
test('T23 -- staleness_days field reflects age in days', () => {
  const row = makeRow({ valid_from: daysAgoIso(7) });
  const now = new Date();
  const [out] = applyDecayToFacts([row], now);
  // Should be approximately 7 days (within 0.1 day rounding tolerance).
  assert.ok(
    Math.abs(out.staleness_days - 7) < 0.1,
    `Expected ~7, got ${out.staleness_days}`
  );
});

// ---------------------------------------------------------------------------
// Test 9 -- Row without valid_from falls back to created_at epoch.
// ---------------------------------------------------------------------------
test('T23 -- row without valid_from falls back to created_at epoch', () => {
  const sevenDaysAgoMs = Date.now() - 7 * 86400 * 1000;
  // Omit valid_from to test fallback.
  const row = {
    id: 1,
    subject: 'user',
    predicate: 'uses',
    object: 'Node.js',
    confidence: 0.8,
    memory_id: null,
    source: 'memory_store:project',
    valid_from: null,   // missing -- should fall back
    valid_to: null,
    created_at: sevenDaysAgoMs,
  };
  const now = new Date();
  const [out] = applyDecayToFacts([row], now);
  assert.ok(
    Math.abs(out.staleness_days - 7) < 0.2,
    `Expected ~7 days from created_at, got ${out.staleness_days}`
  );
});

// ---------------------------------------------------------------------------
// Test 10 -- Empty array returns empty array.
// ---------------------------------------------------------------------------
test('T23 -- empty array input returns empty array', () => {
  const result = applyDecayToFacts([]);
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// Test 11 -- Original row objects are NOT mutated.
// ---------------------------------------------------------------------------
test('T23 -- applyDecayToFacts does not mutate original row objects', () => {
  const row = makeRow({ valid_from: daysAgoIso(15), confidence: 0.75 });
  const originalKeys = Object.keys(row);
  applyDecayToFacts([row]);
  // Original must not have the new fields.
  assert.equal('decayed_confidence' in row, false, 'Original row must not gain decayed_confidence');
  assert.equal('staleness_days' in row, false, 'Original row must not gain staleness_days');
  assert.deepEqual(Object.keys(row), originalKeys, 'Original row keys must be unchanged');
});

// ---------------------------------------------------------------------------
// Test 12 -- decayed_confidence is clamped to [0, original confidence].
// ---------------------------------------------------------------------------
test('T23 -- decayed_confidence is clamped within [0, original_confidence]', () => {
  // Future-dated fact (clock skew / test weirdness): staleness_days could go
  // negative, but decay should not exceed original confidence.
  const futureRow = makeRow({ valid_from: daysAgoIso(-5), confidence: 0.6 });
  const [out] = applyDecayToFacts([futureRow]);
  assert.ok(
    out.decayed_confidence <= 0.6,
    `decayed_confidence must not exceed original confidence; got ${out.decayed_confidence}`
  );
  assert.ok(
    out.decayed_confidence >= 0,
    `decayed_confidence must not be negative; got ${out.decayed_confidence}`
  );
});

// ---------------------------------------------------------------------------
// Test 13 -- getValidAt + applyDecayToFacts integration pipeline.
// Insert a fresh and an old fact; retrieve via getValidAt; apply decay;
// confirm old fact has lower decayed_confidence than fresh fact.
// ---------------------------------------------------------------------------
test('T23 -- getValidAt + applyDecayToFacts integration: old fact ranks lower than fresh', async () => {
  const db = await openTemporalDb(':memory:');
  try {
    const nowTs = new Date().toISOString();
    const oldTs = daysAgoIso(60);

    insertFact(db, { subject: 'user', predicate: 'uses', object: 'Python', source: 'test' }, oldTs);
    insertFact(db, { subject: 'user', predicate: 'uses', object: 'TypeScript', source: 'test' }, nowTs);

    // Both facts have different objects so they coexist without invalidation.
    const rows = getValidAt(db, nowTs);
    assert.equal(rows.length, 2, 'Both facts should be currently valid');

    const decayed = applyDecayToFacts(rows, new Date());

    const pythonFact = decayed.find(r => r.object === 'Python');
    const tsFact = decayed.find(r => r.object === 'TypeScript');

    assert.ok(pythonFact, 'Python fact must be in results');
    assert.ok(tsFact, 'TypeScript fact must be in results');

    // Old fact (60 days) should have much lower decayed_confidence.
    assert.ok(
      pythonFact.decayed_confidence < tsFact.decayed_confidence,
      `Old fact (${pythonFact.decayed_confidence.toFixed(4)}) must rank below fresh fact (${tsFact.decayed_confidence.toFixed(4)})`
    );
    // Fresh fact should retain near-full confidence.
    assert.ok(
      tsFact.decayed_confidence > 0.9,
      `Fresh fact should have decayed_confidence > 0.9, got ${tsFact.decayed_confidence}`
    );
    // 60-day-old fact with 30-day halflife: e^(-2) ≈ 0.135.
    assert.ok(
      pythonFact.decayed_confidence < 0.2,
      `60-day-old fact with 30-day halflife should be < 0.2, got ${pythonFact.decayed_confidence}`
    );
  } finally {
    db.close();
  }
});
