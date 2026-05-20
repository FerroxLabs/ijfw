// mcp-server/src/orchestrator/skill-telemetry.js
// IJFW v1.5.0 -- skills telemetry recorder + top-K reader.

export function recordSkillExecution(db, {
  skill_id,
  session_id = null,
  outcome,
  latency_ms = null,
  created_at = Date.now(),
} = {}) {
  if (!skill_id || !outcome) throw new Error('recordSkillExecution: skill_id and outcome required');
  if (!['success', 'failure', 'aborted'].includes(outcome)) {
    throw new Error(`recordSkillExecution: invalid outcome '${outcome}'`);
  }
  db.prepare(
    `INSERT INTO skill_telemetry (skill_id, session_id, outcome, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(skill_id, session_id, outcome, latency_ms, created_at);
}

export function topKSuccessfulSkills(db, { k = 5, since = null } = {}) {
  const params = [];
  let whereSince = '';
  if (since !== null) { whereSince = 'AND created_at >= ?'; params.push(since); }
  return db
    .prepare(
      `SELECT skill_id, COUNT(*) AS success_count, MAX(created_at) AS last_success_at
         FROM skill_telemetry
        WHERE outcome = 'success' ${whereSince}
        GROUP BY skill_id
        ORDER BY success_count DESC, last_success_at DESC
        LIMIT ?`,
    )
    .all(...params, k);
}

export default { recordSkillExecution, topKSuccessfulSkills };
