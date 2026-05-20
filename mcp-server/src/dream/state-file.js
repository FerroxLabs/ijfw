// IJFW v1.5.0 -- dream-cycle state file (Wayland pattern + idempotency).
//
// Lives at `<repoRoot>/.ijfw/.dream-state.json`. Tracks:
//   - last_run_at: unix-ms timestamp of last completed dream cycle (idle gate)
//   - runs_total:  cumulative count
//   - stages:      per-stage status for the current/most-recent run
//
// The legacy `cooldown.js` file (4h marker) is preserved upstream — runner.mjs
// still calls markCompleted() at the end of the cycle so any downstream code
// reading the old marker keeps working. This module is the additive layer.
//
// Pattern lift from sibling project Wayland's
// `crates/wcore-memory/src/consolidate.rs` DreamThrottle.

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';

const DEFAULT = { version: 1, last_run_at: null, runs_total: 0, stages: {} };

function pathOf(root) {
  return join(root, '.ijfw', '.dream-state.json');
}

export function readDreamState(root) {
  const p = pathOf(root);
  if (!existsSync(p)) return { ...DEFAULT };
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'));
    return { ...DEFAULT, ...obj, stages: obj?.stages || {} };
  } catch {
    // Corrupt file treated as no-record — safer than blocking.
    return { ...DEFAULT };
  }
}

export function writeDreamState(root, state) {
  const p = pathOf(root);
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

export function markStageStarted(root, stage) {
  const s = readDreamState(root);
  s.stages[stage] = { status: 'in_progress', started_at: Date.now() };
  writeDreamState(root, s);
}

export function markStageCompleted(root, stage, extras = {}) {
  const s = readDreamState(root);
  s.stages[stage] = {
    ...(s.stages[stage] || {}),
    status: 'completed',
    completed_at: Date.now(),
    ...extras,
  };
  writeDreamState(root, s);
}

export function markStageFailed(root, stage, reason) {
  const s = readDreamState(root);
  s.stages[stage] = {
    ...(s.stages[stage] || {}),
    status: 'failed',
    failed_at: Date.now(),
    reason: String(reason || 'unknown'),
  };
  writeDreamState(root, s);
}

export function shouldRunNow(root, { min_idle_minutes = 30 } = {}) {
  const s = readDreamState(root);
  if (s.last_run_at == null) return true;
  return (Date.now() - s.last_run_at) / 60000 >= min_idle_minutes;
}

export function markRunStart(root) {
  const s = readDreamState(root);
  s.stages = {};
  writeDreamState(root, s);
}

export function markRunCompleted(root) {
  const s = readDreamState(root);
  s.last_run_at = Date.now();
  s.runs_total = (s.runs_total || 0) + 1;
  writeDreamState(root, s);
}

export default {
  readDreamState, writeDreamState,
  markStageStarted, markStageCompleted, markStageFailed,
  shouldRunNow, markRunStart, markRunCompleted,
};
