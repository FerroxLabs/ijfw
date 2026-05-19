/**
 * test-status-protocol.js — coverage for the 4-value agent status protocol.
 *
 * Created in v1.5.0 audit-H1.2 — the load-bearing parser had ZERO test coverage
 * at HEAD 9ddf1ed. Audit finding workflow.md HIGH-F1 + MED-C2 found that
 * `parseAgentReport`'s `^Status:`/`^Attempts:` regexes returned the FIRST line
 * match, letting an agent that quoted a prior wave's `Status: BLOCKED` (or
 * `Attempts: 5`) hijack its own report's actual status / attempts count.
 *
 * Fix shipped in this commit: extract the LAST occurrence of every protocol
 * field, since the protocol convention places these fields at the END of the
 * report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAgentReport,
  handleStatus,
  ProtocolViolation,
  STATUS_VALUES,
} from './src/orchestrator/status-protocol.js';

// ---------------------------------------------------------------------------
// Baseline: well-formed reports parse correctly
// ---------------------------------------------------------------------------

test('parseAgentReport: minimal DONE report parses', () => {
  const r = parseAgentReport('Status: DONE');
  assert.equal(r.status, 'DONE');
  assert.equal(r.attempts, 0);
});

test('parseAgentReport: full report extracts every field', () => {
  const report = [
    'Worked on the auth fix.',
    'Tests: 12/12 pass',
    'Branch: wave/W12-A/S07',
    'Commit: deadbeef1234',
    'Status: DONE',
    'Attempts: 1',
  ].join('\n');
  const r = parseAgentReport(report);
  assert.equal(r.status, 'DONE');
  assert.equal(r.branch, 'wave/W12-A/S07');
  assert.equal(r.commit_sha, 'deadbeef1234');
  assert.equal(r.tests, '12/12 pass');
  assert.equal(r.attempts, 1);
});

test('parseAgentReport: each valid status value accepted', () => {
  for (const v of STATUS_VALUES) {
    const r = parseAgentReport(`Status: ${v}`);
    assert.equal(r.status, v);
  }
});

test('parseAgentReport: missing Status: throws ProtocolViolation', () => {
  assert.throws(
    () => parseAgentReport('Did some work but forgot to include status.'),
    ProtocolViolation,
  );
});

test('parseAgentReport: invalid status value throws', () => {
  assert.throws(
    () => parseAgentReport('Status: TOTALLY_DONE'),
    ProtocolViolation,
  );
});

// ---------------------------------------------------------------------------
// v1.5.1 H1.2 — audit finding HIGH-F1: quoted prior status MUST NOT hijack
// the agent's own status. Fix: take LAST occurrence.
// ---------------------------------------------------------------------------

test('v1.5.1 H1.2: quoted prior Status: BLOCKED does NOT hijack own Status: DONE', () => {
  const report = [
    'Investigating the wave dispatch issue.',
    'The prior wave reported:',
    'Status: BLOCKED',
    'because subagents went silent.',
    '',
    'I confirmed the fix works.',
    '',
    'Status: DONE',
  ].join('\n');
  const r = parseAgentReport(report);
  assert.equal(r.status, 'DONE',
    'agent\'s OWN status at end of report must win over an earlier quoted status');
});

test('v1.5.1 H1.2: quoted prior NEEDS_CONTEXT does not hijack BLOCKED', () => {
  const report = [
    'Last agent said:',
    'Status: NEEDS_CONTEXT',
    'I tried that and hit a wall.',
    '',
    'Status: BLOCKED',
    'Reason: dependency missing',
  ].join('\n');
  const r = parseAgentReport(report);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'dependency missing');
});

test('v1.5.1 H1.2 (MED-C2): quoted prior Attempts: 5 does NOT trigger escalation on Attempts: 1', () => {
  // Bug: if an agent quotes "the prior wave hit Attempts: 5", the FIRST-match
  // regex returns 5, which trips the 3-attempt-cap escalation even though the
  // agent's actual Attempts is 1.
  const report = [
    'Earlier work hit Attempts: 5 and was abandoned.',
    'I started fresh.',
    '',
    'Status: DONE',
    'Attempts: 1',
  ].join('\n');
  const r = parseAgentReport(report);
  assert.equal(r.attempts, 1,
    'own Attempts: 1 must override quoted Attempts: 5');
  // And handleStatus must NOT escalate on this report
  const action = handleStatus(r, Date.now() / 1000, { projectRoot: '/tmp' });
  assert.notEqual(action.action, 'escalate_to_user',
    'must not escalate when own attempts is below cap');
  assert.notEqual(action.reason, '3-attempt-cap-hit');
});

test('v1.5.1 H1.2: every report field is LAST-match (consistent semantics)', () => {
  // Apply the same fix to all report fields so behavior is uniform.
  const report = [
    'Old report claimed:',
    'Branch: stale/branch-name',
    'Commit: deadbeef0000',
    'Tests: 1/100',
    'Status: BLOCKED',
    '',
    'But actually:',
    'Branch: wave/W12-X/fresh',
    'Commit: cafef00d1234',
    'Tests: 50/50',
    'Status: DONE',
  ].join('\n');
  const r = parseAgentReport(report);
  assert.equal(r.status, 'DONE');
  assert.equal(r.branch, 'wave/W12-X/fresh');
  assert.equal(r.commit_sha, 'cafef00d1234');
  assert.equal(r.tests, '50/50');
});

// ---------------------------------------------------------------------------
// handleStatus — basic action routing (baseline coverage)
// ---------------------------------------------------------------------------

test('handleStatus: 3-attempt cap forces escalate regardless of status', () => {
  const action = handleStatus(
    { status: 'DONE', attempts: 3 },
    Date.now() / 1000,
    { projectRoot: '/tmp' },
  );
  assert.equal(action.action, 'escalate_to_user');
  assert.equal(action.reason, '3-attempt-cap-hit');
});

test('handleStatus: BLOCKED routes to escalate with reason + tried', () => {
  const action = handleStatus(
    { status: 'BLOCKED', reason: 'dep missing', tried: 'npm install' },
    Date.now() / 1000,
    { projectRoot: '/tmp' },
  );
  assert.equal(action.action, 'escalate_to_user');
  assert.equal(action.reason, 'dep missing');
  assert.equal(action.tried, 'npm install');
});

test('handleStatus: NEEDS_CONTEXT routes to redispatch_with_context', () => {
  const action = handleStatus(
    { status: 'NEEDS_CONTEXT', missing: 'API key location' },
    Date.now() / 1000,
    { projectRoot: '/tmp' },
  );
  assert.equal(action.action, 'redispatch_with_context');
  assert.equal(action.missing, 'API key location');
});

test('handleStatus: DONE_WITH_CONCERNS proceeds with flag', () => {
  const action = handleStatus(
    { status: 'DONE_WITH_CONCERNS', concerns: 'flaky test' },
    Date.now() / 1000,
    { projectRoot: '/tmp' },
  );
  assert.equal(action.action, 'proceed_with_flag');
  assert.equal(action.concerns, 'flaky test');
});
