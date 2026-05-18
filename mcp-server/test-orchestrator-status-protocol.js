import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  STATUS_VALUES,
  ProtocolViolation,
  parseAgentReport,
  handleStatus,
} from './src/orchestrator/status-protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp git repo with one empty commit; return { root, sha, ts }. */
function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'status-proto-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  execFileSync('git', ['init'], { cwd: root, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'x'], { cwd: root, env, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
  const ts = parseInt(
    execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, env, encoding: 'utf8' }).trim(),
    10,
  );
  return { root, sha, ts };
}

// ---------------------------------------------------------------------------
// STATUS_VALUES sanity
// ---------------------------------------------------------------------------

test('STATUS_VALUES contains all 4 expected statuses', () => {
  assert.deepEqual([...STATUS_VALUES], ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED']);
});

// ---------------------------------------------------------------------------
// parseAgentReport — valid statuses
// ---------------------------------------------------------------------------

test('parseAgentReport extracts all 4 valid statuses', () => {
  for (const status of STATUS_VALUES) {
    const report = `Some text.\nStatus: ${status}\nBranch: main\nCommit: abc123\nTests: 5 pass\n`;
    const parsed = parseAgentReport(report);
    assert.equal(parsed.status, status, `Expected status ${status}`);
    assert.equal(parsed.branch, 'main');
    assert.equal(parsed.commit_sha, 'abc123');
    assert.equal(parsed.tests, '5 pass');
    assert.equal(parsed.raw, report);
  }
});

// ---------------------------------------------------------------------------
// parseAgentReport — optional fields
// ---------------------------------------------------------------------------

test('parseAgentReport extracts optional fields when present', () => {
  const report = [
    'Status: BLOCKED',
    'Branch: wave/W10-A1/dispatch',
    'Commit: deadbeef',
    'Tests: 0 pass',
    'Concerns: some concern',
    'Reason: dependency missing',
    'Missing: context about X',
    'Tried: ran npm install',
  ].join('\n');
  const parsed = parseAgentReport(report);
  assert.equal(parsed.status, 'BLOCKED');
  assert.equal(parsed.concerns, 'some concern');
  assert.equal(parsed.reason, 'dependency missing');
  assert.equal(parsed.missing, 'context about X');
  assert.equal(parsed.tried, 'ran npm install');
});

// ---------------------------------------------------------------------------
// parseAgentReport — ProtocolViolation on missing Status line
// ---------------------------------------------------------------------------

test('parseAgentReport throws ProtocolViolation on missing Status line', () => {
  const report = 'Branch: main\nCommit: abc\nTests: 1 pass\n';
  assert.throws(
    () => parseAgentReport(report),
    (err) => {
      assert.ok(err instanceof ProtocolViolation);
      assert.ok(err.reason.includes('missing Status'));
      assert.equal(err.raw, report);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// parseAgentReport — ProtocolViolation on invalid status value
// ---------------------------------------------------------------------------

test('parseAgentReport throws ProtocolViolation on invalid status string', () => {
  const report = 'Status: SUCCESS\nBranch: main\n';
  assert.throws(
    () => parseAgentReport(report),
    (err) => {
      assert.ok(err instanceof ProtocolViolation);
      assert.ok(err.reason.includes('SUCCESS'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// handleStatus — DONE with fresh commit → proceed_to_review
// ---------------------------------------------------------------------------

test('handleStatus DONE with fresh commit returns proceed_to_review', () => {
  const { root, sha, ts } = makeGitRepo();
  // dispatch timestamp is 10 seconds before the commit — clearly fresh
  const dispatchTs = ts - 10;
  const parsed = { status: 'DONE', commit_sha: sha, branch: 'main' };
  const result = handleStatus(parsed, dispatchTs, { projectRoot: root });
  assert.equal(result.action, 'proceed_to_review');
  assert.equal(result.commit_sha, sha);
});

// ---------------------------------------------------------------------------
// handleStatus — DONE with stale commit → redispatch_needs_context
// ---------------------------------------------------------------------------

test('handleStatus DONE with stale commit returns redispatch_needs_context', () => {
  const { root, sha, ts } = makeGitRepo();
  // dispatch timestamp is 60 seconds AFTER the commit — commit is stale
  const dispatchTs = ts + 60;
  const parsed = { status: 'DONE', commit_sha: sha, branch: 'main' };
  const result = handleStatus(parsed, dispatchTs, { projectRoot: root });
  assert.equal(result.action, 'redispatch_needs_context');
  assert.equal(result.missing, 'commit-before-report');
});

// ---------------------------------------------------------------------------
// handleStatus — DONE_WITH_CONCERNS → proceed_with_flag
// ---------------------------------------------------------------------------

test('handleStatus DONE_WITH_CONCERNS returns proceed_with_flag with concerns', () => {
  const parsed = {
    status: 'DONE_WITH_CONCERNS',
    commit_sha: 'abc',
    branch: 'main',
    concerns: 'flaky test on line 42',
  };
  const result = handleStatus(parsed, 0, { projectRoot: '/' });
  assert.equal(result.action, 'proceed_with_flag');
  assert.equal(result.concerns, 'flaky test on line 42');
});

// ---------------------------------------------------------------------------
// handleStatus — NEEDS_CONTEXT → redispatch_with_context
// ---------------------------------------------------------------------------

test('handleStatus NEEDS_CONTEXT returns redispatch_with_context', () => {
  const parsed = {
    status: 'NEEDS_CONTEXT',
    missing: 'wave-state API shape',
  };
  const result = handleStatus(parsed, 0, { projectRoot: '/' });
  assert.equal(result.action, 'redispatch_with_context');
  assert.equal(result.missing, 'wave-state API shape');
});

// ---------------------------------------------------------------------------
// handleStatus — BLOCKED → escalate_to_user
// ---------------------------------------------------------------------------

test('handleStatus BLOCKED returns escalate_to_user with reason + tried', () => {
  const parsed = {
    status: 'BLOCKED',
    reason: 'CI environment missing',
    tried: 'npm install, node --version',
  };
  const result = handleStatus(parsed, 0, { projectRoot: '/' });
  assert.equal(result.action, 'escalate_to_user');
  assert.equal(result.reason, 'CI environment missing');
  assert.equal(result.tried, 'npm install, node --version');
});

// ---------------------------------------------------------------------------
// handleStatus — DONE with missing sha → redispatch_needs_context
// ---------------------------------------------------------------------------

test('handleStatus DONE with no commit sha returns redispatch_needs_context', () => {
  const { root } = makeGitRepo();
  const parsed = { status: 'DONE', commit_sha: undefined, branch: 'main' };
  const result = handleStatus(parsed, Date.now() / 1000, { projectRoot: root });
  assert.equal(result.action, 'redispatch_needs_context');
  assert.equal(result.missing, 'commit-before-report');
});
