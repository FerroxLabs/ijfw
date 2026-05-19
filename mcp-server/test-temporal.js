/**
 * test-temporal.js -- v1.5.0 audit H5.4: bi-temporal fact validity.
 *
 * Covers the wave-N2 spec test plan:
 *   1. Insert fact (user, role, data_scientist) at t0 -> valid_to NULL
 *   2. Insert fact (user, role, ML_engineer) at t1 -> t0 fact gets valid_to=t1;
 *      t1 fact valid_to NULL
 *   3. getValidAt(t0+1ms) returns only data_scientist
 *   4. getValidAt(t1+1ms) returns only ML_engineer
 *   5. getHistory(user, role) returns both in order
 *   6. Inserting the SAME object again at t2 (another user/role/ML_engineer)
 *      does NOT invalidate the t1 fact -- no-op.
 *
 * Plus invariants:
 *   - Different (subject, predicate) facts don't get invalidated by an
 *     unrelated update.
 *   - Same (subject, predicate) but different object across THREE points in
 *     time chains correctly (t0 -> t1 -> t2).
 *
 * Tests use a :memory: SQLite handle via openTemporalDb(":memory:") so they
 * run in <100ms with no filesystem state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  openTemporalDb,
  invalidateOlderFacts,
  insertFact,
  storeFactBitemporal,
  getValidAt,
  getHistory,
  getAllFactsWithWindows,
} from './src/memory/temporal.js';

// Helper: build an ISO-8601 timestamp from a millisecond epoch.
function iso(ms) {
  return new Date(ms).toISOString();
}

// Each test gets a fresh in-memory db so state never leaks between cases.
async function freshDb() {
  return await openTemporalDb(':memory:');
}

// ---------------------------------------------------------------------------
// Core spec scenarios
// ---------------------------------------------------------------------------

test('temporal: insert (user, role, data_scientist) at t0 -> valid_to NULL', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_000_000_000_000); // 2001-09-09T01:46:40.000Z
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);

    const rows = db.prepare('SELECT subject, predicate, object, valid_from, valid_to FROM facts').all();
    assert.equal(rows.length, 1, 'expected one fact row');
    assert.equal(rows[0].object, 'data_scientist');
    assert.equal(rows[0].valid_from, t0);
    assert.equal(rows[0].valid_to, null, 'valid_to should be NULL for current fact');
  } finally {
    db.close();
  }
});

test('temporal: contradicting fact closes prior valid_to and inserts new', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    const r = storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);

    assert.equal(r.invalidated, 1, 'should have invalidated one prior fact');
    assert.equal(r.deduped, false);

    const rows = db.prepare(
      'SELECT object, valid_from, valid_to FROM facts ORDER BY valid_from'
    ).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].object, 'data_scientist');
    assert.equal(rows[0].valid_from, t0);
    assert.equal(rows[0].valid_to, t1, 'prior fact valid_to should be set to t1');

    assert.equal(rows[1].object, 'ML_engineer');
    assert.equal(rows[1].valid_from, t1);
    assert.equal(rows[1].valid_to, null, 't1 fact should be currently valid');
  } finally {
    db.close();
  }
});

test('temporal: getValidAt(t0+1ms) returns only data_scientist', async () => {
  const db = await freshDb();
  try {
    const t0ms = 1_700_000_000_000;
    const t1ms = 1_700_000_001_000;
    const t0 = iso(t0ms);
    const t1 = iso(t1ms);
    const tQuery = iso(t0ms + 1);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);

    const valid = getValidAt(db, tQuery);
    assert.equal(valid.length, 1, 'only one fact valid at t0+1ms');
    assert.equal(valid[0].object, 'data_scientist');
  } finally {
    db.close();
  }
});

test('temporal: getValidAt(t1+1ms) returns only ML_engineer', async () => {
  const db = await freshDb();
  try {
    const t0ms = 1_700_000_000_000;
    const t1ms = 1_700_000_001_000;
    const t0 = iso(t0ms);
    const t1 = iso(t1ms);
    const tQuery = iso(t1ms + 1);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);

    const valid = getValidAt(db, tQuery);
    assert.equal(valid.length, 1, 'only one fact valid at t1+1ms');
    assert.equal(valid[0].object, 'ML_engineer');
  } finally {
    db.close();
  }
});

test('temporal: getHistory(user, role) returns both facts in valid_from order', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);

    const hist = getHistory(db, 'user', 'role');
    assert.equal(hist.length, 2);
    assert.equal(hist[0].object, 'data_scientist');
    assert.equal(hist[0].valid_from, t0);
    assert.equal(hist[0].valid_to, t1);
    assert.equal(hist[1].object, 'ML_engineer');
    assert.equal(hist[1].valid_from, t1);
    assert.equal(hist[1].valid_to, null);
  } finally {
    db.close();
  }
});

test('temporal: inserting same object at t2 is a no-op (no new row, no invalidation)', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);
    const t2 = iso(1_700_000_002_000);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);

    // Snapshot pre-t2 state.
    const beforeRows = db.prepare(
      'SELECT id, object, valid_from, valid_to FROM facts ORDER BY id'
    ).all();
    assert.equal(beforeRows.length, 2);

    // Re-store same (user, role, ML_engineer) at t2.
    const r = storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t2);
    assert.equal(r.deduped, true, 'same-object store must be deduped');
    assert.equal(r.invalidated, 0);

    // Row count unchanged, t1 fact still valid (valid_to NULL).
    const afterRows = db.prepare(
      'SELECT id, object, valid_from, valid_to FROM facts ORDER BY id'
    ).all();
    assert.equal(afterRows.length, 2, 'no new row inserted on same-object store');
    const t1Row = afterRows.find(r => r.object === 'ML_engineer');
    assert.equal(t1Row.valid_to, null, 't1 fact still currently valid');
    assert.equal(t1Row.valid_from, t1, 'valid_from unchanged (no row swap)');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Invariants beyond the bullet-list spec
// ---------------------------------------------------------------------------

test('temporal: unrelated (subject, predicate) is not invalidated by an update', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'location', object: 'NYC' }, t0);

    // Contradict only `role`.
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);

    const loc = db.prepare(
      "SELECT valid_to FROM facts WHERE predicate = 'location'"
    ).get();
    assert.equal(loc.valid_to, null, 'unrelated predicate must still be currently valid');
  } finally {
    db.close();
  }
});

test('temporal: three-step chain t0 -> t1 -> t2 closes each prior in order', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);
    const t2 = iso(1_700_000_002_000);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'data_scientist' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'ML_engineer' }, t1);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'staff_eng' }, t2);

    const hist = getHistory(db, 'user', 'role');
    assert.equal(hist.length, 3);
    assert.equal(hist[0].object, 'data_scientist');
    assert.equal(hist[0].valid_to, t1);
    assert.equal(hist[1].object, 'ML_engineer');
    assert.equal(hist[1].valid_to, t2);
    assert.equal(hist[2].object, 'staff_eng');
    assert.equal(hist[2].valid_to, null);

    // Only the staff_eng row is currently valid.
    const valid = getValidAt(db, iso(1_700_000_002_500));
    assert.equal(valid.length, 1);
    assert.equal(valid[0].object, 'staff_eng');
  } finally {
    db.close();
  }
});

test('temporal: invalidateOlderFacts without insert leaves no current valid row', async () => {
  // Edge case: direct use of the low-level invalidate primitive (no insert).
  // Spec lists this as a primitive of its own; assert it can run standalone.
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);

    insertFact(db, { subject: 'project', predicate: 'lead', object: 'alice' }, t0);
    const n = invalidateOlderFacts(db, {
      subject: 'project', predicate: 'lead', object: 'bob',
    }, t1);
    assert.equal(n, 1);

    // Nothing valid now (we invalidated but didn't insert the replacement).
    const valid = getValidAt(db, iso(1_700_000_001_500));
    assert.equal(valid.length, 0);
  } finally {
    db.close();
  }
});

test('temporal: getAllFactsWithWindows returns deterministic ordered list', async () => {
  const db = await freshDb();
  try {
    const t0 = iso(1_700_000_000_000);
    const t1 = iso(1_700_000_001_000);

    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'A' }, t0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'B' }, t1);
    storeFactBitemporal(db, { subject: 'user', predicate: 'location', object: 'NYC' }, t0);

    const all = getAllFactsWithWindows(db);
    assert.equal(all.length, 3);
    // Order: subject ASC, predicate ASC, valid_from ASC
    assert.equal(all[0].predicate, 'location');
    assert.equal(all[1].predicate, 'role');
    assert.equal(all[1].object, 'A');
    assert.equal(all[2].predicate, 'role');
    assert.equal(all[2].object, 'B');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('temporal: rejects malformed inputs cleanly', async () => {
  const db = await freshDb();
  try {
    assert.throws(() => invalidateOlderFacts(null, { subject: 'a', predicate: 'b', object: 'c' }, iso(0)));
    assert.throws(() => invalidateOlderFacts(db, null, iso(0)));
    assert.throws(() => invalidateOlderFacts(db, { subject: '', predicate: 'b', object: 'c' }, iso(0)));
    assert.throws(() => insertFact(db, { subject: 'a', predicate: '', object: 'c' }, iso(0)));
    assert.throws(() => getHistory(db, '', 'role'));
    assert.throws(() => getValidAt(null, iso(0)));
    // ts must be ISO-8601 string or Date.
    assert.throws(() => getValidAt(db, 'yesterday'));
  } finally {
    db.close();
  }
});

test('temporal: accepts Date instances as ts', async () => {
  const db = await freshDb();
  try {
    const d0 = new Date(1_700_000_000_000);
    const d1 = new Date(1_700_000_001_000);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'A' }, d0);
    storeFactBitemporal(db, { subject: 'user', predicate: 'role', object: 'B' }, d1);
    const valid = getValidAt(db, new Date(1_700_000_001_500));
    assert.equal(valid.length, 1);
    assert.equal(valid[0].object, 'B');
  } finally {
    db.close();
  }
});
