#!/usr/bin/env node
/**
 * test-deviation-patterns.js — IJFW v1.5.0 W12-C N04
 *
 * Tests for derivePattern / recordDeviation / readDeviationPatterns.
 * Uses isolated temp project roots; never touches real ~/.ijfw state.
 *
 * Lock-in #48: memory feeds forward — every BLOCKED / 3-attempt-cap-hit /
 * cross-AI divergence writes a memory entry the next phase's planner reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  derivePattern,
  recordDeviation,
  readDeviationPatterns,
} from './src/memory-feedback.js';

async function makeProj(label) {
  return mkdtemp(join(tmpdir(), `ijfw-dev-${label}-`));
}
async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

// --- derivePattern --------------------------------------------------------

test('derivePattern: test-fixture-drift category', () => {
  assert.equal(derivePattern('expected 5 got 3'), 'test-fixture-drift');
  assert.equal(derivePattern('Test failed: assertion error'), 'test-fixture-drift');
});

test('derivePattern: flaky-infra category', () => {
  assert.equal(derivePattern('socket ECONNRESET reading from peer'), 'flaky-infra');
  assert.equal(derivePattern('timeout after 30s'), 'flaky-infra');
  assert.equal(derivePattern('EBUSY: resource busy or locked'), 'flaky-infra');
});

test('derivePattern: missing-dep category', () => {
  assert.equal(derivePattern("Error: Cannot find module 'foo'"), 'missing-dep');
  assert.equal(derivePattern('MODULE_NOT_FOUND at line 3'), 'missing-dep');
});

test('derivePattern: fs-permissions category', () => {
  assert.equal(derivePattern('EACCES: permission denied'), 'fs-permissions');
  assert.equal(derivePattern('permission denied opening /etc/passwd'), 'fs-permissions');
});

test('derivePattern: git-cache-corruption category', () => {
  assert.equal(derivePattern('error: invalid object 1234 cache-tree mismatch'), 'git-cache-corruption');
  assert.equal(derivePattern('fatal: unable to read tree HEAD'), 'git-cache-corruption');
});

test('derivePattern: branch-collision category', () => {
  assert.equal(derivePattern("fatal: A branch named 'wave/foo' already exists."), 'branch-collision');
  assert.equal(derivePattern('cannot create branch: already exists'), 'branch-collision');
});

test('derivePattern: unclassified for empty / garbage / null', () => {
  assert.equal(derivePattern(''), 'unclassified');
  assert.equal(derivePattern(null), 'unclassified');
  assert.equal(derivePattern(undefined), 'unclassified');
  assert.equal(derivePattern(123), 'unclassified');
  assert.equal(derivePattern('a perfectly fine message about nothing'), 'unclassified');
});

// --- recordDeviation ------------------------------------------------------

test('recordDeviation: writes entry with correct key shape + type=feedback', async () => {
  const proj = await makeProj('keyshape');
  try {
    const ts = '2026-05-18T12:00:00.000Z';
    const result = await recordDeviation({
      event: '3-attempt-cap-hit',
      payload: {
        task: 'W12-C N04 build deviation memory',
        attempts: 3,
        last_error: 'expected 5 got 3 in foo.test.js',
      },
      projectRoot: proj,
      ts,
    });

    assert.equal(result.written, true);
    assert.equal(result.type, 'feedback');
    assert.match(result.key, /^deviation_[0-9a-f]{12}_3attempt_2026-05-18T12:00:00\.000Z$/);

    // Verify the entry on disk has the expected shape.
    const raw = await readFile(join(proj, '.ijfw', 'memory', 'deviations.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.key, result.key);
    assert.equal(entry.type, 'feedback');
    assert.equal(entry.event, '3-attempt-cap-hit');
    assert.equal(entry.ts, ts);
    assert.equal(typeof entry.payload_hash, 'string');
    assert.equal(entry.payload_hash.length, 12);
  } finally { await cleanup(proj); }
});

test('recordDeviation: surfaces derived pattern in entry value', async () => {
  const proj = await makeProj('pattern-in-value');
  try {
    const r = await recordDeviation({
      event: 'BLOCKED',
      payload: {
        task: 'install deps',
        last_error: "Cannot find module 'better-sqlite3'",
      },
      projectRoot: proj,
      ts: '2026-05-18T12:01:00.000Z',
    });
    assert.equal(r.pattern, 'missing-dep');

    const raw = await readFile(join(proj, '.ijfw', 'memory', 'deviations.jsonl'), 'utf8');
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.pattern, 'missing-dep');
    assert.match(entry.value, /Pattern: missing-dep/);
    assert.match(entry.value, /install deps/);
  } finally { await cleanup(proj); }
});

test('recordDeviation: cross-ai-divergence shape includes 3 verdicts', async () => {
  const proj = await makeProj('divergence');
  try {
    const r = await recordDeviation({
      event: 'cross-ai-divergence',
      payload: {
        commit: 'abc123def456789',
        verdicts: { codex: 'PASS', gemini: 'FAIL', claude: 'CONDITIONAL' },
        divergence_summary: 'codex passed but gemini saw timeout on suite-7',
      },
      projectRoot: proj,
      ts: '2026-05-18T12:02:00.000Z',
    });
    assert.equal(r.pattern, 'flaky-infra'); // "timeout" in summary
    assert.match(r.key, /^deviation_consensus_abc123def456_2026-05-18T12:02:00\.000Z$/);

    const raw = await readFile(join(proj, '.ijfw', 'memory', 'deviations.jsonl'), 'utf8');
    const entry = JSON.parse(raw.trim());
    assert.match(entry.value, /codex: PASS, gemini: FAIL, claude: CONDITIONAL/);
    assert.match(entry.value, /pattern: flaky-infra/);
  } finally { await cleanup(proj); }
});

// --- readDeviationPatterns -----------------------------------------------

test('readDeviationPatterns: filters by patternLabel', async () => {
  const proj = await makeProj('filter-label');
  try {
    await recordDeviation({
      event: '3-attempt-cap-hit',
      payload: { task: 't1', last_error: 'timeout after 5s' },
      projectRoot: proj,
      ts: '2026-05-18T10:00:00.000Z',
    });
    await recordDeviation({
      event: 'BLOCKED',
      payload: { task: 't2', last_error: 'Cannot find module foo' },
      projectRoot: proj,
      ts: '2026-05-18T11:00:00.000Z',
    });
    await recordDeviation({
      event: '3-attempt-cap-hit',
      payload: { task: 't3', last_error: 'EBUSY locked' },
      projectRoot: proj,
      ts: '2026-05-18T12:00:00.000Z',
    });

    const flaky = await readDeviationPatterns({ projectRoot: proj, patternLabel: 'flaky-infra' });
    assert.equal(flaky.length, 2);
    assert.ok(flaky.every((e) => e.pattern === 'flaky-infra'));
    // Newest first
    assert.equal(flaky[0].ts, '2026-05-18T12:00:00.000Z');
    assert.equal(flaky[1].ts, '2026-05-18T10:00:00.000Z');

    const missing = await readDeviationPatterns({ projectRoot: proj, patternLabel: 'missing-dep' });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].pattern, 'missing-dep');
  } finally { await cleanup(proj); }
});

test('readDeviationPatterns: filters by sinceISO', async () => {
  const proj = await makeProj('filter-since');
  try {
    await recordDeviation({
      event: 'BLOCKED',
      payload: { task: 'old', last_error: 'timeout' },
      projectRoot: proj,
      ts: '2026-04-01T00:00:00.000Z',
    });
    await recordDeviation({
      event: 'BLOCKED',
      payload: { task: 'mid', last_error: 'timeout' },
      projectRoot: proj,
      ts: '2026-05-01T00:00:00.000Z',
    });
    await recordDeviation({
      event: 'BLOCKED',
      payload: { task: 'new', last_error: 'timeout' },
      projectRoot: proj,
      ts: '2026-05-15T00:00:00.000Z',
    });

    const recent = await readDeviationPatterns({
      projectRoot: proj,
      sinceISO: '2026-05-01T00:00:00.000Z',
    });
    assert.equal(recent.length, 2);
    // Newest first; "mid" is inclusive at the boundary
    assert.equal(recent[0].ts, '2026-05-15T00:00:00.000Z');
    assert.equal(recent[1].ts, '2026-05-01T00:00:00.000Z');

    const veryRecent = await readDeviationPatterns({
      projectRoot: proj,
      sinceISO: '2026-05-10T00:00:00.000Z',
    });
    assert.equal(veryRecent.length, 1);
    assert.equal(veryRecent[0].ts, '2026-05-15T00:00:00.000Z');
  } finally { await cleanup(proj); }
});

// --- idempotency ---------------------------------------------------------

test('recordDeviation: idempotent — same payload twice → 1 entry on disk', async () => {
  const proj = await makeProj('idempotent');
  try {
    const payload = {
      task: 'install module',
      attempts: 3,
      last_error: "Cannot find module 'better-sqlite3'",
    };

    const r1 = await recordDeviation({
      event: '3-attempt-cap-hit',
      payload,
      projectRoot: proj,
      ts: '2026-05-18T13:00:00.000Z',
    });
    assert.equal(r1.written, true);

    // Different ts — but same payload hash → must not double-write.
    const r2 = await recordDeviation({
      event: '3-attempt-cap-hit',
      payload,
      projectRoot: proj,
      ts: '2026-05-18T13:05:00.000Z',
    });
    assert.equal(r2.written, false);
    // Returned key/pattern come from the existing entry
    assert.equal(r2.key, r1.key);
    assert.equal(r2.pattern, r1.pattern);

    const raw = await readFile(join(proj, '.ijfw', 'memory', 'deviations.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
  } finally { await cleanup(proj); }
});
