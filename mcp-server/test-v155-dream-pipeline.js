/**
 * test-v155-dream-pipeline.js — regression coverage for v1.5.5 deep-dive
 * findings against `src/dream/stage-runner.js`, `src/dream/state-file.js`,
 * and `src/brain/dream-pipeline.js`.
 *
 * Covers:
 *   - V155-005 (HIGH): markStageCompleted inspects `extras.error|skipped`
 *     and routes to `status:'skipped'|'completed_with_error'` instead of
 *     unconditional 'completed'.
 *   - V155-020 (HIGH): re-ingest with manifest removed (rm -rf processed/)
 *     no longer double-inserts facts — `isProcessedDouble` cross-checks
 *     the facts table for any row whose `source = file.name`.
 *   - V155-038 (MED): concurrent `runDreamCycle` invocations serialise
 *     via the project-scope `.dream-cycle.lock` instead of racing.
 *   - V155-039 (MED): `appendLog` refuses symlink targets via O_NOFOLLOW,
 *     closing the lstat → appendFileSync TOCTOU window.
 *
 * Run: node --test test-v155-dream-pipeline.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { runStages } from './src/dream/stage-runner.js';
import { readDreamState } from './src/dream/state-file.js';
import { runDreamCycle } from './src/brain/dream-pipeline.js';
import { writeLayoutVersion } from './src/brain/layout-sentinel.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'v155-dream-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  // Bless the fixture as a real project so the dream-pipeline seed gate
  // (shouldSeedProject) lets it run. `.ijfw/project` is the `ijfw init` marker.
  writeFileSync(join(r, '.ijfw', 'project'), '# test fixture: blessed project');
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

// ===========================================================================
// V155-005 — stage-runner does not mark skipped/errored as 'completed'
// ===========================================================================

test('V155-005: stage returning {skipped} is recorded as status:skipped', async () => {
  const root = freshRoot();
  try {
    await runStages(root, [
      { name: 'a', run: async () => ({ skipped: 'db-unavailable' }) },
    ]);
    const s = readDreamState(root);
    assert.equal(s.stages.a.status, 'skipped',
      `stage status must be 'skipped', got ${s.stages.a.status}`);
    assert.equal(s.stages.a.skipped, 'db-unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V155-005: stage returning {error} is recorded as completed_with_error', async () => {
  const root = freshRoot();
  try {
    await runStages(root, [
      { name: 'b', run: async () => ({ error: 'tier-promotion-failed' }) },
    ]);
    const s = readDreamState(root);
    assert.equal(s.stages.b.status, 'completed_with_error');
    assert.equal(s.stages.b.error, 'tier-promotion-failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('V155-005: clean stage stays status:completed (back-compat)', async () => {
  const root = freshRoot();
  try {
    await runStages(root, [
      { name: 'c', run: async () => ({ ok: true, rows: 42 }) },
    ]);
    const s = readDreamState(root);
    assert.equal(s.stages.c.status, 'completed');
    assert.equal(s.stages.c.rows, 42);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ===========================================================================
// V155-020 — re-ingest with manifest removed does NOT double-insert facts
// ===========================================================================

test('V155-020: re-ingest after rm -rf processed/ leaves fact count unchanged', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    // Plant one inbox file (markdown, plain text — extractFile handles .md).
    const inboxDir = join(root, 'ijfw', 'dump', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'note.md'), 'Sean is the founder of IJFW.\n');

    // Custom extractor returns one fact (avoids needing LLM).
    const extractFacts = async () => [
      { subject: 'sean', predicate: 'role', object: 'founder', confidence: 0.9 },
    ];

    // First cycle.
    await runDreamCycle({ db, repoRoot: root, extractFacts, env: {} });
    const firstCount = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    assert.ok(firstCount >= 1, 'first cycle inserts at least one fact');

    // OPERATOR CATASTROPHE: blow away processed/ AND re-plant the same file
    // (manifest is gone, but the source file is back in inbox/). Without
    // V155-020, the second cycle would re-extract + re-insert.
    const processedDir = join(root, 'ijfw', 'dump', 'processed');
    rmSync(processedDir, { recursive: true, force: true });
    writeFileSync(join(inboxDir, 'note.md'), 'Sean is the founder of IJFW.\n');

    await runDreamCycle({ db, repoRoot: root, extractFacts, env: {} });
    const secondCount = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    assert.equal(secondCount, firstCount,
      `re-ingest must not double facts: first=${firstCount}, second=${secondCount}`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// V155-038 — concurrent runDreamCycle invocations serialise via lock
// ===========================================================================

test('V155-038: two concurrent runDreamCycle calls extract each file exactly once', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    const inboxDir = join(root, 'ijfw', 'dump', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'race.md'), 'Sean writes IJFW.\n');

    let extractorCallCount = 0;
    const extractFacts = async () => {
      extractorCallCount += 1;
      return [
        { subject: 'sean', predicate: 'role', object: 'author', confidence: 0.9 },
      ];
    };

    // Two concurrent triggers — without V155-038's lock, BOTH would call
    // the extractor (LLM cost doubles) and BOTH would insert facts.
    const [r1, r2] = await Promise.all([
      runDreamCycle({ db, repoRoot: root, extractFacts, env: {} }),
      runDreamCycle({ db, repoRoot: root, extractFacts, env: {} }),
    ]);

    // The extractor must have fired EXACTLY ONCE.
    assert.equal(extractorCallCount, 1,
      `extractor called ${extractorCallCount} times; lock should serialise to 1`);

    // Combined, exactly one file processed.
    const combinedProcessed = (r1.processed || 0) + (r2.processed || 0);
    assert.equal(combinedProcessed, 1,
      `processed total = ${combinedProcessed}; file must be processed once`);

    // Fact count = 1 (no duplicate insert).
    const count = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n;
    assert.equal(count, 1, `facts count = ${count}; expected exactly 1`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// V155-039 — appendLog refuses symlink targets via O_NOFOLLOW
// ===========================================================================

test('V155-039: appendLog refuses to write through a symlink (O_NOFOLLOW)', async () => {
  if (process.platform === 'win32') return; // symlinks require admin on Windows
  const db = freshDb();
  const root = freshRoot();
  let externalTarget;
  try {
    // Plant a wiki log path that is a symlink pointing OUTSIDE the repo.
    const wikiLogPath = join(root, 'ijfw', 'wiki', 'log.md');
    mkdirSync(join(root, 'ijfw', 'wiki'), { recursive: true });
    externalTarget = mkdtempSync(join(tmpdir(), 'v155-039-extern-'));
    const externalFile = join(externalTarget, 'innocent.txt');
    writeFileSync(externalFile, 'before\n');
    symlinkSync(externalFile, wikiLogPath);

    // Run a cycle that would log to wikiLogPath — without V155-039, the
    // append would follow the symlink and write to externalFile.
    const inboxDir = join(root, 'ijfw', 'dump', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, 'note.md'), 'IJFW is a Node project.\n');

    const extractFacts = async () => [
      { subject: 'ijfw', predicate: 'kind', object: 'node-project', confidence: 0.9 },
    ];
    await runDreamCycle({ db, repoRoot: root, extractFacts, env: {} });

    // External target must be unchanged — O_NOFOLLOW refused the symlink follow.
    const ext = readFileSync(externalFile, 'utf8');
    assert.equal(ext, 'before\n',
      `external file content must be untouched; got: ${JSON.stringify(ext)}`);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (externalTarget) rmSync(externalTarget, { recursive: true, force: true });
  }
});
