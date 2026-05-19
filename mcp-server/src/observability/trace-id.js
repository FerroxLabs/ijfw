/**
 * observability/trace-id.js -- v1.5.0 N4.obs M1
 *
 * Session-scoped trace IDs (Langfuse / Helicone-style sessions->traces->observations
 * rollup). One UUID per orchestrator session, propagated to subagent worktrees
 * via the IJFW_TRACE_ID env var, and recorded on every checkpoint / receipt /
 * observation / session row.
 *
 * Discovery order (caller-side):
 *   1. process.env.IJFW_TRACE_ID  (set explicitly by orchestrator or subagent parent)
 *   2. lazy-init: generate one and cache in module state
 *
 * Zero deps -- Node built-in crypto only.
 *
 * Threading model: a single Node process holds at most ONE current trace id at a
 * time. Subagents inherit via env var; if they call ensureTraceId() they keep
 * the parent's id. resetTraceId() exists for tests only.
 */

import { randomUUID } from 'node:crypto';

const ENV_VAR = 'IJFW_TRACE_ID';
// RFC 4122 v4 UUID -- 32 hex chars + 4 dashes
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _cached = null;

/**
 * Hierarchical observation path (Helicone-style) -- v1.5.0 N4.obs M2.
 *
 * The orchestrator-LLM walks down `/wave-<waveId>/sub-<subId>/tool-<toolName>`
 * via pushPath/popPath wrappers (NOT exported -- callers compose the segment
 * themselves so the runtime doesn't have to track a stack across async ops).
 */
const PATH_SEPARATOR = '/';

/**
 * Validate a UUID-shaped trace id. Reject anything else so a poisoned env
 * var (e.g. `IJFW_TRACE_ID=$(rm -rf /)`) doesn't flow into receipt files.
 */
export function isValidTraceId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Get the current trace id, generating one if none exists. Idempotent within a
 * process: subsequent calls return the same id unless `resetTraceId` is called.
 *
 * If process.env.IJFW_TRACE_ID is set and valid, it is adopted (this is how
 * worktree subagents inherit the orchestrator's trace).
 *
 * @returns {string} current trace id (RFC 4122 v4 UUID).
 */
export function ensureTraceId() {
  if (_cached && isValidTraceId(_cached)) return _cached;
  const fromEnv = process.env[ENV_VAR];
  if (isValidTraceId(fromEnv)) {
    _cached = fromEnv;
    return _cached;
  }
  _cached = randomUUID();
  // Reflect into env so a child process spawned without an explicit env arg
  // still inherits via the standard mechanism.
  process.env[ENV_VAR] = _cached;
  return _cached;
}

/**
 * Read the current trace id without generating one. Returns null if neither the
 * cache nor the env var has a valid id. Useful for "tag if available, don't
 * fabricate" call sites.
 *
 * @returns {string|null}
 */
export function getTraceId() {
  if (_cached && isValidTraceId(_cached)) return _cached;
  const fromEnv = process.env[ENV_VAR];
  if (isValidTraceId(fromEnv)) {
    _cached = fromEnv;
    return _cached;
  }
  return null;
}

/**
 * Adopt a trace id explicitly. Used when an orchestrator dispatches a subagent
 * and wants to set the env var into the spawn options.
 *
 * @param {string} id
 * @returns {string} the adopted id (throws if invalid)
 */
export function setTraceId(id) {
  if (!isValidTraceId(id)) {
    throw new Error(`trace-id: refusing to adopt invalid trace id "${id}"`);
  }
  _cached = id;
  process.env[ENV_VAR] = id;
  return _cached;
}

/**
 * Test-only: clear the cached trace id and the env var. Caller-side tests
 * import this to reset state between cases.
 */
export function resetTraceId() {
  _cached = null;
  delete process.env[ENV_VAR];
}

/**
 * Build the env object to hand to child_process.spawn / Agent worktree dispatch
 * so the child inherits the current trace id. Pass-through clones existing env
 * keys; callers MAY override.
 *
 * @param {object} [extra] extra env keys to merge in
 * @returns {object}
 */
export function traceEnv(extra = {}) {
  const id = ensureTraceId();
  return { ...process.env, [ENV_VAR]: id, ...extra };
}

/**
 * Compose a hierarchical observation path -- v1.5.0 N4.obs M2.
 *
 * Convention: `/wave-<waveId>/sub-<subId>/tool-<toolName>`. Each segment is
 * sanitised to `[A-Za-z0-9_-]` so the path is safe to render in a dashboard
 * tree without escaping. Empty/missing segments are skipped.
 *
 * Example:
 *   composePath({ waveId: 'W12-A', subId: 'N05', tool: 'Bash' })
 *   -> "/wave-W12-A/sub-N05/tool-Bash"
 *
 * @param {{waveId?: string, subId?: string, tool?: string, segments?: string[]}} parts
 * @returns {string}
 */
export function composePath(parts = {}) {
  const segs = [];
  if (parts && typeof parts === 'object') {
    if (typeof parts.waveId === 'string' && parts.waveId.length > 0) {
      segs.push(`wave-${sanitiseSegment(parts.waveId)}`);
    }
    if (typeof parts.subId === 'string' && parts.subId.length > 0) {
      segs.push(`sub-${sanitiseSegment(parts.subId)}`);
    }
    if (typeof parts.tool === 'string' && parts.tool.length > 0) {
      segs.push(`tool-${sanitiseSegment(parts.tool)}`);
    }
    if (Array.isArray(parts.segments)) {
      for (const s of parts.segments) {
        if (typeof s !== 'string' || s.length === 0) continue;
        segs.push(sanitiseSegment(s));
      }
    }
  }
  if (segs.length === 0) return '';
  return PATH_SEPARATOR + segs.join(PATH_SEPARATOR);
}

function sanitiseSegment(s) {
  // Collapse anything outside [A-Za-z0-9_-] to '_'. Cap at 64 chars.
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
}
