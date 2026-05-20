import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initBlackboard, readBlackboard, updateBlackboardTask } from './src/blackboard.js';
import { createTeamAssembly } from './src/team/generator.js';
import { prepareSwarmTasks, startSwarmTask } from './src/swarm/planner.js';
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  integrateTaskWorktree,
  listTaskWorktrees,
} from './src/swarm/worktree.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-worktree-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${args.join(' ')}\n${res.stderr}\n${res.stdout}`);
  return res.stdout;
}

function initRepo() {
  const dir = makeTmp();
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}\n');
  writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

function commitCodexAgents(dir) {
  git(dir, ['add', '.codex']);
  git(dir, ['commit', '-m', 'team agents']);
}

test('createTaskWorktree creates worktree for prepared code-heavy task', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:runtime-module');

    const result = createTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(result.ok, true);
    assert.ok(existsSync(result.path));
    assert.match(result.branch, /ijfw\/swarm-w1-runtime-module/);

    const listed = listTaskWorktrees(dir);
    assert.equal(listed.worktrees.length, 1);
    assert.equal(listed.worktrees[0].task_id, 'swarm:w1:runtime-module');
  } finally {
    cleanup(dir);
  }
});

test('createTaskWorktree refuses dirty parent worktree by default', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:runtime-module');
    writeFileSync(join(dir, 'dirty.txt'), 'dirty\n');

    const result = createTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'dirty-worktree');
  } finally {
    cleanup(dir);
  }
});

test('createTaskWorktree refuses non-code tasks unless forced', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'content', force: true });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:campaign-brief');

    const refused = createTaskWorktree(dir, 'swarm:w1:campaign-brief');
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'non-code-task');

    const forced = createTaskWorktree(dir, 'swarm:w1:campaign-brief', { force: true });
    assert.equal(forced.ok, true);
  } finally {
    cleanup(dir);
  }
});

test('integrateTaskWorktree merges committed work and cleanup removes worktree', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:runtime-module');
    const created = createTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(created.ok, true);

    writeFileSync(join(created.path, 'src', 'index.js'), 'export const x = 2;\n');
    git(created.path, ['add', 'src/index.js']);
    git(created.path, ['commit', '-m', 'task change']);

    const integrated = integrateTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(integrated.ok, true);
    // integrateTaskWorktree does a --no-ff merge with a deliberate
    // `ijfw merge: <task-id>` message (so `git log --grep` can recover the
    // merge boundary — see swarm/worktree.js). Assert that exact contract.
    assert.match(git(dir, ['log', '--oneline', '-1']), /ijfw merge: swarm:w1:runtime-module/);

    const cleaned = cleanupTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(cleaned.ok, true);
    assert.equal(existsSync(created.path), false);
  } finally {
    cleanup(dir);
  }
});

test('integrateTaskWorktree preserves worktree with uncommitted changes', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:runtime-module');
    const created = createTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(created.ok, true);
    writeFileSync(join(created.path, 'src', 'index.js'), 'export const x = 3;\n');

    const integrated = integrateTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(integrated.ok, false);
    assert.equal(integrated.error, 'worktree-has-uncommitted-changes');
    assert.equal(existsSync(created.path), true);
    const events = readBlackboard(dir).recent.events;
    assert.ok(events.some((event) => event.type === 'worktree.created'));
  } finally {
    cleanup(dir);
  }
});

test('integrateTaskWorktree refuses task metadata outside IJFW worktrees', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:runtime-module');
    const created = createTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(created.ok, true);

    updateBlackboardTask(dir, 'swarm:w1:runtime-module', {
      worktree: { path: join(dir, 'src'), branch: created.branch, status: 'integrated' },
    });

    const integrated = integrateTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(integrated.ok, false);
    assert.equal(integrated.error, 'invalid-worktree-path');

    const cleaned = cleanupTaskWorktree(dir, 'swarm:w1:runtime-module', { force: true });
    assert.equal(cleaned.ok, false);
    assert.equal(cleaned.error, 'invalid-worktree-path');
    assert.equal(existsSync(join(dir, 'src')), true);
  } finally {
    cleanup(dir);
  }
});

test('integrateTaskWorktree refuses non-IJFW branch metadata', () => {
  const dir = initRepo();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    commitCodexAgents(dir);
    initBlackboard(dir);
    prepareSwarmTasks(dir);
    startSwarmTask(dir, 'swarm:w1:runtime-module');
    const created = createTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(created.ok, true);

    updateBlackboardTask(dir, 'swarm:w1:runtime-module', {
      worktree: { path: created.path, branch: 'feature/runtime-module', status: 'integrated' },
    });

    const integrated = integrateTaskWorktree(dir, 'swarm:w1:runtime-module');
    assert.equal(integrated.ok, false);
    assert.equal(integrated.error, 'invalid-worktree-branch');

    const cleaned = cleanupTaskWorktree(dir, 'swarm:w1:runtime-module', { force: true });
    assert.equal(cleaned.ok, false);
    assert.equal(cleaned.error, 'invalid-worktree-branch');
    assert.equal(existsSync(created.path), true);
  } finally {
    cleanup(dir);
  }
});
