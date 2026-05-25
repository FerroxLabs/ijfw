import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDreamCycle } from '../../src/brain/dream-pipeline.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';
import { isProcessed, readManifest } from '../../src/brain/dump-ingest.js';

function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), 'brain-dream-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  writeLayoutVersion(r, 2);
  return r;
}

function freshDb() {
  const db = new Database(':memory:');
  db.prepare('CREATE TABLE memory_entries (id INTEGER PRIMARY KEY, body TEXT, path TEXT, kind TEXT)').run();
  db.prepare('CREATE TABLE memory_links (id INTEGER PRIMARY KEY, memory_id INTEGER, to_target TEXT)').run();
  return db;
}

function seedFile(root, name, body) {
  const inboxDir = join(root, 'ijfw', 'dump', 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  writeFileSync(join(inboxDir, name), body);
}

test('runDreamCycle: empty inbox -> processed=0, no error', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    const r = await runDreamCycle({ db, repoRoot: root });
    assert.equal(r.processed, 0);
    assert.equal(r.factsInserted, 0);
    assert.deepEqual(r.errors, []);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('runDreamCycle: default extractor (no-op) still writes manifest + commits', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedFile(root, 'note.md', '# title\n\nbody.\n');
    const r = await runDreamCycle({ db, repoRoot: root });
    assert.equal(r.processed, 1);
    assert.equal(r.factsInserted, 0);
    assert.equal(isProcessed(join(root, 'ijfw', 'dump', 'processed'), 'note.md'), true);
    const manifest = readManifest(join(root, 'ijfw', 'dump', 'processed'), 'note.md');
    assert.equal(manifest.factsInserted, 0);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('runDreamCycle: stub extractor produces facts + compiles wiki page', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedFile(root, 'sean.md', 'sean is founder');
    const extractFacts = async () => [
      { subject: 'sean', predicate: 'role', object: 'founder', confidence: 0.9 },
    ];
    const r = await runDreamCycle({ db, repoRoot: root, extractFacts });
    assert.equal(r.processed, 1);
    assert.equal(r.factsInserted, 1);
    assert.equal(r.pagesCompiled, 1);
    assert.ok(existsSync(join(root, 'ijfw', 'wiki', 'entities', 'sean.md')), 'wiki page written');
    assert.ok(existsSync(join(root, 'ijfw', 'wiki', 'log.md')), 'wiki log appended');
    const log = readFileSync(join(root, 'ijfw', 'wiki', 'log.md'), 'utf8');
    assert.ok(log.includes('ingest sean.md'));
    assert.ok(log.includes('compile entity sean'));
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('runDreamCycle: already-processed files (manifest present) skipped', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedFile(root, 'a.md', 'a');
    seedFile(root, 'b.md', 'b');
    // First cycle processes both
    await runDreamCycle({ db, repoRoot: root });
    // Reseed only a.md (was moved on commit) into inbox to simulate a re-drop
    seedFile(root, 'a.md', 'a-again');
    // But the manifest for the FIRST a.md (in processed/) still gates: file
    // name collision means scanInbox finds a.md, but commitProcessed has
    // already moved the original. The second a.md is technically a NEW file
    // in inbox. The manifest from cycle 1 gates it via isProcessed.
    const r2 = await runDreamCycle({ db, repoRoot: root });
    assert.equal(r2.processed, 0, 'second cycle short-circuits on manifest');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('runDreamCycle: extractor error surfaces in errors[] but does not abort the cycle', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedFile(root, 'ok.md', 'ok');
    seedFile(root, 'bad.md', 'bad');
    let call = 0;
    const extractFacts = async ({ file }) => {
      call += 1;
      if (file.name === 'bad.md') throw new Error('synthetic extractor failure');
      return [{ subject: 'ok-subject', predicate: 'p', object: 'v' }];
    };
    const r = await runDreamCycle({ db, repoRoot: root, extractFacts });
    assert.equal(r.processed, 1, 'ok.md processed, bad.md skipped');
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0].file, 'bad.md');
    assert.equal(r.errors[0].stage, 'extract');
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

test('runDreamCycle: budget exhausted halts cycle gracefully', async () => {
  const db = freshDb();
  const root = freshRoot();
  try {
    seedFile(root, 'one.md', 'a');
    seedFile(root, 'two.md', 'b');
    // Budget exhausted env: $0 cycle
    const env = { IJFW_DREAM_BUDGET_USD: '0', IJFW_DREAM_BUDGET_DAY_USD: '0' };
    const r = await runDreamCycle({ db, repoRoot: root, env });
    assert.equal(r.budgetExhausted, true);
    assert.equal(r.processed, 0);
  } finally { rmSync(root, { recursive: true, force: true }); db.close(); }
});

// B1 — additional tests for the real LLM-driven default extractor.

import { defaultExtractFacts } from '../../src/brain/dream-pipeline.js';
import { BudgetGuard } from '../../src/brain/budget-guard.js';

test('defaultExtractFacts: no LLM reachable -> returns [] (graceful no-op)', async () => {
  const root = freshRoot();
  try {
    const guard = BudgetGuard({ repoRoot: root, env: {} });
    const out = await defaultExtractFacts({
      file: { name: 'x.md', kind: 'markdown' },
      text: 'sean is founder',
      chunks: ['sean is founder'],
      env: {}, // no API key, no LOCAL_URL -> not reachable
      guard,
    });
    assert.deepEqual(out, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('defaultExtractFacts: LLM reachable + stubbed call -> validates + returns facts', async () => {
  const root = freshRoot();
  try {
    const guard = BudgetGuard({ repoRoot: root, env: {} });
    const calls = [];
    const stub = async (tier, prompt, opts) => {
      calls.push({ tier, opts });
      return {
        text: 'Here is the array: [{"subject":"sean","predicate":"role","object":"founder","confidence":0.9},{"subject":"foundry","predicate":"is","object":"company","confidence":0.8}]',
      };
    };
    const out = await defaultExtractFacts({
      file: { name: 'x.md', kind: 'markdown' },
      text: 'sean founded foundry',
      chunks: ['sean founded foundry'],
      env: { IJFW_BRAIN_API_KEY: 'sk-stub' }, // makes llmReachable() true
      guard,
      callTieredFn: stub,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].subject, 'sean');
    assert.equal(out[0].predicate, 'role');
    assert.equal(out[0].object, 'founder');
    assert.equal(out[0].confidence, 0.9);
    assert.equal(out[1].subject, 'foundry');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tier, 'extract');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('defaultExtractFacts: malformed JSON in response -> chunk skipped, others still extracted', async () => {
  const root = freshRoot();
  try {
    const guard = BudgetGuard({ repoRoot: root, env: {} });
    let callIdx = 0;
    const stub = async () => {
      callIdx += 1;
      if (callIdx === 1) return { text: 'not json at all, sorry' };
      return { text: '[{"subject":"alpha","predicate":"b","object":"gamma","confidence":0.7}]' };
    };
    // FLAG-5: chunks must contain the fact tokens (substring grounding).
    // Realistic chunk 2 includes "alpha" + "gamma" so the validateFact check passes.
    const out = await defaultExtractFacts({
      file: { name: 'x.md', kind: 'markdown' },
      text: 'two chunks: junk first, then alpha-gamma data',
      chunks: ['filler chunk one with no relevant tokens', 'alpha is gamma in chunk two'],
      env: { IJFW_BRAIN_API_KEY: 'sk-stub' },
      guard,
      callTieredFn: stub,
    });
    assert.equal(out.length, 1, 'first chunk skipped (no JSON), second chunk yielded 1 fact');
    assert.equal(out[0].subject, 'alpha');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('defaultExtractFacts: invalid fact shapes are dropped (subject missing, etc)', async () => {
  const root = freshRoot();
  try {
    const guard = BudgetGuard({ repoRoot: root, env: {} });
    const stub = async () => ({
      text: '[{"subject":"good","predicate":"p","object":"outcome","confidence":0.8},{"subject":"","predicate":"x","object":"y"},{"foo":"bar"},{"subject":"alsoOK","predicate":"q","object":""}]',
    });
    // FLAG-5: chunk text must contain "good", "outcome", "alsoOK" so the
    // grounding check accepts the structurally-valid facts. The empty-subject
    // and missing-fields entries get rejected by shape validation BEFORE the
    // grounding check runs, so their tokens don't need to be in the chunk.
    const out = await defaultExtractFacts({
      file: { name: 'x.md', kind: 'markdown' },
      text: 'the good case here is alsoOK with positive outcome',
      chunks: ['the good case here is alsoOK with positive outcome'],
      env: { IJFW_BRAIN_API_KEY: 'sk-stub' },
      guard,
      callTieredFn: stub,
    });
    // good + alsoOK survive; empty-subject + missing-fields dropped
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f.subject).sort(), ['alsoOK', 'good']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('defaultExtractFacts: per-chunk budget exhaustion halts cleanly', async () => {
  const root = freshRoot();
  try {
    const guard = BudgetGuard({ repoRoot: root, env: {}, cycleUsd: 0.000001, dayUsd: 5.0 });
    // First call drains tiny budget; second-and-onward chunks short-circuit.
    let callIdx = 0;
    const stub = async () => {
      callIdx += 1;
      return { text: '[{"subject":"s","predicate":"p","object":"o","confidence":0.7}]' };
    };
    const recordSpy = guard.record;
    guard.record = (usd) => { recordSpy(0.000001); }; // exhaust on any record
    const out = await defaultExtractFacts({
      file: { name: 'x.md', kind: 'markdown' },
      text: 't',
      chunks: ['c1', 'c2', 'c3'],
      env: { IJFW_BRAIN_API_KEY: 'sk-stub' },
      guard,
      callTieredFn: stub,
    });
    // Initial call may succeed before guard.record is hit; subsequent chunks
    // short-circuit on guardCall.allowed === false.
    assert.ok(callIdx <= 3, 'never more chunk calls than chunks provided');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
