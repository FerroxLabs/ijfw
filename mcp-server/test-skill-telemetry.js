// mcp-server/test-skill-telemetry.js
// IJFW v1.5.0 -- M3 skills-telemetry feedback loop tests.
// M3.1: migration 007 table creation
// M3.2: recordSkillExecution + topKSuccessfulSkills
// M3.3: sinkSkillTelemetry shim
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from './src/memory/migration-runner.js';
import { recordSkillExecution, topKSuccessfulSkills } from './src/orchestrator/skill-telemetry.js';

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

// ---------------------------------------------------------------------------
// M3.2 -- recordSkillExecution + topKSuccessfulSkills
// ---------------------------------------------------------------------------

test('recordSkillExecution writes a row', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 7);
  recordSkillExecution(db, {
    skill_id: 'ijfw-verify', session_id: 's1', outcome: 'success', latency_ms: 120,
  });
  const row = db.prepare('SELECT * FROM skill_telemetry').get();
  assert.equal(row.skill_id, 'ijfw-verify');
  assert.equal(row.outcome, 'success');
});

test('topKSuccessfulSkills ranks by recent success count', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 7);
  const ts = Date.now();
  for (let i = 0; i < 3; i++) {
    recordSkillExecution(db, { skill_id: 'ijfw-verify', outcome: 'success', created_at: ts - i * 1000 });
  }
  recordSkillExecution(db, { skill_id: 'ijfw-plan', outcome: 'success', created_at: ts });
  recordSkillExecution(db, { skill_id: 'ijfw-plan', outcome: 'failure', created_at: ts });
  recordSkillExecution(db, { skill_id: 'ijfw-plan', outcome: 'failure', created_at: ts });
  for (let i = 0; i < 2; i++) {
    recordSkillExecution(db, { skill_id: 'ijfw-debug', outcome: 'success', created_at: ts - i * 1000 });
  }
  const top = topKSuccessfulSkills(db, { k: 2 });
  assert.equal(top[0].skill_id, 'ijfw-verify');
  assert.equal(top[1].skill_id, 'ijfw-debug');
});

test('topKSuccessfulSkills filters by since (ms)', async () => {
  const db = new Database(':memory:');
  await runMigrations(db, 0, 7);
  const now = Date.now();
  recordSkillExecution(db, { skill_id: 'old', outcome: 'success', created_at: now - 1e10 });
  recordSkillExecution(db, { skill_id: 'fresh', outcome: 'success', created_at: now });
  const top = topKSuccessfulSkills(db, { since: now - 1000 });
  assert.equal(top.length, 1);
  assert.equal(top[0].skill_id, 'fresh');
});
