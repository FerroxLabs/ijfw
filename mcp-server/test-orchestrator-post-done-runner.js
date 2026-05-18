import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    // W12-F/F4 — RT2-H1: strict mode is default; failed gate ⇒ gateAction: 'block'.
    assert.equal(r.gateAction, 'block', 'strict default: failed gate ⇒ block');
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
    // W12-F/F4 — RT2-H1: gate passed ⇒ gateAction: 'pass'.
    assert.equal(r.gateAction, 'pass', 'gate ok ⇒ pass');
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
    assert.equal(r.gateAction, 'block', 'strict default: failed gate ⇒ block');
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
  // W12-F/F4 — RT2-H1: even with persistence failure, gateAction is still 'block'
  // under strict default. The classification doesn't depend on whether the
  // violation jsonl was written.
  assert.equal(r.gateAction, 'block');
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

// ---- S09 selfCheck tests ---------------------------------------------------

test('S09 selfCheck PASSED when claimed file exists + claimed commit exists', async () => {
  const root = tmpRoot();
  try {
    // Initialise a real git repo so the commit lookup works.
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'foo.js'), '// hi\n');
    execFileSync('git', ['add', 'foo.js'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'add foo'], { cwd: root });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const shortSha = sha.slice(0, 8);

    const r = await runPostDone({
      taskId: 'sc1', taskSpec: 'x', commitSha: sha, branch: 'main',
      reportText: `Status: DONE\nBranch: main\nCommit: ${shortSha}\n- created: foo.js`,
      toolCallsInMessage: [],
      dispatch: null, projectRoot: root,
    });
    assert.ok(r.selfCheck, 'selfCheck should be present');
    assert.equal(r.selfCheck.verdict, 'PASSED');
    assert.equal(r.selfCheck.files_claimed, 1);
    assert.equal(r.selfCheck.files_present, 1);
    assert.deepEqual(r.selfCheck.files_missing, []);
    assert.equal(r.selfCheck.commits_claimed, 1);
    assert.equal(r.selfCheck.commits_present, 1);
    assert.deepEqual(r.selfCheck.commits_missing, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('S09 selfCheck FAILED when claimed file does not exist', async () => {
  const root = tmpRoot();
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
    writeFileSync(join(root, 'real.js'), '// real\n');
    execFileSync('git', ['add', 'real.js'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'add real'], { cwd: root });

    const r = await runPostDone({
      taskId: 'sc2', taskSpec: 'x', commitSha: 'abc', branch: 'main',
      // claims a file that was never written
      reportText: 'Status: DONE\nBranch: main\n- created: phantom.js',
      toolCallsInMessage: [],
      dispatch: null, projectRoot: root,
    });
    assert.ok(r.selfCheck, 'selfCheck should be present');
    assert.equal(r.selfCheck.verdict, 'FAILED');
    assert.equal(r.selfCheck.files_claimed, 1);
    assert.equal(r.selfCheck.files_present, 0);
    assert.deepEqual(r.selfCheck.files_missing, ['phantom.js']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- W12-F/F4 RT2-H1: strict-mode default + advisory opt-out --------------

test('strict mode (default) returns gateAction: "block" on violation', async () => {
  const root = tmpRoot();
  try {
    const dispatch = async () => ({ verdict: 'PASS', findings: [] });
    const r = await runPostDone({
      // No strictGate param ⇒ default true ⇒ block on failure.
      taskId: 'strict-default', taskSpec: 'x', commitSha: 'abc', branch: 'main',
      reportText: 'all tests pass ✅ shipped successfully',
      toolCallsInMessage: [],
      dispatch, projectRoot: root,
    });
    assert.equal(r.gatePassed, false, 'gate should fail on bare completion claim');
    assert.equal(r.gateAction, 'block', 'strict default ⇒ block on failure');
    assert.ok(r.gateViolation, 'violation detail required so caller can surface block reason');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('strictGate: false returns gateAction: "advise" on violation', async () => {
  const root = tmpRoot();
  try {
    const dispatch = async () => ({ verdict: 'PASS', findings: [] });
    const r = await runPostDone({
      taskId: 'advise-opt-out', taskSpec: 'x', commitSha: 'abc', branch: 'main',
      reportText: 'all tests pass ✅ shipped successfully',
      toolCallsInMessage: [],
      dispatch, projectRoot: root,
      strictGate: false, // explicit advisory opt-out
    });
    assert.equal(r.gatePassed, false, 'gate still fails on the same input');
    assert.equal(r.gateAction, 'advise', 'opt-out ⇒ advisory, not block');
    assert.ok(r.gateViolation, 'violation still surfaced for memory-feedback routing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
