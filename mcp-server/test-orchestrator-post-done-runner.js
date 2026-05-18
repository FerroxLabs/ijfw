import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostDone } from './src/orchestrator/post-done-runner.js';

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'post-done-'));

// reviewTask in review.js takes a `dispatch` callback. We inject a fake for tests.
// Contract: dispatch(reviewerKind, payload) → returns { verdict: 'PASS'|'FAIL', findings: [...] }.

test('spec PASS + quality PASS returns verdict (gate intentionally trips on DONE — by design)', async () => {
  const root = tmpRoot();
  try {
    const dispatch = async (kind /* , payload */) => ({ verdict: 'PASS', findings: [] });
    const r = await runPostDone({
      taskId: 't1', taskSpec: 'do X', commitSha: 'abc', branch: 'main',
      reportText: 'Status: DONE\nBranch: main\nCommit: abc',
      toolCallsInMessage: [], dispatch, projectRoot: root,
    });
    // verdict from reviewTask is the spec/quality result; shape depends on review.js
    assert.ok(r.verdict !== undefined, 'verdict should be present');
    // verification-gate.js intentionally matches Status: DONE as a completion claim
    // (line 25 of verification-gate.js documents this). Without fresh test/build
    // evidence in toolCallsInMessage, the gate is expected to fail.
    assert.equal(r.gatePassed, false);
    assert.ok(r.gateViolation, 'gateViolation should describe the missing evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-completion report (NEEDS_CONTEXT) → gate passes (no claim to verify)', async () => {
  const root = tmpRoot();
  try {
    const dispatch = async () => ({ verdict: 'PASS', findings: [] });
    const r = await runPostDone({
      taskId: 't1b', taskSpec: 'do X', commitSha: 'abc', branch: 'main',
      reportText: 'Status: NEEDS_CONTEXT\nMissing: db schema for table users',
      toolCallsInMessage: [], dispatch, projectRoot: root,
    });
    assert.equal(r.gatePassed, true, 'no completion phrase in body → no claim → gate passes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spec FAIL loops back to implementer; quality not dispatched', async () => {
  const root = tmpRoot();
  try {
    let qualityCalled = false;
    const dispatch = async (kind) => {
      if (kind === 'quality-reviewer') qualityCalled = true;
      return { verdict: 'FAIL', findings: [{ severity: 'HIGH', text: 'spec drift' }] };
    };
    const r = await runPostDone({
      taskId: 't2', taskSpec: 'do Y', commitSha: 'def', branch: 'main',
      reportText: 'Status: DONE\nBranch: main\nCommit: def',
      toolCallsInMessage: [], dispatch, projectRoot: root,
    });
    assert.ok(r.reviewFindings === undefined || Array.isArray(r.reviewFindings));
    assert.equal(qualityCalled, false, 'quality reviewer should not fire after spec FAIL');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate violation when report claims completion without test evidence', async () => {
  const root = tmpRoot();
  try {
    const dispatch = async () => ({ verdict: 'PASS', findings: [] });
    const r = await runPostDone({
      taskId: 't3', taskSpec: 'x', commitSha: 'abc', branch: 'main',
      reportText: 'all tests pass ✅ shipped successfully',  // claims completion, no Bash tool calls
      toolCallsInMessage: [],
      dispatch, projectRoot: root,
    });
    assert.equal(r.gatePassed, false);
    assert.ok(r.gateViolation, 'gateViolation should describe the missing evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordViolation failure (e.g. .ijfw absent) is non-fatal', async () => {
  // Use a path that's read-only or nonexistent to ensure recordViolation cannot succeed.
  const root = '/nonexistent/path/will/not/exist/' + Math.random();
  const dispatch = async () => ({ verdict: 'PASS', findings: [] });
  // Should NOT throw even if recordViolation can't write.
  const r = await runPostDone({
    taskId: 't4', taskSpec: 'x', commitSha: 'abc', branch: 'main',
    reportText: 'all tests pass',  // triggers gate violation
    toolCallsInMessage: [],
    dispatch, projectRoot: root,
  });
  // gateViolation should still be populated even though recording it failed.
  assert.equal(r.gatePassed, false);
});

test('null dispatch (server-side invocation) does not crash', async () => {
  const root = tmpRoot();
  try {
    // server.js passes dispatch:null because it has no Agent tool. review.js must handle this.
    const r = await runPostDone({
      taskId: 't5', taskSpec: 'x', commitSha: 'abc', branch: 'main',
      reportText: 'Status: DONE\nBranch: main\nCommit: abc',
      toolCallsInMessage: [],
      dispatch: null, projectRoot: root,
    });
    // result shape may indicate review was skipped or returned default verdict — must not throw.
    assert.ok(r, 'should return a result object even with null dispatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
