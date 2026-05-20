// IJFW v1.5.0 M1.4 -- tests for the Dataview-grade declarative query.
//
// Schema note: migration 001 creates memory_entries(id INTEGER PK, body,
// source, session_id, created_at). No title column. memory_links/_tags/_meta
// (migration 006) store TEXT memory_id; SQLite coerces across the integer
// boundary at JOIN time (permissive without strict FKs). Tests insert with
// explicit numeric ids and pass them as strings to indexObsidianRelations
// — the same shape the production write path uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';
import { indexObsidianRelations } from './src/memory/obsidian-parser.js';
import { parseDataviewQuery, runDataviewQuery } from './src/memory/query-dataview.js';

async function seed() {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 6);
  // memory_entries was created by migration 001; just insert.
  const ins = db.prepare(
    'INSERT INTO memory_entries (id, body, source, created_at) VALUES (?,?,?,?)',
  );
  ins.run(1, 'Tagged #project/r17 [author:: Sean] linked [[plan]]', 'brief',  1700000000);
  ins.run(2, 'Tagged #project/r17/audit [author:: Sean]',           'plan',   1700100000);
  ins.run(3, 'Tagged #ship',                                        'other',  1700200000);
  for (const id of [1, 2, 3]) {
    const row = db.prepare('SELECT body FROM memory_entries WHERE id=?').get(id);
    indexObsidianRelations(db, String(id), row.body);
  }
  return db;
}

test('parses tag filter', () => {
  const q = parseDataviewQuery('tag = #project/r17');
  assert.deepEqual(q, { tag: 'project/r17', filters: [] });
});

test('parses linked_to filter', () => {
  const q = parseDataviewQuery('linked_to = "plan"');
  assert.deepEqual(q, { filters: [{ field: 'linked_to', op: '=', value: 'plan' }] });
});

test('parses created_after filter', () => {
  const q = parseDataviewQuery('created_after = 1700050000');
  assert.deepEqual(q, {
    filters: [{ field: 'created_after', op: '=', value: 1700050000 }],
  });
});

test('parses created_before filter', () => {
  const q = parseDataviewQuery('created_before = 1700150000');
  assert.deepEqual(q, {
    filters: [{ field: 'created_before', op: '=', value: 1700150000 }],
  });
});

test('parses multiple AND clauses', () => {
  const q = parseDataviewQuery('tag = #ship and created_after = 1700000000');
  assert.equal(q.tag, 'ship');
  assert.deepEqual(q.filters, [{ field: 'created_after', op: '=', value: 1700000000 }]);
});

test('runs tag query — nested prefix matches descendants', async () => {
  const db = await seed();
  const out = runDataviewQuery(db, parseDataviewQuery('tag = #project/r17'));
  const ids = out.rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [1, 2]);
});

test('runs linked_to query', async () => {
  const db = await seed();
  const out = runDataviewQuery(db, parseDataviewQuery('linked_to = "plan"'));
  assert.deepEqual(out.rows.map((r) => r.id), [1]);
});

test('runs created_after query', async () => {
  const db = await seed();
  const out = runDataviewQuery(db, parseDataviewQuery('created_after = 1700050000'));
  assert.deepEqual(out.rows.map((r) => r.id).sort(), [2, 3]);
});

test('runs combined tag + created_before', async () => {
  const db = await seed();
  const out = runDataviewQuery(
    db,
    parseDataviewQuery('tag = #project/r17 and created_before = 1700050000'),
  );
  assert.deepEqual(out.rows.map((r) => r.id), [1]);
});

test('unrecognised clause silently surfaces in parsed.filters', () => {
  const q = parseDataviewQuery('bogus_field = "x"');
  assert.equal(q.filters.length, 1);
  assert.equal(q.filters[0].field, '__unrecognised');
});
