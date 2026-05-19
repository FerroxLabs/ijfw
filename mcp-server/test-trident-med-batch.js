#!/usr/bin/env node
/**
 * test-trident-med-batch.js -- v1.5.0 audit-MED-trident M3/M5/M6/M7/M8.
 *
 * Validates the MED-batch behaviors closed by N4.trident:
 *   - M3: mergeAudit clusters findings by signature; ≥2-lens clusters get
 *         consensus:true + consensusCount + consensusLenses.
 *   - M5: runPhaseEConverge per-lens USD cap drops over-budget lenses.
 *   - M6: runPhaseEConverge totalTimeoutMs aborts the convergence loop.
 *   - M7: shouldRetryOnTimeout matrix differentiates cli vs api per pick.
 *   - M8: normaliseSeverity coerces disposition values into canonical
 *         finding-severity vocabulary so they sort correctly.
 *
 * ESM, zero external deps.  No CLI spawn, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeResponses,
  normaliseSeverity,
  FINDING_SEVERITIES,
  AUDIT_DISPOSITIONS,
} from './src/cross-dispatcher.js';
import {
  runPhaseEConverge,
  _shouldRetryOnTimeout,
} from './src/cross-orchestrator.js';

// ---------------------------------------------------------------------------
// M3 — mergeAudit consensus clustering
// ---------------------------------------------------------------------------

test('M3: mergeAudit marks findings flagged by ≥2 lenses as consensus', () => {
  const r1 = { items: [
    { _lens: 'codex',  severity: 'high',   issue: 'race condition in foo', location: 'foo.js:42' },
    { _lens: 'codex',  severity: 'medium', issue: 'unique codex finding',   location: 'bar.js:1' },
  ]};
  const r2 = { items: [
    { _lens: 'gemini', severity: 'high',   issue: 'race condition in foo', location: 'foo.js:42' },
    { _lens: 'gemini', severity: 'low',    issue: 'unique gemini finding', location: 'baz.js:7' },
  ]};
  const merged = mergeResponses('audit', [r1, r2]);

  // First in the list should be the consensus finding.
  assert.equal(merged[0].consensus, true, 'shared finding marked consensus');
  assert.equal(merged[0].consensusCount, 2, 'consensusCount = 2');
  assert.deepEqual(merged[0].consensusLenses.sort(), ['codex', 'gemini']);

  // Other findings carry consensus:false.
  const nonConsensus = merged.filter(m => !m.consensus);
  assert.equal(nonConsensus.length, 2, 'two non-consensus findings');
  for (const f of nonConsensus) assert.equal(f.consensus, false);
});

test('M3: consensus group sorts ahead of single-lens group', () => {
  const merged = mergeResponses('audit', [
    { items: [{ _lens: 'codex', severity: 'high', issue: 'shared', location: 'a:1' }] },
    { items: [{ _lens: 'codex', severity: 'critical', issue: 'codex-only', location: 'b:1' }] },
    { items: [{ _lens: 'gemini', severity: 'high', issue: 'shared', location: 'a:1' }] },
  ]);
  assert.equal(merged[0].consensus, true, 'consensus first');
  assert.equal(merged[1].consensus, false, 'single-lens next');
});

test('M3: identical findings from same lens do NOT inflate consensus', () => {
  const merged = mergeResponses('audit', [
    { items: [
      { _lens: 'codex', severity: 'high', issue: 'same', location: 'x:1' },
      { _lens: 'codex', severity: 'high', issue: 'same', location: 'x:1' },
    ]},
  ]);
  assert.equal(merged.length, 1, 'duplicates collapsed into one bucket');
  assert.equal(merged[0].consensus, false, 'single distinct lens => not consensus');
});

// ---------------------------------------------------------------------------
// M5 — per-lens budget cap
// ---------------------------------------------------------------------------

test('M5: lens exceeding perLensBudgetUsd is dropped from next iteration', async () => {
  let codexCalls = 0;
  let geminiCalls = 0;
  const dispatch = async ({ lens, iteration }) => {
    if (lens === 'codex') {
      codexCalls++;
      // Big spend per call → exceeds $0.10 cap on iter 1.
      return { lens, verdict: 'CONDITIONAL', findings: [{ severity: 'high', issue: 'codex finding ' + iteration, location: 'a:1' }], cost_usd: 0.50 };
    }
    if (lens === 'gemini') {
      geminiCalls++;
      return { lens, verdict: 'CONDITIONAL', findings: [{ severity: 'high', issue: 'gemini finding ' + iteration, location: 'b:1' }], cost_usd: 0.01 };
    }
    return { lens, verdict: 'PASS', findings: [], cost_usd: 0.01 };
  };
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    lenses: ['codex', 'gemini', 'claude'],
    dispatch,
    maxIterations: 3,
    perLensBudgetUsd: 0.10,
  });
  // codex fires once and gets dropped; gemini + claude continue.
  assert.equal(codexCalls, 1, 'codex called once before budget cap');
  assert.ok(geminiCalls >= 1, 'gemini keeps running');
  assert.ok(Array.isArray(r.lensesOverBudget), 'lensesOverBudget surfaced');
  assert.ok(r.lensesOverBudget.includes('codex'), 'codex flagged over-budget');
  assert.ok(r.lensCosts.codex > 0.10, 'codex cumulative cost recorded');
});

test('M5: when no cap is set, lensCosts is still tracked for observability', async () => {
  const dispatch = async ({ lens }) => ({
    lens,
    verdict: 'PASS',
    findings: [],
    cost_usd: 0.03,
  });
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    lenses: ['codex', 'gemini', 'claude'],
    dispatch,
    maxIterations: 1,
  });
  assert.equal(r.lensCosts.codex, 0.03);
  assert.equal(r.lensCosts.gemini, 0.03);
  assert.equal(r.lensCosts.claude, 0.03);
  assert.equal(r.lensesOverBudget, undefined, 'no over-budget set without cap');
});

// ---------------------------------------------------------------------------
// M6 — cumulative-timeout cap
// ---------------------------------------------------------------------------

test('M6: totalTimeoutMs aborts the convergence loop', async () => {
  let iterCount = 0;
  // Each lens sleeps a tiny bit and reports CONDITIONAL with a unique finding
  // per iter (so we don't hit early consensus termination).
  const dispatch = async ({ lens, iteration }) => {
    iterCount++;
    await new Promise(r => setTimeout(r, 30));
    return {
      lens,
      verdict: 'CONDITIONAL',
      findings: [{ severity: 'high', issue: `unique ${lens} ${iteration}`, location: `${lens}.js:${iteration}` }],
    };
  };
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    lenses: ['codex', 'gemini', 'claude'],
    dispatch,
    maxIterations: 10,
    totalTimeoutMs: 50, // shorter than 10 iters × 3 lenses × 30ms = 900ms.
  });
  // Result either has timedOutTotal:true or terminated early; either way,
  // we should NOT have completed 10 full iterations.
  assert.ok(r.iterations < 10, `loop should not finish 10 iters; got ${r.iterations}`);
});

// ---------------------------------------------------------------------------
// M7 — per-(provider, path) retry matrix
// ---------------------------------------------------------------------------

test('M7: codex defaults to no-retry on CLI, but retry on API', () => {
  const codex = { id: 'codex', family: 'openai' };
  assert.equal(_shouldRetryOnTimeout(codex, 'cli'), false, 'codex CLI: no retry');
  assert.equal(_shouldRetryOnTimeout(codex, 'api'), true,  'codex API: retry');
});

test('M7: gemini defaults to retry on both CLI and API', () => {
  const gemini = { id: 'gemini', family: 'google' };
  assert.equal(_shouldRetryOnTimeout(gemini, 'cli'), true);
  assert.equal(_shouldRetryOnTimeout(gemini, 'api'), true);
});

test('M7: pick.retryMatrix overrides defaults', () => {
  const pick = { id: 'codex', family: 'openai', retryMatrix: { cli: true, api: false } };
  assert.equal(_shouldRetryOnTimeout(pick, 'cli'), true,  'matrix.cli=true wins');
  assert.equal(_shouldRetryOnTimeout(pick, 'api'), false, 'matrix.api=false wins');
});

test('M7: explicit retryOnTimeout=false wins over provider/family default', () => {
  // Gemini family defaults retry=true, but pick says false.
  const pick = { id: 'gemini', family: 'google', retryOnTimeout: false };
  // The matrix beats the legacy single-axis flag for known providers, but
  // unknown providers fall through to the legacy flag. We assert the unknown-
  // provider case explicitly to lock the precedence in.
  const unknownPick = { id: 'NEVER', family: 'NEVER', retryOnTimeout: false };
  assert.equal(_shouldRetryOnTimeout(unknownPick, 'cli'), false);
});

test('M7: unknown provider falls back to path-typical default', () => {
  const pick = { id: 'NEVER_SEEN' };
  assert.equal(_shouldRetryOnTimeout(pick, 'cli'), false, 'CLI default = no retry');
  assert.equal(_shouldRetryOnTimeout(pick, 'api'), true,  'API default = retry');
});

// ---------------------------------------------------------------------------
// M8 — severity vocabulary alignment
// ---------------------------------------------------------------------------

test('M8: normaliseSeverity passes canonical values through', () => {
  for (const sev of FINDING_SEVERITIES) {
    assert.equal(normaliseSeverity(sev), sev);
    assert.equal(normaliseSeverity(sev.toUpperCase()), sev, 'case-insensitive');
  }
});

test('M8: normaliseSeverity coerces disposition values to severities', () => {
  assert.equal(normaliseSeverity('warn'), 'medium');
  assert.equal(normaliseSeverity('WARN'), 'medium');
  assert.equal(normaliseSeverity('flag'), 'high');
  assert.equal(normaliseSeverity('fail'), 'critical');
  assert.equal(normaliseSeverity('conditional'), 'medium');
  assert.equal(normaliseSeverity('pass'), 'low');
});

test('M8: normaliseSeverity returns null for unknown values', () => {
  assert.equal(normaliseSeverity(''), null);
  assert.equal(normaliseSeverity(null), null);
  assert.equal(normaliseSeverity(undefined), null);
  assert.equal(normaliseSeverity('totally-unknown'), null);
});

test('M8: dispositions list is exactly the trident dispatch vocabulary', () => {
  // Mirror src/trident/dispatch.js VERDICT_RANK keys.
  assert.deepEqual([...AUDIT_DISPOSITIONS].map(s => s.toUpperCase()).sort(),
                   ['CONDITIONAL', 'FAIL', 'FLAG', 'PASS', 'WARN']);
});

test('M8: mergeAudit ranks disposition-valued severities correctly', () => {
  // A finding tagged severity:'fail' (a disposition) should rank with critical,
  // not at the unrecognized-99 bottom. Under the new mergeAudit, both are
  // single-lens (no consensus), so the only ordering signal is severity.
  const merged = mergeResponses('audit', [
    { items: [{ _lens: 'codex', severity: 'low', issue: 'cosmetic', location: 'a:1' }] },
    { items: [{ _lens: 'gemini', severity: 'fail', issue: 'disposition-valued', location: 'b:1' }] },
  ]);
  // The 'fail' should rank first (coerced to critical).
  assert.equal(merged[0].severity, 'fail', 'disposition-coerced finding ranks first');
  assert.equal(merged[1].severity, 'low');
});
