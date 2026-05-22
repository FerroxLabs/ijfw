/**
 * test-server-ingest.js — H5.5 + H5.6 integration tests.
 *
 * Verifies the wiring of fact-extractor and dedup into handleStore/handleRecall:
 *   1. handleStore triggers fact extraction → facts.jsonl appended.
 *   2. handleStore dedups near-duplicate content → second call returns
 *      `deduped: true` with the existing id, NO journal grow.
 *   3. handleRecall({context_hint:'facts'}) returns the appended facts.
 *
 * Drives the in-process exports rather than spawning a child MCP server.
 * CLAUDE_PROJECT_DIR is set before the dynamic import so PROJECT_DIR resolves
 * to a temp dir we can scrub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Allocate the temp project dir BEFORE importing server.js so PROJECT_DIR
// (a module-level const that snapshots env once) sees it.
const TMP_PROJECT = mkdtempSync(join(tmpdir(), 'ijfw-ingest-test-'));
process.env.CLAUDE_PROJECT_DIR = TMP_PROJECT;
// Ensure dedup defaults are clean for this test run regardless of caller env.
delete process.env.IJFW_DEDUP_OFF;
delete process.env.IJFW_DEDUP_THRESHOLD;
delete process.env.IJFW_DEDUP_WINDOW;
// Pre-create the .ijfw/memory dir so bootstrap doesn't race the first append.
mkdirSync(join(TMP_PROJECT, '.ijfw', 'memory'), { recursive: true });

// Dynamic import so the env mutation above is in place before module init.
const { handleStore, handleRecall, MEMORY_DIR, FACTS_FILE } = await import('./src/server.js');

function readJournalLines() {
  const p = join(MEMORY_DIR, 'project-journal.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(l => l.startsWith('- ['));
}

function readFactLines() {
  if (!existsSync(FACTS_FILE)) return [];
  return readFileSync(FACTS_FILE, 'utf8').split('\n').filter(Boolean);
}

test('handleStore: fact extraction populates facts.jsonl after journal append', () => {
  const journalBefore = readJournalLines().length;
  const factsBefore = readFactLines().length;
  const result = handleStore({
    content: 'owner: Sean Donahoe\nship date: 2026-07-04\nIJFW uses SQLite for warm tier',
    type: 'decision',
    summary: 'release ownership + stack note',
  });
  assert.equal(result.isError, undefined, `unexpected error: ${result.text}`);
  // Journal grew by one.
  assert.equal(readJournalLines().length, journalBefore + 1);
  // facts.jsonl grew by ≥ 3 (owner, ship_date, uses).
  const factLinesAfter = readFactLines();
  assert.ok(
    factLinesAfter.length >= factsBefore + 3,
    `expected ≥3 new facts, got ${factLinesAfter.length - factsBefore}`,
  );
  // Each appended fact must parse as JSON with the expected shape.
  const newFacts = factLinesAfter.slice(factsBefore).map(l => JSON.parse(l));
  for (const f of newFacts) {
    assert.equal(typeof f.subject, 'string');
    assert.equal(typeof f.predicate, 'string');
    assert.equal(typeof f.object, 'string');
    assert.equal(typeof f.confidence, 'number');
    assert.ok(f.memory_id && f.memory_id.startsWith('m-'));
    assert.equal(f.source, 'memory_store:decision');
  }
  // Spot-check that the owner fact came through.
  assert.ok(newFacts.some(f => f.predicate === 'owner' && /Sean/.test(f.object)));
});

test('handleStore: near-duplicate content returns deduped:true and skips append', () => {
  const journalBefore = readJournalLines().length;
  // First store — should append normally.
  const first = handleStore({
    content: 'decided to migrate ingest pipeline to streaming chunked uploader',
    type: 'decision',
    summary: 'streaming chunked uploader migration',
  });
  assert.equal(first.isError, undefined, `unexpected error: ${first.text}`);
  assert.equal(readJournalLines().length, journalBefore + 1, 'first store must append');

  // Near-duplicate — same summary tokens dominate the Jaccard ratio (the
  // journal entry shape is `**decision** ... : <summary or content prefix>`,
  // so reusing the summary guarantees a high overlap on what dedup actually
  // compares against).
  const dup = handleStore({
    content: 'decided to migrate ingest pipeline to streaming chunked uploader again, today',
    type: 'decision',
    summary: 'streaming chunked uploader migration',
  });
  assert.equal(dup.deduped, true, `expected deduped:true; got ${JSON.stringify(dup)}`);
  assert.ok(dup.existing_id, 'expected existing_id on dedup response');
  assert.ok(typeof dup.similarity === 'number' && dup.similarity >= 0.85);
  // Journal must NOT have grown.
  assert.equal(readJournalLines().length, journalBefore + 1, 'dedup must skip append');
});

test('handleStore + handleRecall({facts}): facts feed is queryable', () => {
  // Drop a recognizable structured memory then read it back via recall.
  handleStore({
    content: 'lead: Alice\nrelease date: 2027-01-15',
    type: 'observation',
    summary: 'lead + release dates for Q1',
  });
  const recall = handleRecall({ context_hint: 'facts' });
  assert.equal(recall.isError, undefined, `recall errored: ${recall.text}`);
  assert.match(recall.text, /"predicate":\s*"lead"/);
  assert.match(recall.text, /"object":\s*"Alice"/);
  assert.match(recall.text, /"predicate":\s*"release_date"/);
});

// v1.5.1 R4-H2 — the v1.5.0 memory-moat (M1 Obsidian indexing + M2 A-Mem
// auto-linking) only fired inside fts5.indexEntry, which the production
// writers never called. handleStore now mirrors every store into the FTS5
// warm tier via indexEntry, so a real ijfw_store call must populate the
// obsidian aux tables (memory_links / memory_tags / memory_meta) and fire
// the auto-linker — not just the benchmark harness.
test('handleStore: M1 obsidian indexing + M2 auto-link fire on the real write path', async () => {
  // Keep M2 deterministic: with no API key autoLink returns skipped cleanly,
  // which still proves the M2 dispatch is wired. We assert the dispatch
  // promise exists rather than asserting LLM-produced links.
  const result = handleStore({
    content:
      'Routing decision: see [[r4-synthesis]] and [[memory-moat]] for context. '
      + '#audit/round4 #memory/moat [owner:: Sean Donahoe].',
    type: 'decision',
    summary: 'memory-moat wiring decision',
  });
  assert.equal(result.isError, undefined, `unexpected error: ${result.text}`);

  // handleStore mirrors into FTS5 fire-and-forget; await the exposed promise
  // for deterministic completion before asserting on the aux tables.
  assert.ok(handleStore.__lastIndexPromise, 'expected an FTS5 index promise');
  const inserted = await handleStore.__lastIndexPromise;
  assert.ok(inserted && inserted.id != null, 'indexEntry must return a row id');

  // Open the per-project memory db directly and verify M1 wrote rows.
  const { openDb, closeDb } = await import('./src/memory/fts5.js');
  const db = await openDb(TMP_PROJECT);
  try {
    // M1: [[wikilinks]] -> memory_links
    const links = db
      .prepare('SELECT to_target FROM memory_links ORDER BY to_target')
      .all()
      .map((r) => r.to_target);
    assert.ok(links.includes('r4-synthesis'), `expected r4-synthesis link, got ${links}`);
    assert.ok(links.includes('memory-moat'), `expected memory-moat link, got ${links}`);

    // M1: #nested/tags -> memory_tags
    const tags = db
      .prepare('SELECT tag_path FROM memory_tags ORDER BY tag_path')
      .all()
      .map((r) => r.tag_path);
    assert.ok(tags.includes('audit/round4'), `expected audit/round4 tag, got ${tags}`);
    assert.ok(tags.includes('memory/moat'), `expected memory/moat tag, got ${tags}`);

    // M1: [key:: value] inline metadata -> memory_meta
    const meta = db
      .prepare("SELECT value FROM memory_meta WHERE key='owner'")
      .get();
    assert.ok(meta && /Sean/.test(meta.value), `expected owner meta, got ${JSON.stringify(meta)}`);

    // FTS5 warm-tier row exists for the stored entry.
    const entryCount = db
      .prepare('SELECT COUNT(*) AS c FROM memory_entries')
      .get().c;
    assert.ok(entryCount >= 1, 'expected at least one FTS5 memory_entries row');
  } finally {
    closeDb(db);
  }

  // M2: the auto-linker must have been dispatched inside indexEntry. With no
  // API key it resolves to { skipped: true, reason: 'no_key' } — still proof
  // the M2 wiring is live on the real write path (not just the benchmark).
  const fts5Mod = await import('./src/memory/fts5.js');
  assert.ok(
    fts5Mod.indexEntry.__lastAutoLinkPromise,
    'expected M2 autoLink to be dispatched by indexEntry on the real store path',
  );
  const linkResult = await fts5Mod.indexEntry.__lastAutoLinkPromise;
  assert.ok(linkResult, 'autoLink promise must resolve (skipped or applied)');
});

// v1.5.1 R4-H3 — handleStore must redact secret-shaped tokens before they
// land in .ijfw/memory/*.md. Without this, a secret pasted into a direct
// ijfw_store call persists cleartext and re-injects into every future recall.
test('handleStore: secrets are redacted before the markdown write', () => {
  const secret = 'sk-proj-' + 'A'.repeat(48);
  const result = handleStore({
    content: `Use this OpenAI key for the integration: ${secret}`,
    type: 'decision',
    summary: 'integration credential',
    why: `the secret is ${secret}`,
  });
  assert.equal(result.isError, undefined, `unexpected error: ${result.text}`);

  // The raw secret must NOT appear anywhere in the journal markdown.
  const journal = readFileSync(join(MEMORY_DIR, 'project-journal.md'), 'utf8');
  assert.ok(!journal.includes(secret), 'raw secret must not appear in project-journal.md');

  // The structured knowledge file (decision/pattern path) must also be clean
  // and carry the redaction label instead.
  const knowledgePath = join(MEMORY_DIR, 'knowledge.md');
  if (existsSync(knowledgePath)) {
    const knowledge = readFileSync(knowledgePath, 'utf8');
    assert.ok(!knowledge.includes(secret), 'raw secret must not appear in knowledge.md');
    assert.match(knowledge, /\[REDACTED/, 'expected a [REDACTED] label in knowledge.md');
  }
});

test('cleanup: scrub temp project dir', () => {
  rmSync(TMP_PROJECT, { recursive: true, force: true });
  // node:test will still exit because the readline interface goes idle once
  // no more tests run; explicit unref keeps the process from lingering on slow
  // CI hosts.
  if (process.stdin && typeof process.stdin.unref === 'function') {
    process.stdin.unref();
  }
});
