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

import { reviewTask } from './review.js';
import { checkVerificationGate, recordViolation } from './verification-gate.js';

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
  };
}
