/**
 * subagent-telemetry.js — v1.5.0 S1: subagent checkpoint/resume telemetry.
 *
 * Closes 8/13 truncation pattern observed across v1.4.4 Wave 10 + v1.5.0
 * research dispatch. Implementer agents call `recordCheckpoint` via the
 * (forthcoming) `ijfw checkpoint` CLI to persist progress before the
 * Claude Code subagent harness's ~20-tool / 60s wall-clock cap fires.
 * The orchestrator calls `listOrphanedSubagents` post-wave to detect
 * truncations, and `readLastCheckpoint` to resume mid-execution.
 *
 * Storage layout:
 *   <projectRoot>/.ijfw/wave-<waveId>/subagent-<subId>.checkpoint.json
 * Lock:
 *   <projectRoot>/.ijfw/wave-<waveId>/.subagent-<subId>.lock
 *
 * v1.5.0 T9: checkpoint/summary/violation writes route through the state-SDK
 * verbs (`subagent.checkpoint`, `event.emit`) instead of raw fs writes.
 * Append ops carry stable dedupKeys derived from their inputs.
 *
 * Frozen surface for Wave 11-A (S1 rest, S2, S3) — do not change signatures.
 */

import { mkdir, readFile, readdir, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { query } from './state-sdk.js';
import { pollEvents } from './state-events.js';
// v1.5.0 N4.obs M1+M2: trace-id + hierarchical observation path.
import { getTraceId, composePath } from '../observability/trace-id.js';
// v1.5.1 W2.F: checkpoint-contract evaluator (N4.obs M3). Validates a final
// status report carried by a checkpoint envelope against the v1.4.4 N2
// four-section contract before the envelope is written.
import { evaluateCheckpointContract } from '../observability/evaluator-checkpoint-contract.js';

// ---------------------------------------------------------------------------
// Frozen constants — Wave 11-A imports these directly
// ---------------------------------------------------------------------------

export const MAX_CHECKPOINT_SIZE = 4 * 1024;
export const SUB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const WAVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateWaveId(waveId) {
  if (typeof waveId !== 'string' || !WAVE_ID_PATTERN.test(waveId)) {
    throw new Error(
      `subagent-telemetry: invalid waveId "${waveId}" — must match ${WAVE_ID_PATTERN}`,
    );
  }
}

function validateSubId(subId) {
  if (typeof subId !== 'string' || !SUB_ID_PATTERN.test(subId)) {
    throw new Error(
      `subagent-telemetry: invalid subId "${subId}" — must match ${SUB_ID_PATTERN}`,
    );
  }
}

function checkpointPaths(waveId, subId, projectRoot) {
  const dir = join(projectRoot, '.ijfw', `wave-${waveId}`);
  return {
    dir,
    file: join(dir, `subagent-${subId}.checkpoint.json`),
    lock: join(dir, `.subagent-${subId}.lock`),
  };
}

/**
 * Derive a short hash string for use in dedupKeys. Stable across calls with
 * the same input — sha256 of JSON-serialised payload, first 12 hex chars.
 */
function shortHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Public API — FROZEN for Wave 11-A
// ---------------------------------------------------------------------------

/**
 * Atomically record a subagent checkpoint. Caller-supplied `checkpoint` is
 * merged into a payload envelope with schema_version/wave_id/sub_id/ts.
 *
 * @param {string} waveId        e.g. "W11-A0"
 * @param {string} subId         e.g. "W11-A1"
 * @param {object} checkpoint    arbitrary JSON (e.g. tool_use_count, last_action)
 * @param {string} projectRoot   absolute path to project root
 * @returns {Promise<void>}
 */
export async function recordCheckpoint(waveId, subId, checkpoint, projectRoot) {
  validateWaveId(waveId);
  validateSubId(subId);

  // v1.5.0-major S01: when running in a worktree subagent, the parent orchestrator
  // passes IJFW_PARENT_PROJECT_ROOT in env so checkpoints land in the parent's
  // .ijfw/ directory (visible after worktree cleanup). Backward-compatible:
  // missing env var → use projectRoot as before.
  const effectiveRoot = process.env.IJFW_PARENT_PROJECT_ROOT ?? projectRoot;

  // v1.5.0 N4.obs M1: tag every checkpoint with the orchestrator's trace_id when
  // one is available (env-var inheritance or already-cached). Never fabricate
  // here -- if the env isn't set + the orchestrator never called ensureTraceId,
  // we skip the field so old consumers don't see a half-populated id.
  const traceId = getTraceId();
  // v1.5.0 N4.obs M2: hierarchical observation path. The orchestrator can pass
  // a richer path via `checkpoint.path`; otherwise we synthesise a default that
  // a UI tree-view can group on: /wave-<waveId>/sub-<subId>.
  const observPath = (typeof checkpoint.path === 'string' && checkpoint.path.length > 0)
    ? checkpoint.path
    : composePath({ waveId, subId });

  // Build the checkpoint envelope (preserving existing field contract for
  // readLastCheckpoint consumers). The envelope is passed as the `checkpoint`
  // object to the SDK verb and stored nested under that key.
  const ts = new Date().toISOString();
  const envelope = {
    schema_version: 1,
    wave_id: waveId,
    sub_id: subId,
    ts,
    ...(traceId ? { trace_id: traceId } : {}),
    path: observPath,
    ...checkpoint,
  };

  // v1.5.1 W2.F: contract-validate at emission time. When a checkpoint
  // envelope carries the subagent's final status report (`checkpoint.report`),
  // it MUST satisfy the v1.4.4 N2 four-section contract (Status/SHAs/Files/
  // Tests). Schema drift now fails LOUD here at write — not silently at read.
  // Progress-only checkpoints (no `report` field) skip this check unchanged.
  if (typeof checkpoint.report === 'string') {
    const evalResult = evaluateCheckpointContract(checkpoint.report);
    if (!evalResult.valid) {
      throw new Error(
        `subagent-telemetry: checkpoint report for ${waveId}/${subId} `
        + `violates checkpoint-contract — ${evalResult.reason}`,
      );
    }
  }

  const serialised = JSON.stringify(envelope);
  if (serialised.length > MAX_CHECKPOINT_SIZE) {
    throw new Error(
      `subagent-telemetry: checkpoint size ${serialised.length} exceeds MAX_CHECKPOINT_SIZE ${MAX_CHECKPOINT_SIZE}`,
    );
  }

  // v1.5.0 T9: route through state-SDK verb — no raw fs write.
  // dedupKey is stable for this (subId, ts) pair: callers that retry within
  // the same millisecond get a no-op rather than a double-write.
  const dedupKey = `checkpoint:${subId}:${ts}`;
  await query(
    'subagent.checkpoint',
    { waveId, subagentId: subId, checkpoint: envelope, dedupKey },
    { projectRoot: effectiveRoot },
  );
}

/**
 * Read the most recent checkpoint for a (waveId, subId) pair.
 * Returns parsed JSON object, or `null` if the file doesn't exist yet.
 *
 * @param {string} waveId
 * @param {string} subId
 * @param {string} projectRoot
 * @returns {Promise<object|null>}
 */
export async function readLastCheckpoint(waveId, subId, projectRoot) {
  validateWaveId(waveId);
  validateSubId(subId);

  // v1.5.0-major S01: honor IJFW_PARENT_PROJECT_ROOT for worktree subagents.
  const effectiveRoot = process.env.IJFW_PARENT_PROJECT_ROOT ?? projectRoot;

  const { file } = checkpointPaths(waveId, subId, effectiveRoot);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw);
  // v1.5.0 T9: the SDK verb writes `{ waveId, subagentId, dedupKey, checkpoint,
  // updated_at }` — the caller-supplied envelope lives nested under `checkpoint`.
  // Unwrap to restore the flat shape that readLastCheckpoint consumers expect.
  // Old-format files (no `checkpoint` key, have `schema_version`) are returned
  // as-is for backward compatibility during migration.
  if (parsed && typeof parsed.checkpoint === 'object' && parsed.checkpoint !== null
      && typeof parsed.waveId === 'string') {
    return parsed.checkpoint;
  }
  return parsed;
}

