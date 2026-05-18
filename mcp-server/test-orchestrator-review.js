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
