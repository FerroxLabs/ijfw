import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBlackboard } from './src/blackboard.js';
import { createTeamAssembly, loadTeamTemplate, readTeamAssembly } from './src/team/generator.js';
import { prepareSwarmTasks } from './src/swarm/planner.js';
import { deriveReviewTasks } from './src/swarm/review.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-swarm-review-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('deriveReviewTasks creates software review tasks from workflow fixtures', () => {
  const bundle = loadTeamTemplate('software');
  const tasks = deriveReviewTasks({
    workflow: bundle.workflow,
    charter: bundle.charter,
  });

  const review = tasks.find((task) => task.id === 'review:w1:runtime-module:ijfw-integration-checker');
  assert.ok(review);
  assert.equal(review.status, 'ready');
  assert.equal(review.owner, 'ijfw-integration-checker');
  assert.deepEqual(review.artifact_ids, ['runtime-module']);
  assert.deepEqual(review.depends_on, ['swarm:w1:runtime-module']);
  assert.deepEqual(review.verification, ['npm test']);
  assert.deepEqual(review.review_criteria, ['behavior', 'edge-cases']);
});

test('deriveReviewTasks blocks design reviews when prepared implementation tasks are not done', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'design' });
    initBlackboard(dir);
    const team = readTeamAssembly(dir);
    const prepared = prepareSwarmTasks(dir);

    const tasks = deriveReviewTasks({
      plan: prepared.plan,
      tasks: prepared.tasks,
      charter: team.charter,
    });

    const review = tasks.find((task) => task.id === 'review:w1:screen-system:ijfw-accessibility-reviewer');
    assert.ok(review);
    assert.equal(review.status, 'blocked');
    assert.deepEqual(review.depends_on, ['swarm:w1:screen-system']);
    assert.deepEqual(review.blocked_by, [{ task_id: 'swarm:w1:screen-system', status: 'ready' }]);
    assert.deepEqual(review.review_criteria, ['layout', 'contrast', 'responsive-fit']);
  } finally {
    cleanup(dir);
  }
});

test('deriveReviewTasks marks prepared design reviews ready when implementation tasks are done', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'design' });
    initBlackboard(dir);
    const team = readTeamAssembly(dir);
    const prepared = prepareSwarmTasks(dir);
    const doneTasks = prepared.tasks.map((task) => (
      task.id === 'swarm:w1:screen-system' ? { ...task, status: 'done' } : task
    ));

    const tasks = deriveReviewTasks({
      plan: prepared.plan,
      tasks: doneTasks,
      charter: team.charter,
    });

    const review = tasks.find((task) => task.id === 'review:w1:screen-system:ijfw-accessibility-reviewer');
    assert.ok(review);
    assert.equal(review.status, 'ready');
    assert.deepEqual(review.blocked_by, []);
  } finally {
    cleanup(dir);
  }
});

test('deriveReviewTasks can use prepared swarm task records directly', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'design' });
    initBlackboard(dir);
    const prepared = prepareSwarmTasks(dir);
    const doneTasks = prepared.tasks.map((task) => (
      task.id === 'swarm:w1:screen-system' ? { ...task, status: 'done' } : task
    ));

    const tasks = deriveReviewTasks(doneTasks);
    const review = tasks.find((task) => task.id === 'review:w1:screen-system:ijfw-accessibility-reviewer');
    assert.ok(review);
    assert.equal(review.status, 'ready');
    assert.deepEqual(review.depends_on, ['swarm:w1:screen-system']);
    assert.deepEqual(review.verification, ['visual audit']);
  } finally {
    cleanup(dir);
  }
});

test('deriveReviewTasks creates mixed-fixture review tasks for each artifact reviewer', () => {
  const bundle = loadTeamTemplate('mixed');
  const tasks = deriveReviewTasks({
    workflow: bundle.workflow,
    charter: bundle.charter,
  });

  const appReview = tasks.find((task) => task.id === 'review:w1:product-screens:ijfw-app-engineer');
  const copyReview = tasks.find((task) => task.id === 'review:w1:product-screens:ijfw-launch-editor');
  assert.ok(appReview);
  assert.ok(copyReview);
  assert.deepEqual(appReview.depends_on, ['swarm:w1:product-screens']);
  assert.deepEqual(copyReview.depends_on, ['swarm:w1:product-screens']);
  assert.deepEqual(appReview.review_criteria, ['integration', 'accessibility']);
  assert.deepEqual(copyReview.review_criteria, ['message-match', 'voice']);
});
