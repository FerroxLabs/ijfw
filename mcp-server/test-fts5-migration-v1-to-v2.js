#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- migration v1 -> v2 smoke test (C9.4 + C9.6).
//
// Simulates an existing v1 db that already has data, then exercises the
// recreate-with-data migration path:
//
//   1. Apply only migration 001 to a fresh db (PRAGMA user_version=1).
//   2. Insert 25 rows with morphological variants ("authenticate" /
//      "authenticating" / "ran" / "running") via the v1 schema.
//   3. Hand-bump highestKnownVersion to 2 by reopening through the public
//      API (which now sees both migrations on disk and applies 002).
//   4. Assert every row survived + raw.source column was added + porter
//      tokenizer is now in effect (queries collapse stems).
//
// Run: node mcp-server/test-fts5-migration-v1-to-v2.js

import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import { openDb, safeWrite, search, closeDb, dbPathFor } from './src/compute/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-mig-v1v2-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 migration v1 -> v2 -- project root: ${projectRoot}`);

let db;
try {
  // Step 1: open a fresh db at v1 by hand-applying just the v1 schema.
  // We do this directly with better-sqlite3 to bypass the migration runner.
  const Database = (await import('better-sqlite3')).default;
  const dbPath = dbPathFor(projectRoot);
  const fs = await import('fs');
  fs.mkdirSync(dirname(dbPath), { recursive: true });
  const handDb = new Database(dbPath);
  handDb.exec('PRAGMA journal_mode = WAL');
  // Apply v1 schema literally (simulate a db that was opened pre-C9.4/6).
  // We rebuild the v1 DDL inline so this test is independent of the
  // current schema.sql file (which now ships v2).
  handDb.exec(`
    CREATE TABLE IF NOT EXISTS raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      brief_id TEXT,
      session_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      profile TEXT,
      event_type TEXT,
      halt_status TEXT,
      raw_output_pointer TEXT,
      body TEXT NOT NULL,
      ts INTEGER NOT NULL,
      CHECK (halt_status IN ('GREEN','YELLOW','RED') OR halt_status IS NULL)
    );
    CREATE INDEX IF NOT EXISTS raw_session_idx ON raw(session_id, ts);
    CREATE INDEX IF NOT EXISTS raw_brief_idx ON raw(brief_id) WHERE brief_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS raw_kind_idx ON raw(source_kind);
    CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(body, content='raw', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS raw_ai AFTER INSERT ON raw BEGIN
      INSERT INTO raw_fts(rowid, body) VALUES (new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS raw_ad AFTER DELETE ON raw BEGIN
      INSERT INTO raw_fts(raw_fts, rowid, body) VALUES('delete', old.id, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS raw_au AFTER UPDATE ON raw BEGIN
      INSERT INTO raw_fts(raw_fts, rowid, body) VALUES('delete', old.id, old.body);
      INSERT INTO raw_fts(rowid, body) VALUES (new.id, new.body);
    END;
    CREATE TABLE IF NOT EXISTS compiled (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      source_raw_ids TEXT NOT NULL,
      cross_links TEXT,
      ts INTEGER NOT NULL,
      schema_v INTEGER NOT NULL DEFAULT 1
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS compiled_fts USING fts5(topic, body, content='compiled', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS compiled_ai AFTER INSERT ON compiled BEGIN
      INSERT INTO compiled_fts(rowid, topic, body) VALUES (new.id, new.topic, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS compiled_ad AFTER DELETE ON compiled BEGIN
      INSERT INTO compiled_fts(compiled_fts, rowid, topic, body) VALUES('delete', old.id, old.topic, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS compiled_au AFTER UPDATE ON compiled BEGIN
      INSERT INTO compiled_fts(compiled_fts, rowid, topic, body) VALUES('delete', old.id, old.topic, old.body);
      INSERT INTO compiled_fts(rowid, topic, body) VALUES (new.id, new.topic, new.body);
    END;
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    );
    PRAGMA user_version = 1;
    INSERT OR IGNORE INTO schema_meta(version, applied_at, description)
      VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000, 'alpha v1.3.0');
  `);

  // Step 2: insert v1 rows with morphological variants.
  const insertStmt = handDb.prepare(
    `INSERT INTO raw (source_kind, session_id, project_root, event_type, body, ts) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const NOW = Date.now();
  const variants = [
    'service must authenticate every caller before issuing tokens',
    'middleware is currently authenticating the request',
    'authentication failed three times in a row',
    'configure the proxy with the new upstream pool',
    'configured the proxy with three retries',
    'configuring the proxy now requires a restart',
    'multiple queries arrived from the analytics dashboard',
    'each query touches the same partition',
    'background workers are running smoothly',
    'cache invalidation handler triggered twice',
  ];
  for (let i = 0; i < variants.length; i++) {
    insertStmt.run('compute_output', 'mig-test', projectRoot, 'output', variants[i], NOW + i);
  }
  // Verify v1 row count + tokenizer.
  const v1Count = handDb.prepare('SELECT COUNT(*) AS c FROM raw').get();
  if (v1Count.c === variants.length) ok(`v1 db populated with ${variants.length} rows`);
  else bad('v1 db populated', `got ${v1Count.c}`);

  const v1FtsDdl = handDb.prepare("SELECT sql FROM sqlite_master WHERE name='raw_fts'").get();
  if (v1FtsDdl && !/porter/i.test(v1FtsDdl.sql)) ok('v1 raw_fts uses default tokenizer (no porter)');
  else bad('v1 raw_fts uses default tokenizer', JSON.stringify(v1FtsDdl));
  if (v1FtsDdl && /CREATE VIRTUAL TABLE/i.test(v1FtsDdl.sql)) ok('v1 raw_fts is a CREATE VIRTUAL TABLE statement');
  handDb.close();

  // Step 3: reopen via the public API -- migration runner will apply 002.
  db = await openDb(projectRoot);

  const uv = db.prepare('PRAGMA user_version').get();
  const uvN = Number(uv.user_version ?? uv.USER_VERSION ?? 0);
  if (uvN === 2) ok(`PRAGMA user_version is 2 after reopen (was 1)`);
  else bad('PRAGMA user_version is 2 after reopen', `got ${uvN}`);

  // Step 4: assertions.
  const v2Count = db.prepare('SELECT COUNT(*) AS c FROM raw').get();
  if (v2Count.c === variants.length) ok(`all ${variants.length} rows survived migration`);
  else bad('all rows survived migration', `got ${v2Count.c}`);

  const cols = db.prepare("PRAGMA table_info(raw)").all().map(r => r.name);
  if (cols.includes('source')) ok('raw.source column added by migration');
  else bad('raw.source column added by migration', `cols=${cols.join(',')}`);

  const v2FtsDdl = db.prepare("SELECT sql FROM sqlite_master WHERE name='raw_fts'").get();
  if (v2FtsDdl && /porter/i.test(v2FtsDdl.sql)) ok('raw_fts now uses porter tokenizer');
  else bad('raw_fts now uses porter tokenizer', JSON.stringify(v2FtsDdl));

  // Verify FTS5 was rebuilt -- query the rebuilt index for migrated rows.
  const rebuiltHits = search(db, 'raw', 'authentication', 10);
  if (rebuiltHits.length >= 3) ok(`FTS5 rebuilt: porter "authentication" matches ${rebuiltHits.length} stems (>= 3)`);
  else bad('FTS5 rebuilt + porter collapses authentication stems', `got ${rebuiltHits.length}`);

  // Insert a fresh row with source set; round-trip via search.
  safeWrite(db, 'raw', {
    source_kind: 'compute_output',
    source: 'src/migrated.js:99',
    session_id: 'mig-test-2',
    project_root: projectRoot,
    event_type: 'output',
    body: 'fresh row inserted post-migration with provenance pointer',
    ts: NOW + 1000,
  });
  const fresh = search(db, 'raw', 'provenance', 5);
  if (fresh.length === 1 && fresh[0].source === 'src/migrated.js:99') ok('post-migration insert + search carries source');
  else bad('post-migration insert + search carries source', JSON.stringify(fresh).slice(0, 240));

  // Round-trip a stem on a legacy row to confirm migration's FTS5 rebuild
  // populated against the existing rows.
  const stemHits = search(db, 'raw', 'configure', 10);
  if (stemHits.length >= 3) ok(`legacy rows reachable via porter stem: configure -> ${stemHits.length} hits`);
  else bad('legacy rows reachable via porter stem', `got ${stemHits.length}`);

} catch (err) {
  bad('v1->v2 migration test threw', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 migration v1 -> v2: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
