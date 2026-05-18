/**
 * runtime-loop.js — v1.5.0-major S02: callable runtime wrapper for the
 * v1.4.4 N2 status protocol. Closes the "discipline-in-markdown" gap by
 * giving the orchestrator-LLM an MCP tool to invoke per subagent report,
 * instead of reading SKILL.md and hoping it remembers to call the right
 * thing in the right order.
 *
 * Pipeline (per subagent message):
 *   reviewSubagentReport(reportText, ctx)
 *     1. parseAgentReport(reportText)   -- status-protocol.js N2
 *     2. handleStatus(parsed, dispatchTs, ctx)
 *     3. return { action, ...decision, parsed? }
 *
 * Failure modes are explicit, never thrown:
 *   - ProtocolViolation  -> { action: 'redispatch_needs_context',
 *                              missing: 'protocol-violation', error, raw }
 *   - Stale commit       -> { action: 'redispatch_needs_context',
 *                              missing: 'commit-before-report' }   (from handleStatus)
 *
 * The MCP tool wrapper in server.js passes projectRoot from cwd.
 */

import { parseAgentReport, handleStatus, ProtocolViolation } from './status-protocol.js';

/**
 * Review a subagent's report through the v1.4.4 4-value protocol.
 * Returns a route decision object the orchestrator should act on.
 *
 * @param {string} reportText - the subagent's final message
 * @param {object} ctx
 * @param {number} ctx.dispatchTimestamp - Unix seconds at dispatch
 * @param {string} [ctx.branch]          - dispatched branch (for branch-tuple freshness check)
 * @param {string} ctx.projectRoot       - absolute path of project root for git commands
 * @returns {{ action: string, parsed?: object, missing?: string, error?: string, raw?: string, [k: string]: unknown }}
 */
export function reviewSubagentReport(reportText, ctx) {
  if (typeof reportText !== 'string' || reportText.length === 0) {
    return {
      action: 'redispatch_needs_context',
      missing: 'protocol-violation',
      error: 'empty or non-string reportText',
      raw: String(reportText ?? ''),
    };
  }
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('reviewSubagentReport: ctx is required');
  }
  if (typeof ctx.dispatchTimestamp !== 'number' || !Number.isFinite(ctx.dispatchTimestamp)) {
    throw new TypeError('reviewSubagentReport: ctx.dispatchTimestamp must be a finite number (unix seconds)');
  }
  if (typeof ctx.projectRoot !== 'string' || ctx.projectRoot.length === 0) {
    throw new TypeError('reviewSubagentReport: ctx.projectRoot is required');
  }

  let parsed;
  try {
    parsed = parseAgentReport(reportText);
  } catch (err) {
    if (err instanceof ProtocolViolation) {
      return {
        action: 'redispatch_needs_context',
        missing: 'protocol-violation',
        error: err.reason,
        raw: err.raw,
      };
    }
    throw err;
  }

  // If the parsed branch contradicts the dispatched branch, prefer the parsed
  // (agent-reported) value -- handleStatus uses it for the branch-tuple check.
  // The ctx.branch is informational; we don't override what the agent said.
  const decision = handleStatus(parsed, ctx.dispatchTimestamp, { projectRoot: ctx.projectRoot });
  return { ...decision, parsed };
}

/**
 * Cross-AI resume routing (v1.5.0 W12-C N02).
 *
 * When a subagent truncates mid-task, the orchestrator can resume the same
 * checkpoint on a *different* AI to avoid the same context-window/format
 * failure mode. These helpers encode the routing matrix + brief composition
 * so the orchestrator-LLM doesn't have to remember it.
 *
 * The matrix is deliberately small and hand-tuned: each entry picks an
 * alternate AI whose context window / output style differs from the one
 * that truncated. We never reselect the truncated AI itself.
 */

const RESUME_PREFERENCE = {
  claude: ['gemini', 'codex'],
  gemini: ['claude', 'codex'],
  codex: ['claude', 'gemini'],
};

/**
 * Pick a resume AI for a truncated subagent.
 *
 * @param {object} args
 * @param {string} args.truncatedAI               - AI that truncated ('claude' | 'gemini' | 'codex')
 * @param {string[]} [args.available]             - AIs the orchestrator can dispatch to
 * @param {string} [args.lastFailureReason]       - e.g. 'context_window'
 * @returns {string|null}                         - resume target, or null when blocked
 */
