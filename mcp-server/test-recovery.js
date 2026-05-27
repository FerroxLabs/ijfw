import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initBlackboard } from './src/blackboard.js';
import { createCheckpoint, latestCheckpoint, recoveryStatus } from './src/recovery/checkpoint.js';
import { createTeamAssembly } from './src/team/generator.js';
import { completeSwarmTask, prepareSwarmTasks, startSwarmTask } from './src/swarm/planner.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-recovery-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('createCheckpoint writes latest json and markdown snapshot', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software', teamName: 'recovery-team' });
    initBlackboard(dir);
    prepareSwarmTasks(dir);

    const checkpoint = createCheckpoint(dir, 'after-prepare');
    assert.equal(checkpoint.ok, true);
    assert.ok(existsSync(checkpoint.jsonPath));
    assert.ok(existsSync(checkpoint.mdPath));
    assert.equal(checkpoint.snapshot.team.name, 'recovery-team');
    assert.equal(checkpoint.snapshot.tasks.ready, 2);

    const latest = latestCheckpoint(dir);
    assert.equal(latest.ok, true);
    assert.equal(latest.id, checkpoint.id);
    assert.match(latest.markdown, /IJFW Checkpoint: after-prepare/);
  } finally {
    cleanup(dir);
  }
});

test('recoveryStatus recommends next action from task state', () => {
  const dir = makeTmp();
  try {
    createTeamAssembly(dir, { archetype: 'software' });
    initBlackboard(dir);
    prepareSwarmTasks(dir);

    let status = recoveryStatus(dir);
    assert.match(status.next, /Start task: swarm:w1:runtime-module/);

    startSwarmTask(dir, 'swarm:w1:runtime-module');
    status = recoveryStatus(dir);
    assert.match(status.next, /Continue task: swarm:w1:runtime-module/);

    completeSwarmTask(dir, 'swarm:w1:runtime-module', {
      evidence: { commitSha: 'feedface1234567' },
    });
    status = recoveryStatus(dir);
    assert.match(status.next, /Start task: swarm:w2:regression-tests/);
  } finally {
    cleanup(dir);
  }
});

test('recoveryStatus recommends team init when no team exists', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const status = recoveryStatus(dir);
    assert.equal(status.team.ok, false);
    assert.equal(status.next, 'Run: ijfw team init');
  } finally {
    cleanup(dir);
  }
});

