#!/usr/bin/env node
/**
 * test-d1-tier-semantic.js -- D-Pillar / D1 4-tier semantic axis.
 *
 * Source authority: PRD-v2 §9 Pillar D D1 + .planning/1.3.0/D-PILLAR-SPEC.md §1.
 *
 * Covers:
 *   1. Memory migration v1 -> v2 preserves existing rows + adds tier_semantic
 *      column with DEFAULT 'working'.
 *   2. Compute migration v2 -> v3 preserves existing rows + adds
 *      tier_semantic on raw (default 'working') and compiled (default
 *      'semantic').
 *   3. Working -> Episodic promotion writes a NEW record with
 *      tier_semantic='episodic', preserves the original Working rows.
 *   4. Episodic -> Semantic promotion fires on Jaccard > 0.7.
 *   5. Working -> Procedural fires on TaskUpdate completed + duration >= 5min,
 *      and pattern match (3+ similar candidates) lifts to Procedural.
 *   6. Search with tier_semantic filter returns only matching tier.
 *   7. Concurrent migration safe (BEGIN IMMEDIATE).
 *
 * Run: node --test mcp-server/test-d1-tier-semantic.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  openDb as openMemoryDb,
  indexEntry,
  closeDb,
  dbPathFor,
} from './src/memory/fts5.js';
import { searchMemory } from './src/memory/search.js';
import {
  TIERS,
  promoteWorkingToEpisodic,
  promoteEpisodicToSemantic,
  promoteWorkingToProcedural,
  promoteSemanticToArchived,
} from './src/memory/tier-promotion.js';
import { openDb as openComputeDb, safeWrite } from './src/compute/fts5.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

// --- Migrations ------------------------------------------------------------

test('D1 -- memory v1 -> v2 preserves rows + adds tier_semantic', async () => {
  const root = tmpRoot('d1-mem-migrate');
  let db;
  try {
    db = await openMemoryDb(root);

    // Insert a row at v2 (the default since we always migrate to highest).
    indexEntry(db, { body: 'pre-D1 working row', source: 'legacy.md' });

    const uv = db.prepare('PRAGMA user_version').get();
    // Memory v3 (GA-B2 stale_candidate column) bumped this to 3 after the
    // original D1 assertion was authored. Assert >= 2 (D1's gate) so
    // subsequent migrations can extend the schema without churning this test.
    assert.ok(Number(uv.user_version) >= 2,
      `user_version >= 2 after open (got ${uv.user_version})`);

    // tier_semantic column present.
    const cols = db.prepare(`PRAGMA table_info(memory_entries)`).all();
    const tsCol = cols.find(c => c.name === 'tier_semantic');
    assert.ok(tsCol, 'tier_semantic column present');
    assert.equal(String(tsCol.type).toUpperCase(), 'TEXT', 'TEXT type');
    assert.equal(tsCol.dflt_value, "'working'", "DEFAULT 'working'");

    // Existing row reads back as 'working' via the DEFAULT.
    const r = db.prepare(`SELECT tier_semantic FROM memory_entries WHERE source = ?`)
      .get('legacy.md');
    assert.equal(r.tier_semantic, 'working');

    // schema_meta has v2 row.
    const meta = db.prepare(`SELECT version FROM schema_meta WHERE version = 2`).get();
    assert.ok(meta, 'schema_meta row for v2 present');

    // Index on (tier_semantic, created_at) present.
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_entries'`).all();
    const names = idx.map(r => r.name);
    assert.ok(
      names.includes('memory_entries_tier_semantic_idx'),
      `expected memory_entries_tier_semantic_idx in ${names.join(', ')}`
    );
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 -- compute v2 -> v3 preserves rows + adds tier_semantic on raw + compiled', async () => {
  const root = tmpRoot('d1-cmp-migrate');
  let db;
  try {
    db = await openComputeDb(root);

    // Insert a raw row at v3.
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'sess-A',
      project_root: root,
      body: 'pre-D1 raw row',
      ts: Date.now(),
    });

    // Insert a compiled row.
    safeWrite(db, 'compiled', {
      topic: 'caching',
      body: 'compiled summary',
      source_raw_ids: '[]',
      ts: Date.now(),
    });

    const uv = db.prepare('PRAGMA user_version').get();
    // D1 establishes the v3 invariant; later migrations (D2 v4, ...) may
    // bump this further. The contract under test is "v3 schema PRESENT
    // and schema_meta v3 row landed", not "user_version equals 3".
    assert.ok(Number(uv.user_version) >= 3, `user_version >= 3 after open (got ${uv.user_version})`);

    // raw.tier_semantic default 'working'.
    const rawCols = db.prepare(`PRAGMA table_info(raw)`).all();
    const rawTs = rawCols.find(c => c.name === 'tier_semantic');
    assert.ok(rawTs, 'raw.tier_semantic present');
    assert.equal(rawTs.dflt_value, "'working'", "raw default is 'working'");

    const rawRow = db.prepare(`SELECT tier_semantic FROM raw LIMIT 1`).get();
    assert.equal(rawRow.tier_semantic, 'working');

    // compiled.tier_semantic default 'semantic'.
    const cmpCols = db.prepare(`PRAGMA table_info(compiled)`).all();
    const cmpTs = cmpCols.find(c => c.name === 'tier_semantic');
    assert.ok(cmpTs, 'compiled.tier_semantic present');
    assert.equal(cmpTs.dflt_value, "'semantic'", "compiled default is 'semantic'");

    const cmpRow = db.prepare(`SELECT tier_semantic FROM compiled LIMIT 1`).get();
    assert.equal(cmpRow.tier_semantic, 'semantic');

    // schema_meta v3 row.
    const meta = db.prepare(`SELECT version FROM schema_meta WHERE version = 3`).get();
    assert.ok(meta, 'schema_meta v3 row');

    // Indexes present.
    const idx = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index'`).all();
    const names = idx.map(r => `${r.tbl_name}.${r.name}`);
    assert.ok(names.includes('raw.raw_tier_semantic_idx'), `raw idx (${names.join(', ')})`);
    assert.ok(names.includes('compiled.compiled_tier_semantic_idx'), 'compiled idx');
  } finally {
    if (db) { try { db.close(); } catch { /* nothing */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Promotion: Working -> Episodic ----------------------------------------

