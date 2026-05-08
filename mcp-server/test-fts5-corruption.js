#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- FTS5 corruption-detection test.
//
// 1. Open db, write good rows -- safeWrite's quick_check returns 'ok'.
// 2. Close db, scribble garbage over an interior page of the file.
// 3. Reopen and try another safeWrite. Expect IntegrityError because
//    PRAGMA quick_check now returns a non-'ok' diagnostic.
//
// Page-1 (the SQLite header) is fragile; corrupting it makes the file
// unreadable and the open itself fails before quick_check can run. We
// target a later page so the db opens but quick_check catches the damage.
//
// Run: node mcp-server/test-fts5-corruption.js

import { mkdtempSync, rmSync, openSync, closeSync, writeSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  openDb, safeWrite, closeDb, dbPathFor, IntegrityError, ComputeDbError,
} from './src/compute/index.js';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-corruption-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 corruption -- project root: ${projectRoot}`);

let db;
try {
  db = await openDb(projectRoot);
  const dbFile = dbPathFor(projectRoot);

  // Inflate the db so it has multiple pages we can later overwrite. Insert
  // ~200 rows of moderate size so the file grows past page 1.
  for (let i = 0; i < 200; i++) {
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'corruption-test',
      project_root: projectRoot,
      event_type: 'output',
      body: `pre-corruption row ${i} -- ` + 'x'.repeat(200),
      ts: Date.now() + i,
    });
  }
  ok('200 rows written + quick_check ok each time');

  // Force WAL checkpoint so all data lives in the main file (safer to
  // corrupt deterministically across drivers).
  try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); } catch { /* fine */ }
  closeDb(db);
  db = null;

  // 2. Corrupt the file. SQLite default page size is 4096; pages are
  //    1-indexed. We scramble bytes in pages 4-6 (well past the header at
  //    page 1) which holds raw_fts segments.
  const stats = statSync(dbFile);
  const PAGE = 4096;
  if (stats.size < PAGE * 6) {
    bad('db grew past 6 pages', `size=${stats.size}`);
  } else {
    ok(`db file is ${stats.size} bytes (>= 6 pages)`);
    const fd = openSync(dbFile, 'r+');
    try {
      const garbage = Buffer.alloc(PAGE * 3, 0xAB);
      writeSync(fd, garbage, 0, garbage.length, PAGE * 3); // overwrite pages 4-6
    } finally {
      closeSync(fd);
    }
    ok('scribbled 3 pages of garbage into the db file');
  }

  // 3. Reopen and try to write. quick_check should report damage and
  //    safeWrite should throw IntegrityError. Some drivers may also raise a
  //    lower-level ComputeDbError or driver SqliteError on the prepare/insert
  //    step before quick_check runs. All three are acceptable failure modes
  //    -- the contract is "next write does NOT silently succeed".
  let reopened = null;
  try {
    reopened = await openDb(projectRoot);
  } catch (err) {
    // Open itself rejected the file -- also acceptable: integrity caught at
    // schema-version read time.
    ok(`reopen rejected corrupted file: ${err.name}`);
  }

  if (reopened) {
    db = reopened;
    let threw = null;
    try {
      safeWrite(db, 'raw', {
        source_kind: 'compute_output',
        session_id: 'corruption-test',
        project_root: projectRoot,
        event_type: 'output',
        body: 'post-corruption row',
        ts: Date.now(),
      });
    } catch (err) {
      threw = err;
    }
    if (threw instanceof IntegrityError) {
      ok('safeWrite threw IntegrityError after corruption');
    } else if (threw instanceof ComputeDbError) {
      ok(`safeWrite refused write after corruption (${threw.name})`);
    } else if (threw) {
      // Driver-level SqliteError is also an acceptable failure -- the
      // contract is "next write does NOT silently succeed", which is met.
      ok(`safeWrite threw on corrupted db: ${threw.name}: ${String(threw.message).split('\n')[0]}`);
    } else {
      bad('safeWrite throws on corrupted db', 'no error thrown -- silent corruption pass-through!');
    }
  }

} catch (err) {
  bad('corruption test threw unexpectedly', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 corruption: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
