/**
 * post-done-runner.js — v1.5.0-major S02: post-DONE pipeline primitives.
 *
 * WHAT IS LIVE: `runSelfCheck` is the only export on the production path. The
 * live DONE-handler is the `subagent.post-done` state-SDK verb, which calls
 * `runSelfCheck` directly (and fires debug-trident via debug-trident-trigger.js
 * on a self-check failure). The verification gate itself is also enforced live
 * — `state-sdk.js` calls `enforceVerificationGate` directly.
 *
 * WHAT IS NOT LIVE: `runPostDone` is a library/test surface — NOT the live
 * DONE-handler. It is a convenience wrapper that bundles reviewTask (v1.4.4 N3
 * two-stage review) + checkVerificationGate (v1.4.4 N5) for direct-import
 * callers and the test path (`test-orchestrator-post-done-runner.js`). The
 * production two-stage spec+quality review happens via agent dispatch
 * (spec-reviewer + quality-reviewer agents), not through this wrapper. Its
 * original S02 caller (`runtime-loop.js`) was never wired; that file is now
 * removed. `runPostDone` is kept for its test surface and for any future
 * caller that wants the two checks bundled — it does not carry production
 * traffic today.
 *
 * v1.5.0 T13: the standalone `ijfw_subagent_post_done` MCP tool was retired and
 * absorbed into the single `ijfw_state` MCP tool as the `subagent.post-done`
 * verb (see STATE-SDK-CONTRACT §7). `runSelfCheck` is re-exported through
 * `state-sdk.js` for that verb.
 *
 * Outcome shape (uniform regardless of branch taken):
 *   {
 *     verdict: 'approved' | 'spec_failed' | 'quality_failed',
 *     reviewStage: 'spec' | 'quality',
 *     reviewOk: boolean,
 *     reviewFindings: string[],
 *     gatePassed: boolean,
 *     gateAction: 'block' | 'advise' | 'pass',
 *     gateViolation: object | null,
 *   }
 *
 * `gateAction` (W12-F/F4 — RT2-H1) tells the MCP tool handler what to do
 * with a gate failure:
 *   - 'pass'   → gate passed; advance normally.
 *   - 'block'  → strict mode (default) AND gate failed. Caller MUST refuse
 *                to claim success. The MCP handler should surface a structured
 *                `block: true` so the orchestrator-LLM treats it as a hard stop.
 *   - 'advise' → caller opted out of strict via `strictGate: false` AND gate
 *                failed. Caller may proceed but should still surface the
 *                violation so it gets routed into memory-feedback.
 *
 * The `dispatch` parameter is the reviewTask injected dispatcher:
 *   (kind: 'spec-compliance'|'code-quality', ctx: object)
 *     => Promise<{ verdict: 'PASS'|'FAIL', findings: string[] }>
 *
 * If `dispatch` is null/undefined we still run the gate check (the orchestrator
 * may invoke the reviewers itself via the Agent tool); verdict becomes
 * 'no_review' to signal that.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewTask } from './review.js';
import { checkVerificationGate, recordViolation } from './verification-gate.js';
// debug-trident (T29) is wired on the LIVE path only: `subagent.post-done` in
// state-sdk.js fires debug-trident fire-and-forget when its self-check gate
// fails, via `maybeFireDebugTrident` in debug-trident-trigger.js. That is the
// genuine production caller — codex+gemini are dispatched against the real
// gate-failure evidence whenever IJFW_DEBUG_TRIDENT is enabled. runPostDone
// deliberately does NOT invoke debug-trident (the earlier W2.C inline-
// annotation hook was dead — computed but never returned — and was removed).

/**
 * Extract paths claimed in the report. Naive but effective: looks for
 * "created/modified/file: <path>" plus bullet-list `- path/...` patterns.
 * Skip lines under "Self-Check" section (don't recurse into reported self-checks).
 */