/**
 * v1.5.0 T9: Append a summary event for a subagent via the `event.emit` verb.
 * Routes through the state-SDK — no raw fs write.
 *
 * @param {string} waveId
 * @param {string} subId
 * @param {object} data     arbitrary JSON (summary body ≤ 4 KiB)
 * @param {string} projectRoot
 * @returns {Promise<{ok: boolean, seq?: number, deduped?: boolean}>}
 */
export async function appendSummary(waveId, subId, data, projectRoot) {
  validateWaveId(waveId);
  validateSubId(subId);
  if (!data || typeof data !== 'object') {
    throw new Error('subagent-telemetry: appendSummary requires a data object');
  }
  // v1.5.0-major S01: honor IJFW_PARENT_PROJECT_ROOT for worktree subagents.
  const effectiveRoot = process.env.IJFW_PARENT_PROJECT_ROOT ?? projectRoot;
  // dedupKey: stable hash of (waveId, subId, data) — identical retries are no-ops.
  const dedupKey = `summary:${subId}:${shortHash({ waveId, subId, data })}`;
  return query(
    'event.emit',
    { subagentId: subId, waveId, eventType: 'summary', data, dedupKey },
    { projectRoot: effectiveRoot },
  );
}

/**
 * v1.5.0 T9: Record a violation event for a subagent via the `event.emit` verb.
 * Routes through the state-SDK — no raw fs write.
 *
 * @param {string} waveId
 * @param {string} subId
 * @param {object} data     violation payload (type, message, etc.) ≤ 4 KiB
 * @param {string} projectRoot
 * @returns {Promise<{ok: boolean, seq?: number, deduped?: boolean}>}
 */
