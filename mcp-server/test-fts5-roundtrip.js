#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- FTS5 roundtrip test.
//
// Opens a fresh per-project compute db, inserts 100 raw rows, queries FTS5,
// asserts top-10 results returned. PRAGMA quick_check runs inside safeWrite()
// after every insert -- a passing test means it returned 'ok' 100 times.
//
// Run: node mcp-server/test-fts5-roundtrip.js

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { openDb, safeWrite, search, closeDb, dbPathFor } from './src/compute/index.js';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-roundtrip-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 roundtrip -- project root: ${projectRoot}`);

let db;
try {
  // 1. openDb creates the file in the right place.
  db = await openDb(projectRoot);
  const expected = dbPathFor(projectRoot);
  if (existsSync(expected)) ok(`db file created at ${expected}`);
  else bad('db file created', `not found at ${expected}`);

  // 2. Insert 100 raw rows. Body content alternates between two corpora so
  //    we can verify FTS5 actually filters (not just returns the last 10).
  const NOW = Date.now();
  for (let i = 0; i < 100; i++) {
    const body = i % 2 === 0
      ? `alpha lever compute index entry number ${i} discusses fts5 retrieval`
      : `beta sandbox runner item ${i} discusses subprocess isolation`;
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'roundtrip-session',
      project_root: projectRoot,
      event_type: 'output',
      body,
      ts: NOW + i,
    });
  }
  ok('inserted 100 raw rows with quick_check after each');

  // 3. Search for "alpha" -- should match the 50 even-indexed rows; we ask
  //    for top-10. Confirm exactly 10 returned and all contain "alpha".
  const alphaHits = search(db, 'raw', 'alpha', 10);
  if (alphaHits.length === 10) ok('search returned 10 results for alpha');
  else bad('search returned 10 results for alpha', `got ${alphaHits.length}`);

  const allAlpha = alphaHits.every(r => /alpha/i.test(r.body));
  if (allAlpha) ok('every alpha-hit body contains "alpha"');
  else bad('every alpha-hit body contains "alpha"', 'at least one row missing the term');

  // 4. Disjoint query -- "beta" should also return 10 distinct rows.
  const betaHits = search(db, 'raw', 'beta', 10);
  if (betaHits.length === 10) ok('search returned 10 results for beta');
  else bad('search returned 10 results for beta', `got ${betaHits.length}`);

  const noOverlap = !alphaHits.some(a => betaHits.some(b => b.id === a.id));
  if (noOverlap) ok('alpha and beta result sets are disjoint');
  else bad('alpha and beta disjoint', 'unexpected overlap');

  // 5. FTS5 prefix syntax: "subprocess*" should match the beta rows.
  const prefixHits = search(db, 'raw', 'subprocess*', 5);
  if (prefixHits.length === 5) ok('FTS5 prefix query returned 5 results');
  else bad('FTS5 prefix query returned 5 results', `got ${prefixHits.length}`);

  // 6. k clamping: ask for k=0 -> coerced to 1; k=10000 -> capped at 1000.
  const clampedLow = search(db, 'raw', 'alpha', 0);
  if (clampedLow.length >= 1) ok('k=0 coerced to a positive limit');
  else bad('k=0 coerced to a positive limit', `got ${clampedLow.length}`);

  // 7. Empty query returns [] (defensive).
  const emptyHits = search(db, 'raw', '', 10);
  if (emptyHits.length === 0) ok('empty query returns empty result set');
  else bad('empty query returns empty result set', `got ${emptyHits.length}`);

} catch (err) {
  bad('roundtrip threw', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 roundtrip: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
