#!/usr/bin/env node
/**
 * test-memory-engine-audit-fixes.js -- v1.6.1 full-audit-sweep regression
 * tests for the memory-engine batch.
 *
 * Covers:
 *   1. compute/staleness.js: LIKE ... ESCAPE '\' so snake_case kg_node
 *      names actually flag rows (audit confirmed[31]). Without the ESCAPE
 *      clause, the escaped pattern %parse\_config% matches a literal
 *      backslash + any char, so snake_case symbols silently flagged zero
 *      rows. Includes a negative control proving `\_` no longer behaves
 *      as a single-char wildcard.
 *   2. memory/search.js autoIndex: warm-tier rebuild routes raw markdown
 *      through redactSecrets, same gate as fts5.js#indexEntry (audit
 *      confirmed[30]). Secrets in hot-tier files must never land
 *      cleartext in memory_entries or the FTS index.
 *   3. memory/fts5.js: PRAGMA quick_check throttle cadence (audit
 *      confirmed[33]+[53]) -- first write per db file checks, then every
 *      Nth write or after the time floor; never on every insert.
 *
 * Run: node --test mcp-server/test-memory-engine-audit-fixes.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb, safeWrite } from './src/compute/fts5.js';
import { upsertNode } from './src/compute/edges.js';
import { propagateStale } from './src/compute/staleness.js';
import { searchMemory } from './src/memory/search.js';
import { dbPathFor, __quickCheck } from './src/memory/fts5.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

function addEdge(db, srcId, dstId, weight, ts, kind = 'co_occurs', count = 3) {
  const lo = Math.min(srcId, dstId);
  const hi = Math.max(srcId, dstId);
  db.prepare(
    `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(lo, hi, kind, weight, count, ts);
}

// --- 1. LIKE ESCAPE clause: snake_case names flag rows -----------------

test('propagateStale flags rows referencing snake_case node names', async () => {
  const root = tmpRoot('staleness-escape');
  const prevDir = process.env.IJFW_PROJECT_DIR;
  process.env.IJFW_PROJECT_DIR = root;
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const idA = upsertNode(db, { kind: 'function', name: 'authLogin', redacted: 0 }, ts).id;
    const idB = upsertNode(db, { kind: 'function', name: 'parse_config_file', redacted: 0 }, ts).id;
    addEdge(db, idA, idB, 0.9, ts);

    // Row referencing the snake_case neighbour: MUST be flagged.
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'escape-test',
      project_root: root,
      body: 'we refactored parse_config_file to stream the config',
      ts,
    });
    // Negative control: underscores replaced by other single chars. If the
    // escaped `\_` still acted as a one-char wildcard (the pre-fix bug had
    // the inverse failure mode), this row would be scooped up too.
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'escape-test',
      project_root: root,
      body: 'unrelated parseXconfigYfile mention must stay fresh',
      ts,
    });

    const env = propagateStale(db, idA, { weight_threshold: 0.5, depth_cap: 2 });
    assert.equal(env.flagged_raw, 1, 'exactly the snake_case-referencing row is flagged');
    const stale = db.prepare(
      `SELECT body FROM raw WHERE stale_candidate >= 1`
    ).all();
    assert.equal(stale.length, 1);
    assert.match(stale[0].body, /parse_config_file/);
  } finally {
    closeDb(db);
    if (prevDir === undefined) delete process.env.IJFW_PROJECT_DIR;
    else process.env.IJFW_PROJECT_DIR = prevDir;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// --- 2. autoIndex routes bodies through redactSecrets -------------------

test('warm-tier autoIndex scrubs secrets before INSERT into memory.db', async () => {
  const SECRET = 'sk_live_TESTABC123DEFGHIJKLMNOPQRSTUVWXYZ'; // gitleaks:allow -- synthetic fixture proving the scrub gate
  const root = tmpRoot('autoindex-scrub');
  const prevDir = process.env.IJFW_PROJECT_DIR;
  const prevScrub = process.env.IJFW_INGEST_SCRUB;
  process.env.IJFW_PROJECT_DIR = root;
  delete process.env.IJFW_INGEST_SCRUB; // default-on
  try {
    const memDir = join(root, '.ijfw', 'memory');
    mkdirSync(memDir, { recursive: true });
    const notePath = join(memDir, 'note.md');
    writeFileSync(
      notePath,
      `# deploy notes\nstripe key is ${SECRET} keep it safe\n`,
      'utf8'
    );

    // Empty db + non-empty file list triggers the autoIndex rebuild.
    searchMemory('deploy', [{ path: notePath, relpath: '.ijfw/memory/note.md' }], 10);

    const mod = await import('better-sqlite3');
    const Database = mod.default || mod;
    const db = new Database(dbPathFor(root), { readonly: true });
    try {
      const rows = db.prepare('SELECT body FROM memory_entries').all();
      assert.ok(rows.length > 0, 'autoIndex inserted the note');
      for (const r of rows) {
        assert.ok(!r.body.includes(SECRET), 'secret must not persist cleartext');
      }
      // FTS index must not surface the secret either.
      const hits = db.prepare(
        `SELECT rowid FROM memory_entries_fts WHERE memory_entries_fts MATCH ?`
      ).all(`"${SECRET}"`);
      assert.equal(hits.length, 0, 'FTS index does not match the raw secret');
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } finally {
    if (prevDir === undefined) delete process.env.IJFW_PROJECT_DIR;
    else process.env.IJFW_PROJECT_DIR = prevDir;
    if (prevScrub === undefined) delete process.env.IJFW_INGEST_SCRUB;
    else process.env.IJFW_INGEST_SCRUB = prevScrub;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// --- 3. quick_check cadence ---------------------------------------------

test('quick_check cadence: first write, every Nth, and time floor', () => {
  const { shouldQuickCheck, QUICK_CHECK_EVERY_N, QUICK_CHECK_MIN_INTERVAL_MS, reset } = __quickCheck;
  reset();
  const t0 = 1_000_000;
  const f = '/tmp/cadence-test/memory.db';

  assert.equal(shouldQuickCheck(f, t0), true, 'first write per db file always checks');
  let fired = 0;
  for (let i = 2; i < QUICK_CHECK_EVERY_N; i++) {
    if (shouldQuickCheck(f, t0)) fired++;
  }
  assert.equal(fired, 0, 'steady-state writes inside the window do not scan');
  assert.equal(shouldQuickCheck(f, t0), true, `write #${QUICK_CHECK_EVERY_N} checks`);
  assert.equal(shouldQuickCheck(f, t0), false, 'write after the Nth does not');
  assert.equal(
    shouldQuickCheck(f, t0 + QUICK_CHECK_MIN_INTERVAL_MS),
    true,
    'time floor elapsing re-arms the tripwire'
  );

  // Independent per-filename state: a different db file starts fresh.
  assert.equal(shouldQuickCheck('/tmp/other/memory.db', t0), true);
  reset();
});