export async function recordViolation(waveId, subId, data, projectRoot) {
  validateWaveId(waveId);
  validateSubId(subId);
  if (!data || typeof data !== 'object') {
    throw new Error('subagent-telemetry: recordViolation requires a data object');
  }
  // v1.5.0-major S01: honor IJFW_PARENT_PROJECT_ROOT for worktree subagents.
  const effectiveRoot = process.env.IJFW_PARENT_PROJECT_ROOT ?? projectRoot;
  // dedupKey: stable hash of (waveId, subId, data) — identical retries are no-ops.
  const dedupKey = `violation:${subId}:${shortHash({ waveId, subId, data })}`;
  return query(
    'event.emit',
    { subagentId: subId, waveId, eventType: 'violation', data, dedupKey },
    { projectRoot: effectiveRoot },
  );
}

/**
 * List subagent IDs that have a checkpoint file but are NOT in the wave's
 * completed-subs set. Used by the orchestrator post-wave to detect truncated
 * subagents.
 *
 * v1 (W11-A0): the completed-subs set is empty (we don't yet consume
 * STATE.md frontmatter.completed_subs). This returns ALL subIds with a
 * checkpoint file. W11-A1 will refine by reading the wave STATE.md.
 *
 * v1.5.0-major S01: accepts optional `additionalRoots: string[]` — additional
 * project roots to scan (e.g. active git worktree paths). This lets the
 * orchestrator see checkpoints written by worktree subagents BEFORE drain runs,
 * by inspecting both the parent root and each worktree root. Honors
 * IJFW_PARENT_PROJECT_ROOT for the primary `projectRoot` argument like
 * record/read do (worktree subagents calling this still see the parent dir).
 *
 * Returns [] if no directory exists. Returned IDs are deduplicated.
 *
 * @param {string} waveId
 * @param {string} projectRoot
 * @param {string[]} [additionalRoots] optional extra roots to scan
 * @returns {Promise<string[]>}
 */
