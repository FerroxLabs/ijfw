import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimArtifact, initBlackboard } from './src/blackboard.js';
import { createTeamAssembly } from './src/team/generator.js';
import {
  blockSwarmTask,
  buildSwarmPlan,
  completeSwarmTask,
  listSwarmTasks,
  prepareSwarmTasks,
  readySwarmTask,
  startSwarmTask,
  swarmPlanSummary,
} from './src/swarm/planner.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-swarm-planner-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('buildSwarmPlan asks for team assembly when missing', () => {
  const dir = makeTmp();
  try {
    const plan = buildSwarmPlan(dir);
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'missing-team-assembly');
    assert.match(swarmPlanSummary(plan), /Run: ijfw team init/);
  } finally {
    cleanup(dir);
  }
});

test('buildSwarmPlan produces project-artifact waves from team workflow', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'mixed', teamName: 'mixed-launch' });
    initBlackboard(dir);
    const plan = buildSwarmPlan(dir);
    assert.equal(plan.ok, true);
    assert.equal(plan.team_name, 'mixed-launch');
    assert.deepEqual(plan.project_archetypes, ['software', 'design', 'content', 'mixed']);
    assert.equal(plan.waves[0].mode, 'parallel');
    assert.deepEqual(plan.waves[0].artifact_ids, ['app-shell', 'product-screens']);
    assert.equal(plan.waves[1].mode, 'review');

    const appTask = plan.waves[0].tasks.find((task) => task.artifact_id === 'app-shell');
    assert.equal(appTask.owner, 'app-engineer');
    assert.deepEqual(appTask.verification, ['npm test']);
  } finally {
    cleanup(dir);
  }
});

test('buildSwarmPlan marks artifacts blocked by conflicting blackboard claims', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'design' });
    initBlackboard(dir);
    const claim = claimArtifact(dir, {
      artifact: 'screen-system',
      owner: 'other-agent',
      paths: ['design/screens/**'],
    });
    assert.equal(claim.ok, true);

    const plan = buildSwarmPlan(dir);
    assert.equal(plan.ok, true);
    assert.equal(plan.waves[0].mode, 'blocked');
    const task = plan.waves[0].tasks[0];
    assert.equal(task.blocked, true);
    assert.equal(task.blocked_by[0].agent, 'other-agent');
    assert.match(swarmPlanSummary(plan), /blocked by screen-system:other-agent/);
  } finally {
    cleanup(dir);
  }
});

test('buildSwarmPlan allows owner to hold its own artifact claim', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    initBlackboard(dir);
    assert.equal(claimArtifact(dir, {
      artifact: 'runtime-module',
      owner: 'implementation-engineer',
      paths: ['src/**/*.js'],
    }).ok, true);

    const plan = buildSwarmPlan(dir);
    assert.equal(plan.ok, true);
    assert.equal(plan.waves[0].mode, 'parallel');
    assert.equal(plan.waves[0].tasks[0].blocked, false);
  } finally {
    cleanup(dir);
  }
});

test('swarmPlanSummary includes owners and verification', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'content', teamName: 'content-team' });
    initBlackboard(dir);
    const summary = swarmPlanSummary(buildSwarmPlan(dir));
    assert.match(summary, /Swarm plan for content-team/);
    assert.match(summary, /campaign-brief -> content-strategist/);
    assert.match(summary, /verify: brand voice review/);
  } finally {
    cleanup(dir);
  }
});

test('prepareSwarmTasks writes ready and blocked tasks to blackboard', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'design' });
    initBlackboard(dir);
    assert.equal(claimArtifact(dir, {
      artifact: 'screen-system',
      owner: 'other-agent',
      paths: ['design/screens/**'],
    }).ok, true);

    const prepared = prepareSwarmTasks(dir);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.written, 2);
    assert.equal(prepared.tasks[0].id, 'swarm:w1:screen-system');
    assert.equal(prepared.tasks[0].status, 'blocked');
    assert.equal(prepared.tasks[0].blocked_by[0].agent, 'other-agent');
    assert.equal(prepared.tasks[1].status, 'ready');

    const status = buildSwarmPlan(dir);
    assert.equal(status.ok, true);
  } finally {
    cleanup(dir);
  }
});

test('prepareSwarmTasks maps artifact dependencies to task ids', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'content' });
    initBlackboard(dir);
    const prepared = prepareSwarmTasks(dir);
    assert.equal(prepared.ok, true);
    const article = prepared.tasks.find((task) => task.artifact_ids.includes('article-draft'));
    assert.deepEqual(article.depends_on, ['swarm:w1:campaign-brief']);
  } finally {
    cleanup(dir);
  }
});

test('prepareSwarmTasks can include blocked review tasks', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    initBlackboard(dir);
    const prepared = prepareSwarmTasks(dir, { includeReviews: true });
    assert.equal(prepared.ok, true);
    const review = prepared.tasks.find((task) => task.id === 'review:w1:runtime-module:test-reviewer');
    assert.ok(review);
    assert.equal(review.status, 'blocked');
    assert.deepEqual(review.depends_on, ['swarm:w1:runtime-module']);
  } finally {
    cleanup(dir);
  }
});

test('swarm task lifecycle starts, completes, and releases claims', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    initBlackboard(dir);
    prepareSwarmTasks(dir);

    const taskId = 'swarm:w1:runtime-module';
    const started = startSwarmTask(dir, taskId);
    assert.equal(started.ok, true);
    assert.equal(started.task.status, 'in_progress');
    assert.equal(started.claims[0].artifact_id, 'runtime-module');

    const completed = completeSwarmTask(dir, taskId, { message: 'tests passed' });
    assert.equal(completed.ok, true);
    assert.equal(completed.task.status, 'done');
    assert.equal(completed.releases[0].released, 1);

    const task = listSwarmTasks(dir).tasks.find((item) => item.id === taskId);
    assert.equal(task.completion_note, 'tests passed');
  } finally {
    cleanup(dir);
  }
});

test('startSwarmTask requires dependencies to be done', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'content' });
    initBlackboard(dir);
    prepareSwarmTasks(dir);

    const blocked = startSwarmTask(dir, 'swarm:w2:article-draft');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'dependency-not-done');

    assert.equal(startSwarmTask(dir, 'swarm:w1:campaign-brief').ok, true);
    assert.equal(completeSwarmTask(dir, 'swarm:w1:campaign-brief').ok, true);
    assert.equal(startSwarmTask(dir, 'swarm:w2:article-draft').ok, true);
  } finally {
    cleanup(dir);
  }
});

test('blockSwarmTask records blocker and readySwarmTask clears it', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'design' });
    initBlackboard(dir);
    prepareSwarmTasks(dir);

    const blocked = blockSwarmTask(dir, 'swarm:w1:screen-system', { message: 'needs design source' });
    assert.equal(blocked.ok, true);
    assert.equal(blocked.task.status, 'blocked');
    assert.equal(blocked.task.blocker, 'needs design source');

    const ready = readySwarmTask(dir, 'swarm:w1:screen-system');
    assert.equal(ready.ok, true);
    assert.equal(ready.task.status, 'ready');
    assert.equal(ready.task.blocker, null);
  } finally {
    cleanup(dir);
  }
});
