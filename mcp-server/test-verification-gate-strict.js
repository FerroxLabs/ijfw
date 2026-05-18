// W12-F/F4 (RT2-H1): strict-by-default verification gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceVerificationGate,
  VerificationGateViolation,
} from './src/orchestrator/verification-gate.js';

// A message that claims completion but provides NO Bash test/build evidence
// in toolCalls — this is the failure path the gate is designed to catch.
const FAILING_MSG = 'all tests pass ✅ shipped successfully';
const PASSING_MSG = 'still investigating; no claim yet.';

test('enforceVerificationGate throws VerificationGateViolation when gate fails AND strict default', () => {
  assert.throws(
    () => enforceVerificationGate(FAILING_MSG, []),
    (err) => err instanceof VerificationGateViolation,
    'strict default should throw VerificationGateViolation on failure',
  );
});

test('enforceVerificationGate returns { ok: true } when gate passes', () => {
  const r = enforceVerificationGate(PASSING_MSG, []);
  assert.equal(r.ok, true, 'no completion claim ⇒ ok: true');
});

test('enforceVerificationGate strict:false does NOT throw on failure; returns advisory result', () => {
  let thrown = null;
  let result = null;
  try {
    result = enforceVerificationGate(FAILING_MSG, [], { strict: false });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, null, 'strict:false must not throw');
  assert.equal(result.ok, false, 'returns advisory failure result');
  assert.ok(result.violation, 'violation reason present');
});

test('VerificationGateViolation.message includes the violation reason', () => {
  try {
    enforceVerificationGate(FAILING_MSG, []);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof VerificationGateViolation);
    assert.ok(err.message.length > 0, 'message non-empty');
    assert.ok(err.violation, 'violation field populated');
  }
});

test('VerificationGateViolation extends Error and is instanceof Error', () => {
  try {
    enforceVerificationGate(FAILING_MSG, []);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof Error, 'subclass of Error');
    assert.ok(err instanceof VerificationGateViolation, 'is VerificationGateViolation');
    assert.equal(err.name, 'VerificationGateViolation');
  }
});
