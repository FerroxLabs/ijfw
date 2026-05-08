#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- C9.5 synonym expansion test.
//
// Asserts:
//  1. expandQuery rewrites a known shorthand into an OR group.
//  2. Reverse direction works (long-form -> short-form).
//  3. IJFW_SYNONYM_EXPAND=0 disables expansion entirely.
//  4. Per-call ctx.synonym='0' override disables for one call.
//  5. dispatchSearch result envelope carries synonym_matches metadata.
//  6. Small-repo precision fixture: synonym expansion can broaden the
//     result set; the envelope reports exactly which expansions fired so
//     the caller can re-query with the toggle off.
//
// Run: node mcp-server/test-fts5-synonyms.js

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { openDb, safeWrite, closeDb } from './src/compute/index.js';
import { expandQuery, synonymMapSize } from './src/compute/synonyms.js';
import { parseColonCommand, dispatchSearch } from './src/dispatch/colon-syntax.js';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-syn-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 synonym expansion -- project root: ${projectRoot}`);

let db;
try {
  // --- expandQuery unit checks ---
  if (synonymMapSize() >= 80) ok(`synonym map has ${synonymMapSize()} entries (>= 80)`);
  else bad('synonym map has >= 80 entries', `got ${synonymMapSize()}`);

  // 1. Single-pair expansion: db -> includes "database".
  const e1 = expandQuery('db');
  if (e1.applied && /database/i.test(e1.expanded) && e1.synonym_matches.db) {
    ok(`db expands -> ${e1.expanded}`);
  } else {
    bad('db expands to include "database"', JSON.stringify(e1));
  }

  // 2. Reverse: database -> includes "db".
  const e2 = expandQuery('database');
  if (e2.applied && /\bdb\b/.test(e2.expanded) && e2.synonym_matches.database) {
    ok(`database expands -> ${e2.expanded}`);
  } else {
    bad('database expands to include "db"', JSON.stringify(e2));
  }

  // 3. Env disables expansion entirely.
  process.env.IJFW_SYNONYM_EXPAND = '0';
  const e3 = expandQuery('db');
  if (!e3.applied && e3.expanded === 'db' && Object.keys(e3.synonym_matches).length === 0) {
    ok('IJFW_SYNONYM_EXPAND=0 disables expansion');
  } else {
    bad('IJFW_SYNONYM_EXPAND=0 disables expansion', JSON.stringify(e3));
  }
  delete process.env.IJFW_SYNONYM_EXPAND;

  // 4. Per-call env override.
  const e4 = expandQuery('db', { env: 'off' });
  if (!e4.applied) ok('per-call env override disables expansion');
  else bad('per-call env override disables expansion', JSON.stringify(e4));

  // FTS5 reserved keyword should pass through.
  const e5 = expandQuery('db AND auth');
  if (e5.applied && /AND/.test(e5.expanded) && /auth/.test(e5.expanded) && /database/.test(e5.expanded)) {
    ok(`AND keyword preserved alongside expansion: ${e5.expanded}`);
  } else {
    bad('AND keyword preserved', JSON.stringify(e5));
  }

  // Quoted phrase passes through unchanged.
  const e6 = expandQuery('"db cluster" perf');
  if (/"db cluster"/.test(e6.expanded) && /performance/.test(e6.expanded)) {
    ok(`quoted phrase preserved: ${e6.expanded}`);
  } else {
    bad('quoted phrase preserved', JSON.stringify(e6));
  }

  // --- dispatchSearch integration ---
  db = await openDb(projectRoot);
  const NOW = Date.now();
  // Insert two rows: one mentions "database", one mentions "auth".
  // Searching "db" should retrieve the database row via expansion.
  safeWrite(db, 'raw', {
    source_kind: 'compute_output',
    session_id: 'syn-session',
    project_root: projectRoot,
    event_type: 'output',
    body: 'database connection pool exhausted under high concurrency',
    ts: NOW,
  });
  safeWrite(db, 'raw', {
    source_kind: 'compute_output',
    session_id: 'syn-session',
    project_root: projectRoot,
    event_type: 'output',
    body: 'authentication middleware rejected the bearer token',
    ts: NOW + 1,
  });
  closeDb(db);
  db = null;
  ok('inserted 2 rows for dispatchSearch integration');

  // dispatchSearch with "db" should retrieve the database row + report
  // synonym_matches.db -> ['database'].
  const parsed = parseColonCommand('compute:db');
  const r1 = await dispatchSearch(parsed, { projectRoot });
  if (r1.ok && r1.hits.length >= 1 && r1.hits.some(h => /database/.test(h.body))) {
    ok(`dispatchSearch compute:db retrieved database row via expansion (${r1.hits.length} hits)`);
  } else {
    bad('dispatchSearch compute:db retrieved database row', JSON.stringify(r1).slice(0, 240));
  }
  if (r1.synonym_applied && r1.synonym_matches && r1.synonym_matches.db) {
    ok(`envelope reports synonym_matches.db = ${JSON.stringify(r1.synonym_matches.db)}`);
  } else {
    bad('envelope reports synonym_matches.db', JSON.stringify(r1.synonym_matches));
  }

  // dispatchSearch with synonym disabled per-call: should NOT retrieve the
  // database row from the bare token "db".
  const r2 = await dispatchSearch(parseColonCommand('compute:db'), {
    projectRoot,
    synonym: '0',
  });
  if (r2.ok && r2.hits.length === 0) {
    ok('dispatchSearch with synonym=0 returns 0 hits for bare "db"');
  } else if (r2.ok && r2.hits.length >= 1) {
    // If FTS5 + porter happens to stem 'db' to a token in the corpus,
    // this would still pass; document the observed behavior in the
    // failure message rather than masking it.
    bad('dispatchSearch with synonym=0 returns 0 hits for bare "db"',
        `got ${r2.hits.length} hits -- precision check may need a stricter corpus`);
  } else {
    bad('dispatchSearch with synonym=0', JSON.stringify(r2).slice(0, 240));
  }
  if (!r2.synonym_applied && Object.keys(r2.synonym_matches || {}).length === 0) {
    ok('envelope reports no synonym matches when disabled');
  } else {
    bad('envelope reports no synonym matches when disabled', JSON.stringify(r2.synonym_matches));
  }

  // 5. Small-repo precision fixture: synthetic 3-row repo where expansion
  //    broadens results. We assert envelope.synonym_matches is populated
  //    so the caller can re-query with synonym=0 if precision matters.
  const r3 = await dispatchSearch(parseColonCommand('compute:auth'), { projectRoot });
  if (r3.ok && r3.hits.some(h => /authentication/.test(h.body))) {
    ok('compute:auth retrieves authentication row via expansion (small-repo precision case)');
  } else {
    bad('compute:auth retrieves authentication row', JSON.stringify(r3).slice(0, 240));
  }
  if (r3.synonym_matches && r3.synonym_matches.auth && r3.synonym_matches.auth.includes('authentication')) {
    ok('small-repo precision case reports auth -> authentication in envelope -- caller can disable expansion');
  } else {
    bad('small-repo precision case reports auth -> authentication',
        JSON.stringify(r3.synonym_matches));
  }

} catch (err) {
  bad('synonym test threw', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 synonym expansion: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
