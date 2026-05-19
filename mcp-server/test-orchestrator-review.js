import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewTask,
  shouldReReview,
  REVIEW_MAX_ITERATIONS,
} from './src/orchestrator/review.js';

// ---------------------------------------------------------------------------
// Mock dispatch factories
// ---------------------------------------------------------------------------

function passBoth() {
  return async (_kind, _ctx) => ({ verdict: 'PASS', findings: [] });
}

function failSpec(findings = ['Requirement X not implemented']) {
  return async (kind, _ctx) => {
    if (kind === 'spec-compliance') return { verdict: 'FAIL', findings };
    return { verdict: 'PASS', findings: [] };
  };
}

function failQuality(findings = ['Missing null-check on line 42']) {
  return async (kind, _ctx) => {
    if (kind === 'code-quality') return { verdict: 'FAIL', findings };
    return { verdict: 'PASS', findings: [] };
  };
}

const BASE = {
  taskId: 't1',
  taskSpec: 'Implement foo',
  commitSha: 'abc123',
  branch: 'feature/foo',
};

// ---------------------------------------------------------------------------
// reviewTask tests
// ---------------------------------------------------------------------------

test('reviewTask returns ok:true + stage:quality when both stages PASS', async () => {
  const result = await reviewTask({ ...BASE, dispatch: passBoth() });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'quality');
  assert.deepEqual(result.findings, []);
});

test('reviewTask returns ok:false + stage:spec when spec FAIL', async () => {
  const result = await reviewTask({ ...BASE, dispatch: failSpec() });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'spec');
});

test('reviewTask skips quality stage when spec FAIL', async () => {
  const calls = [];
  const dispatch = async (kind, _ctx) => {
    calls.push(kind);
    if (kind === 'spec-compliance') return { verdict: 'FAIL', findings: [] };
    return { verdict: 'PASS', findings: [] };
  };
  await reviewTask({ ...BASE, dispatch });
  assert.deepEqual(calls, ['spec-compliance']);
});

test('reviewTask returns ok:false + stage:quality when spec passes but quality FAIL', async () => {
  const result = await reviewTask({ ...BASE, dispatch: failQuality() });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'quality');
});

test('reviewTask forwards findings from the failing stage', async () => {
  const specFindings = ['Missing method foo()', 'Return type mismatch'];
  const result = await reviewTask({ ...BASE, dispatch: failSpec(specFindings) });
  assert.deepEqual(result.findings, specFindings);
});

test('reviewTask forwards quality findings when quality FAIL', async () => {
  const qualityFindings = ['No input sanitisation', 'Untested edge case'];
  const result = await reviewTask({ ...BASE, dispatch: failQuality(qualityFindings) });
  assert.deepEqual(result.findings, qualityFindings);
});

// ---------------------------------------------------------------------------
// shouldReReview tests
// ---------------------------------------------------------------------------

test('shouldReReview returns true for FAIL + iteration < REVIEW_MAX_ITERATIONS', () => {
  assert.equal(shouldReReview('FAIL', 1), true);
  assert.equal(shouldReReview('FAIL', 2), true);
});

test('shouldReReview returns false for FAIL + iteration === REVIEW_MAX_ITERATIONS (cap)', () => {
  assert.equal(shouldReReview('FAIL', REVIEW_MAX_ITERATIONS), false);
});

test('shouldReReview returns false for PASS regardless of iteration', () => {
  assert.equal(shouldReReview('PASS', 1), false);
  assert.equal(shouldReReview('PASS', 0), false);
});

test('REVIEW_MAX_ITERATIONS is 3', () => {
  assert.equal(REVIEW_MAX_ITERATIONS, 3);
});

// ---------------------------------------------------------------------------
// v1.5.0 audit-MED-work-M7 — bothStages opt-in surfaces quality findings on spec FAIL
// ---------------------------------------------------------------------------

function failSpecPassQuality(specFindings = ['spec gap'], qualityFindings = ['null-check missing']) {
  return async (kind) => {
    if (kind === 'spec-compliance') return { verdict: 'FAIL', findings: specFindings };
    return { verdict: 'PASS', findings: qualityFindings };
  };
}

test('M7: bothStages=false (default) — spec FAIL means quality stage is skipped', async () => {
  const calls = [];
  const dispatch = async (kind) => {
    calls.push(kind);
    if (kind === 'spec-compliance') return { verdict: 'FAIL', findings: [] };
    return { verdict: 'PASS', findings: [] };
  };
  const r = await reviewTask({ ...BASE, dispatch });
  assert.deepEqual(calls, ['spec-compliance']);
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'spec');
  assert.equal(r.qualityFindings, undefined);
});

test('M7: bothStages=true — spec FAIL still runs quality + returns qualityFindings (INFO-prefixed)', async () => {
  const r = await reviewTask({
    ...BASE,
    bothStages: true,
    dispatch: failSpecPassQuality(['Missing X'], ['No input sanitisation']),
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'spec');           // outer verdict still keys off spec
  assert.deepEqual(r.findings, ['Missing X']);
  assert.ok(Array.isArray(r.qualityFindings));
  assert.equal(r.qualityFindings.length, 1);
  // INFO downgrade prefix applied
  assert.match(r.qualityFindings[0], /^\[INFO\] /);
  assert.match(r.qualityFindings[0], /No input sanitisation/);
});

test('M7: bothStages=true — pre-prefixed [INFO] findings are not double-prefixed', async () => {
  const r = await reviewTask({
    ...BASE,
    bothStages: true,
    dispatch: failSpecPassQuality(['Missing X'], ['[INFO] already labelled']),
  });
  assert.equal(r.qualityFindings[0], '[INFO] already labelled');
});

test('M7: bothStages=true — quality dispatch error falls through to spec-only result', async () => {
  const dispatch = async (kind) => {
    if (kind === 'spec-compliance') return { verdict: 'FAIL', findings: ['x'] };
    throw new Error('quality reviewer offline');
  };
  const r = await reviewTask({ ...BASE, bothStages: true, dispatch });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'spec');
  assert.equal(r.qualityFindings, undefined);
});
