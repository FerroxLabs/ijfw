import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getHistoryWindow } from '../../src/memory/temporal.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      subject TEXT, predicate TEXT, object TEXT,
      valid_from TEXT, valid_to TEXT,
      memory_id INTEGER, source TEXT, confidence REAL
    );
  `);
  return db;
}

function seedFacts(db, n, subject = 'sean', predicate = 'role') {
  const ins = db.prepare(
    'INSERT INTO facts (subject, predicate, object, valid_from, valid_to, memory_id, source, confidence) VALUES (?,?,?,?,?,?,?,?)'
  );
  for (let i = 0; i < n; i++) {
    // valid_from ascending so DESC ordering puts highest i first
    const iso = new Date(Date.UTC(2024, 0, 1 + i)).toISOString();
    ins.run(subject, predicate, `value-${i}`, iso, null, i + 1, 'test', 0.9);
  }
}

test('getHistoryWindow: returns all rows DESC when count <= limit', () => {
  const db = freshDb();
  seedFacts(db, 5);
  const { rows, older } = getHistoryWindow(db, 'sean', 'role', { limit: 50 });
  assert.equal(rows.length, 5);
  // newest first (object = 'value-4' inserted last)
  assert.equal(rows[0].object, 'value-4');
  assert.equal(rows[4].object, 'value-0');
  assert.equal(older, null);
});

test('getHistoryWindow: caps to limit and rolls up older', () => {
  const db = freshDb();
  seedFacts(db, 75);
  const { rows, older } = getHistoryWindow(db, 'sean', 'role', { limit: 20 });
  assert.equal(rows.length, 20);
  assert.equal(rows[0].object, 'value-74');
  // older.count should be 75 - 20 = 55
  assert.ok(older !== null);
  assert.equal(older.count, 55);
  assert.ok(older.fromIso < older.toIso);
});

test('getHistoryWindow: predicate=null returns all predicates for subject', () => {
  const db = freshDb();
  seedFacts(db, 3, 'sean', 'role');
  seedFacts(db, 2, 'sean', 'works-at');
  const { rows } = getHistoryWindow(db, 'sean', null, { limit: 50 });
  assert.equal(rows.length, 5);
});

test('getHistoryWindow: since filter applies', () => {
  const db = freshDb();
  seedFacts(db, 10);
  const cutoff = new Date(Date.UTC(2024, 0, 6)).toISOString();
  const { rows } = getHistoryWindow(db, 'sean', 'role', { limit: 50, since: cutoff });
  // values inserted on day-5 (i=5) and later have valid_from >= cutoff
  // day-5 valid_from = Jan 6 -- equal-to is >=. So 5..9 = 5 rows.
  assert.equal(rows.length, 5);
});

test('getHistoryWindow: rollupOlder=false returns no rollup even at limit', () => {
  const db = freshDb();
  seedFacts(db, 75);
  const { rows, older } = getHistoryWindow(db, 'sean', 'role', { limit: 20, rollupOlder: false });
  assert.equal(rows.length, 20);
  assert.equal(older, null);
});

test('getHistoryWindow: no rows for unknown subject -> empty', () => {
  const db = freshDb();
  seedFacts(db, 5);
  const { rows, older } = getHistoryWindow(db, 'nobody', null);
  assert.equal(rows.length, 0);
  assert.equal(older, null);
});