export async function listOrphanedSubagents(waveId, projectRoot, additionalRoots = []) {
  validateWaveId(waveId);

  // v1.5.0-major S01: honor IJFW_PARENT_PROJECT_ROOT for the primary root.
  const effectiveRoot = process.env.IJFW_PARENT_PROJECT_ROOT ?? projectRoot;

  const rootsToScan = [effectiveRoot, ...(Array.isArray(additionalRoots) ? additionalRoots : [])];

  const seen = new Set();
  for (const root of rootsToScan) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const dir = join(root, '.ijfw', `wave-${waveId}`);
    let entries;
    try {
      entries = await readdir(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }

    for (const name of entries) {
      // Match subagent-<subId>.checkpoint.json
      const m = name.match(/^subagent-(.+)\.checkpoint\.json$/);
      if (!m) continue;
      const subId = m[1];
      // Defence in depth: skip entries that wouldn't pass the pattern (e.g.
      // an attacker-crafted filename someone dropped in by hand).
      if (!SUB_ID_PATTERN.test(subId)) continue;
      seen.add(subId);
    }
  }

  // Completed-subs set is empty in v1 — every subId with a checkpoint is
  // "orphaned" from the orchestrator's POV until W11-A1 wires in STATE.md.
  return [...seen];
}

/**
 * v1.5.0-major S01: drain checkpoint files from a worktree's .ijfw/wave-<id>/
 * directory into the parent project's .ijfw/wave-<id>/ directory.
 *
 * Belt-and-suspenders for the IJFW_PARENT_PROJECT_ROOT env-var passthrough:
 * if a subagent runs without the env var set (older callers, manual `claude`
 * invocation in a worktree, etc.) the checkpoint will land in the worktree's
 * own .ijfw/ — this drain copies them into the parent before
 * `git worktree remove` deletes them forever.
 *
 * Idempotent: re-running with the same source overwrites destination (same
 * checkpoint content). Filenames are preserved.
 *
 * @param {string} waveId
 * @param {string} worktreePath  absolute path to the worktree root
 * @param {string} projectRoot   absolute path to the parent project root
 * @returns {Promise<{ok: true, drained: number} | {ok: false, reason: string}>}
 */
export async function drainCheckpoints(waveId, worktreePath, projectRoot) {
  validateWaveId(waveId);
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
    return { ok: false, reason: 'invalid worktreePath' };
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' };
  }

  const sourceDir = join(worktreePath, '.ijfw', `wave-${waveId}`);
  const destDir = join(projectRoot, '.ijfw', `wave-${waveId}`);

  let entries;
  try {
    entries = await readdir(sourceDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, drained: 0 };
    return { ok: false, reason: `readdir ${sourceDir}: ${err.message}` };
  }

  await mkdir(destDir, { recursive: true });

  // v1.5.0 audit-LOW-work-L3: parallelise the per-file copy. The previous
  // sequential await pinned us to O(N * disk-latency); on a wave with 20+
  // subagents this is the difference between ~1s and "feels instant".
  // Each entry has independent src/dst paths so there's no ordering
  // requirement and no shared state to coordinate.
  const tasks = entries.map(async (name) => {
    const m = name.match(/^subagent-(.+)\.checkpoint\.json$/);
    if (!m) return 0;
    const subId = m[1];
    if (!SUB_ID_PATTERN.test(subId)) return 0;

    const src = join(sourceDir, name);
    const dst = join(destDir, name);
    try {
      const srcStat = await stat(src);
      if (!srcStat.isFile()) return 0;
    } catch {
      return 0;
    }
    try {
      await copyFile(src, dst);
      return 1;
    } catch {
      return 0;
    }
  });
  const counts = await Promise.all(tasks);
  const drained = counts.reduce((a, b) => a + b, 0);

  return { ok: true, drained };
}

