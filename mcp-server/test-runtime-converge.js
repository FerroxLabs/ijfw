#!/usr/bin/env node
/**
 * test-runtime-converge.js -- v1.5.0 W12-C N01
 *
 * Validates runPhaseEConverge() multi-lens consensus convergence loop in
 * src/cross-orchestrator.js.  Uses injected dispatcher (no real CLI spawn,
 * no network), so the suite finishes in <2s.
 *
 * Coverage:
 *   1. all 3 PASS first iter → verdict: PASS, iterations: 1
 *   2. divergent iter 1, all PASS iter 2 → verdict: PASS, iterations: 2
 *   3. divergent for 3 iters → verdict: consensus_failed, iterations: 3
 *   4. byte-identical findings iter 1 vs iter 2 → stalled: true
 *   5. maxIterations: 1 caps the loop after 1 iter
 *
 * ESM, zero external deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPhaseEConverge } from './src/cross-orchestrator.js';

// Build a dispatcher that returns scripted verdicts per iteration.
// script: { [lens]: [iter1_result, iter2_result, ...] }
function scriptedDispatch(script) {
  return async ({ lens, iteration }) => {
    const lensScript = script[lens];
    if (!lensScript) {
      return { lens, verdict: 'UNREACHABLE', findings: [] };
    }
    // Clamp to last entry if iteration overruns the script.
    const idx = Math.min(iteration - 1, lensScript.length - 1);
    return { lens, ...lensScript[idx] };
  };
}

test('all 3 PASS first iter → verdict PASS, iterations 1', async () => {
  const dispatch = scriptedDispatch({
    codex:  [{ verdict: 'PASS', findings: [] }],
    gemini: [{ verdict: 'PASS', findings: [] }],
    claude: [{ verdict: 'PASS', findings: [] }],
  });
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    dispatch,
  });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.iterations, 1);
  assert.equal(r.stalled, undefined);
  assert.equal(r.divergence, undefined);
});

test('divergent iter 1, all PASS iter 2 → verdict PASS, iterations 2', async () => {
  const dispatch = scriptedDispatch({
    codex:  [
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'leak in foo' }] },
      { verdict: 'PASS', findings: [] },
    ],
    gemini: [
      { verdict: 'PASS', findings: [] },
      { verdict: 'PASS', findings: [] },
    ],
    claude: [
      { verdict: 'PASS', findings: [] },
      { verdict: 'PASS', findings: [] },
    ],
  });
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    dispatch,
  });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.iterations, 2);
  assert.equal(r.divergence, undefined);
});

test('divergent for 3 iters → consensus_failed, divergence populated', async () => {
  // Each iteration codex disagrees with the gemini+claude majority.
  // Findings must DIFFER between iterations or stall breaker fires first.
  const dispatch = scriptedDispatch({
    codex: [
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'r1' }] },
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'r2' }] },
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'r3' }] },
    ],
    gemini: [
      { verdict: 'PASS', findings: [{ text: 'g1' }] },
      { verdict: 'PASS', findings: [{ text: 'g2' }] },
      { verdict: 'PASS', findings: [{ text: 'g3' }] },
    ],
    claude: [
      { verdict: 'PASS', findings: [{ text: 'c1' }] },
      { verdict: 'PASS', findings: [{ text: 'c2' }] },
      { verdict: 'PASS', findings: [{ text: 'c3' }] },
    ],
  });
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    dispatch,
    maxIterations: 3,
  });
  assert.equal(r.verdict, 'consensus_failed');
  assert.equal(r.iterations, 3);
  assert.ok(Array.isArray(r.divergence), 'divergence array populated');
  assert.ok(r.divergence.length > 0, 'divergence has at least one axis');
  // codex is the odd-one-out (FAIL vs PASS majority)
  assert.equal(r.divergence[0].lens, 'codex');
  assert.equal(r.divergence[0].verdict, 'FAIL');
  assert.equal(r.divergence[0].majority, 'PASS');
});

test('byte-identical findings iter 1 vs iter 2 → stalled: true', async () => {
  // Same findings, same verdicts; loop should halt at iter 2 with stalled flag
  // rather than running through to maxIterations.
  const dispatch = scriptedDispatch({
    codex: [
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'frozen' }] },
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'frozen' }] },
      { verdict: 'FAIL', findings: [{ severity: 'high', text: 'frozen' }] },
    ],
    gemini: [
      { verdict: 'PASS', findings: [] },
      { verdict: 'PASS', findings: [] },
      { verdict: 'PASS', findings: [] },
    ],
    claude: [
      { verdict: 'PASS', findings: [] },
      { verdict: 'PASS', findings: [] },
      { verdict: 'PASS', findings: [] },
    ],
  });
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    dispatch,
    maxIterations: 5,
  });
  assert.equal(r.stalled, true);
  assert.equal(r.verdict, 'consensus_failed');
  // Halt should be at iter 2 (first iter where findings == prior iter findings).
  assert.equal(r.iterations, 2);
});

test('maxIterations: 1 caps the loop after 1 iter', async () => {
  // Even though lenses diverge and would normally trigger more iters,
  // maxIterations=1 forces a single shot.
  const dispatch = scriptedDispatch({
    codex:  [{ verdict: 'FAIL', findings: [{ text: 'x' }] }],
    gemini: [{ verdict: 'PASS', findings: [] }],
    claude: [{ verdict: 'PASS', findings: [] }],
  });
  const r = await runPhaseEConverge({
    commitRange: 'HEAD~1..HEAD',
    dispatch,
    maxIterations: 1,
  });
  assert.equal(r.iterations, 1);
  // maxIter=1 + divergent verdicts → consensus_failed verdict (loop never gets
  // a chance to converge). This is documented behavior, not a bug.
  assert.equal(r.verdict, 'consensus_failed');
});
