import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileWikiPage, slugify } from '../../src/brain/wiki-compiler.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'brain-compiler-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  writeLayoutVersion(r, 2); // use visible ijfw/ layout
  return r;
}

function freshDb() {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, body TEXT, path TEXT, kind TEXT)').run();
  db.prepare('CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)').run();
  db.prepare('CREATE TABLE memory_links (id INTEGER PRIMARY KEY, memory_id INTEGER, to_target TEXT)').run();
  return db;
}

test('slugify: lowercases + non-alphanum -> dash + trims', () => {
  assert.equal(slugify('Sean Donahoe'), 'sean-donahoe');
  assert.equal(slugify('  IJFW Brain v1.5.2  '), 'ijfw-brain-v1-5-2');
  assert.equal(slugify(''), 'untitled');
  assert.equal(slugify(null), 'untitled');
});

test('compileWikiPage: happy path writes page atomically with cites resolved', async () => {
  const db = freshDb();
  db.prepare('INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)').run(5, 'sean is founder', '/notes/a.md', 'markdown');
  db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)').run(11, 'sean', 'role', 'founder', '2024-01-01T00:00:00Z', 5);
  const root = freshRoot();
  try {
    const result = await compileWikiPage(db, { repoRoot: root, type: 'entity', subject: 'sean' });
    assert.equal(result.ok, true);
    assert.equal(result.factsCount, 1);
    const pagePath = join(root, 'ijfw', 'wiki', 'entities', 'sean.md');
    assert.equal(result.pagePath, pagePath);
    assert.ok(existsSync(pagePath));
    const content = readFileSync(pagePath, 'utf8');
    assert.ok(content.includes('[fact:11]'));
    assert.ok(content.includes('[mem:5]'));
    assert.ok(content.includes('section="current-state"'));
    assert.ok(content.includes('section="history"'));
    // no leftover .tmp
    assert.equal(existsSync(pagePath + '.tmp'), false);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('compileWikiPage: rejects when citation unresolved (no file written)', async () => {
  const db = freshDb();
  // Insert fact 11 but DO NOT insert the linked memory id 99 -> [mem:99] dangles
  db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)').run(11, 'ghost', 'role', 'x', '2024-01-01T00:00:00Z', 99);
  const root = freshRoot();
  try {
    const result = await compileWikiPage(db, { repoRoot: root, type: 'entity', subject: 'ghost' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unresolved-citations');
    assert.ok(result.unresolved.length > 0);
    // page NOT written
    assert.equal(existsSync(join(root, 'ijfw', 'wiki', 'entities', 'ghost.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('compileWikiPage: preserves NOTES outside auto regions', async () => {
  const db = freshDb();
  db.prepare('INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)').run(5, 'x', '/p.md', 'markdown');
  db.prepare('INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)').run(11, 'alice', 'role', 'r', '2024-01-01T00:00:00Z', 5);
  const root = freshRoot();
  try {
    const pageDir = join(root, 'ijfw', 'wiki', 'entities');
    mkdirSync(pageDir, { recursive: true });
    const pagePath = join(pageDir, 'alice.md');
    writeFileSync(pagePath, '# alice\n\n## Operator notes\nhand-written context [important].\n');
    const result = await compileWikiPage(db, { repoRoot: root, type: 'entity', subject: 'alice' });
    assert.equal(result.ok, true);
    const content = readFileSync(pagePath, 'utf8');
    assert.ok(content.includes('hand-written context [important]'), 'NOTES preserved');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('compileWikiPage: missing subject -> ok:false', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    const result = await compileWikiPage(db, { repoRoot: root, type: 'entity' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing-subject');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});