// ---------------------------------------------------------------------------
// v1.5.0 T19 (G1) — subagent dispatch + event-stream reader
//
// Thin SDK-facing helpers the orchestrator uses to (1) dispatch a subagent
// via the deterministic `subagent.dispatch` verb and (2) poll its per-
// subagent event log to see verbs arrive live (every verb the subagent
// dispatches fires `_emitEvent` per T5 / state-events.js).
// ---------------------------------------------------------------------------

/**
 * Dispatch a subagent via the `subagent.dispatch` state-SDK verb. Wraps the
 * raw `query()` call with the documented orchestrator-side signature
 * (waveId, subId, role, brief, projectRoot, opts) and returns the verb's
 * `{ ok, dispatchBrief, subagentId, waveId, mode, isolation, inheritedEnv,
 * eventLogPath }` shape verbatim.
 *
 * The dispatch brief is DETERMINISTIC on Claude (handed to the native
 * subagent primitive) and a best-effort PROMPT TEMPLATE elsewhere — the
 * `mode` field discriminates. The SDK env-var contract is baked into the
 * brief and returned via `inheritedEnv` for the caller to seed the
 * subagent process when the platform supports env passthrough.
 *
 * @param {string}  waveId       wave id (matches /^[A-Za-z0-9_-]{1,64}$/)
 * @param {string}  subId        subagent id (matches /^[A-Za-z0-9_-]{1,64}$/)
 * @param {string}  role         role label (e.g. 'implementer', 'reviewer')
 * @param {string}  brief        the task brief markdown
 * @param {string}  projectRoot  absolute path to the project root
 * @param {{isolation?: 'shared'|'worktree', env?: object, platform?: string,
 *          subagentId?: string}} [opts]
 * @returns {Promise<object>} the verb result (see contract §7
 *                            `subagent.dispatch`).
 */
export async function dispatchSubagent(waveId, subId, role, brief, projectRoot, opts = {}) {
  validateWaveId(waveId);
  validateSubId(subId);
  if (typeof brief !== 'string' || brief.length === 0) {
    throw new Error('subagent-telemetry: dispatchSubagent requires a non-empty brief');
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('subagent-telemetry: dispatchSubagent requires projectRoot');
  }
  const payload = {
    subagentId: subId,
    waveId,
    brief,
    isolation: opts.isolation === 'shared' ? 'shared' : 'worktree',
  };
  if (typeof role === 'string' && role.length > 0) payload.role = role;
  if (opts.env && typeof opts.env === 'object' && !Array.isArray(opts.env)) {
    payload.env = opts.env;
  }
  const ctx = { projectRoot };
  if (typeof opts.platform === 'string') ctx.platform = opts.platform;
  if (typeof opts.subagentId === 'string') ctx.subagentId = opts.subagentId;
  return query('subagent.dispatch', payload, ctx);
}

/**
 * Stream the per-subagent event log. Returns the events with `seq > since`
 * (the cursor), plus the highest `seq` seen so the caller can feed it back
 * on the next poll. NEVER uses `fs.watch` — explicit-interval polling per
 * contract §5 (works across all 13 platforms).
 *
 * Every verb the subagent calls fires `_emitEvent` after lock release; the
 * tap envelope carries `{ seq, verb, subagentId, ts, verbId, outcome,
 * payloadDigest }` — exactly the rows this poller surfaces.
 *
 * @param {string} waveId
 * @param {string} subId
 * @param {string} projectRoot
 * @param {number} [since]   highest seq already processed (default 0)
 * @returns {{events: object[], cursor: number}}
 */
export function streamSubagentEvents(waveId, subId, projectRoot, since = 0) {
  validateWaveId(waveId);
  validateSubId(subId);
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('subagent-telemetry: streamSubagentEvents requires projectRoot');
  }
  return pollEvents({
    projectRoot,
    waveId,
    subagentId: subId,
    since: Number.isFinite(since) ? since : 0,
  });
}
