/**
 * runtime-mediator.js -- IJFW 1.4.0 W7/B2
 *
 * Tier-1 cross-platform runtime sandbox mediation for installed extensions.
 *
 * Reads the active extension descriptor at ~/.ijfw/state/active-extension.json
 * (written by the extension installer when an extension takes the active
 * context). Maps MCP tool calls to (action, target) and decides whether the
 * extension's declared permissions allow them.
 *
 * Backwards compat invariant: with NO state file present, behaviour is
 * identical to today (allow all) -- callers see activeExt === null and
 * checkPermission() returns { allowed: true }.
 *
 * Fail-closed invariant: if the file exists but is unparseable / malformed,
 * the caller MUST treat it as a deny. A corrupted state file is not a free
 * pass -- that would defeat the sandbox.
 */

import { readFile, mkdir, appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Log rotation: when permission-events.jsonl exceeds this many lines, rename
// to .0 (overwriting any prior .0) and start fresh. Total on disk = 2 * cap.
const ROTATION_LINE_CAP = 10_000;

// Sentinel returned from getActiveExtension when the file exists but is
// invalid. Callers compare with === to distinguish from null (no file).
const MALFORMED = Object.freeze({ __malformed: true });

function stateDir(home) {
  return join(home, '.ijfw', 'state');
}

function activeExtPath(home) {
  return join(stateDir(home), 'active-extension.json');
}

function eventLogPath(home) {
  return join(stateDir(home), 'permission-events.jsonl');
}

/**
 * Read and validate ~/.ijfw/state/active-extension.json.
 *
 * Returns:
 *   - null          -- file absent (bundled IJFW context, allow all).
 *   - {name, scope, permissions:{reads,writes}} -- well-formed descriptor.
 *   - {__malformed: true} (=== MALFORMED) -- file exists but broken; deny.
 */
export async function getActiveExtension(opts = {}) {
  const home = opts.homeDir || process.env.HOME || homedir();
  let raw;
  try {
    raw = await readFile(activeExtPath(home), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    // Any other read error (permission denied, etc) is fail-closed.
    return MALFORMED;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return MALFORMED;
  }
  if (!parsed || typeof parsed !== 'object') return MALFORMED;
  if (typeof parsed.name !== 'string' || !parsed.name) return MALFORMED;
  if (!parsed.permissions || typeof parsed.permissions !== 'object') return MALFORMED;
  const reads = parsed.permissions.reads;
  const writes = parsed.permissions.writes;
  if (!Array.isArray(reads) || !Array.isArray(writes)) return MALFORMED;
  return {
    name: parsed.name,
    scope: typeof parsed.scope === 'string' ? parsed.scope : 'project',
    permissions: { reads, writes },
  };
}

/**
 * Match a target against an entry in a permissions list. Supports:
 *   - exact match
 *   - '*' wildcard (matches everything)
 *   - prefix glob 'memory:*' (matches anything beginning with 'memory:')
 */
function matchesEntry(entry, target) {
  if (entry === '*') return true;
  if (entry === target) return true;
  if (typeof entry === 'string' && entry.endsWith(':*')) {
    const prefix = entry.slice(0, -1); // 'memory:*' -> 'memory:'
    if (target.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Decide whether `action` against `target` is permitted under the active
 * extension's permissions.
 *
 *   - activeExt === null      -> allowed (bundled IJFW context).
 *   - activeExt === MALFORMED -> denied with 'malformed active-extension state'.
 *   - action === 'read'       -> target must match an entry in permissions.reads.
 *   - action === 'write'      -> target must match an entry in permissions.writes.
 *
 * Returns { allowed: boolean, reason: string }.
 */
export function checkPermission(action, target, activeExt) {
  if (activeExt === null || activeExt === undefined) {
    return { allowed: true, reason: 'bundled context' };
  }
  if (activeExt && activeExt.__malformed) {
    return { allowed: false, reason: 'malformed active-extension state' };
  }
  if (action !== 'read' && action !== 'write') {
    return { allowed: false, reason: `unknown action: ${action}` };
  }
  const list = action === 'read' ? activeExt.permissions.reads : activeExt.permissions.writes;
  for (const entry of list) {
    if (matchesEntry(entry, target)) {
      return { allowed: true, reason: `matched ${entry}` };
    }
  }
  return {
    allowed: false,
    reason: `${action} ${target} not permitted by extension "${activeExt.name}"`,
  };
}

/**
 * Rotate permission-events.jsonl if it exceeds ROTATION_LINE_CAP lines.
 * Renames current file to .0 (overwriting any prior .0) then the caller
 * appends to the fresh empty file. Best effort -- never throws.
 */
async function maybeRotateEventLog(logPath) {
  try {
    let st;
    try { st = await stat(logPath); } catch { return; } // ENOENT = no rotation needed
    if (st.size === 0) return;
    // Count newlines in a single Buffer read. This is the amortised cost.
    const buf = await readFile(logPath);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++; // '\n'
    }
    if (count < ROTATION_LINE_CAP) return;
    await rename(logPath, logPath + '.0');
  } catch {
    // Rotation failure is non-fatal.
  }
}

/**
 * Append one JSON line to ~/.ijfw/state/permission-events.jsonl. Best effort:
 * never throws. The forensic trail is a nice-to-have, not a critical path.
 * Rotation check runs on each append (cost amortised).
 */
export async function logPermissionEvent(event, opts = {}) {
  try {
    const home = opts.homeDir || process.env.HOME || homedir();
    await mkdir(stateDir(home), { recursive: true });
    await maybeRotateEventLog(eventLogPath(home));
    const line = JSON.stringify(event) + '\n';
    await appendFile(eventLogPath(home), line, 'utf8');
  } catch {
    // Swallow: logging must never break tool dispatch.
  }
}

/**
 * Map an MCP tool name (+ args) to the (action, target) tuple used for
 * permission checks. Returns null for unrecognised tool names; callers
 * should treat null as "no policy applies, allow" (these are bundled-only).
 */
export function toolNameToActionTarget(toolName, args) {
  switch (toolName) {
    case 'ijfw_memory_store':
      return { action: 'write', target: 'memory:write' };
    case 'ijfw_memory_recall':
    case 'ijfw_memory_search':
    case 'ijfw_memory_status':
    case 'ijfw_memory_prelude':
    case 'ijfw_cross_project_search':
      return { action: 'read', target: 'memory:read' };
    case 'ijfw_metrics':
      return { action: 'read', target: 'metrics:read' };
    case 'ijfw_update_check':
      return { action: 'read', target: 'update:check' };
    case 'ijfw_update_apply':
      return { action: 'write', target: 'update:apply' };
    case 'ijfw_prompt_check':
      return { action: 'read', target: 'prompt:check' };
    case 'ijfw_run': {
      // Parse the first colon-syntax token out of args.command -- e.g.
      // "compute:python ..." -> subject 'compute'. Anything without a
      // colon-prefixed leading token gets target 'run:*'.
      let subject = '*';
      if (args && typeof args.command === 'string') {
        const m = args.command.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:/);
        if (m) subject = m[1];
      }
      return { action: 'write', target: `run:${subject}` };
    }
    default:
      return null;
  }
}
