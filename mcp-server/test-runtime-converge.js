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
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runPhaseEConverge,
  MAX_CONVERGE_ITERATIONS,
  _resetMaxIterWarnLog,
  defaultConvergeDispatch,
} from './src/cross-orchestrator.js';
import { RECEIPTS_FILE } from './src/receipts.js';

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

// ---------------------------------------------------------------------------
// v1.5.0 audit-H4.1 — maxIterations cap regression tests
// ---------------------------------------------------------------------------

test('audit-H4.1: maxIterations above MAX_CONVERGE_ITERATIONS is clamped', async () => {
  _resetMaxIterWarnLog();

  // Capture stderr to verify the dedup'd clamp warning fires once.
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return origWrite(chunk, ...rest);
  };

  let dispatchCalls = 0;
  const dispatch = async ({ lens }) => {
    dispatchCalls++;
    // Always diverge so the loop wants to run forever — only the cap stops it.
    return lens === 'codex'
      ? { lens, verdict: 'FAIL', findings: [{ severity: 'high', text: `iter-${dispatchCalls}` }] }
      : { lens, verdict: 'PASS', findings: [{ text: `iter-${dispatchCalls}` }] };
  };

  try {
    const r = await runPhaseEConverge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      maxIterations: 100,
      projectDir: mkdtempSync(join(tmpdir(), 'ijfw-h41-')),
    });
    // Cap must have clamped — iterations cannot exceed MAX_CONVERGE_ITERATIONS.
    assert.ok(
      r.iterations <= MAX_CONVERGE_ITERATIONS,
      `iterations=${r.iterations} exceeded cap=${MAX_CONVERGE_ITERATIONS}`
    );
    // Warning fired exactly once for "100".
    assert.ok(
      captured.includes('clamped to MAX_CONVERGE_ITERATIONS'),
      `expected clamp warning, got: ${captured}`
    );
    const matches = captured.match(/clamped to MAX_CONVERGE_ITERATIONS/g) || [];
    assert.equal(matches.length, 1, 'clamp warning should fire exactly once');
  } finally {
    process.stderr.write = origWrite;
  }
});

test('audit-H4.1: dedup — same over-cap value across two calls warns once', async () => {
  _resetMaxIterWarnLog();

  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return origWrite(chunk, ...rest);
  };

  const dispatch = async ({ lens }) => ({
    lens,
    verdict: 'PASS',
    findings: [],
  });

  try {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ijfw-h41-dedup-'));
    await runPhaseEConverge({ commitRange: 'HEAD~1..HEAD', dispatch, maxIterations: 50, projectDir: tmpDir });
    await runPhaseEConverge({ commitRange: 'HEAD~1..HEAD', dispatch, maxIterations: 50, projectDir: tmpDir });
    const matches = captured.match(/clamped to MAX_CONVERGE_ITERATIONS/g) || [];
    assert.equal(matches.length, 1, 'dedup must collapse repeated warnings to one');
  } finally {
    process.stderr.write = origWrite;
  }
});

test('audit-H4.1: in-range maxIterations is NOT clamped or warned', async () => {
  _resetMaxIterWarnLog();

  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return origWrite(chunk, ...rest);
  };

  const dispatch = async ({ lens }) => ({ lens, verdict: 'PASS', findings: [] });

  try {
    const r = await runPhaseEConverge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      maxIterations: 5,
      projectDir: mkdtempSync(join(tmpdir(), 'ijfw-h41-ok-')),
    });
    assert.equal(r.verdict, 'PASS');
    assert.ok(!captured.includes('clamped'), 'no clamp warning expected for in-range value');
  } finally {
    process.stderr.write = origWrite;
  }
});

// ---------------------------------------------------------------------------
// v1.5.0 audit-H4.2 — defaultConvergeDispatch cycleSummary suffix ordering
// ---------------------------------------------------------------------------
//
// The dispatcher concatenates `commitRange` and `cycleSummary` into a `target`
// string before calling buildRequest. For user-content cache_control readiness
// (ADJUDICATIONS DISPUTED-1), the cacheable prefix (commitRange) MUST come
// FIRST and the iteration-varying summary MUST come AFTER.
//
// We can't easily call the real dispatcher without spawning a CLI, so we test
// the ordering invariant by introspecting the source: the construction must
// place `${commitRange}` before `${cycleSummary}` in the template.

