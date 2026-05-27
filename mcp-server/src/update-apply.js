// Internal helper: ijfwUpdateApply (sentinel writer).
//
// V155-017 (v1.5.5): formerly exposed as the `ijfw_update_apply` MCP tool.
// The MCP registration was retired in v1.5.5 because `ijfw_update_check`
// already issues a confirmation token whose instruction tells the user to
// type `ijfw update --confirm <token>` in their terminal directly. The
// intermediate `ijfw_update_apply` MCP verb wrote a pending sentinel, but
// the terminal CLI does not require the sentinel to confirm — the token
// itself is authoritative.
//
// The function is kept INTERNAL-ONLY: still called from sentinel-write tests
// (test-1.1.6.js) which exercise validateToken + writePendingSentinel +
// target-mismatch semantics. It is NOT registered as an MCP tool and NOT
// referenced from user-facing CLI strings. If you find yourself wanting to
// re-expose it via MCP, check the ≤14 tool cap (mcp-server/TOOLS.md) and
// pick a tool to retire first.
//
// Does NOT execute the update. Validates the token, writes (or overwrites)
// the pending sentinel. Idempotent against a matching sentinel already
// written by ijfw_update_check.

import { validateToken, writePendingSentinel } from './lib/token.js';
import { isVersionStringValid } from './lib/npm-view.js';

/**
 * V155-017: internal sentinel-write helper. Was the `ijfw_update_apply`
 * MCP tool through v1.5.4; retired from MCP surface in v1.5.5. Retained
 * as in-process callable for the sentinel-write test surface and for any
 * future flow that wants to write a sentinel without going through
 * `ijfw_update_check` (no current production caller).
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

// V155-017: TOOL_DEF removed in v1.5.5 — `ijfw_update_apply` is no longer
// an MCP tool. The streamlined update flow is `ijfw_update_check` → terminal
// `ijfw update --confirm <token>`. See server.js TOOLS array for the v1.5.5
// MCP tool surface; do not re-add this without retiring another tool first
// (≤14 tool cap, mcp-server/TOOLS.md).
