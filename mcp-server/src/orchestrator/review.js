/**
 * review.js — Two-stage per-task review for the IJFW orchestrator.
 *
 * Stage 1: spec-compliance reviewer — confirms the diff faithfully
 *   implements every requirement in the task spec.
 * Stage 2: code-quality reviewer — checks correctness, security, and
 *   project-convention adherence (runs only after Stage 1 passes).
 *
 * The `dispatch` parameter is injected by the caller so this module is
 * testable without a live Agent tool. Signature:
 *   (kind: 'spec-compliance' | 'code-quality', ctx: object)
 *     => Promise<{ verdict: 'PASS' | 'FAIL', findings: string[] }>
 *
 * Landed in W10-A2 (v1.4.4 — N3).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum re-review iterations before escalation. */
export const REVIEW_MAX_ITERATIONS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when re-review should be triggered.
 *
 * @param {'PASS'|'FAIL'} prevVerdict
 * @param {number} iteration  1-based iteration count (1 = first attempt)
 * @returns {boolean}
 */
export function shouldReReview(prevVerdict, iteration) {
  return prevVerdict !== 'PASS' && iteration < REVIEW_MAX_ITERATIONS;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run two-stage review for a completed task.
 *
 * @param {object} params
 * @param {string} params.taskId               Blackboard task ID
 * @param {string} params.taskSpec             Full task specification text
 * @param {string} params.commitSha            SHA of the implementer's commit
 * @param {string} params.branch               Branch name
 * @param {string} [params.projectConventions] CLAUDE.md / AGENTS.md excerpt
 * @param {Function} params.dispatch           Injected reviewer dispatcher
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   stage: 'spec' | 'quality',
 *   findings: string[]
 * }>}
 */
export async function reviewTask({
  taskId,
  taskSpec,
  commitSha,
  branch,
  projectConventions = '',
  dispatch,
}) {
  // ------------------------------------------------------------------
  // Stage 1: spec-compliance reviewer
  // ------------------------------------------------------------------
  const spec = await dispatch('spec-compliance', {
    taskId,
    taskSpec,
    commitSha,
    branch,
  });

  if (spec.verdict !== 'PASS') {
    return {
      ok: false,
      stage: 'spec',
      findings: spec.findings ?? [],
    };
  }

  // ------------------------------------------------------------------
  // Stage 2: code-quality reviewer (only runs after spec PASS)
  // ------------------------------------------------------------------
  const quality = await dispatch('code-quality', {
    taskId,
    commitSha,
    branch,
    projectConventions,
  });

  return {
    ok: quality.verdict === 'PASS',
    stage: 'quality',
    findings: quality.findings ?? [],
  };
}