export function selectResumeAI({ truncatedAI, available = ['claude', 'gemini', 'codex'], lastFailureReason } = {}) {
  if (typeof truncatedAI !== 'string' || truncatedAI.length === 0) {
    return null;
  }

  // gemini already has the largest practical context window of the three.
  // If it truncated *because of* context-window pressure, no alternative
  // gives us a larger window -- escalate instead of pretending to resume.
  if (lastFailureReason === 'context_window' && truncatedAI === 'gemini') {
    return null;
  }

  const preferred = RESUME_PREFERENCE[truncatedAI] || [];
  for (const candidate of preferred) {
    if (candidate === truncatedAI) continue;
    if (available.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Build a resume brief composing the original spec + checkpoint state.
 * Intentionally omits the Step 0 workspace-setup boilerplate: the resume
 * agent inherits the branch + worktree from the first attempt and skips it.
 *
 * @param {object} args
 * @param {string} args.originalSpec   - original task brief, verbatim
 * @param {object} args.checkpoint     - { filesWritten?, commitSha?, partialProgress? }
 * @param {string} args.fromAI         - AI that truncated
 * @param {string} args.toAI           - AI taking over
 * @returns {string}
 */
export function buildResumeBrief({ originalSpec, checkpoint = {}, fromAI, toAI } = {}) {
  const spec = typeof originalSpec === 'string' ? originalSpec : '';
  const files = Array.isArray(checkpoint.filesWritten) ? checkpoint.filesWritten : [];
  const sha = typeof checkpoint.commitSha === 'string' ? checkpoint.commitSha : '';
  const partial = typeof checkpoint.partialProgress === 'string' ? checkpoint.partialProgress : '';

  const filesLine = files.length > 0 ? `  Files written: ${files.join(', ')}` : '  Files written: (none recorded)';
  const shaLine = sha ? `  Commit: ${sha}` : '  Commit: (none yet)';
  const partialLine = partial ? `  Partial progress: ${partial}` : '  Partial progress: (none recorded)';

  // r15-M6: estimate brief size and surface a context-window advisory. The
  // receiving model may have a SMALLER window than the one that truncated
  // (selectResumeAI refuses gemini→larger when reason is context_window, but
  // it can't know the receiver's exact window from here). Tell the receiver
  // to summarise rather than re-quote if the prior context approaches its cap.
  const approxTokens = Math.ceil((spec.length + filesLine.length + shaLine.length + partialLine.length) / 4);
  const budgetLine = `Approx prior-context tokens: ~${approxTokens}. If this brief plus your reply would exceed your context window, summarise the prior agent's "Files written" + "Partial progress" lines instead of quoting verbatim and proceed.`;

  return [
    spec,
    '',
    '---',
    `RESUME CONTEXT — Prior agent (${fromAI}) truncated. Already done:`,
    filesLine,
    shaLine,
    partialLine,
    '',
    budgetLine,
    '',
    `You are ${toAI}. Continue from here. Do NOT redo completed work.`,
    'Skip workspace setup (Step 0) -- branch + worktree already exist.',
  ].join('\n');
}

/**
 * Decide what to do when a subagent report indicates truncation.
 *
 * @param {object} args
 * @param {object} args.parsed                 - parsed report (must carry ai + reason if known)
 * @param {object} args.ctx                    - orchestrator context; ctx.checkpoint may be present
 * @param {string[]} [args.available]          - AIs available to dispatch
 * @returns {{action:'resume_with_alt_ai', toAI:string, brief:string}
 *           | {action:'escalate_to_user', reason:string}}
 */
export function handleTruncation({ parsed = {}, ctx = {}, available = ['claude', 'gemini', 'codex'] } = {}) {
  const truncatedAI = typeof parsed.ai === 'string' && parsed.ai.length > 0 ? parsed.ai : 'claude';
  const lastFailureReason = parsed.reason;
  const toAI = selectResumeAI({ truncatedAI, available, lastFailureReason });

  if (!toAI) {
    return {
      action: 'escalate_to_user',
      reason: lastFailureReason === 'context_window' && truncatedAI === 'gemini'
        ? 'context_window_exceeded_on_largest_ai'
        : 'no_alternate_ai_available',
    };
  }

  const checkpoint = ctx.checkpoint && typeof ctx.checkpoint === 'object' ? ctx.checkpoint : {};
  const originalSpec = typeof ctx.originalSpec === 'string' ? ctx.originalSpec : '';
  const brief = buildResumeBrief({ originalSpec, checkpoint, fromAI: truncatedAI, toAI });

  return { action: 'resume_with_alt_ai', toAI, brief };
}
