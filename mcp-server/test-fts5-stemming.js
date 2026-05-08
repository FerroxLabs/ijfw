#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- C9.4 FTS5 porter stemming test.
//
// Asserts the porter unicode61 tokenizer collapses morphological variants
// across raw_fts on a fresh db (path: migration 001 -> 002 applied at open).
// Run: node mcp-server/test-fts5-stemming.js

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { openDb, safeWrite, search, closeDb } from './src/compute/index.js';

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ok  ${name}`); }
function bad(name, err) { fail++; console.log(`  FAIL ${name}: ${err}`); }

const projectRoot = mkdtempSync(join(tmpdir(), 'ijfw-fts5-stem-'));
process.env.IJFW_PROJECT_DIR = projectRoot;

console.log(`# FTS5 porter stemming -- project root: ${projectRoot}`);

let db;
try {
  db = await openDb(projectRoot);

  // Verify the migration ran -- user_version should be >= 2.
  const uv = db.prepare('PRAGMA user_version').get();
  const uvN = Number(uv && (uv.user_version ?? uv.USER_VERSION ?? 0));
  if (uvN >= 2) ok(`PRAGMA user_version >= 2 (got ${uvN})`);
  else bad('PRAGMA user_version >= 2', `got ${uvN}`);

  // Verify raw_fts uses porter tokenizer by inspecting sqlite_master.
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='raw_fts'").get();
  if (ddl && /porter/i.test(ddl.sql)) ok('raw_fts uses porter tokenizer');
  else bad('raw_fts uses porter tokenizer', JSON.stringify(ddl));

  // Insert known morphological variants. Each row's body contains exactly
  // one form so we can assert stem-collapse via cross-form matching.
  const NOW = Date.now();
  const fixtures = [
    { tag: 'authenticate', body: 'service must authenticate every caller before issuing tokens' },
    { tag: 'authenticating', body: 'middleware is currently authenticating the request' },
    { tag: 'authentication', body: 'authentication failed three times in a row' },
    { tag: 'running', body: 'the worker is running on the background queue' },
    { tag: 'ran', body: 'the migration ran cleanly during the deploy' },
    { tag: 'queries', body: 'multiple queries arrived from the analytics dashboard' },
    { tag: 'query', body: 'each query touches the same partition' },
    { tag: 'configure', body: 'configure the proxy with the new upstream pool' },
    { tag: 'configured', body: 'the proxy was configured with three retries' },
    { tag: 'configuring', body: 'configuring the proxy now requires a restart' },
  ];
  for (let i = 0; i < fixtures.length; i++) {
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'stem-test',
      project_root: projectRoot,
      event_type: 'output',
      body: fixtures[i].body,
      ts: NOW + i,
    });
  }
  ok(`inserted ${fixtures.length} morphological-variant rows`);

  // Stemming assertions.
  function expectMatchesAtLeast(query, atLeast, label) {
    const hits = search(db, 'raw', query, 50);
    if (hits.length >= atLeast) ok(`${label}: query "${query}" returned ${hits.length} hits (>= ${atLeast})`);
    else bad(`${label}: query "${query}" returned >= ${atLeast}`, `got ${hits.length}`);
    return hits;
  }

  // "authenticate" should match all three auth* rows (authenticate /
  // authenticating / authentication share the porter stem 'authent').
  const authHits = expectMatchesAtLeast('authenticate', 3, 'auth-stem-collapse');
  const authBodies = new Set(authHits.map(h => h.body));
  if ([...authBodies].some(b => /authenticating/.test(b))) ok('"authenticate" matches "authenticating" body');
  else bad('"authenticate" matches "authenticating" body', 'no match');
  if ([...authBodies].some(b => /authentication/.test(b))) ok('"authenticate" matches "authentication" body');
  else bad('"authenticate" matches "authentication" body', 'no match');

  // "running" -> "ran" is famously NOT covered by porter (irregular verb).
  // We accept that and instead test "running" -> "running" + "runs"-style
  // pairs via the "configure" group which porter handles cleanly.
  const cfgHits = expectMatchesAtLeast('configure', 3, 'configure-stem-collapse');
  const cfgBodies = cfgHits.map(h => h.body).join(' ');
  if (/configured/.test(cfgBodies)) ok('"configure" matches "configured" body');
  else bad('"configure" matches "configured" body', 'no match');
  if (/configuring/.test(cfgBodies)) ok('"configure" matches "configuring" body');
  else bad('"configure" matches "configuring" body', 'no match');

  // "queries" should match "query" and vice versa under porter.
  const queryHits = expectMatchesAtLeast('query', 2, 'queries-query-collapse');
  const queriesHits = expectMatchesAtLeast('queries', 2, 'reverse-queries-query');
  if (queryHits.length >= 2 && queriesHits.length >= 2) ok('queries <-> query bidirectional');
  else bad('queries <-> query bidirectional', `query=${queryHits.length} queries=${queriesHits.length}`);

  // "running" should match the "running" row (sanity); irregular "ran" is
  // documented as NOT collapsed by porter -- we don't assert it.
  const runHits = search(db, 'raw', 'running', 5);
  if (runHits.length >= 1) ok('"running" returns the running-row');
  else bad('"running" returns the running-row', `got ${runHits.length}`);

} catch (err) {
  bad('stemming test threw', err.stack || err.message);
} finally {
  closeDb(db);
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`# FTS5 porter stemming: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