test('D1 -- Working -> Episodic writes new episodic row, preserves working', async () => {
  const root = tmpRoot('d1-w2e');
  let db;
  try {
    db = await openMemoryDb(root);

    // Three Working entries for session 's1'.
    indexEntry(db, { body: 'observation A', source: 'a', session_id: 's1' });
    indexEntry(db, { body: 'observation B', source: 'b', session_id: 's1' });
    indexEntry(db, { body: 'observation C', source: 'c', session_id: 's1' });
    // Unrelated session row -- must not affect promotion.
    indexEntry(db, { body: 'other session', source: 'x', session_id: 's2' });

    const before = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries`).get();
    assert.equal(Number(before.n), 4);

    const r = promoteWorkingToEpisodic(db, { session_id: 's1' });
    assert.equal(r.errors.length, 0, `errors: ${r.errors.join('; ')}`);
    assert.equal(r.promoted, 1, 'one episodic record written');

    // Original three Working rows preserved.
    const working = db.prepare(
      `SELECT COUNT(*) AS n FROM memory_entries WHERE tier_semantic = ? AND session_id = ?`
    ).get(TIERS.WORKING, 's1');
    assert.equal(Number(working.n), 3, 'working rows preserved');

    // One Episodic for s1.
    const ep = db.prepare(
      `SELECT body, source FROM memory_entries WHERE tier_semantic = ? AND session_id = ?`
    ).all(TIERS.EPISODIC, 's1');
    assert.equal(ep.length, 1);
    assert.match(ep[0].source, /^session:s1:episodic$/);
    assert.match(ep[0].body, /observation A/);
    assert.match(ep[0].body, /observation B/);

    // Idempotent: second call no-ops.
    const r2 = promoteWorkingToEpisodic(db, { session_id: 's1' });
    assert.equal(r2.promoted, 0, 'idempotent no-op on second call');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Promotion: Episodic -> Semantic ---------------------------------------

test('D1 -- Episodic -> Semantic promotes when Jaccard > 0.7', async () => {
  const root = tmpRoot('d1-e2s');
  let db;
  try {
    db = await openMemoryDb(root);

    // Insert two Episodic records with very similar bodies (Jaccard > 0.7).
    const sharedTokens = 'authentication tokens jwt validation expiry refresh rotation';
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run(`${sharedTokens} and a unique extra alpha`, 'session:s1:episodic', 's1', Date.now(), TIERS.EPISODIC);
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run(`${sharedTokens} plus unique extra beta`, 'session:s2:episodic', 's2', Date.now() + 1, TIERS.EPISODIC);
    // Unrelated Episodic to ensure non-similar pairs don't trigger.
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run('completely unrelated kitchen recipe pasta sauce', 'session:s3:episodic', 's3', Date.now() + 2, TIERS.EPISODIC);

    const r = promoteEpisodicToSemantic(db);
    assert.equal(r.errors.length, 0, `errors: ${r.errors.join('; ')}`);
    assert.equal(r.promoted, 1, 'one semantic record promoted via Jaccard');

    const sem = db.prepare(
      `SELECT body, source FROM memory_entries WHERE tier_semantic = ?`
    ).all(TIERS.SEMANTIC);
    assert.equal(sem.length, 1);
    assert.match(sem[0].source, /^episodic:\d+:semantic$/);

    // Idempotent re-run.
    const r2 = promoteEpisodicToSemantic(db);
    assert.equal(r2.promoted, 0, 'no double-promotion on second call');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 -- Episodic -> Semantic explicit promote tag bypasses similarity', async () => {
  const root = tmpRoot('d1-e2s-tag');
  let db;
  try {
    db = await openMemoryDb(root);

    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run('one unique paragraph', 'session:s1:episodic promote:semantic', 's1', Date.now(), TIERS.EPISODIC);

    const r = promoteEpisodicToSemantic(db);
    assert.equal(r.errors.length, 0);
    assert.equal(r.promoted, 1, 'explicit tag promoted');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Promotion: Working -> Procedural --------------------------------------

test('D1 -- Working -> Procedural fires on TaskUpdate completed + duration >= 5min', async () => {
  const root = tmpRoot('d1-w2p');
  let db;
  try {
    db = await openMemoryDb(root);

    const taskBody = 'install deps then run tests then commit then push';
    const start = Date.now();

    // Below threshold -- no promotion.
    let r0 = promoteWorkingToProcedural(db, {
      task_id: 't-short',
      status: 'completed',
      start_ts: start,
      end_ts: start + 4 * 60 * 1000,
      body: taskBody,
      session_id: 's1',
    });
    assert.equal(r0.promoted, 0, 'sub-5min task does not promote');

    // Above threshold -- candidate emitted.
    let r1 = promoteWorkingToProcedural(db, {
      task_id: 't1',
      status: 'completed',
      start_ts: start,
      end_ts: start + 6 * 60 * 1000,
      body: taskBody,
      session_id: 's1',
    });
    assert.equal(r1.errors.length, 0, `errors: ${r1.errors.join('; ')}`);
    assert.equal(r1.promoted, 1, 'one procedural_candidate emitted');

    const cand = db.prepare(
      `SELECT id, source FROM memory_entries WHERE tier_semantic = ?`
    ).all(TIERS.PROCEDURAL_CANDIDATE);
    assert.equal(cand.length, 1);
    assert.equal(cand[0].source, 'task:t1:procedural_candidate');

    // Non-completed status -- no-op.
    let r2 = promoteWorkingToProcedural(db, {
      task_id: 't2',
      status: 'in_progress',
      start_ts: start,
      end_ts: start + 10 * 60 * 1000,
      body: taskBody,
      session_id: 's1',
    });
    assert.equal(r2.promoted, 0);

    // Add two more similar candidates -> the third should hit the
    // 3+-chain threshold and produce a Procedural row.
    const r3 = promoteWorkingToProcedural(db, {
      task_id: 't3',
      status: 'completed',
      start_ts: start,
      end_ts: start + 6 * 60 * 1000,
      body: taskBody + ' v2',
      session_id: 's1',
    });
    assert.equal(r3.errors.length, 0, `errors: ${r3.errors.join('; ')}`);
    assert.ok(r3.promoted >= 1, 'second candidate emitted');

    const r4 = promoteWorkingToProcedural(db, {
      task_id: 't4',
      status: 'completed',
      start_ts: start,
      end_ts: start + 6 * 60 * 1000,
      body: taskBody + ' v3',
      session_id: 's1',
    });
    assert.equal(r4.errors.length, 0);
    // Third call: candidate insert + Procedural confirmation = 2 promoted.
    assert.ok(r4.promoted >= 2, `expected >=2 promotions, got ${r4.promoted}`);

    const proc = db.prepare(
      `SELECT id, source FROM memory_entries WHERE tier_semantic = ?`
    ).all(TIERS.PROCEDURAL);
    assert.ok(proc.length >= 1, `expected procedural rows, got ${proc.length}`);
    assert.match(proc[0].source, /^procedural:from-candidates:/);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Search filter ---------------------------------------------------------

test('D1 -- searchMemory tier_semantic filter returns only matching tier', async () => {
  const root = tmpRoot('d1-search');
  let db;
  try {
    // Lay out memory dir so resolveIndexRoot finds the project.
    const memDir = join(root, '.ijfw', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'note.md'), '# Note\nworking observation alpha\n');

    // Open the SAME root via openMemoryDb to write tier_semantic-tagged rows
    // that the searchMemory call will then read.
    db = await openMemoryDb(root);
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run('working observation alpha', 'note.md', 's1', Date.now(), TIERS.WORKING);
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run('episodic summary alpha', 'session:s1:episodic', 's1', Date.now(), TIERS.EPISODIC);
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic)
       VALUES (?, ?, ?, ?, ?)`
    ).run('semantic concept alpha', 'episodic:1:semantic', 's1', Date.now(), TIERS.SEMANTIC);
    closeDb(db);
    db = null;

    // searchMemory needs to find this root via files; ensure an entry's path
    // sits under <root>/.ijfw so resolveIndexRoot picks it up.
    const fileList = [{
      path: join(memDir, 'note.md'),
      relpath: 'note.md',
      title: 'note',
      preview: 'working observation alpha',
    }];

    // No filter -- all three tiers eligible.
    const rAll = searchMemory('alpha', fileList);
    assert.ok(rAll.length >= 3, `expected >=3 hits, got ${rAll.length}`);
    const tiersSeen = new Set(rAll.map(r => r.tier_semantic));
    assert.ok(tiersSeen.has('working'));
    assert.ok(tiersSeen.has('episodic'));
    assert.ok(tiersSeen.has('semantic'));

    // Tier filter: episodic only.
    const rEp = searchMemory('alpha', fileList, 50, { tier_semantic: 'episodic' });
    assert.ok(rEp.length > 0, 'episodic filter returns results');
    for (const r of rEp) {
      assert.equal(r.tier_semantic, 'episodic',
        `expected episodic, got ${r.tier_semantic} for ${r.relpath}`);
    }

    // Tier filter: semantic only.
    const rSem = searchMemory('alpha', fileList, 50, { tier_semantic: 'semantic' });
    assert.ok(rSem.length > 0, 'semantic filter returns results');
    for (const r of rSem) {
      assert.equal(r.tier_semantic, 'semantic');
    }

    // Tier filter: working only.
    const rW = searchMemory('alpha', fileList, 50, { tier_semantic: 'working' });
    assert.ok(rW.length > 0);
    for (const r of rW) {
      assert.equal(r.tier_semantic, 'working');
    }

    // String shorthand also accepted.
    const rW2 = searchMemory('alpha', fileList, 50, 'working');
    for (const r of rW2) {
      assert.equal(r.tier_semantic, 'working');
    }
  } finally {
    if (db) closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Concurrent migration ---------------------------------------------------

test('D1 -- concurrent v1->v2 migration is BEGIN IMMEDIATE safe', async () => {
  const root = tmpRoot('d1-mem-concurrent');
  const N = 4;

  const fts5Path = join(__dirname, 'src', 'memory', 'fts5.js');
  const workerPath = join(root, 'worker.mjs');
  const worker = `
import { openDb, indexEntry, closeDb } from '${pathToFileURL(fts5Path).href}';
const projectRoot = process.argv[2];
const id = process.argv[3];
let db;
try {
  db = await openDb(projectRoot);
  for (let i = 0; i < 4; i++) {
    indexEntry(db, {
      body: 'writer=' + id + ' i=' + i + ' tier semantic concurrent migration check',
      source: 'worker-' + id + '/row-' + i,
      session_id: 'sess-' + id,
    });
  }
  const uv = db.prepare('PRAGMA user_version').get();
  console.log('OK ' + id + ' user_version=' + uv.user_version);
} catch (e) {
  console.error('FAIL ' + id + ' ' + (e && e.code) + ' ' + (e && e.message));
  process.exit(1);
} finally {
  try { closeDb(db); } catch {}
}
`;
  writeFileSync(workerPath, worker);

  const children = [];
  for (let i = 0; i < N; i++) {
    children.push(new Promise((resolveProc) => {
      const c = spawn(process.execPath, [workerPath, root, String(i)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
      let out = '', err = '';
      c.stdout.on('data', (d) => { out += d.toString('utf8'); });
      c.stderr.on('data', (d) => { err += d.toString('utf8'); });
      c.on('close', (code) => resolveProc({ code, out, err, id: i }));
    }));
  }

  const results = await Promise.all(children);
  for (const r of results) {
    const busy = /SQLITE_BUSY/i.test(r.out) || /SQLITE_BUSY/i.test(r.err);
    assert.equal(r.code, 0,
      `worker ${r.id} exit (out=${r.out.slice(0, 200)} err=${r.err.slice(0, 200)})`);
    assert.equal(busy, false, `worker ${r.id} no SQLITE_BUSY`);
    // Memory schema bumped to v3 by GA-B2 (stale_candidate column).
    // Assert worker landed at v2 OR newer so future migrations don't
    // churn this test. Pre-fix-wave callers expect v2 minimum.
    const versionMatch = r.out.match(/user_version=(\d+)/);
    assert.ok(versionMatch, `worker ${r.id} reports a user_version (out=${r.out.slice(0, 200)})`);
    assert.ok(Number(versionMatch[1]) >= 2,
      `worker ${r.id} ended at v>=2 (got ${versionMatch[1]})`);
  }

  let db;
  try {
    db = await openMemoryDb(root);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries`).get();
    assert.equal(Number(total.n), N * 4, 'all writers committed');
    // All inserted rows default to 'working'.
    const w = db.prepare(`SELECT COUNT(*) AS n FROM memory_entries WHERE tier_semantic = 'working'`).get();
    assert.equal(Number(w.n), N * 4);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Sentinel: archived no-op ---------------------------------------------

test('D1 -- Semantic -> archived is alpha no-op', async () => {
  const root = tmpRoot('d1-archive');
  let db;
  try {
    db = await openMemoryDb(root);
    const r = promoteSemanticToArchived(db);
    assert.deepEqual(r, { promoted: 0, errors: [] });
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- F4: Procedural promotion wired into dream runner ---------------------

test('F4 -- runner.mjs dispatches promoteWorkingToProcedural on every cycle', async () => {
  // Run the dream runner directly with a project root containing seeded
  // memory rows. The runner SHOULD invoke promoteWorkingToProcedural even
  // when there is no source data (zero-shape no-op call). We assert the
  // log line carrying "working->procedural=" lands in the dream log.
  const root = tmpRoot('f4-runner-procedural');
  try {
    // Seed memory db so tier-promotion has somewhere to consolidate.
    const db = await openMemoryDb(root);
    const sid = 'f4-session';
    db.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
    ).run('working memory entry one', 'src1', sid, Date.now(), TIERS.WORKING);
    closeDb(db);

    // Spawn the runner directly (single child, blocking, so we can read
    // the log file after it exits).
    const runnerPath = join(__dirname, 'src', 'dream', 'runner.mjs');
    const child = spawn(
      process.execPath,
      [runnerPath, '--project-root', root, '--host', 'test', '--reason', 'f4-test', '--session-id', sid],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    await new Promise((resolve) => {
      child.on('exit', () => resolve());
    });

    // Locate the dream log directory, then find the most recent log file.
    const logDir = join(root, '.ijfw', 'logs');
    if (!existsSync(logDir)) {
      throw new Error('runner did not create .ijfw/logs');
    }
    const { readdirSync, readFileSync } = await import('node:fs');
    const files = readdirSync(logDir).filter(f => f.startsWith('dream-')).sort();
    assert.ok(files.length >= 1, 'at least one dream-*.log file landed');
    const latest = files[files.length - 1];
    const log = readFileSync(join(logDir, latest), 'utf8');
    assert.match(log, /tier-promotion: working->episodic=.*episodic->semantic=.*working->procedural=/,
      'F4: runner log includes working->procedural dispatch line');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
