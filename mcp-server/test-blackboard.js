import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addBlackboardNote,
  appendBlackboardEvent,
  blackboardPaths,
  blackboardStatus,
  claimArtifact,
  initBlackboard,
  readBlackboard,
  releaseClaim,
  writeHandoff,
} from './src/blackboard.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-blackboard-test-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('initBlackboard creates the runtime files', () => {
  const dir = makeTmp();
  try {
    const result = initBlackboard(dir);
    const paths = blackboardPaths(dir);
    assert.equal(result.ok, true);
    assert.ok(existsSync(paths.tasks));
    assert.ok(existsSync(paths.claims));
    assert.ok(existsSync(paths.findings));
    assert.ok(existsSync(paths.decisions));
    assert.ok(existsSync(paths.blockers));
    assert.ok(existsSync(paths.events));
    assert.ok(existsSync(paths.handoff));
  } finally {
    cleanup(dir);
  }
});

test('appendBlackboardEvent records append-only events', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const result = appendBlackboardEvent(dir, {
      type: 'task.started',
      actor: 'agent-a',
      task_id: 'swarm:w1:demo',
      artifact_ids: ['demo'],
      message: 'started demo',
    });
    assert.equal(result.ok, true);
    const events = readBlackboard(dir).recent.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'task.started');
    assert.equal(events[0].task_id, 'swarm:w1:demo');
  } finally {
    cleanup(dir);
  }
});

test('claimArtifact records active claims and status reports them', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const result = claimArtifact(dir, {
      artifact: 'schema-foundation',
      owner: 'schema-fixture-engineer',
      paths: ['mcp-server/src/team/**'],
    });
    assert.equal(result.ok, true);

    const status = blackboardStatus(dir);
    assert.equal(status.claims.active, 1);
    assert.deepEqual(status.claims.active_items[0], {
      artifact_id: 'schema-foundation',
      agent: 'schema-fixture-engineer',
      paths: ['mcp-server/src/team/**'],
    });
  } finally {
    cleanup(dir);
  }
});

test('claimArtifact blocks conflicting artifact owners', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    assert.equal(claimArtifact(dir, { artifact: 'blackboard', owner: 'agent-a' }).ok, true);
    const conflict = claimArtifact(dir, { artifact: 'blackboard', owner: 'agent-b' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, 'conflict');
    assert.equal(conflict.conflicts[0].agent, 'agent-a');
  } finally {
    cleanup(dir);
  }
});

test('claimArtifact blocks overlapping path claims', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    assert.equal(claimArtifact(dir, {
      artifact: 'team-skill',
      owner: 'agent-a',
      paths: ['shared/skills/ijfw-team/**'],
    }).ok, true);
    const conflict = claimArtifact(dir, {
      artifact: 'team-skill-docs',
      owner: 'agent-b',
      paths: ['shared/skills/ijfw-team/SKILL.md'],
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, 'conflict');
  } finally {
    cleanup(dir);
  }
});

test('releaseClaim marks matching active claims released', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    claimArtifact(dir, { artifact: 'design-docs', owner: 'docs-agent' });
    const released = releaseClaim(dir, { artifact: 'design-docs', owner: 'docs-agent' });
    assert.deepEqual(released, { ok: true, released: 1 });
    assert.equal(blackboardStatus(dir).claims.active, 0);
    const state = readBlackboard(dir);
    assert.equal(state.claims.data.claims[0].status, 'released');
  } finally {
    cleanup(dir);
  }
});

test('addBlackboardNote appends typed JSONL entries', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const result = addBlackboardNote(dir, {
      kind: 'blocker',
      author: 'verification-engineer',
      artifact: 'worktree-manager',
      message: 'dirty worktree policy needs confirmation',
    });
    assert.equal(result.ok, true);
    const paths = blackboardPaths(dir);
    const line = readFileSync(paths.blockers, 'utf8').trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.kind, 'blocker');
    assert.equal(parsed.artifact, 'worktree-manager');
  } finally {
    cleanup(dir);
  }
});

test('writeHandoff stores markdown handoff', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const result = writeHandoff(dir, '# Handoff\n\nWave 1 complete.');
    assert.equal(result.ok, true);
    assert.match(readFileSync(blackboardPaths(dir).handoff, 'utf8'), /Wave 1 complete/);
  } finally {
    cleanup(dir);
  }
});
