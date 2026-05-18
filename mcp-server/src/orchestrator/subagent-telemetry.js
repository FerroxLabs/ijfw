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
 * Frozen surface for Wave 11-A (S1 rest, S2, S3) — do not change signatures.
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withFsLock } from '../fs-lock.js';

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

  const payload = {
    schema_version: 1,
    wave_id: waveId,
    sub_id: subId,
    ts: new Date().toISOString(),
    ...checkpoint,
  };

  const serialised = JSON.stringify(payload);
  if (serialised.length > MAX_CHECKPOINT_SIZE) {
    throw new Error(
      `subagent-telemetry: checkpoint size ${serialised.length} exceeds MAX_CHECKPOINT_SIZE ${MAX_CHECKPOINT_SIZE}`,
    );
  }

  const { dir, file, lock } = checkpointPaths(waveId, subId, projectRoot);

  await withFsLock(lock, async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(file, serialised, 'utf8');
  });
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

  const { file } = checkpointPaths(waveId, subId, projectRoot);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
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
 * Returns [] if the wave directory doesn't exist.
 *
 * @param {string} waveId
 * @param {string} projectRoot
 * @returns {Promise<string[]>}
 */
export async function listOrphanedSubagents(waveId, projectRoot) {
  validateWaveId(waveId);

  const dir = join(projectRoot, '.ijfw', `wave-${waveId}`);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const subIds = [];
  for (const name of entries) {
    // Match subagent-<subId>.checkpoint.json
    const m = name.match(/^subagent-(.+)\.checkpoint\.json$/);
    if (!m) continue;
    const subId = m[1];
    // Defence in depth: skip entries that wouldn't pass the pattern (e.g.
    // an attacker-crafted filename someone dropped in by hand).
    if (!SUB_ID_PATTERN.test(subId)) continue;
    subIds.push(subId);
  }

  // Completed-subs set is empty in v1 — every subId with a checkpoint is
  // "orphaned" from the orchestrator's POV until W11-A1 wires in STATE.md.
  return subIds;
}
