#!/usr/bin/env node
/**
 * Tests for v1.5.0 W12-C N05 -- dashboard intervention endpoints.
 *
 * We exercise the sentinel-writer functions directly (they encapsulate the
 * entire HTTP handler body once arguments are extracted). Each test runs
 * against an isolated tmp dir via the IJFW_PARENT_PROJECT_ROOT env var that
 * the server module consults at write time.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeRedispatchSentinel,
  writeSwapAiSentinel,
  writeBlockWaveSentinel,
  listActiveWaves,
} from './server.js';

let tmpRoot;
let prevEnv;

before(() => {
  prevEnv = process.env.IJFW_PARENT_PROJECT_ROOT;
});

after(() => {
  if (prevEnv === undefined) delete process.env.IJFW_PARENT_PROJECT_ROOT;
  else process.env.IJFW_PARENT_PROJECT_ROOT = prevEnv;
});

beforeEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  tmpRoot = mkdtempSync(join(tmpdir(), 'ijfw-intervention-'));
  process.env.IJFW_PARENT_PROJECT_ROOT = tmpRoot;
});

// --- 1. redispatch happy path ---
test('POST /api/wave/W12-C/subagent/N05/redispatch writes redispatch.json with correct shape', () => {
  const r = writeRedispatchSentinel('W12-C', 'N05', { reason: 'stuck on test' });
  assert.equal(r.ok, true);
  assert.ok(r.sentinelPath.endsWith('/.ijfw/wave-W12-C/subagent-N05.redispatch.json'),
    `sentinelPath was: ${r.sentinelPath}`);
  assert.ok(existsSync(r.sentinelPath));
  const written = JSON.parse(readFileSync(r.sentinelPath, 'utf8'));
  assert.equal(written.type, 'redispatch');
  assert.equal(written.waveId, 'W12-C');
  assert.equal(written.subId, 'N05');
  assert.equal(written.requestedBy, 'dashboard');
  assert.equal(written.reason, 'stuck on test');
  assert.match(written.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// --- 2. swap-ai happy path ---
test('POST /api/wave/W12-C/subagent/N05/swap-ai with {toAI:"gemini"} writes swap-ai.json', () => {
  const r = writeSwapAiSentinel('W12-C', 'N05', { toAI: 'gemini', reason: 'claude looping' });
  assert.equal(r.ok, true);
  assert.ok(r.sentinelPath.endsWith('/.ijfw/wave-W12-C/subagent-N05.swap-ai.json'));
  const written = JSON.parse(readFileSync(r.sentinelPath, 'utf8'));
  assert.equal(written.type, 'swap-ai');
  assert.equal(written.toAI, 'gemini');
  assert.equal(written.subId, 'N05');
  assert.equal(written.requestedBy, 'dashboard');
});

// --- 3. swap-ai rejects invalid AI family ---
test('POST /api/wave/W12-C/subagent/N05/swap-ai with {toAI:"invalid"} returns 400 and writes no sentinel', () => {
  const r = writeSwapAiSentinel('W12-C', 'N05', { toAI: 'invalid' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /invalid toAI/);
  // No sentinel file should exist for the rejected request.
  const waveDir = join(tmpRoot, '.ijfw', 'wave-W12-C');
  if (existsSync(waveDir)) {
    const files = readdirSync(waveDir);
    assert.equal(files.filter(f => f.endsWith('.swap-ai.json')).length, 0,
      `expected no swap-ai.json; got: ${files}`);
  }
});

// --- 4. block wave happy path ---
test('POST /api/wave/W12-C/block with {reason:"oncall"} writes block.json', () => {
  const r = writeBlockWaveSentinel('W12-C', { reason: 'oncall' });
  assert.equal(r.ok, true);
  assert.ok(r.sentinelPath.endsWith('/.ijfw/wave-W12-C/wave-W12-C.block.json'));
  const written = JSON.parse(readFileSync(r.sentinelPath, 'utf8'));
  assert.equal(written.type, 'block');
  assert.equal(written.waveId, 'W12-C');
  assert.equal(written.reason, 'oncall');
  assert.equal(written.requestedBy, 'dashboard');
});

// --- 5. path traversal blocked ---
test('POST with waveId containing ".." returns 400 (path traversal blocked)', () => {
  const cases = [
    () => writeRedispatchSentinel('..', 'N05'),
    () => writeRedispatchSentinel('W12/../etc', 'N05'),
    () => writeRedispatchSentinel('W12-C', '../N05'),
    () => writeSwapAiSentinel('..', 'N05', { toAI: 'claude' }),
    () => writeBlockWaveSentinel('../../etc', { reason: 'oops' }),
    () => writeBlockWaveSentinel('wave with spaces', { reason: 'r' }),
  ];
  for (const fn of cases) {
    const r = fn();
    assert.equal(r.ok, false, `expected rejection for ${fn.toString()}`);
    assert.equal(r.status, 400);
  }
  // Confirm no `.ijfw/` directory ever got created with funny names.
  const ijfwDir = join(tmpRoot, '.ijfw');
  if (existsSync(ijfwDir)) {
    for (const d of readdirSync(ijfwDir)) {
      assert.ok(/^wave-[A-Za-z0-9_-]+$/.test(d), `unexpected dir: ${d}`);
    }
  }
});

// --- 6. missing required body fields ---
test('POST with missing body fields returns 400', () => {
  // swap-ai needs toAI
  const r1 = writeSwapAiSentinel('W12-C', 'N05', {});
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);

  // swap-ai called with no body at all
  const r2 = writeSwapAiSentinel('W12-C', 'N05');
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 400);

  // block requires reason
  const r3 = writeBlockWaveSentinel('W12-C', {});
  assert.equal(r3.ok, false);
  assert.equal(r3.status, 400);
  assert.match(r3.error, /reason is required/);

  const r4 = writeBlockWaveSentinel('W12-C', { reason: '   ' });
  assert.equal(r4.ok, false);
  assert.equal(r4.status, 400);
});

// --- 7. idempotency under concurrent writes ---
test('Two concurrent POSTs for same subagent both succeed (last-write-wins, idempotent)', async () => {
  // We picked the idempotent variant: both writes succeed, the second one wins
  // because rename(2) is atomic and overwrites. Critically, neither must throw
  // and the final file must be valid JSON (not a torn write).
  const [r1, r2] = await Promise.all([
    Promise.resolve(writeRedispatchSentinel('W12-C', 'N05', { reason: 'first' })),
    Promise.resolve(writeRedispatchSentinel('W12-C', 'N05', { reason: 'second' })),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.sentinelPath, r2.sentinelPath);
  // File parses cleanly and matches one of the two reasons.
  const written = JSON.parse(readFileSync(r1.sentinelPath, 'utf8'));
  assert.equal(written.type, 'redispatch');
  assert.ok(['first', 'second'].includes(written.reason),
    `reason was ${written.reason}`);
  // No leftover .tmp files in the wave dir.
  const dir = join(tmpRoot, '.ijfw', 'wave-W12-C');
  const tmps = readdirSync(dir).filter(f => f.includes('.tmp.'));
  assert.equal(tmps.length, 0, `unexpected tmp leftovers: ${tmps}`);
});

// --- Bonus: listActiveWaves surfaces sentinels for UI ---
test('listActiveWaves reports blocked + pending sentinels for the UI', () => {
  // Seed a fake checkpoint so the wave dir + subagent are discoverable.
  const waveDir = join(tmpRoot, '.ijfw', 'wave-W99-X');
  rmSync(waveDir, { recursive: true, force: true });
  // First create a sentinel via the writer -- mkdir -p handles dir creation.
  writeRedispatchSentinel('W99-X', 'S01', { reason: 'queued' });
  // Now drop a synthetic checkpoint file beside it.
  const cpPath = join(waveDir, 'subagent-S01.checkpoint.json');
  writeFileSync(cpPath, JSON.stringify({
    schema_version: 1, wave_id: 'W99-X', sub_id: 'S01',
    ts: '2026-05-18T10:00:00Z', tool_use_count: 5,
    last_action: 'idle waiting on operator',
  }));
  writeBlockWaveSentinel('W99-X', { reason: 'oncall' });

  const { waves } = listActiveWaves(tmpRoot);
  const wave = waves.find(w => w.waveId === 'W99-X');
  assert.ok(wave, 'expected W99-X to be listed');
  assert.equal(wave.blocked, true);
  assert.equal(wave.subagents.length, 1);
  assert.equal(wave.subagents[0].subId, 'S01');
  assert.equal(wave.subagents[0].redispatchPending, true);
  assert.equal(wave.subagents[0].lastAction, 'idle waiting on operator');
});
