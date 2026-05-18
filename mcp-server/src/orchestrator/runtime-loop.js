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
