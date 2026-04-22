// MCP tool: ijfw_update_check
//
// Returns { current, latest, available, confirmation_token?, expires_at?, changelog_url, instruction? }
// If update is available, issues a 5-min confirmation token. Token must be
// consumed via terminal-side `ijfw update --confirm <token>` -- see v3 sec 16.
//
// Re-entrancy guard: if state.json.last_applied_version == cached last_latest_seen,
// returns available:false (just-updated suppression).

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSafe, writeAtomic } from './lib/atomic-io.js';
import { npmView, compareSemver } from './lib/npm-view.js';
import { issueToken } from './lib/token.js';

const PKG = '@ijfw/install';
const REPO = 'TheRealSeanDonahoe/ijfw';

function ijfwHome() {
  return process.env.IJFW_HOME || join(homedir(), '.ijfw');
}

export function readInstalledVersion() {
  const sp = readSafe(join(ijfwHome(), 'state.json'));
  if (sp.ok && sp.data && typeof sp.data.installed_version === 'string') {
    return sp.data.installed_version;
  }
  return '0.0.0';
}

export function readLastApplied() {
  const sp = readSafe(join(ijfwHome(), 'state.json'));
  return (sp.ok && sp.data && sp.data.last_applied_version) || null;
}

export function readCachedCheck() {
  return readSafe(join(ijfwHome(), 'cache', 'update-check.json'));
}

export function writeCachedCheck(data) {
  return writeAtomic(join(ijfwHome(), 'cache', 'update-check.json'), {
    schema_version: 1,
    last_check: Math.floor(Date.now() / 1000),
    ...data,
  });
}

export function ijfwUpdateCheck(args = {}) {
  const sessionId = args.session_id || process.env.IJFW_SESSION_ID || 'default-session';
  const force = args.force === true;

  const current = readInstalledVersion();
  const lastApplied = readLastApplied();
  const cached = readCachedCheck();

  let latest = null;
  if (!force && cached.ok && cached.data && typeof cached.data.last_latest_seen === 'string') {
    // Use cached value if fresh enough (24h)
    const ageSec = Math.floor(Date.now() / 1000) - (cached.data.last_check || 0);
    if (ageSec < 24 * 3600 && ageSec >= 0) {
      latest = cached.data.last_latest_seen;
    }
  }
  if (!latest) {
    const r = npmView(PKG);
    if (!r.ok) {
      return {
        current,
        latest: null,
        available: false,
        error: r.error,
        message: 'update check failed; will retry next session',
      };
    }
    latest = r.version;
    try { writeCachedCheck({ last_latest_seen: latest, last_failure: null }); } catch { /* */ }
  }

  // Re-entrancy: if we just applied this version, don't nudge again
  if (lastApplied && compareSemver(lastApplied, latest) >= 0) {
    return { current, latest, available: false, reason: 'up-to-date' };
  }

  const cmp = compareSemver(current, latest);
  const available = cmp < 0;

  const result = {
    current,
    latest,
    available,
    changelog_url: `https://github.com/${REPO}/releases/tag/v${latest}`,
  };

  if (available) {
    const tok = issueToken(sessionId, latest);
    result.confirmation_token = tok.token;
    result.expires_at = tok.expires_at;
    result.instruction =
      `To proceed, run in your TERMINAL: ijfw update --confirm ${tok.token}\n` +
      `Token expires in 5 minutes. The MCP tool cannot execute the update directly.`;
  }

  return result;
}

export const TOOL_DEF = {
  name: 'ijfw_update_check',
  description:
    'Check if an IJFW update is available. Issues a confirmation token; the user must run ' +
    "'ijfw update --confirm <token>' in their terminal to actually update. The model cannot " +
    'execute updates directly -- this air-gaps prompt injection from code execution.',
  inputSchema: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: 'Bypass cache, fetch from npm now' },
      session_id: { type: 'string', description: 'Session ID for token scoping (optional)' },
    },
  },
};
