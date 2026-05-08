#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- FTS5 migration / schema-version test.
//
// 1. Open a fresh db; verify schema_meta has a row for version 1.
// 2. Hand-bump PRAGMA user_version to a number above the highest known
//    migration; reopen and verify SchemaVersionError is thrown (downgrade
//    refused).
//
// Run: node mcp-server/test-fts5-migrations.js

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  openDb, closeDb, SchemaVersionError, highestKnownVersion,
} from './src/compute/index.js';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-migrations-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 migrations -- project root: ${projectRoot}`);

let db;
try {
  // 1. Fresh open: migration applied; schema_meta gains a row for version 1.
  db = await openDb(projectRoot);
  const target = await highestKnownVersion();
  if (target >= 1) ok(`highestKnownVersion >= 1 (got ${target})`);
  else bad('highestKnownVersion >= 1', `got ${target}`);

  const meta = db.prepare('SELECT version, description FROM schema_meta WHERE version = 1').get();
  if (meta && meta.version === 1) ok('schema_meta has row for version 1');
  else bad('schema_meta has row for version 1', JSON.stringify(meta));

  const uv = db.prepare('PRAGMA user_version').get();
  const uvN = Number(uv && (uv.user_version ?? uv.USER_VERSION ?? 0));
  if (uvN === target) ok(`PRAGMA user_version == ${target}`);
  else bad(`PRAGMA user_version == ${target}`, `got ${uvN}`);

  // Verify all expected tables + FTS5 virtual tables exist.
  const expectTables = ['raw', 'raw_fts', 'compiled', 'compiled_fts', 'trident_run', 'schema_meta'];
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
  const have = new Set(rows.map(r => r.name));
  let allPresent = true;
  for (const t of expectTables) {
    if (!have.has(t)) { allPresent = false; bad(`table ${t} present`, 'missing'); }
  }
  if (allPresent) ok(`all expected tables present (${expectTables.join(', ')})`);

  // 2. Bump user_version above target and reopen: SchemaVersionError.
  const future = target + 99;
  db.exec(`PRAGMA user_version = ${future}`);
  closeDb(db);
  db = null;

  let threw = null;
  try {
    db = await openDb(projectRoot);
  } catch (err) {
    threw = err;
  }
  if (threw && threw instanceof SchemaVersionError) {
    ok('reopen with future user_version throws SchemaVersionError');
  } else if (threw) {
    bad('reopen throws SchemaVersionError', `got ${threw.name}: ${threw.message}`);
  } else {
    bad('reopen throws SchemaVersionError', 'no error thrown');
  }

} catch (err) {
  bad('migrations test threw', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 migrations: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
