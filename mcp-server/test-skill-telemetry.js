// mcp-server/test-skill-telemetry.js
// IJFW v1.5.0 -- M3 skills-telemetry feedback loop tests.
// M3.1: migration 007 table creation
// M3.2: recordSkillExecution + topKSuccessfulSkills
// M3.3: sinkSkillTelemetry shim
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';

// ---------------------------------------------------------------------------
// M3.1 -- migration 007 creates skill_telemetry table
// ---------------------------------------------------------------------------

test('migration 007 creates skill_telemetry table', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 7);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('skill_telemetry'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
});
