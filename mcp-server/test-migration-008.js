// IJFW v1.5.0 M4.1 -- migration 008 (write-origin provenance) test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';

test('migration 008 adds origin column to memory_entries', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 8);
  const cols = db
    .prepare('PRAGMA table_info(memory_entries)')
    .all()
    .map((c) => c.name);
  assert.ok(cols.includes('origin'), 'memory_entries.origin column');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
});

test('migration 008 origin column defaults to foreground', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 8);
  // Insert with explicit columns (omitting origin) — default must apply.
  db.prepare(
    'INSERT INTO memory_entries (id, body, created_at) VALUES (?,?,?)',
  ).run(1, 'test body', Date.now());
  const row = db.prepare('SELECT origin FROM memory_entries WHERE id=?').get(1);
  assert.equal(row.origin, 'foreground');
});

test('migration 008 is idempotent (re-run safe)', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 8);
  // Running again with same target version should be a no-op.
  const finalVersion = await runMigrations(db, 8, 8);
  assert.equal(finalVersion, 8);
});

test('migration 008 creates origin index', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 8);
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='memory_entries_origin_idx'")
    .get();
  assert.ok(idx);
});
