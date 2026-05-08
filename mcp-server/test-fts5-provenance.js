#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- C9.6 citation provenance test.
//
// Asserts:
//  1. Inserts with `source` + `session_id` round-trip via dispatchSearch.
//  2. Inserts without `source` round-trip with source=null.
//  3. Filter by session_id (--session=<id>) scopes results.
//  4. Result envelope reports session_filter when applied.
//  5. Migration adds the `source` column on a v1 db (recreate-with-data path).
//
// Run: node mcp-server/test-fts5-provenance.js

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { openDb, safeWrite, search, closeDb } from './src/compute/index.js';
import { parseColonCommand, dispatchRun, dispatchSearch } from './src/dispatch/colon-syntax.js';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-prov-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 citation provenance -- project root: ${projectRoot}`);

let db;
try {
  db = await openDb(projectRoot);

  // Verify migration ran: raw has a `source` column.
  const cols = db.prepare("PRAGMA table_info(raw)").all().map(r => r.name);
  if (cols.includes('source')) ok('raw.source column present after migration');
  else bad('raw.source column present after migration', `cols=${cols.join(',')}`);
  if (cols.includes('session_id')) ok('raw.session_id column present (existed since v1)');
  else bad('raw.session_id column present', `cols=${cols.join(',')}`);

  // Verify partial index raw_source_idx exists.
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='raw_source_idx'").get();
  if (idx) ok('raw_source_idx index present');
  else bad('raw_source_idx index present', 'missing');

  // 1. Insert with source + session_id via safeWrite directly.
  const NOW = Date.now();
  safeWrite(db, 'raw', {
    source_kind: 'compute_output',
    source: 'src/foo.js:42',
    session_id: 'sess-A',
    project_root: projectRoot,
    event_type: 'output',
    body: 'authentication middleware passed three checks',
    ts: NOW,
  });
  ok('inserted row with source + session_id (sess-A)');

  // 2. Insert without source -- source stays null.
  safeWrite(db, 'raw', {
    source_kind: 'compute_output',
    session_id: 'sess-B',
    project_root: projectRoot,
    event_type: 'output',
    body: 'authentication retry succeeded after backoff',
    ts: NOW + 1,
  });
  ok('inserted row without source (sess-B)');

  // Direct search() check: top-level row carries source + session_id.
  const direct = search(db, 'raw', 'authentication', 10);
  if (direct.length >= 2) ok(`direct search returned ${direct.length} hits`);
  else bad('direct search returned 2 hits', `got ${direct.length}`);
  const withSrc = direct.find(h => h.session_id === 'sess-A');
  const noSrc = direct.find(h => h.session_id === 'sess-B');
  if (withSrc && withSrc.source === 'src/foo.js:42') ok('hit for sess-A carries source pointer');
  else bad('hit for sess-A carries source', JSON.stringify(withSrc));
  if (noSrc && (noSrc.source === null || noSrc.source === undefined)) ok('hit for sess-B has source=null');
  else bad('hit for sess-B has source=null', JSON.stringify(noSrc));

  closeDb(db);
  db = null;

  // 3. dispatchSearch surfaces source + session_id.
  const r1 = await dispatchSearch(parseColonCommand('compute:authentication'), { projectRoot });
  if (r1.ok && r1.hits.length >= 2) ok(`dispatchSearch returned ${r1.hits.length} hits`);
  else bad('dispatchSearch returned >= 2 hits', JSON.stringify(r1).slice(0, 240));
  const sa = r1.hits.find(h => h.session_id === 'sess-A');
  const sb = r1.hits.find(h => h.session_id === 'sess-B');
  if (sa && sa.source === 'src/foo.js:42' && sa.session_id === 'sess-A') {
    ok('dispatchSearch hit carries source + session_id (sess-A)');
  } else {
    bad('dispatchSearch hit carries source + session_id (sess-A)', JSON.stringify(sa));
  }
  if (sb && sb.source == null && sb.session_id === 'sess-B') {
    ok('dispatchSearch hit carries null source + session_id (sess-B)');
  } else {
    bad('dispatchSearch hit carries null source + session_id (sess-B)', JSON.stringify(sb));
  }

  // 4. Session filter via --session=sess-A.
  const r2 = await dispatchSearch(parseColonCommand('compute:authentication --session=sess-A'), { projectRoot });
  if (r2.ok && r2.hits.length === 1 && r2.hits[0].session_id === 'sess-A') {
    ok('--session=sess-A filter returns only sess-A row');
  } else {
    bad('--session=sess-A filter', JSON.stringify(r2).slice(0, 240));
  }
  if (r2.session_filter === 'sess-A') ok('envelope reports session_filter');
  else bad('envelope reports session_filter', JSON.stringify(r2));

  // 5. dispatchRun index path with --source=<value> attaches provenance.
  const idxParsed = parseColonCommand('index:source --source=skill:ijfw-compute "compute lever fired in 12ms"');
  const idxResult = await dispatchRun(idxParsed, { projectRoot, sessionId: 'sess-C' });
  if (idxResult && idxResult.ok && idxResult.provenance === 'skill:ijfw-compute' && idxResult.session_id === 'sess-C') {
    ok('index:* with --source=<value> propagates provenance + session_id');
  } else {
    bad('index:* with --source=<value> propagates provenance', JSON.stringify(idxResult));
  }
  // Verify the row landed with source set.
  const r3 = await dispatchSearch(parseColonCommand('compute:lever'), { projectRoot });
  const sc = r3.hits && r3.hits.find(h => h.session_id === 'sess-C');
  if (sc && sc.source === 'skill:ijfw-compute') {
    ok('index:* row retrievable with source=skill:ijfw-compute');
  } else {
    bad('index:* row retrievable with source=skill:ijfw-compute', JSON.stringify(sc));
  }

  // 6. dispatchRun index path WITHOUT --source: provenance stays null.
  const idx2 = parseColonCommand('index:source "no provenance attached here"');
  const idx2Result = await dispatchRun(idx2, { projectRoot, sessionId: 'sess-D' });
  if (idx2Result && idx2Result.ok && idx2Result.provenance == null) {
    ok('index:* without --source leaves provenance null');
  } else {
    bad('index:* without --source leaves provenance null', JSON.stringify(idx2Result));
  }

} catch (err) {
  bad('provenance test threw', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 citation provenance: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
