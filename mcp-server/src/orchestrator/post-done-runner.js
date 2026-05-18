/**
 * post-done-runner.js — v1.5.0-major S02: enforced post-DONE pipeline.
 *
 * Runs after a subagent's DONE has been verified by runtime-loop.js. Wraps
 * reviewTask (v1.4.4 N3 two-stage review) and checkVerificationGate
 * (v1.4.4 N5) into a single callable the orchestrator-LLM invokes via MCP,
 * so the post-DONE contract isn't satisfied by markdown prose.
 *
 * Outcome shape (uniform regardless of branch taken):
 *   {
 *     verdict: 'approved' | 'spec_failed' | 'quality_failed',
 *     reviewStage: 'spec' | 'quality',
 *     reviewOk: boolean,
 *     reviewFindings: string[],
 *     gatePassed: boolean,
 *     gateViolation: object | null,
 *   }
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
import { execFileSync } from 'node:child_process';
import { reviewTask } from './review.js';
import { checkVerificationGate, recordViolation } from './verification-gate.js';

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
  const filesPresent = claimedPaths.filter((p) =>
    existsSync(p.startsWith('/') ? p : `${projectRoot}/${p}`),
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
 * @returns {Promise<{
 *   verdict: 'approved'|'spec_failed'|'quality_failed'|'no_review',
 *   reviewStage: 'spec'|'quality'|null,
 *   reviewOk: boolean,
 *   reviewFindings: string[],
 *   gatePassed: boolean,
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

  return {
    verdict,
    reviewStage,
    reviewOk,
    reviewFindings,
    gatePassed: gateOutcome.ok === true,
    gateViolation: gateOutcome.ok ? null : { violation: gateOutcome.violation, claim: gateOutcome.claim },
    selfCheck,
  };
}
