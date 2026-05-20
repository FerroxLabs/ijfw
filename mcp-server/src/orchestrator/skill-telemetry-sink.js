// mcp-server/src/orchestrator/skill-telemetry-sink.js
// IJFW v1.5.0 -- state-SDK telemetry.record -> skill_telemetry shim.
//
// Maps the existing state-SDK telemetry.record payload shape into the
// skill_telemetry table. Payload shape (per state-sdk.js telemetry.record):
//   { kind, dedupKey, metrics }
// When kind === 'skill.execution' we expect metrics to carry:
//   { skill_id, session_id?, outcome, latency_ms?, created_at? }
// Anything else is a clean skip — the generic telemetry.record verb keeps
// its existing append-to-telemetry-file behavior regardless of this sink.

import { recordSkillExecution } from './skill-telemetry.js';

export function sinkSkillTelemetry(db, payload) {
  if (!payload || payload.kind !== 'skill.execution') return { skipped: true };
  const m = payload.metrics || {};
  const skill_id = m.skill_id;
  if (!skill_id) return { skipped: true, reason: 'no_skill_id' };
  recordSkillExecution(db, {
    skill_id,
    session_id: m.session_id || null,
    outcome: m.outcome || 'success',
    latency_ms: typeof m.latency_ms === 'number' ? m.latency_ms : null,
    created_at: m.created_at || Date.now(),
  });
  return { skipped: false };
}

export default { sinkSkillTelemetry };
