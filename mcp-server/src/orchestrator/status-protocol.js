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
 * (dispatchTimestamp - 5s tolerance).
 *
 * @param {string|undefined} sha
 * @param {string|undefined} _branch  (reserved for future ref-checking)
 * @param {number}           dispatchTimestamp  Unix seconds
 * @param {{ projectRoot: string }} ctx
 * @returns {boolean}
 */
function verifyFreshCommit(sha, _branch, dispatchTimestamp, ctx) {
  if (!sha) return false;
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', sha],
      { cwd: ctx.projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const commitTs = parseInt(out, 10);
    if (!Number.isFinite(commitTs)) return false;
    return commitTs >= dispatchTimestamp - 5;
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
