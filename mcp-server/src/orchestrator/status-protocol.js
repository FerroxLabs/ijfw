/**
 * status-protocol.js — 4-value agent status protocol + commit-before-report verification.
 *
 * Every implementer agent must end its report with:
 *   Status: <VALUE>
 *   Branch: <branch>
 *   Commit: <sha>
 *   Tests: <summary>
 *
 * Landed in W10-A1 (v1.4.4 N2).
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATUS_VALUES = Object.freeze([
  'DONE',
  'DONE_WITH_CONCERNS',
  'NEEDS_CONTEXT',
  'BLOCKED',
]);

// ---------------------------------------------------------------------------
// ProtocolViolation
// ---------------------------------------------------------------------------

export class ProtocolViolation extends Error {
  /**
   * @param {string} reason  Human-readable explanation
   * @param {string} raw     The original report text
   */
  constructor(reason, raw) {
    super(reason);
    this.name = 'ProtocolViolation';
    this.reason = reason;
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// parseAgentReport
// ---------------------------------------------------------------------------

/**
 * Parse a structured agent report into its constituent fields.
 *
 * Required field: `Status: <VALUE>` — throws ProtocolViolation if missing or invalid.
 * All other fields are extracted best-effort (undefined if absent).
 *
 * @param {string} reportText
 * @returns {{ status: string, commit_sha?: string, branch?: string, tests?: string,
 *             concerns?: string, reason?: string, missing?: string, tried?: string,
 *             raw: string }}
 * @throws {ProtocolViolation}
 */
export function parseAgentReport(reportText) {
  const raw = reportText;

  const statusMatch = raw.match(/^Status:\s*(\S+)\s*$/m);
  if (!statusMatch) {
    throw new ProtocolViolation('missing Status: line in agent report', raw);
  }
  const status = statusMatch[1];
  if (!STATUS_VALUES.includes(status)) {
    throw new ProtocolViolation(
      `invalid status "${status}"; expected one of ${STATUS_VALUES.join(', ')}`,
      raw,
    );
  }

  return {
    status,
    commit_sha: extract(raw, 'Commit'),
    branch:     extract(raw, 'Branch'),
    tests:      extract(raw, 'Tests'),
    concerns:   extract(raw, 'Concerns'),
    reason:     extract(raw, 'Reason'),
    missing:    extract(raw, 'Missing'),
    tried:      extract(raw, 'Tried'),
    raw,
  };
}

/** Extract a single-line field value, or undefined if absent. */
function extract(text, field) {
  const m = text.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// verifyFreshCommit (internal)
// ---------------------------------------------------------------------------

/**
 * Returns true if the commit at `sha` was authored at or after
 * (dispatchTimestamp - 1s tolerance) AND is reachable from the dispatched branch.
 *
 * v1.5.0 S3 (W11-A3): branch-tuple check closes the r13-M-N2 bypass where a
 * stale commit on main could pass as "fresh" because the time window happened
 * to match. Empty/undefined branch falls back to time-only (detached HEAD or
 * implicit-main case — orchestrator's choice whether to enforce).
 *
 * @param {string|undefined} sha
 * @param {string|undefined} branch  Dispatched branch name (empty = skip membership check)
 * @param {number}           dispatchTimestamp  Unix seconds
 * @param {{ projectRoot: string }} ctx
 * @returns {boolean}
 */
function verifyFreshCommit(sha, branch, dispatchTimestamp, ctx) {
  if (!sha) return false;
  try {
    // 1. Freshness check (r13-M-02: 1s tolerance for clock skew).
    const tsOut = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', sha],
      { cwd: ctx.projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const commitTs = parseInt(tsOut, 10);
    if (!Number.isFinite(commitTs) || commitTs < dispatchTimestamp - 1) return false;

    // 2. v1.5.0 S3: branch-tuple check. Closes the "stale commit from main passes
    //    as fresh because the time window happens to match" bypass that r13-M-N2
    //    deferred to the structural fix.
    //    Empty branch = detached HEAD or implicit-main — skip membership check
    //    (orchestrator's choice whether to enforce).
    if (branch && branch.length > 0) {
      const branchOut = execFileSync(
        'git',
        ['branch', '--contains', sha, '--list', branch],
        { cwd: ctx.projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (branchOut.trim().length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// handleStatus
// ---------------------------------------------------------------------------

/**
 * Decide the orchestrator action based on a parsed agent report.
 *
 * @param {{ status: string, commit_sha?: string, branch?: string, concerns?: string,
 *           missing?: string, reason?: string, tried?: string }} parsed
 * @param {number}  dispatchTimestamp  Unix seconds (Date.now()/1000 at dispatch)
 * @param {{ projectRoot: string }} ctx
 * @returns {{ action: string, [key: string]: unknown }}
 */
export function handleStatus(parsed, dispatchTimestamp, ctx) {
  switch (parsed.status) {
    case 'DONE': {
      const fresh = verifyFreshCommit(
        parsed.commit_sha,
        parsed.branch,
        dispatchTimestamp,
        ctx,
      );
      if (!fresh) {
        return { action: 'redispatch_needs_context', missing: 'commit-before-report' };
      }
      return { action: 'proceed_to_review', commit_sha: parsed.commit_sha };
    }

    case 'DONE_WITH_CONCERNS':
      return { action: 'proceed_with_flag', concerns: parsed.concerns };

    case 'NEEDS_CONTEXT':
      return { action: 'redispatch_with_context', missing: parsed.missing };

    case 'BLOCKED':
      return { action: 'escalate_to_user', reason: parsed.reason, tried: parsed.tried };

    default:
      // STATUS_VALUES is exhaustive; parseAgentReport guards this.
      throw new ProtocolViolation(`unhandled status "${parsed.status}"`, parsed.raw ?? '');
  }
}
