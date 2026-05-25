import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { parseCitations, resolveCitations } from '../../src/brain/citation-resolver.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, body TEXT);
    CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT);
  `);
  return db;
}

test('parseCitations: extracts [mem:N] and [fact:N] in order', () => {
  const md = 'See [mem:1] and [fact:42]. Also [mem:7].';
  assert.deepEqual(parseCitations(md), [
    { kind: 'mem', id: 1 }, { kind: 'fact', id: 42 }, { kind: 'mem', id: 7 },
  ]);
});

test('parseCitations: ignores malformed tokens', () => {
  const md = '[mem:abc] not a cite, [mem :1] not a cite, [memo:1] not a cite, [mem:1] IS a cite.';
  assert.deepEqual(parseCitations(md), [{ kind: 'mem', id: 1 }]);
});

test('parseCitations: empty input returns []', () => {
  assert.deepEqual(parseCitations(''), []);
  assert.deepEqual(parseCitations(null), []);
});

test('resolveCitations: all present -> ok:true, empty unresolved', () => {
  const db = freshDb();
  db.prepare('INSERT INTO memory_entries(id, body) VALUES (1, ?), (7, ?)').run('a', 'b');
  db.prepare('INSERT INTO facts(id, subject) VALUES (42, ?)').run('x');
  const r = resolveCitations(db, 'cites: [mem:1] [fact:42] [mem:7]');
  assert.equal(r.ok, true);
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.cites.length, 3);
});

test('resolveCitations: missing id -> ok:false, unresolved lists it', () => {
  const db = freshDb();
  db.prepare('INSERT INTO memory_entries(id, body) VALUES (1, ?)').run('a');
  const r = resolveCitations(db, 'see [mem:1] and [mem:999] and [fact:5]');
  assert.equal(r.ok, false);
  assert.equal(r.unresolved.length, 2);
  const ids = r.unresolved.map((c) => `${c.kind}:${c.id}`).sort();
  assert.deepEqual(ids, ['fact:5', 'mem:999']);
});

test('resolveCitations: no citations -> ok:true', () => {
  const db = freshDb();
  const r = resolveCitations(db, 'no cites here.');
  assert.equal(r.ok, true);
});
