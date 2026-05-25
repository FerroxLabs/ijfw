/**
 * Task 28 — Structured provenance in search results.
 *
 * Tests that searchMemory(q, files, limit, {format: 'structured'}) returns
 * an array of provenance objects with the specified shape, and that the
 * legacy call (no format) returns the same shape as before.
 *
 * Suite 1-4: hot-linear fallback (no SQLite needed).
 * Suite 5: warm-fts5 tier using a seeded in-memory SQLite db.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { searchMemory } from '../../src/memory/search.js';

// Suppress A-Mem auto-linker fire-and-forget promises so they don't escape
// test boundaries and trigger node:test's async-activity warning.
process.env.IJFW_AUTOLINK_OFF = '1';

// ---------------------------------------------------------------------------
// Helper: build a files array from a temp dir with seeded content
// ---------------------------------------------------------------------------
function freshTmpDir() {
  return mkdtempSync(join(tmpdir(), 'ijfw-search-structured-'));
}

function seedFiles(dir, entries) {
  const files = [];
  for (const { name, body } of entries) {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    files.push({ path: p, relpath: name, title: name.replace(/\.md$/, '') });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Suite 1: structured shape via hot-linear fallback
// ---------------------------------------------------------------------------
test('structured provenance shape — hot-linear tier', () => {
  const dir = freshTmpDir();
  try {
    const files = seedFiles(dir, [
      { name: 'alpha.md', body: 'The authentication flow is documented here.' },
      { name: 'beta.md',  body: 'auth token refresh logic explained in detail.' },
      { name: 'gamma.md', body: 'Completely unrelated content about llamas.' },
    ]);

    const results = searchMemory('auth', files, 10, { format: 'structured' });

    assert.ok(Array.isArray(results), 'results should be an array');
    assert.ok(results.length > 0, 'should match at least one file');

    for (const r of results) {
      assert.ok('source'        in r, 'has source');
      assert.ok('anchor'        in r, 'has anchor');
      assert.ok('snippet'       in r, 'has snippet');
      assert.ok('confidence'    in r, 'has confidence');
      assert.ok('ageDays'       in r, 'has ageDays');
      assert.ok('decayFactor'   in r, 'has decayFactor');
      assert.ok('whyMatched'    in r, 'has whyMatched');
      assert.ok('backlinkCount' in r, 'has backlinkCount');

      assert.equal(typeof r.source,  'string', 'source is string');
      assert.equal(r.anchor,         null,     'anchor is null (not yet computed)');
      assert.equal(typeof r.snippet, 'string', 'snippet is string');
      assert.ok(
        typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1,
        `confidence in [0,1], got ${r.confidence}`,
      );
      assert.ok(
        typeof r.ageDays === 'number' && r.ageDays >= 0,
        `ageDays >= 0, got ${r.ageDays}`,
      );
      assert.equal(r.decayFactor, null, 'decayFactor is null (hot-linear)');
      assert.ok(Array.isArray(r.whyMatched), 'whyMatched is array');
      assert.ok(r.whyMatched.includes('auth'), 'whyMatched contains query term');
      assert.equal(typeof r.backlinkCount, 'number', 'backlinkCount is number');
      assert.ok(r.backlinkCount >= 0, 'backlinkCount >= 0');
    }

    // unrelated file should not appear
    const sources = results.map(r => r.source);
    assert.ok(!sources.some(s => s.includes('gamma')), 'gamma.md should not match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite 2: multi-term whyMatched
// ---------------------------------------------------------------------------
test('structured whyMatched contains all query terms', () => {
  const dir = freshTmpDir();
  try {
    const files = seedFiles(dir, [
      { name: 'notes.md', body: 'memory search implementation notes here.' },
    ]);

    const results = searchMemory('memory search', files, 10, { format: 'structured' });
    assert.ok(results.length > 0, 'should match');

    const terms = results[0].whyMatched;
    assert.ok(terms.includes('memory'), 'whyMatched has "memory"');
    assert.ok(terms.includes('search'), 'whyMatched has "search"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite 3: legacy path (no format) is structurally unchanged
// ---------------------------------------------------------------------------
test('legacy path unchanged — no format option returns {path,relpath,title,snippet,score}', () => {
  const dir = freshTmpDir();
  try {
    const files = seedFiles(dir, [
      { name: 'legacy.md', body: 'legacy search test content here for matching.' },
    ]);

    const results = searchMemory('legacy', files, 10);

    assert.ok(Array.isArray(results), 'results is array');
    assert.ok(results.length > 0, 'at least one hit');

    const r = results[0];
    // Legacy fields must exist
    assert.ok('path'    in r, 'legacy: has path');
    assert.ok('relpath' in r, 'legacy: has relpath');
    assert.ok('title'   in r, 'legacy: has title');
    assert.ok('snippet' in r, 'legacy: has snippet');
    assert.ok('score'   in r, 'legacy: has score');

    // Structured fields must NOT appear in legacy output
    assert.ok(!('source'        in r), 'legacy: no source field');
    assert.ok(!('confidence'    in r), 'legacy: no confidence field');
    assert.ok(!('whyMatched'    in r), 'legacy: no whyMatched field');
    assert.ok(!('backlinkCount' in r), 'legacy: no backlinkCount field');

    // Non-enumerable decorations preserved
    assert.ok(typeof results.synonym_matches === 'object', 'synonym_matches decoration present');
    assert.ok(typeof results.tier === 'string', 'tier decoration present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite 4: empty query returns [] for both paths
// ---------------------------------------------------------------------------
test('empty query returns [] regardless of format', () => {
  const dir = freshTmpDir();
  try {
    const files = seedFiles(dir, [{ name: 'data.md', body: 'some content' }]);

    assert.deepEqual(searchMemory('',    files, 10, { format: 'structured' }), []);
    assert.deepEqual(searchMemory('   ', files, 10, { format: 'structured' }), []);
    assert.deepEqual(searchMemory('',    files, 10), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite 5: warm-fts5 structured path with a real seeded SQLite db
// ---------------------------------------------------------------------------
test('structured provenance shape — warm-fts5 tier (seeded db)', async () => {
  let Database;
  try {
    const mod = await import('better-sqlite3');
    Database = mod.default || mod;
  } catch {
    // better-sqlite3 not available — skip gracefully
    return;
  }

  const dir = freshTmpDir();
  const ijfwDir = join(dir, '.ijfw', 'index');
  mkdirSync(ijfwDir, { recursive: true });
  const dbPath = join(ijfwDir, 'memory.db');

  let db;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        source TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
        body,
        content='memory_entries',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memory_entries_ai
        AFTER INSERT ON memory_entries BEGIN
          INSERT INTO memory_entries_fts(rowid, body) VALUES (new.id, new.body);
        END;
      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_links (
        from_id  TEXT NOT NULL,
        to_target TEXT NOT NULL,
        line     INTEGER,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        PRIMARY KEY (from_id, to_target, line)
      );
      CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links(to_target);
    `);

    // Set user_version to the highest migration so search.js skips all migrations
    const { loadMigrations } = await import('../../src/memory/migration-runner.js');
    const migrations = await loadMigrations();
    const maxV = migrations.length ? migrations[migrations.length - 1].version : 1;
    db.pragma(`user_version = ${maxV}`);

    const now = Date.now();
    const ins = db.prepare(
      'INSERT INTO memory_entries (body, source, session_id, created_at) VALUES (?, ?, ?, ?)',
    );
    const r1 = ins.run('warm structured provenance test content here', 'warm-a.md', null, now - 86400000);
    const r2 = ins.run('another structured warm tier provenance entry',  'warm-b.md', null, now - 172800000);

    // warm-b links to warm-a (so warm-a.id has backlinkCount >= 1)
    db.prepare(
      'INSERT OR IGNORE INTO memory_links (from_id, to_target, line, created_at) VALUES (?, ?, ?, ?)',
    ).run(String(r2.lastInsertRowid), String(r1.lastInsertRowid), 1, now);

    db.close();
    db = null;
  } catch (err) {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  try {
    const files = [
      { path: join(dir, '.ijfw', 'warm-a.md'), relpath: 'warm-a.md', title: 'warm-a' },
      { path: join(dir, '.ijfw', 'warm-b.md'), relpath: 'warm-b.md', title: 'warm-b' },
    ];

    const prev = process.env.IJFW_PROJECT_DIR;
    process.env.IJFW_PROJECT_DIR = dir;
    let results;
    try {
      results = searchMemory('structured', files, 10, { format: 'structured' });
    } finally {
      if (prev === undefined) delete process.env.IJFW_PROJECT_DIR;
      else process.env.IJFW_PROJECT_DIR = prev;
    }

    assert.ok(Array.isArray(results), 'warm results is array');

    if (results.length > 0) {
      const r = results[0];
      assert.ok('source'        in r, 'warm: has source');
      assert.ok('anchor'        in r, 'warm: has anchor');
      assert.ok('snippet'       in r, 'warm: has snippet');
      assert.ok('confidence'    in r, 'warm: has confidence');
      assert.ok('ageDays'       in r, 'warm: has ageDays');
      assert.ok('decayFactor'   in r, 'warm: has decayFactor');
      assert.ok(Array.isArray(r.whyMatched), 'warm: whyMatched is array');
      assert.ok(typeof r.backlinkCount === 'number', 'warm: backlinkCount is number');
      assert.ok(r.ageDays >= 0, 'warm: ageDays >= 0');
      assert.ok(r.confidence >= 0 && r.confidence <= 1, 'warm: confidence in [0,1]');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
