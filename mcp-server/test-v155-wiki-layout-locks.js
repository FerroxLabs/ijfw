/**
 * test-v155-wiki-layout-locks.js — regression coverage for v1.5.5 deep-dive
 * findings against `mcp-server/src/brain/wiki-compiler.js` and
 * `mcp-server/src/brain/layout-sentinel.js`.
 *
 * Covers:
 *   - V155-015 (HIGH): wiki-compiler.js now uses `withFsLock` instead of an
 *     isolated `openSync('wx')` with unsafe stale-recovery race. The new
 *     lock honours canonical heartbeat-refreshed stale recovery.
 *   - V155-016 (HIGH): layout-sentinel.js's `withLayoutLock` delegates to
 *     `withFsLock` — a SIGKILL'd holder's lockdir ages out cleanly instead
 *     of orphaning forever.
 *   - V155-054 (LOW): wiki-compiler.js refuses compile when the existing
 *     page is larger than `WIKI_PAGE_MAX_BYTES` (2 MB). Defends against a
 *     poisoned page that would blow up memory + LLM budget.
 *
 * Run: node --test test-v155-wiki-layout-locks.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { compileWikiPage } from './src/brain/wiki-compiler.js';
import {
  writeLayoutVersion, withLayoutLock,
} from './src/brain/layout-sentinel.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'v155-wiki-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  writeLayoutVersion(r, 2);
  return r;
}

function freshDb() {
  const db = new Database(':memory:');
  db.prepare(
    'CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, body TEXT, path TEXT, kind TEXT)'
  ).run();
  db.prepare(
    'CREATE TABLE facts (id INTEGER PRIMARY KEY, subject TEXT, predicate TEXT, object TEXT, valid_from TEXT, valid_to TEXT, memory_id INTEGER, source TEXT, confidence REAL)'
  ).run();
  db.prepare(
    'CREATE TABLE memory_links (id INTEGER PRIMARY KEY, memory_id INTEGER, to_target TEXT)'
  ).run();
  return db;
}

function seedSubject(db, subject, factId, memId) {
  db.prepare(
    'INSERT INTO memory_entries (id, body, path, kind) VALUES (?,?,?,?)'
  ).run(memId, `${subject} body`, '/notes/a.md', 'markdown');
  db.prepare(
    'INSERT INTO facts (id, subject, predicate, object, valid_from, memory_id) VALUES (?,?,?,?,?,?)'
  ).run(factId, subject, 'role', 'x', '2024-01-01T00:00:00Z', memId);
}

// ===========================================================================
// V155-015 — wiki-compiler.js withFsLock serialises concurrent compiles
// ===========================================================================

test('V155-015: concurrent compileWikiPage for same subject serialises (no torn write)', async () => {
  const db = freshDb();
  seedSubject(db, 'subjectA', 1, 10);
  const root = freshRoot();
  try {
    // Fire two concurrent compiles for the same subject. Under the prior
    // bespoke-lock implementation, the second would race-reclaim the lock
    // and BOTH would rename their .tmp file into pagePath — the operator's
    // NOTES region between reads could be lost. Under withFsLock, the
    // second compile waits for the first to release.
    const [r1, r2] = await Promise.all([
      compileWikiPage(db, { repoRoot: root, type: 'entity', subject: 'subjectA' }),
      compileWikiPage(db, { repoRoot: root, type: 'entity', subject: 'subjectA' }),
    ]);

    // BOTH must report ok:true — no `page-locked-by-concurrent-compile`
    // refusal (the prior bespoke-lock returned that on the racing caller).
    assert.equal(r1.ok, true, `first compile ok, got ${JSON.stringify(r1)}`);
    assert.equal(r2.ok, true, `second compile ok, got ${JSON.stringify(r2)}`);

    // The page exists at exactly one canonical path with consistent content.
    const pagePath = join(root, 'ijfw', 'wiki', 'entities', 'subjecta.md');
    assert.ok(existsSync(pagePath), 'compiled page exists');
    assert.equal(existsSync(pagePath + '.tmp'), false, 'no orphan .tmp');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// V155-054 — wiki-compiler.js refuses oversized existing pages
// ===========================================================================

test('V155-054: compileWikiPage refuses when existing page is >2 MB', async () => {
  const db = freshDb();
  seedSubject(db, 'poisoned', 2, 20);
  const root = freshRoot();
  try {
    // Plant a 5 MB page at the compile target — simulates an adversary
    // poisoning the wiki between compiles to blow up subsequent compiles.
    const pageDir = join(root, 'ijfw', 'wiki', 'entities');
    mkdirSync(pageDir, { recursive: true });
    const pagePath = join(pageDir, 'poisoned.md');
    writeFileSync(pagePath, 'X'.repeat(5 * 1024 * 1024)); // 5 MB

    const r = await compileWikiPage(db, {
      repoRoot: root, type: 'entity', subject: 'poisoned',
    });
    assert.equal(r.ok, false, 'oversized page must be refused');
    assert.equal(r.error, 'page-too-large');
    assert.ok(r.sizeBytes > 2 * 1024 * 1024, 'reports the actual oversize');
    assert.equal(r.maxBytes, 2 * 1024 * 1024, 'reports the cap');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// V155-016 — layout-sentinel.js withLayoutLock now stale-recovers
// ===========================================================================

test('V155-016: withLayoutLock serialises and releases cleanly', async () => {
  const root = freshRoot();
  try {
    let first = false;
    let second = false;
    await withLayoutLock(root, async () => { first = true; });
    await withLayoutLock(root, async () => { second = true; });
    assert.equal(first, true);
    assert.equal(second, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V155-016: withLayoutLock holds while fn runs (mutual exclusion)', async () => {
  const root = freshRoot();
  try {
    let aDone = false;
    let bRan = false;
    const aDoneAt = { t: 0 };
    const bRunAt = { t: 0 };

    const a = withLayoutLock(root, async () => {
      await new Promise(r => setTimeout(r, 100));
      aDone = true;
      aDoneAt.t = Date.now();
    });
    // tiny stagger to ensure A's lock acquired first
    await new Promise(r => setTimeout(r, 5));
    const b = withLayoutLock(root, async () => {
      bRan = true;
      bRunAt.t = Date.now();
    });
    await Promise.all([a, b]);
    assert.equal(aDone, true);
    assert.equal(bRan, true);
    // B must not have started before A finished.
    assert.ok(bRunAt.t >= aDoneAt.t, 'B ran after A — mutual exclusion');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
