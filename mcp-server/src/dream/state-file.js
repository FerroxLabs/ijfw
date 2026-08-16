// IJFW v1.5.0 -- dream-cycle state file (Wayland pattern + idempotency).
//
// Lives at `<repoRoot>/.ijfw/.dream-state-v2.json` (legacy cooldown.js owns
// `.dream-state.json` and writes an ISO-string last_run_at incompatible
// with this module's numeric unix-ms; using a separate path avoids the
// schema collision while letting both layers coexist).
//
// Tracks:
//   - last_run_at: unix-ms timestamp of last completed dream cycle (idle gate)
//   - runs_total:  cumulative count
//   - stages:      per-stage status for the current/most-recent run
//
// The legacy cooldown.markCompleted() is still called as the final stage
// in runner.mjs so any downstream code reading the old marker keeps working.
// This module is the additive layer.
//
// Pattern lift from sibling project Wayland's
// `crates/wcore-memory/src/consolidate.rs` DreamThrottle.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../lib/atomic-io.js';

const DEFAULT = { version: 1, last_run_at: null, runs_total: 0, stages: {} };

function pathOf(root) {
  return join(root, '.ijfw', '.dream-state-v2.json');
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
  // Delegate to the shared atomic writer: randomized tmp name (no fixed-name
  // collisions across concurrent runs / stale crash leftovers) + Windows
  // rename-retry that survives transient EPERM/EBUSY from AV or the Search
  // indexer. writeAtomic ensures the .ijfw dir exists.
  writeAtomic(p, JSON.stringify(state, null, 2));
}

export function markStageStarted(root, stage) {
  const s = readDreamState(root);
  s.stages[stage] = { status: 'in_progress', started_at: Date.now() };
  writeDreamState(root, s);
}

export function markStageCompleted(root, stage, extras = {}) {
  const s = readDreamState(root);
  // V155-005 (HIGH): the previous shape unconditionally wrote
  // `status:'completed'` even when the stage returned a payload like
  // `{ skipped:'db-unavailable' }` or `{ error:'tier-promotion-failed' }`.
  // Operators reading `.dream-state-v2.json` saw "all stages completed"
  // perpetually even when wiki-compile had been skipped for weeks. Inspect
  // the returned envelope and route to a more honest status:
  //   - `extras.skipped`      → status:'skipped'
  //   - `extras.error`        → status:'completed_with_error'
  //   - otherwise             → status:'completed' (back-compat shape).
  let status = 'completed';
  if (extras && typeof extras === 'object') {
    if (extras.skipped) status = 'skipped';
    else if (extras.error) status = 'completed_with_error';
  }
  s.stages[stage] = {
    ...s.stages[stage],
    status,
    completed_at: Date.now(),
    ...extras,
  };
  writeDreamState(root, s);
}

export function markStageFailed(root, stage, reason) {
  const s = readDreamState(root);
  s.stages[stage] = {
    ...s.stages[stage],
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
