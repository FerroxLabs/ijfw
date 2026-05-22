/**
 * post-done-runner.js — v1.5.0-major S02: enforced post-DONE pipeline.
 *
 * Runs after a subagent reports DONE. Wraps reviewTask (v1.4.4 N3 two-stage
 * review) and checkVerificationGate (v1.4.4 N5) into a single callable the
 * orchestrator-LLM invokes via MCP, so the post-DONE contract isn't satisfied
 * by markdown prose. (The live production path is the `subagent.post-done`
 * state-SDK verb, which calls `runSelfCheck` directly; `runtime-loop.js` —
 * the original S02 caller — was never wired and carries no production traffic.)
 *
 * v1.5.0 T13: the standalone `ijfw_subagent_post_done` MCP tool was retired and
 * absorbed into the single `ijfw_state` MCP tool as the `subagent.post-done`
 * verb (see STATE-SDK-CONTRACT §7). `runSelfCheck` is re-exported through
 * `state-sdk.js` for that verb; `runPostDone` is still exported here for the
 * direct-import test path (`test-orchestrator-post-done-runner.js`).
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
import { execFileSync } from 'node:child_process';
import { reviewTask } from './review.js';
import { checkVerificationGate, recordViolation } from './verification-gate.js';
// v1.5.1 W2.C: debug-trident (T29) — wired into runPostDone's gate-failure
// branch as an informational 2nd opinion. INTEGRATION STATUS (v1.5.1 medlow
// audit): runPostDone itself is the test-path export (see header — the live
// subagent-completion path is the `subagent.post-done` state-SDK verb, which
// uses runSelfCheck, not runPostDone). debug-trident therefore fires only
// when a caller of runPostDone injects `debugTridentDispatch`; no production
// caller does so today. The campaign is annotation-only (never alters
// gateAction, fail-safe per W2.C). Promoting this to the live verb requires
// a lens dispatcher the state-SDK verb does not currently carry — deferred
// rather than overclaimed.
import { runDebugCampaign, DEBUG_OUTCOMES } from './debug-trident.js';

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
 * @param {boolean} [params.strictGate=true]
 *   W12-F/F4 — RT2-H1. When true (default) and the verification gate fails,
 *   the result includes `gateAction: 'block'` and the MCP handler MUST refuse
 *   to claim success. Pass `false` for legacy advisory-only behavior.
 * @param {Function} [params.debugTridentDispatch]
 *   v1.5.1 W2.C. Optional Trident lens dispatcher. When the verification gate
 *   FAILS and this dispatcher is provided, runDebugCampaign (T29) is invoked
 *   as an informational 2nd opinion — the resulting competing-hypothesis
 *   summary is attached as `debugTridentAnnotation` on the receipt. NEVER
 *   alters `gateAction` (fail-safe wiring: block-verdict is authoritative).
 *   Shape: async ({ lens, evidencePack, currentHypotheses }) =>
 *     { lens, hypotheses: [ { hypothesis, rationale? } ] }.
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
  debugTridentDispatch,
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
  let debugTridentAnnotation = null;
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

    // v1.5.1 W2.C: invoke debug-trident (T29) for an informational 2nd
    // opinion on WHY the gate failed. Wired conservatively:
    //   - Only fires when a dispatcher was injected by the caller (default off).
    //   - Result is annotation-only — never alters gateAction.
    //   - A throw inside runDebugCampaign is swallowed; the gate verdict
    //     remains authoritative (fail-safe per W2.C contract).
    //   - Single forced cycle (maxCycles:1 + forceTrident via dispatch
    //     returning INVESTIGATION_INCONCLUSIVE) keeps cost bounded; we are
    //     after competing hypotheses, not a multi-round debug campaign.
    if (typeof debugTridentDispatch === 'function') {
      try {
        const claimText = gateOutcome.claim ? String(gateOutcome.claim) : '<unknown>';
        const evidencePack = [
          `gate-violation: ${gateOutcome.violation}`,
          `claim: ${claimText}`,
          `taskId: ${taskId}`,
          `branch: ${branch || '(unspecified)'}`,
          `commitSha: ${commitSha || '(none)'}`,
          // Truncate the report so we don't spend lens tokens on a wall of text.
          `report-head: ${String(reportText).slice(0, 2048)}`,
        ].join('\n');
        const campaign = await runDebugCampaign({
          sessionId: `gate-failure:${taskId || 'unknown'}`,
          symptoms: `verification-gate FAILED: claim="${claimText}" but no fresh verify in same message`,
          // Seed the tree with the gate's own hypothesis ("the agent claimed
          // completion without evidence"). The lenses will compete on WHY.
          hypotheses: [{
            id: 'H1',
            hypothesis: 'Agent emitted completion claim without running tests/build in same message.',
            status: 'open',
            evidence: gateOutcome.violation,
            refuted_by: '',
          }],
          // One forced cycle: returning INVESTIGATION_INCONCLUSIVE triggers
          // immediate stall-detection → Trident escalation → exit.
          dispatch: async () => ({ terminator: 'INVESTIGATION_INCONCLUSIVE' }),
          tridentDispatch: debugTridentDispatch,
          maxCycles: 1,
          evidencePack,
          projectRoot,
          // Telemetry is fine to record — it never alters the campaign verdict
          // and gives the dashboard a debug-campaign event per gate failure.
          recordTelemetry: true,
        });
        debugTridentAnnotation = {
          outcome: campaign.outcome,
          stalls: campaign.stalls,
          tridentInvocations: campaign.tridentInvocations,
          hypothesesAdded: campaign.hypothesesAdded,
          competingHypotheses: (Array.isArray(campaign.hypothesesFinal) ? campaign.hypothesesFinal : [])
            .filter((h) => typeof h?.from === 'string' && h.from.startsWith('trident:'))
            .slice(0, 6)
            .map((h) => ({
              id: h.id,
              from: h.from,
              hypothesis: h.hypothesis,
              rationale: h.rationale || '',
            })),
          durationMs: campaign.duration_ms,
          // Mirror the DEBUG_OUTCOMES vocabulary so dashboards can group by it
          // without hard-coding string literals.
          knownOutcome: Object.values(DEBUG_OUTCOMES).includes(campaign.outcome),
        };
      } catch (err) {
        // Fail-safe: a throw from debug-trident must NOT change the gate
        // verdict. Record the error on the annotation so the receipt shows
        // the 2nd-opinion attempt was made but didn't yield hypotheses.
        debugTridentAnnotation = {
          outcome: 'campaign_failed',
          error: err && err.message ? String(err.message) : String(err),
          competingHypotheses: [],
        };
      }
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
