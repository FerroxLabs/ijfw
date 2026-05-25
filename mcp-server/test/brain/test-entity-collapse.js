import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { canonicalize, findCandidateMerges } from '../../src/brain/entity-collapse.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT)');
  return db;
}

test('canonicalize: lowercase + collapse + trim', () => {
  assert.equal(canonicalize('Sean Donahoe'), 'sean donahoe');
  assert.equal(canonicalize('  sean   donahoe '), 'sean donahoe');
  assert.equal(canonicalize('SEAN  DONAHOE'), 'sean donahoe');
});

test('canonicalize: null / undefined / number / empty handled', () => {
  assert.equal(canonicalize(null), '');
  assert.equal(canonicalize(undefined), '');
  assert.equal(canonicalize(42), '42');
  assert.equal(canonicalize(''), '');
});

test('findCandidateMerges: returns groups with >1 variant only', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO facts (subject) VALUES (?)');
  for (const s of ['Sean Donahoe', 'sean donahoe', '  Sean  Donahoe ', 'Anthropic', 'IJFW']) ins.run(s);
  const groups = findCandidateMerges(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonical, 'sean donahoe');
  assert.equal(groups[0].variants.length, 3);
});

test('findCandidateMerges: no duplicates -> []', () => {
  const db = freshDb();
  for (const s of ['Alice', 'Bob', 'Carol']) db.prepare('INSERT INTO facts (subject) VALUES (?)').run(s);
  assert.deepEqual(findCandidateMerges(db), []);
});

test('findCandidateMerges: identical strings dedup at DISTINCT; nulls ignored', () => {
  const db = freshDb();
  db.prepare('INSERT INTO facts (subject) VALUES (NULL), (NULL), (?), (?)').run('A', 'A');
  assert.deepEqual(findCandidateMerges(db), []);
});