function extractClaimedPaths(reportText) {
  const lines = String(reportText || '').split('\n');
  const paths = new Set();
  let inSelfCheck = false;
  for (const line of lines) {
    if (/^##\s*Self-Check/i.test(line)) { inSelfCheck = true; continue; }
    if (inSelfCheck) continue;
    const m = line.match(/(?:created|modified|file):\s*[`"]?([^\s`"]+)[`"]?/i);
    if (m && m[1].includes('.')) paths.add(m[1]);
    const m2 = line.match(/^\s*-\s+[`"]?([^\s`"]+\.\w+)[`"]?/);
    if (m2) paths.add(m2[1]);
  }
  return [...paths];
}

/**
 * Extract plausible commit SHAs (hex, 7-40 chars) from the report.
 */
function extractClaimedCommits(reportText) {
  const matches = String(reportText || '').match(/\b[0-9a-f]{7,40}\b/g) || [];
  return [...new Set(matches.filter((s) => /^[0-9a-f]+$/.test(s) && s.length >= 7))];
}

/**
 * runSelfCheck — verify claimed files + commits actually exist before review.
 * @param {string} reportText
 * @param {string} projectRoot
 * @returns {{
 *   verdict: 'PASSED'|'FAILED',
 *   files_claimed: number,
 *   files_present: number,
 *   files_missing: string[],
 *   commits_claimed: number,
 *   commits_present: number,
 *   commits_missing: string[],
 * }}
 */
export function runSelfCheck(reportText, projectRoot) {
  const claimedPaths = extractClaimedPaths(reportText);
  const claimedCommits = extractClaimedCommits(reportText);
  // V155-019: use isAbsolute() so Windows absolute paths (C:\Users\…) aren't
  // misclassified as relative. Previously `p.startsWith('/')` returned false
  // for Windows absolutes → they were joined to projectRoot → existsSync
  // false → real subagent work was flagged as missing files.
  const filesPresent = claimedPaths.filter((p) =>
    existsSync(isAbsolute(p) ? p : join(projectRoot, p)),
  );
  let commitsPresent = [];
  try {
    const allShas = execFileSync('git', ['log', '--all', '--format=%H'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n');
    commitsPresent = claimedCommits.filter((c) => allShas.some((sha) => sha.startsWith(c)));
  } catch {
    /* not a git repo — skip commit check */
  }
  const verdict =
    filesPresent.length === claimedPaths.length &&
    commitsPresent.length === claimedCommits.length
      ? 'PASSED'
      : 'FAILED';
  return {
    verdict,
    files_claimed: claimedPaths.length,
    files_present: filesPresent.length,
    files_missing: claimedPaths.filter((p) => !filesPresent.includes(p)),
    commits_claimed: claimedCommits.length,
    commits_present: commitsPresent.length,
    commits_missing: claimedCommits.filter((c) => !commitsPresent.includes(c)),
  };
}

/**
 * runPostDone — library/test surface. NOT the live DONE-handler.
 *
 * The live subagent-completion path is the `subagent.post-done` state-SDK verb
 * (which runs `runSelfCheck` + fires debug-trident on failure), plus the
 * verification gate enforced directly in `state-sdk.js`; the production
 * two-stage spec+quality review runs via agent dispatch (spec-reviewer +
 * quality-reviewer agents). This wrapper bundles reviewTask (N3) +
 * checkVerificationGate (N5) + runSelfCheck (S09) for direct-import callers
 * and `test-orchestrator-post-done-runner.js`. It carries no production
 * traffic — keep it honest: do not describe it as the live handler.
 *
 * @param {object} params
 * @param {string} params.taskId
 * @param {string} [params.taskSpec]
 * @param {string} params.commitSha
 * @param {string} [params.branch]
 * @param {string} params.reportText
 * @param {Array<{tool: string, input?: {command?: string}}>} [params.toolCallsInMessage]
 * @param {Function|null} [params.dispatch]   Reviewer dispatcher; null = skip review
 * @param {string} params.projectRoot
 * @param {string} [params.projectConventions]
 * @param {boolean} [params.strictGate=true]
 *   W12-F/F4 — RT2-H1. When true (default) and the verification gate fails,
 *   the result includes `gateAction: 'block'` and the MCP handler MUST refuse
 *   to claim success. Pass `false` for legacy advisory-only behavior.
 * @returns {Promise<{
 *   verdict: 'approved'|'spec_failed'|'quality_failed'|'no_review',
 *   reviewStage: 'spec'|'quality'|null,
 *   reviewOk: boolean,
 *   reviewFindings: string[],
 *   gatePassed: boolean,
 *   gateAction: 'block'|'advise'|'pass',
 *   gateViolation: object|null,
 *   selfCheck: {
 *     verdict: 'PASSED'|'FAILED',
 *     files_claimed: number,
 *     files_present: number,
 *     files_missing: string[],
 *     commits_claimed: number,
 *     commits_present: number,
 *     commits_missing: string[],
 *   },
 * }>}
 */
export async function runPostDone({
  taskId,
  taskSpec = '',
  commitSha,
  branch = '',
  reportText,
  toolCallsInMessage,
  dispatch,
  projectRoot,
  projectConventions = '',
  strictGate = true,
}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new TypeError('runPostDone: projectRoot is required');
  }
  if (typeof reportText !== 'string') {
    throw new TypeError('runPostDone: reportText must be a string');
  }

  // ---- Self-Check (S09) ------------------------------------------------
  // Verify claimed files + commits exist before spending review tokens.
  // Additive: doesn't gate downstream — surfaces the divergence in result.
  const selfCheck = runSelfCheck(reportText, projectRoot);

  // ---- Two-stage review (N3) -------------------------------------------
  let reviewOk = false;
  let reviewStage = null;
  let reviewFindings = [];
  let verdict = 'no_review';

  if (typeof dispatch === 'function') {
    const r = await reviewTask({
      taskId,
      taskSpec,
      commitSha,
      branch,
      projectConventions,
      dispatch,
    });
    reviewOk = !!r.ok;
    reviewStage = r.stage ?? null;
    reviewFindings = Array.isArray(r.findings) ? r.findings : [];
    if (reviewOk) {
      verdict = 'approved';
    } else {
      verdict = r.stage === 'spec' ? 'spec_failed' : 'quality_failed';
    }
  }

  // ---- Verification gate (N5) ------------------------------------------
  const gateOutcome = checkVerificationGate(
    reportText,
    Array.isArray(toolCallsInMessage) ? toolCallsInMessage : [],
  );
  if (!gateOutcome.ok) {
    try {
      // recordViolation signature is (violation, projectRoot) -- see verification-gate.js
      await recordViolation(
        { taskId, ...gateOutcome },
        projectRoot,
      );
    } catch {
      // Advisory -- never block on violation log failure (matches v1.4.4 N5 contract)
    }
  }

  // W12-F/F4 — RT2-H1: classify the gate outcome so the caller knows whether
  // to BLOCK (strict default + failure), ADVISE (caller opted out + failure),
  // or PASS (gate succeeded). The MCP tool handler reads `gateAction` and
  // surfaces a structured `block: true` to the orchestrator-LLM when 'block'.
  let gateAction;
  if (gateOutcome.ok) {
    gateAction = 'pass';
  } else if (strictGate === false) {
    gateAction = 'advise';
  } else {
    gateAction = 'block';
  }

  return {
    verdict,
    reviewStage,
    reviewOk,
    reviewFindings,
    gatePassed: gateOutcome.ok === true,
    gateAction,
    gateViolation: gateOutcome.ok ? null : { violation: gateOutcome.violation, claim: gateOutcome.claim },
    selfCheck,
  };
}
