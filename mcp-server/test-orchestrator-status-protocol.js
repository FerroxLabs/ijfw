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

/** Create a temp git repo with one empty commit on `main`; return { root, sha, ts }. */
function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), 'status-proto-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  // -b main: deterministic branch name across git versions / host configs
  // (v1.5.0 S3 branch-tuple verifier checks ref membership).
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'x'], { cwd: root, env, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
  const ts = parseInt(
    execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, env, encoding: 'utf8' }).trim(),
    10,
  );
  return { root, sha, ts, env };
}

/**
 * Add a second commit on a NEW branch `feat`, leaving HEAD on that branch.
 * Returns the feature-branch sha + ts. Original {sha,ts} remain on `main`.
 */
function addFeatureBranchCommit(root, env) {
  execFileSync('git', ['checkout', '-b', 'feat'], { cwd: root, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'feat-only'], { cwd: root, env, stdio: 'ignore' });
  const featSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
  const featTs = parseInt(
    execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, env, encoding: 'utf8' }).trim(),
    10,
  );
  return { featSha, featTs };
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

// ---------------------------------------------------------------------------
// v1.5.0 S3 (W11-A3): branch-tuple verifyFreshCommit
// ---------------------------------------------------------------------------

test('handleStatus DONE with fresh commit on dispatched branch returns proceed_to_review', () => {
  const { root, sha, ts } = makeGitRepo();
  // commit is on `main`, dispatched branch is `main` → membership check passes
  const dispatchTs = ts - 10;
  const parsed = { status: 'DONE', commit_sha: sha, branch: 'main' };
  const result = handleStatus(parsed, dispatchTs, { projectRoot: root });
  assert.equal(result.action, 'proceed_to_review');
  assert.equal(result.commit_sha, sha);
});

test('handleStatus DONE with fresh commit on a DIFFERENT branch returns redispatch_needs_context', () => {
  const { root, sha, ts, env } = makeGitRepo();
  // Create a second commit on `feat` branch; agent reports the `main`-only sha
  // but claims branch `feat`. Time check passes (commit is recent) but the
  // branch-tuple check must reject because `sha` is not contained in `feat`'s
  // history? Actually `feat` branches off main so it WOULD contain `sha`.
  // We need the inverse: the reported sha is on `feat` only, but dispatched
  // branch is `main` → main does not contain featSha.
  const { featSha, featTs } = addFeatureBranchCommit(root, env);
  const dispatchTs = featTs - 10;
  const parsed = { status: 'DONE', commit_sha: featSha, branch: 'main' };
  const result = handleStatus(parsed, dispatchTs, { projectRoot: root });
  assert.equal(result.action, 'redispatch_needs_context');
  assert.equal(result.missing, 'commit-before-report');
  // sanity: the same featSha against branch `feat` would pass
  const okResult = handleStatus(
    { status: 'DONE', commit_sha: featSha, branch: 'feat' },
    dispatchTs,
    { projectRoot: root },
  );
  assert.equal(okResult.action, 'proceed_to_review');
  // sanity: unused vars referenced to satisfy lint
  assert.ok(sha && ts);
});

test('handleStatus DONE with empty branch (detached HEAD) falls back to time-only check', () => {
  const { root, sha, ts } = makeGitRepo();
  const dispatchTs = ts - 10;
  // Empty branch string skips the membership check; fresh commit passes.
  const parsed = { status: 'DONE', commit_sha: sha, branch: '' };
  const result = handleStatus(parsed, dispatchTs, { projectRoot: root });
  assert.equal(result.action, 'proceed_to_review');
  assert.equal(result.commit_sha, sha);
});

// ---------------------------------------------------------------------------
// v1.5.0-major S07 (W12-A): Attempts field + 3-attempt cap escalation
// ---------------------------------------------------------------------------

test('parseAgentReport extracts Attempts: 2 from the Attempts line', () => {
  const report = [
    'Status: DONE',
    'Branch: main',
    'Commit: abc123',
    'Tests: 5 pass',
    'Attempts: 2',
  ].join('\n');
  const parsed = parseAgentReport(report);
  assert.equal(parsed.attempts, 2);
  assert.equal(parsed.status, 'DONE');
});

test('handleStatus escalates to user when attempts >= 3 regardless of DONE status', () => {
  // Even if the implementer claims DONE, hitting the 3-attempt cap means a
  // documented-but-unfixed issue remains; the orchestrator MUST surface it.
  const parsed = {
    status: 'DONE',
    commit_sha: 'abc',
    branch: 'main',
    attempts: 3,
  };
  const result = handleStatus(parsed, 0, { projectRoot: '/' });
  assert.equal(result.action, 'escalate_to_user');
  assert.equal(result.reason, '3-attempt-cap-hit');
  assert.equal(result.original_status, 'DONE');
});

test('handleStatus with attempts: 0 routes normally for DONE (3-cap is opt-in)', () => {
  // Reports without an Attempts: line (default 0) MUST behave exactly as
  // before — the 3-cap field is purely additive.
  const { root, sha, ts } = makeGitRepo();
  const dispatchTs = ts - 10;
  const parsed = { status: 'DONE', commit_sha: sha, branch: 'main', attempts: 0 };
  const result = handleStatus(parsed, dispatchTs, { projectRoot: root });
  assert.equal(result.action, 'proceed_to_review');
  assert.equal(result.commit_sha, sha);
});
