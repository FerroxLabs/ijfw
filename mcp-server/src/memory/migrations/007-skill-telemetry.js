// IJFW v1.5.0 -- memory migration 007: skill telemetry table.
//
// Records per-execution skill outcomes so the procedural-memory tier can
// reorder the skill surface at session start. Wayland pattern.

export const VERSION = 7;
export const DESCRIPTION = 'memory v1.5.0 -- skill_telemetry table for skills-feedback loop';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_telemetry (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id    TEXT NOT NULL,
      session_id  TEXT,
      outcome     TEXT NOT NULL CHECK (outcome IN ('success','failure','aborted')),
      latency_ms  INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skill_telemetry_aggr_idx
      ON skill_telemetry(skill_id, outcome, created_at DESC);
  `);
}

export default { version: VERSION, description: DESCRIPTION, up };
