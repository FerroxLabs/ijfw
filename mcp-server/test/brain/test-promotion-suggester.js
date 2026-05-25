import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestPromotions } from '../../src/brain/promotion-suggester.js';

function freshProjectDb(dir, name, facts) {
  const path = join(dir, `${name}.db`);
  const db = new Database(path);
  db.prepare('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT)').run();
  const ins = db.prepare('INSERT INTO facts (subject, predicate, object, valid_to) VALUES (?, ?, ?, NULL)');
  for (const [s, p, o] of facts) ins.run(s, p, o);
  db.close();
  return { name, dbPath: path };
}

test('suggestPromotions: empty input -> []', () => {
  assert.deepEqual(suggestPromotions({ projectDbs: [] }), []);
});

test('suggestPromotions: fact in 3 of 4 projects -> surfaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-promo-'));
  try {
    const shared = ['sean', 'works-at', 'foundry'];
    const dbs = [
      freshProjectDb(dir, 'a', [shared, ['a-only', 'r', 'x']]),
      freshProjectDb(dir, 'b', [shared, ['b-only', 'r', 'x']]),
      freshProjectDb(dir, 'c', [shared, ['c-only', 'r', 'x']]),
      freshProjectDb(dir, 'd', [['d-only', 'r', 'x']]),
    ];
    const out = suggestPromotions({ projectDbs: dbs, minProjects: 3 });
    assert.equal(out.length, 1);
    assert.deepEqual({ s: out[0].subject, p: out[0].predicate, o: out[0].object }, { s: 'sean', p: 'works-at', o: 'foundry' });
    assert.deepEqual(out[0].projects, ['a', 'b', 'c']);
    assert.equal(out[0].confidence, 'medium');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suggestPromotions: fact in 5 projects -> confidence high', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-promo-'));
  try {
    const shared = ['t', 'p', 'v'];
    const dbs = ['a','b','c','d','e'].map((n) => freshProjectDb(dir, n, [shared]));
    const out = suggestPromotions({ projectDbs: dbs, minProjects: 3 });
    assert.equal(out.length, 1);
    assert.equal(out[0].confidence, 'high');
    assert.equal(out[0].projects.length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suggestPromotions: missing dbs skipped silently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-promo-'));
  try {
    const real = freshProjectDb(dir, 'a', [['x', 'y', 'z'], ['x', 'y', 'z']]);
    const ghost = { name: 'ghost', dbPath: join(dir, 'no-such.db') };
    const out = suggestPromotions({ projectDbs: [real, ghost], minProjects: 1 });
    assert.equal(out.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('suggestPromotions: superseded facts (valid_to NOT NULL) excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-promo-'));
  try {
    const path = join(dir, 'closed.db');
    const db = new Database(path);
    db.prepare('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_to TEXT)').run();
    db.prepare('INSERT INTO facts (subject, predicate, object, valid_to) VALUES (?,?,?,?)').run('a','b','c','2024-01-01');
    db.close();
    const out = suggestPromotions({ projectDbs: [{ name: 'a', dbPath: path }], minProjects: 1 });
    assert.deepEqual(out, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
