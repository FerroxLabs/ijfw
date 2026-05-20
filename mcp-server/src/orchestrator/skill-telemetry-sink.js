// mcp-server/src/orchestrator/skill-telemetry-sink.js
// IJFW v1.5.0 -- state-SDK telemetry.record -> skill_telemetry shim.

import { recordSkillExecution } from './skill-telemetry.js';

export function sinkSkillTelemetry(db, payload) {
  if (!payload || payload.metric !== 'skill.execution') return { skipped: true };
  const skill_id = payload.labels?.skill_id;
  if (!skill_id) return { skipped: true, reason: 'no_skill_id' };
  recordSkillExecution(db, {
    skill_id,
    session_id: payload.labels?.session_id || null,
    outcome: payload.outcome || 'success',
    latency_ms: typeof payload.latency_ms === 'number' ? payload.latency_ms : null,
    created_at: payload.created_at || Date.now(),
  });
  return { skipped: false };
}

export default { sinkSkillTelemetry };
