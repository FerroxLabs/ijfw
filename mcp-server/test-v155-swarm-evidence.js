// V155-006 regression: completeSwarmTask must require evidence (or explicit
// skipEvidence opt-out). Before v1.5.5 a subagent could claim DONE and the
// blackboard would record it with no filesystem witness — same shape as the
// v1.5.1 hallucination signature, encoded into state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listBlackboardTasks, blackboardPaths, initBlackboard } from './src/blackboard.js';
import {
  completeSwarmTask,
  startSwarmTask,
  prepareSwarmTasks,
} from './src/swarm/planner.js';
import { createTeamAssembly } from './src/team/generator.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-v155-006-'));
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function setup(dir, taskId = 'swarm:w1:runtime-module') {
  createTeamAssembly(dir, { archetype: 'software' });
  initBlackboard(dir);
  prepareSwarmTasks(dir);
  startSwarmTask(dir, taskId);
  return taskId;
}

test('V155-006: completeSwarmTask refuses without evidence', () => {
  const dir = makeTmp();
  try {
    const taskId = setup(dir);
    const res = completeSwarmTask(dir, taskId, { message: 'all good (trust me)' });
    assert.equal(res.ok, false, 'should refuse without evidence');
    assert.equal(res.error, 'missing-evidence');
    assert.match(res.message || '', /commitSha|diffStats|skipEvidence/);
    // Task must remain in_progress — DONE must not be recorded.
    const tasks = listBlackboardTasks(dir);
    const task = tasks.tasks.find((t) => t.id === taskId);
    assert.equal(task.status, 'in_progress');
  } finally { cleanup(dir); }
});

test('V155-006: completeSwarmTask accepts commitSha evidence', () => {
  const dir = makeTmp();
  try {
    const taskId = setup(dir);
    const res = completeSwarmTask(dir, taskId, {
      evidence: { commitSha: 'deadbeefcafe1234' },
    });
    assert.equal(res.ok, true);
    assert.equal(res.task.status, 'done');
  } finally { cleanup(dir); }
});

test('V155-006: completeSwarmTask accepts diffStats evidence', () => {
  const dir = makeTmp();
  try {
    const taskId = setup(dir);
    const res = completeSwarmTask(dir, taskId, {
      evidence: { diffStats: { filesChanged: 3 } },
    });
    assert.equal(res.ok, true);
    assert.equal(res.task.status, 'done');
  } finally { cleanup(dir); }
});

test('V155-006: rejects malformed commitSha (too short or non-hex)', () => {
  const dir = makeTmp();
  try {
    const taskId = setup(dir);
    // 6 chars (too short — min is 7)
    let res = completeSwarmTask(dir, taskId, { evidence: { commitSha: 'abc123' } });
    assert.equal(res.ok, false, 'should reject 6-char sha');
    // non-hex
    res = completeSwarmTask(dir, taskId, { evidence: { commitSha: 'g'.repeat(40) } });
    assert.equal(res.ok, false, 'should reject non-hex sha');
  } finally { cleanup(dir); }
});

test('V155-006: rejects diffStats with filesChanged=0', () => {
  const dir = makeTmp();
  try {
    const taskId = setup(dir);
    const res = completeSwarmTask(dir, taskId, {
      evidence: { diffStats: { filesChanged: 0 } },
    });
    assert.equal(res.ok, false, 'filesChanged must be >= 1');
  } finally { cleanup(dir); }
});

test('V155-006: skipEvidence:true bypasses the gate and tags the event', () => {
  const dir = makeTmp();
  try {
    const taskId = setup(dir);
    const res = completeSwarmTask(dir, taskId, { skipEvidence: true });
    assert.equal(res.ok, true);
    assert.equal(res.task.status, 'done');
    // Event log should carry the bypass tag for audit visibility — read the
    // events.jsonl file directly because blackboardStatus.recent is a summary
    // object, not the raw event stream.
    const paths = blackboardPaths(dir);
    const eventLines = readFileSync(paths.events, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const completionEvent = eventLines
      .filter((e) => e.task_id === taskId)
      .find((e) => e.type === 'task.completed-no-evidence');
    assert.ok(completionEvent, 'expected task.completed-no-evidence event tag');
  } finally { cleanup(dir); }
});
