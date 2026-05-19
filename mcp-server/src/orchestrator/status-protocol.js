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
 *             attempts: number, raw: string }}
 * @throws {ProtocolViolation}
 */
export function parseAgentReport(reportText) {
  const raw = reportText;

  // v1.5.1 H1.2 (audit workflow.md HIGH-F1): take the LAST `^Status:` match,
  // not the first. The protocol places `Status:` at the end of the report, so
  // when an agent quotes a prior wave's `Status: BLOCKED` mid-body, the FIRST
  // match was hijacking the agent's own status at the end. Same fix applied
  // to `extract()` below for Attempts / Branch / Commit / Tests / etc.
  const statusMatches = [...raw.matchAll(/^Status:\s*(\S+)\s*$/gm)];
  const statusMatch = statusMatches[statusMatches.length - 1];
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
    // v1.5.0-major S07 (W12-A): 3-attempt cap signal. Opt-in; defaults to 0
    // when an implementer omits the line — preserving prior behavior for
    // every existing report. Implementers using ijfw-executor.md set this to
    // the max auto-fix attempts on any single issue (Rules 1-3).
    attempts:   parseInt(extract(raw, 'Attempts') || '0', 10),
    raw,
  };
}

/**
 * Extract the LAST single-line field value, or undefined if absent.
 *
 * v1.5.1 H1.2 (audit workflow.md HIGH-F1 / MED-C2): take the last match, not
 * the first, so a quoted prior `Attempts: 5` (or any other field) does not
 * override the agent's own value at the end of the report.
 *
 * Callers pass static field names (Commit, Branch, Tests, Attempts, etc.), so
 * regex injection through `field` is not a concern — but we keep this comment
 * as a tripwire: if you ever pass a user-controlled string here, escape it.
 */
// v1.5.0 audit-LOW-work-L1: defensive escapeRegExp around the field name.
// Today callers only pass static field names (Commit, Branch, Tests, etc.) so
// regex injection is impossible -- but the previous comment was a tripwire,
// not a guard. This makes the function safe even if a future caller forgets.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extract(text, field) {
  const matches = [...text.matchAll(new RegExp(`^${escapeRegExp(field)}:\\s*(.+?)\\s*$`, 'gm'))];
  const last = matches[matches.length - 1];
  return last ? last[1] : undefined;
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
    // 1. Freshness check.
    //    r13-M-02: 1s tolerance for clock skew.
    //    v1.5.0 audit-LOW-work-L4: bumped to 2s to close the Windows-share
    //    mtime-granularity edge case (FAT/SMB filesystems report 2s
    //    resolution; a 1s window can false-reject a genuinely-fresh commit
    //    when the orchestrator clock and the worktree filesystem disagree
    //    by ~1s). 2s is still tight enough that the original "stale commit
    //    that happens to match the time window" attack stays out of reach.
    const tsOut = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', sha],
      { cwd: ctx.projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const commitTs = parseInt(tsOut, 10);
    if (!Number.isFinite(commitTs) || commitTs < dispatchTimestamp - 2) return false;

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
 *           missing?: string, reason?: string, tried?: string, attempts?: number }} parsed
 * @param {number}  dispatchTimestamp  Unix seconds (Date.now()/1000 at dispatch)
 * @param {{ projectRoot: string }} ctx
 * @returns {{ action: string, [key: string]: unknown }}
 */
export function handleStatus(parsed, dispatchTimestamp, ctx) {
  // v1.5.0-major S07 (W12-A): 3-attempt cap is a hard escalation signal
  // regardless of reported status. If an implementer (ijfw-executor.md) ran
  // out the per-issue auto-fix budget, the orchestrator MUST surface to the
  // user — even if the agent claims DONE — because by definition the
  // remaining issue is documented but unfixed. R2's #1 pattern: convert
  // truncation from a behavior problem to a budget problem.
  if (typeof parsed.attempts === 'number' && parsed.attempts >= 3) {
    return {
      action: 'escalate_to_user',
      reason: '3-attempt-cap-hit',
      original_status: parsed.status,
      original_action: undefined,
    };
  }
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
