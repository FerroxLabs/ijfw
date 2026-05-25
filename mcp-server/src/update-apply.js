// MCP tool: ijfw_update_apply
//
// @deprecated since v1.5.0; will be removed in v1.6.0 (F-FUN-3 / v1.5.0 audit-MED-M7).
// `ijfw_update_check` already issues a confirmation token whose instruction tells
// the user to type `ijfw update --confirm <token>` in their terminal directly.
// The intermediate `ijfw_update_apply` step writes a pending sentinel, but the
// terminal CLI does not require the sentinel to confirm — the token itself is
// authoritative. The tool is retained for v1.5.0 back-compat (older skills that
// still call it work unchanged) and slated for retirement in v1.6.0 to free the
// MCP-tool slot (see CLAUDE.md "MCP server: ≤14 tools" cap).
//
// Does NOT execute the update. Validates the token, writes (or overwrites)
// the pending sentinel, returns instruction telling the user to run the
// terminal-side confirm command. Idempotent against a matching sentinel
// already written by ijfw_update_check -- the sentinel + token are the
// same artifact, so re-writing with the same values is a no-op.
// Air-gaps the MCP path from actual code execution -- per v3 sec 16 blocker fix.

import { validateToken, writePendingSentinel } from './lib/token.js';
import { isVersionStringValid } from './lib/npm-view.js';

/**
 * @deprecated since v1.5.0; scheduled for removal in v1.6.0. Callers should
 * skip straight from `ijfw_update_check` to the terminal-side confirm command;
 * the intermediate sentinel write is redundant given the token contract.
 */
export function ijfwUpdateApply(args = {}) {
  const { target_version, confirmation_token } = args || {};
  const sessionId = args.session_id || process.env.IJFW_SESSION_ID || 'default-session';

  if (!target_version || !isVersionStringValid(target_version)) {
    return {
      status: 'error',
      message: 'target_version is required and must be a valid semver string',
    };
  }
  if (!confirmation_token || typeof confirmation_token !== 'string') {
    return {
      status: 'error',
      message:
        'confirmation_token is required. Run ijfw_update_check first to receive a token, then ' +
        "the user must run 'ijfw update --confirm <token>' in their TERMINAL to proceed.",
    };
  }

  const v = validateToken(sessionId, confirmation_token);
  if (!v.ok) {
    return {
      status: 'error',
      reason: v.error,
      message:
        v.error === 'expired' ? 'Token expired. Re-run ijfw_update_check to issue a fresh one.' :
        v.error === 'mismatch' ? 'Token mismatch. The token must match the one issued by the most recent ijfw_update_check.' :
        v.error === 'already-consumed' ? 'Token already consumed -- the update either ran or was attempted.' :
        'No active token. Run ijfw_update_check first.',
    };
  }
  if (v.target_version !== target_version) {
    return {
      status: 'error',
      reason: 'target-mismatch',
      message: `Token was issued for v${v.target_version}, not v${target_version}. Re-run ijfw_update_check.`,
    };
  }

  const path = writePendingSentinel(sessionId, target_version, confirmation_token);

  return {
    status: 'pending_user_confirmation',
    target_version,
    sentinel_path: path,
    instruction:
      `Run in your TERMINAL: ijfw update --confirm ${confirmation_token}\n` +
      `This MCP tool cannot execute the update -- only a terminal command can.`,
  };
}

export const TOOL_DEF = {
  name: 'ijfw_update_apply',
  description:
    '[DEPRECATED v1.5.0; removal in v1.6.0] Stage an IJFW update behind out-of-band terminal ' +
    'confirmation. Writes a pending sentinel; actual update only runs when the user types ' +
    "'ijfw update --confirm <token>' in their terminal. This MCP tool NEVER executes the " +
    'update directly. Prefer calling ijfw_update_check and forwarding the returned ' +
    "'ijfw update --confirm <token>' instruction directly to the user.",
  inputSchema: {
    type: 'object',
    required: ['target_version', 'confirmation_token'],
    properties: {
      target_version: { type: 'string', description: 'Target semver to install' },
      confirmation_token: { type: 'string', description: 'Token from ijfw_update_check' },
      session_id: { type: 'string', description: 'Session ID for token scoping (optional)' },
    },
  },
};
