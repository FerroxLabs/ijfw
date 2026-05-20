// IJFW v1.5.0 -- per-stage error-isolated dream runner.
//
// Wayland's "best-effort staged" pattern: a failure in one stage logs and
// continues; downstream stages still execute. The state file records each
// stage's status so a future run (or operator) can see what actually
// happened, and which stages need re-execution.
//
// Lift from sibling project Wayland:
// crates/wcore-memory/src/consolidate.rs ConsolidationEngine::run

import {
  markRunStart, markStageStarted, markStageCompleted,
  markStageFailed, markRunCompleted,
} from './state-file.js';

export async function runStages(root, stages) {
  markRunStart(root);
  const completed = [];
  const failed = [];
  for (const stage of stages) {
    if (!stage || typeof stage.name !== 'string' || typeof stage.run !== 'function') {
      failed.push({ name: String(stage?.name), reason: 'invalid_stage_definition' });
      continue;
    }
    markStageStarted(root, stage.name);
    try {
      const extras = (await stage.run()) || {};
      markStageCompleted(root, stage.name, extras);
      completed.push({ name: stage.name, extras });
    } catch (e) {
      markStageFailed(root, stage.name, e?.message || String(e));
      failed.push({ name: stage.name, reason: e?.message || String(e) });
      // CONTINUE -- per-stage isolation.
    }
  }
  markRunCompleted(root);
  return { ok: failed.length === 0, completed, failed };
}

export default { runStages };
