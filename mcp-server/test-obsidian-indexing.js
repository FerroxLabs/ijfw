// mcp-server/test-obsidian-indexing.js
// IJFW v1.5.0 M1.1 + M1.3 -- integration tests for migration 006 and indexObsidianRelations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';
import { indexObsidianRelations } from './src/memory/obsidian-parser.js';

// Helper: create a fresh in-memory db with all migrations applied through version 6.
async function freshDb() {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 6);
  return db;
}

test('migration 006 creates obsidian-graph tables', async () => {
  const db = await freshDb();

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

  assert.ok(tables.includes('memory_links'), 'memory_links table missing');
  assert.ok(tables.includes('memory_tags'), 'memory_tags table missing');
  assert.ok(tables.includes('memory_meta'), 'memory_meta table missing');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
});

test('indexObsidianRelations writes links/tags/meta to db', async () => {
  const db = await freshDb();
  indexObsidianRelations(db, 'memA', 'See [[brief]] #project/r17 [author:: Sean].');

  const links = db.prepare('SELECT * FROM memory_links WHERE from_id=?').all('memA');
  assert.equal(links.length, 1);
  assert.equal(links[0].to_target, 'brief');

  const tags = db.prepare('SELECT * FROM memory_tags WHERE memory_id=?').all('memA');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].tag_path, 'project/r17');

  const meta = db.prepare('SELECT * FROM memory_meta WHERE memory_id=?').all('memA');
  assert.equal(meta.length, 1);
  assert.equal(meta[0].key, 'author');
});

test('indexObsidianRelations is idempotent on re-index', async () => {
  const db = await freshDb();
  indexObsidianRelations(db, 'memB', 'See [[brief]] #ship.');
  indexObsidianRelations(db, 'memB', 'See [[brief]] #ship.');
  const c = db.prepare('SELECT COUNT(*) AS c FROM memory_links WHERE from_id=?').get('memB').c;
  assert.equal(c, 1);
});
