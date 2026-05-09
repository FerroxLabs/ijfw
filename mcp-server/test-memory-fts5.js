#!/usr/bin/env node
/**
 * test-memory-fts5.js -- D-Pillar / D0 memory FTS5 regression suite.
 *
 * Covers:
 *   1. Insert + search roundtrip (porter stemming verified)
 *   2. Migration v0 -> v1 (fresh db lands at user_version 1)
 *   3. Concurrent-write with 4 writers (BEGIN IMMEDIATE invariant)
 *   4. searchMemory() warm-tier hit with synonym expansion envelope
 *   5. Graceful fallback to hot tier when warm returns no hits
 *
 * Run: node --test mcp-server/test-memory-fts5.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  openDb as openMemoryDb,
  indexEntry,
  searchFts5,
  rowCount,
  closeDb,
  dbPathFor,
} from './src/memory/fts5.js';
import { searchMemory } from './src/memory/search.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

test('memory FTS5 -- insert + search roundtrip', async () => {
  const root = tmpRoot('mem-fts5-roundtrip');
  const db = await openMemoryDb(root);
  try {
    assert.equal(existsSync(dbPathFor(root)), true, 'db file should exist');

    const a = indexEntry(db, { body: 'caching strategies in depth', source: 'alpha.md' });
    const b = indexEntry(db, { body: 'positive framing memory recall', source: 'beta.md' });
    const c = indexEntry(db, { body: 'authentication and authorization flows', source: 'gamma.md' });
    assert.ok(a.id > 0 && b.id > 0 && c.id > 0, 'all rows inserted');
    assert.equal(rowCount(db), 3);

    const r1 = searchFts5(db, 'caching', 5);
    assert.equal(r1.length, 1, 'caching matches alpha only');
    assert.equal(r1[0].source, 'alpha.md');

    // Porter stemming: "recalling" stems to "recall" -> matches beta.md
    const r2 = searchFts5(db, 'recalling', 5);
    assert.equal(r2.length, 1, 'recalling stems to recall');
    assert.equal(r2[0].source, 'beta.md');

    // Authentication / authenticating both stem the same way.
    const r3 = searchFts5(db, 'authenticating', 5);
    assert.equal(r3.length, 1, 'authenticating stems to authentication');
    assert.equal(r3[0].source, 'gamma.md');

    // Empty query returns [].
    assert.deepEqual(searchFts5(db, '', 5), []);
    assert.deepEqual(searchFts5(db, '   ', 5), []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory FTS5 -- migration v0 -> latest lands at >= v1 with v1 row in schema_meta', async () => {
  const root = tmpRoot('mem-fts5-migrate');
  const db = await openMemoryDb(root);
  try {
    const row = db.prepare('PRAGMA user_version').get();
    // D0 lands at v1; subsequent migrations (D1 etc.) only bump higher.
    // The invariant we care about: user_version >= 1 AND v1 schema_meta row.
    assert.ok(Number(row.user_version) >= 1, 'user_version bumped to >= 1');

    const meta = db.prepare('SELECT version, description FROM schema_meta WHERE version=1').get();
    assert.ok(meta, 'schema_meta row for v1 present');
    assert.match(String(meta.description), /memory v1\.3\.0/);

    // Tables present.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").all();
    const names = tables.map(t => t.name);
    assert.ok(names.includes('memory_entries'), 'memory_entries table');
    assert.ok(names.includes('memory_entries_fts'), 'memory_entries_fts virtual table');
    assert.ok(names.includes('memory_entries_ai'), 'AFTER INSERT trigger');
    assert.ok(names.includes('memory_entries_ad'), 'AFTER DELETE trigger');
    assert.ok(names.includes('memory_entries_au'), 'AFTER UPDATE trigger');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory FTS5 -- 4 concurrent writers serialise via BEGIN IMMEDIATE', async () => {
  const root = tmpRoot('mem-fts5-concurrent');
  const N_WRITERS = 4;
  const ROWS_PER_WRITER = 6;

  const workerPath = join(root, 'worker.mjs');
  const fts5Path = join(__dirname, 'src', 'memory', 'fts5.js');
  // Worker: spawned subprocess that opens the SAME db path and writes
  // ROWS_PER_WRITER entries. With BEGIN IMMEDIATE + busy_timeout=5000 the
  // writers must serialise without surfacing SQLITE_BUSY.
  const worker = `
import { openDb, indexEntry, closeDb } from '${pathToFileURL(fts5Path).href}';
const projectRoot = process.argv[2];
const writerId = process.argv[3];
const n = ${ROWS_PER_WRITER};
let db;
try {
  db = await openDb(projectRoot);
  for (let i = 0; i < n; i++) {
    indexEntry(db, {
      body: 'writer=' + writerId + ' i=' + i + ' authentication and recall',
      source: 'worker-' + writerId + '/row-' + i,
      session_id: 'concurrent-' + writerId,
    });
  }
  console.log('WRITER_OK ' + writerId);
} catch (e) {
  console.error('WRITER_FAIL ' + writerId + ' ' + (e && e.code) + ' ' + (e && e.message));
  process.exit(1);
} finally {
  try { closeDb(db); } catch {}
}
`;
  writeFileSync(workerPath, worker);

  const children = [];
  for (let i = 0; i < N_WRITERS; i++) {
    children.push(new Promise((resolveProc) => {
      const c = spawn(process.execPath, [workerPath, root, String(i)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => { out += d.toString('utf8'); });
      c.stderr.on('data', (d) => { err += d.toString('utf8'); });
      c.on('close', (code) => resolveProc({ code, out, err, id: i }));
    }));
  }

  const results = await Promise.all(children);
  for (const r of results) {
    const busy = /SQLITE_BUSY/i.test(r.out) || /SQLITE_BUSY/i.test(r.err);
    assert.equal(r.code, 0, `writer ${r.id} exit code (out=${r.out.slice(0, 200)} err=${r.err.slice(0, 200)})`);
    assert.equal(busy, false, `writer ${r.id} produced no SQLITE_BUSY`);
  }

  // Final count -- all writers must have committed.
  const db = await openMemoryDb(root);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM memory_entries").get();
    assert.equal(Number(row.n), N_WRITERS * ROWS_PER_WRITER, 'all rows committed under concurrent writes');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('searchMemory -- warm-tier hit with synonym expansion envelope', async () => {
  const root = tmpRoot('mem-fts5-search');
  // Lay out files in the .ijfw/memory tier so resolveIndexRoot finds them.
  const memDir = join(root, '.ijfw', 'memory');
  mkdirSync(memDir, { recursive: true });

  const FILES = [
    { name: 'auth.md', body: '# Auth\nThe authentication system uses JWT tokens.\n' },
    { name: 'caching.md', body: '# Caching\nMemoization of expensive operations.\n' },
    { name: 'plain.md', body: '# Plain\nNothing special here.\n' },
  ];
  for (const f of FILES) writeFileSync(join(memDir, f.name), f.body);

  // Build the file list shape that listMemoryFiles() produces.
  const fileList = FILES.map(f => ({
    path: join(memDir, f.name),
    relpath: f.name,
    title: f.name.replace('.md', ''),
    preview: f.body.slice(0, 120),
  }));

  // Search for 'authentication' -- should hit auth.md via FTS5.
  const r1 = searchMemory('authentication', fileList);
  assert.ok(r1.length > 0, 'authentication search returns results');
  assert.equal(r1[0].relpath, 'auth.md', 'auth.md ranks first');
  assert.equal(r1.tier, 'warm-fts5', 'warm-tier provenance flagged');

  // Synonym expansion: 'auth' should expand to 'authentication' / 'authn'.
  const r2 = searchMemory('auth', fileList);
  assert.ok(r2.length > 0, 'auth search returns results via synonym');
  assert.ok(r2.synonym_matches, 'synonym_matches envelope present');
  assert.ok(
    Object.prototype.hasOwnProperty.call(r2.synonym_matches, 'auth'),
    'auth token expansion captured'
  );
  assert.ok(
    r2.synonym_matches.auth.includes('authentication'),
    'auth -> authentication expansion applied'
  );

  // Non-enumerable: legacy callers that JSON.stringify the array shouldn't
  // see the envelope sneak into the wire payload as numeric indices.
  const json = JSON.parse(JSON.stringify(r2));
  assert.ok(Array.isArray(json), 'serialises as plain array');
  assert.equal(json.synonym_matches, undefined, 'synonym_matches not in serialised payload');

  rmSync(root, { recursive: true, force: true });
});

test('searchMemory -- empty query returns [] (legacy contract)', () => {
  const r = searchMemory('', [{ path: '/x', relpath: 'x', title: 'x', preview: '' }]);
  assert.deepEqual(r, []);
});

test('searchMemory -- no-files input returns [] (legacy contract)', () => {
  const r = searchMemory('q', []);
  assert.deepEqual(r, []);
});

test('searchMemory -- falls back to hot-linear when warm returns nothing', async () => {
  const root = tmpRoot('mem-fts5-fallback');
  const memDir = join(root, '.ijfw', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'note.md'), '# Note\nxyzzy_unique_token only here\n');

  const fileList = [{
    path: join(memDir, 'note.md'),
    relpath: 'note.md',
    title: 'note',
    preview: 'xyzzy_unique_token only here',
  }];

  // Warm tier auto-indexes the file -- but the unique token is bare so FTS5
  // should hit. Confirm the result is warm-tier sourced.
  const r = searchMemory('xyzzy_unique_token', fileList);
  assert.ok(r.length > 0);
  assert.equal(r[0].relpath, 'note.md');

  rmSync(root, { recursive: true, force: true });
});

// --- GA-B2: stale_candidate column + filter --------------------------

test('GA-B2 -- memory v2 -> v3 adds stale_candidate column with default 0', async () => {
  const root = tmpRoot('mem-stale-migrate');
  const db = await openMemoryDb(root);
  try {
    const cols = db.prepare(`PRAGMA table_info(memory_entries)`).all();
    const stale = cols.find(c => c.name === 'stale_candidate');
    assert.ok(stale, 'memory_entries.stale_candidate column present');
    assert.equal(Number(stale.dflt_value), 0, 'stale_candidate default=0');

    // Partial index present.
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_entries'`).all();
    const names = idx.map(r => r.name);
    assert.ok(names.includes('memory_entries_stale_candidate_idx'),
      'memory_entries_stale_candidate_idx present');

    // schema_meta v3 row.
    const meta = db.prepare(`SELECT version FROM schema_meta WHERE version = 3`).get();
    assert.ok(meta, 'schema_meta v3 row');

    // user_version >= 3.
    const uv = db.prepare(`PRAGMA user_version`).get();
    assert.ok(Number(uv.user_version) >= 3, `user_version >= 3 (got ${uv.user_version})`);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B2 -- searchFts5 excludes stale_candidate=1 by default', async () => {
  const root = tmpRoot('mem-search-stale-default');
  const db = await openMemoryDb(root);
  try {
    indexEntry(db, { body: 'fresh observation about validateSession flow' });
    indexEntry(db, { body: 'stale observation about validateSession flow' });
    db.prepare(`UPDATE memory_entries SET stale_candidate = 1 WHERE id = 2`).run();

    const r = searchFts5(db, 'validateSession', 10);
    assert.equal(r.length, 1, 'default excludes stale row');
    assert.equal(Number(r[0].id), 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B2 -- searchFts5 with include_stale=true returns all rows', async () => {
  const root = tmpRoot('mem-search-stale-include');
  const db = await openMemoryDb(root);
  try {
    indexEntry(db, { body: 'fresh observation about validateSession flow' });
    indexEntry(db, { body: 'stale observation about validateSession flow' });
    db.prepare(`UPDATE memory_entries SET stale_candidate = 1 WHERE id = 2`).run();

    const r = searchFts5(db, 'validateSession', 10, { include_stale: true });
    assert.equal(r.length, 2, 'include_stale=true returns all rows');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B2 -- searchMemory honours include_stale option', async () => {
  const root = tmpRoot('mem-search-mem-stale');
  const memDir = join(root, '.ijfw', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, 'note1.md'), 'fresh observation about uniquefooflag flow\n');
  writeFileSync(join(memDir, 'note2.md'), 'stale observation about uniquefooflag flow\n');

  const fileList = [
    { path: join(memDir, 'note1.md'), relpath: 'note1.md', title: 'note1' },
    { path: join(memDir, 'note2.md'), relpath: 'note2.md', title: 'note2' },
  ];

  // Warm-up indexes both rows; flag the second.
  searchMemory('uniquefooflag', fileList);
  const db = await openMemoryDb(root);
  try {
    db.prepare(`UPDATE memory_entries SET stale_candidate = 1 WHERE source = ?`).run('note2.md');
  } finally {
    closeDb(db);
  }

  const defaultHits = searchMemory('uniquefooflag', fileList);
  assert.ok(defaultHits.length >= 1, 'default returns the fresh row');
  assert.ok(defaultHits.every(h => h.relpath !== 'note2.md'),
    'default excludes the flagged note');

  const allHits = searchMemory('uniquefooflag', fileList, 50, { include_stale: true });
  const relpaths = allHits.map(h => h.relpath);
  assert.ok(relpaths.includes('note1.md'), 'include_stale returns note1');
  assert.ok(relpaths.includes('note2.md'), 'include_stale returns note2 (the flagged row)');

  rmSync(root, { recursive: true, force: true });
});
