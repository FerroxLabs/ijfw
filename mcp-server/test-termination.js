// v1.5.0 audit-MED-work-M3 — tests for composable termination conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MaxAttempts,
  WallClockTimeout,
  TokenBudget,
  FindingSeverity,
  or,
  and,
  not,
  defaultTermination,
} from './src/orchestrator/termination.js';
// NOTE: the `runLoop` integration tests that previously lived here were
// removed alongside `runtime-loop.js` (v1.5.1 R4-H5 — runtime-loop was a pure
// orphan with zero production callers). This suite now covers `termination.js`
// only — its composable predicates + combinators, which is what it tests.

// ---------------------------------------------------------------------------
// Atomic conditions
// ---------------------------------------------------------------------------

test('MaxAttempts: fires after Nth iteration completes', () => {
  const t = MaxAttempts(3);
  assert.equal(t(0, {}), false);
  assert.equal(t(1, {}), false);
  assert.equal(t(2, {}), true);
});

test('MaxAttempts: rejects non-positive values', () => {
  assert.throws(() => MaxAttempts(0), TypeError);
  assert.throws(() => MaxAttempts(-1), TypeError);
  assert.throws(() => MaxAttempts(NaN), TypeError);
});

test('WallClockTimeout: fires after budget exceeded; never fires without start', () => {
  const t = WallClockTimeout(50);
  // No startTimestamp → never fires (defensive).
  assert.equal(t(0, {}), false);
  // Simulated past start.
  assert.equal(t(0, { startTimestamp: Date.now() - 1000 }), true);
  assert.equal(t(0, { startTimestamp: Date.now() }), false);
});

test('TokenBudget: fires only when state.tokensUsed >= max', () => {
  const t = TokenBudget(1000);
  assert.equal(t(0, {}), false);
  assert.equal(t(0, { tokensUsed: 500 }), false);
  assert.equal(t(0, { tokensUsed: 1000 }), true);
  assert.equal(t(0, { tokensUsed: 2000 }), true);
});

test('FindingSeverity: HIGH threshold fires on HIGH+ findings only', () => {
  const t = FindingSeverity('HIGH');
  assert.equal(t(0, { findings: [{ severity: 'LOW' }] }), false);
  assert.equal(t(0, { findings: [{ severity: 'MEDIUM' }] }), false);
  assert.equal(t(0, { findings: [{ severity: 'HIGH' }] }), true);
  assert.equal(t(0, { findings: [] }), false);
});

test('FindingSeverity: MEDIUM threshold fires on MED+ findings', () => {
  const t = FindingSeverity('MEDIUM');
  assert.equal(t(0, { findings: [{ severity: 'LOW' }] }), false);
  assert.equal(t(0, { findings: [{ severity: 'MEDIUM' }] }), true);
  assert.equal(t(0, { findings: [{ severity: 'HIGH' }] }), true);
});

test('FindingSeverity: rejects unknown severity', () => {
  assert.throws(() => FindingSeverity('CATASTROPHIC'), TypeError);
});

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

test('or: fires when ANY condition fires', () => {
  const t = or(MaxAttempts(5), TokenBudget(100));
  assert.equal(t(0, { tokensUsed: 50 }), false);
  assert.equal(t(0, { tokensUsed: 200 }), true);
  assert.equal(t(4, { tokensUsed: 0 }), true);
});

test('and: fires only when ALL conditions fire', () => {
  const t = and(MaxAttempts(2), TokenBudget(100));
  assert.equal(t(0, { tokensUsed: 200 }), false);  // attempts not yet hit
  assert.equal(t(1, { tokensUsed: 50 }), false);   // tokens not hit
  assert.equal(t(1, { tokensUsed: 200 }), true);   // both hit
});

test('and: with zero conditions never fires', () => {
  const t = and();
  assert.equal(t(0, {}), false);
});

test('not: negates the inner condition', () => {
  // MaxAttempts(5) at iter 0 → iter+1=1 < 5 → false; not → true.
  assert.equal(not(MaxAttempts(5))(0, {}), true);
  // MaxAttempts(1) at iter 0 → iter+1=1 >= 1 → true; not → false.
  assert.equal(not(MaxAttempts(1))(0, {}), false);
});

// ---------------------------------------------------------------------------
// defaultTermination
// ---------------------------------------------------------------------------

test('defaultTermination is MaxAttempts(3) by default', () => {
  const t = defaultTermination();
  assert.equal(t(0, {}), false);
  assert.equal(t(1, {}), false);
  assert.equal(t(2, {}), true);
});