test('audit-H4.2: defaultConvergeDispatch source places commitRange before cycleSummary', () => {
  const src = readFileSync('./src/cross-orchestrator.js', 'utf8');
  // Find the target = (...) ? ... : commitRange; block.
  // The template must look like `${commitRange}\n\n---\n\n${cycleSummary}`,
  // not `${cycleSummary}\n\n---\n\n${commitRange}`.
  const goodPattern = /`\$\{commitRange\}\\n\\n---\\n\\n\$\{cycleSummary\}`/;
  const badPattern  = /`\$\{cycleSummary\}\\n\\n---\\n\\n\$\{commitRange\}`/;
  assert.ok(
    goodPattern.test(src),
    'expected commitRange-then-cycleSummary ordering (cache_control-ready prefix)'
  );
  assert.ok(
    !badPattern.test(src),
    'cycleSummary must NOT be prefixed before commitRange (would bust cache_control on iter ≥ 2)'
  );
  // Sanity: defaultConvergeDispatch exists and is callable.
  assert.equal(typeof defaultConvergeDispatch, 'function');
});

// ---------------------------------------------------------------------------
// v1.5.0 audit-H4.5 — runPhaseEConverge writes receipts
// ---------------------------------------------------------------------------

test('audit-H4.5: runPhaseEConverge writes a receipt at .ijfw/receipts/cross-runs.jsonl', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ijfw-h45-'));
  try {
    const dispatch = async ({ lens }) => ({
      lens,
      verdict: 'PASS',
      findings: [],
    });
    const r = await runPhaseEConverge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
    });
    assert.equal(r.verdict, 'PASS');

    const receiptsPath = RECEIPTS_FILE(tmpDir);
    assert.ok(existsSync(receiptsPath), `receipt file must exist at ${receiptsPath}`);

    const raw = readFileSync(receiptsPath, 'utf8').trim();
    assert.ok(raw.length > 0, 'receipt file must have at least one line');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one receipt for one converge run');

    const rec = JSON.parse(lines[0]);
    assert.equal(rec.mode, 'converge');
    assert.equal(rec.target, 'HEAD~1..HEAD');
    assert.ok(rec.converge, 'receipt must carry converge-specific block');
    assert.equal(rec.converge.iterations, 1);
    assert.equal(rec.converge.verdict, 'PASS');
    assert.equal(rec.converge.total_invocations, 3, 'one cycle × 3 lenses = 3 invocations');
    assert.equal(rec.converge.cycles.length, 1);
    assert.equal(rec.converge.cycles[0].iteration, 1);
    assert.equal(rec.converge.cycles[0].findingCount, 0);
    assert.ok(typeof rec.duration_ms === 'number' && rec.duration_ms >= 0);
    assert.ok(Array.isArray(rec.auditors) && rec.auditors.length === 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('audit-H4.5: receipt records correct invocation count across multiple iterations', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ijfw-h45-multi-'));
  try {
    // 3 lenses, scripted to diverge then converge after 2 iters.
    const script = {
      codex:  [
        { verdict: 'FAIL', findings: [{ severity: 'high', text: 'a' }] },
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
    };
    const dispatch = async ({ lens, iteration }) => {
      const s = script[lens];
      const idx = Math.min(iteration - 1, s.length - 1);
      return { lens, ...s[idx] };
    };

    const r = await runPhaseEConverge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
      maxIterations: 5,
    });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.iterations, 2);

    const receiptsPath = RECEIPTS_FILE(tmpDir);
    const raw = readFileSync(receiptsPath, 'utf8').trim();
    const rec = JSON.parse(raw.split('\n').filter(Boolean).pop());
    assert.equal(rec.converge.iterations, 2);
    assert.equal(rec.converge.total_invocations, 6, '2 cycles × 3 lenses = 6 invocations');
    assert.equal(rec.converge.cycles.length, 2);
    assert.equal(rec.converge.cycles[0].iteration, 1);
    assert.equal(rec.converge.cycles[1].iteration, 2);
    // Iter 1 had at least one finding; iter 2 had zero.
    assert.ok(rec.converge.cycles[0].findingCount >= 1);
    assert.equal(rec.converge.cycles[1].findingCount, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('audit-H4.5: receipt records stalled flag + final verdict on stall', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ijfw-h45-stall-'));
  try {
    const dispatch = async ({ lens }) =>
      lens === 'codex'
        ? { lens, verdict: 'FAIL', findings: [{ severity: 'high', text: 'frozen' }] }
        : { lens, verdict: 'PASS', findings: [] };

    const r = await runPhaseEConverge({
      commitRange: 'HEAD~1..HEAD',
      dispatch,
      projectDir: tmpDir,
      maxIterations: 5,
    });
    assert.equal(r.stalled, true);
    assert.equal(r.verdict, 'consensus_failed');

    const rec = JSON.parse(readFileSync(RECEIPTS_FILE(tmpDir), 'utf8').trim().split('\n').pop());
    assert.equal(rec.converge.stalled, true);
    assert.equal(rec.converge.verdict, 'consensus_failed');
    assert.equal(rec.converge.divergent, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
