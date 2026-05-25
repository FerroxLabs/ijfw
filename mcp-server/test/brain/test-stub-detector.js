import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStubs } from '../../src/brain/stub-detector.js';

function freshDb() {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE memory_links (id INTEGER PRIMARY KEY, memory_id INTEGER, to_target TEXT)').run();
  return db;
}
function freshRoot() { return mkdtempSync(join(tmpdir(), 'brain-stub-')); }

test('detectStubs: surfaces target with 5 incoming + no page', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO memory_links (memory_id, to_target) VALUES (?, ?)');
  for (let i = 0; i < 5; i++) ins.run(i, 'missing-page');
  const root = freshRoot();
  try {
    mkdirSync(join(root, 'ijfw', 'wiki', 'concepts'), { recursive: true });
    const stubs = detectStubs(db, root, { minIncomingLinks: 3 });
    assert.equal(stubs.length, 1);
    assert.equal(stubs[0].target, 'missing-page');
    assert.equal(stubs[0].incomingLinks, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectStubs: existing pages filtered out', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO memory_links (memory_id, to_target) VALUES (?, ?)');
  for (let i = 0; i < 4; i++) ins.run(i, 'exists');
  const root = freshRoot();
  try {
    mkdirSync(join(root, 'ijfw', 'wiki', 'entities'), { recursive: true });
    writeFileSync(join(root, 'ijfw', 'wiki', 'entities', 'exists.md'), '# exists\n');
    assert.deepEqual(detectStubs(db, root, { minIncomingLinks: 3 }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectStubs: below threshold not surfaced', () => {
  const db = freshDb();
  db.prepare('INSERT INTO memory_links (memory_id, to_target) VALUES (1, ?), (2, ?)').run('twice', 'twice');
  const root = freshRoot();
  try { assert.deepEqual(detectStubs(db, root, { minIncomingLinks: 3 }), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectStubs: legacy .ijfw/ page also blocks stub', () => {
  const db = freshDb();
  const ins = db.prepare('INSERT INTO memory_links (memory_id, to_target) VALUES (?, ?)');
  for (let i = 0; i < 5; i++) ins.run(i, 'legacy');
  const root = freshRoot();
  try {
    mkdirSync(join(root, '.ijfw', 'wiki', 'milestones'), { recursive: true });
    writeFileSync(join(root, '.ijfw', 'wiki', 'milestones', 'legacy.md'), '# legacy\n');
    assert.deepEqual(detectStubs(db, root, { minIncomingLinks: 3 }), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectStubs: empty / null targets ignored', () => {
  const db = freshDb();
  db.prepare('INSERT INTO memory_links (memory_id, to_target) VALUES (1, NULL), (2, NULL), (3, NULL), (4, ?)').run('');
  const root = freshRoot();
  try { assert.deepEqual(detectStubs(db, root, { minIncomingLinks: 1 }), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
