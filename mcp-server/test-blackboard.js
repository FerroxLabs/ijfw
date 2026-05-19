import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetBlackboardReadCache,
  addBlackboardNote,
  appendBlackboardEvent,
  blackboardPaths,
  blackboardStatus,
  claimArtifact,
  DEFAULT_CLAIM_TTL_MS,
  evictOrphanedClaims,
  initBlackboard,
  readBlackboard,
  releaseClaim,
  updateClaimHeartbeat,
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

// --- F-REL-1 (H5.3): claim TTL + heartbeat + orphan eviction ----------

test('claimArtifact records a default 30-minute TTL on creation', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const res = claimArtifact(dir, { artifact: 'a1', owner: 'agent-a' });
    assert.equal(res.ok, true);
    assert.equal(res.claim.ttl_ms, DEFAULT_CLAIM_TTL_MS);
    assert.equal(res.claim.heartbeat_at, null);
    assert.ok(res.claim.claimed_at);
  } finally {
    cleanup(dir);
  }
});

test('evictOrphanedClaims releases a stale claim whose anchor exceeds TTL', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const res = claimArtifact(dir, { artifact: 'stale', owner: 'silent-agent', ttlMs: 1000 });
    assert.equal(res.ok, true);
    // Advance now beyond the per-claim TTL.
    const future = Date.now() + 10_000;
    const evicted = evictOrphanedClaims(dir, { nowMs: future });
    assert.equal(evicted.ok, true);
    assert.equal(evicted.count, 1);
    assert.deepEqual(evicted.evicted_ids, [res.claim.id]);
    // Status is now 'expired', not 'active'.
    const state = readBlackboard(dir);
    const claim = state.claims.data.claims.find((c) => c.id === res.claim.id);
    assert.equal(claim.status, 'expired');
    assert.equal(claim.eviction_reason, 'ttl-exceeded');
  } finally {
    cleanup(dir);
  }
});

test('updateClaimHeartbeat extends the freshness anchor and prevents eviction', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const res = claimArtifact(dir, { artifact: 'living', owner: 'live-agent', ttlMs: 5000 });
    assert.equal(res.ok, true);
    // Heartbeat at t+4s (still inside TTL).
    const hb = updateClaimHeartbeat(dir, { claim_id: res.claim.id });
    assert.equal(hb.ok, true);
    assert.ok(hb.claim.heartbeat_at);
    // Now eviction at t+8s (4s after heartbeat) -- inside the 5s TTL anchored on heartbeat.
    const hbMs = Date.parse(hb.claim.heartbeat_at);
    const evicted = evictOrphanedClaims(dir, { nowMs: hbMs + 4000 });
    assert.equal(evicted.count, 0);
    // But at heartbeat+6s (past TTL) it does evict.
    const evicted2 = evictOrphanedClaims(dir, { nowMs: hbMs + 6000 });
    assert.equal(evicted2.count, 1);
  } finally {
    cleanup(dir);
  }
});

test('evictOrphanedClaims returns evicted IDs and leaves fresh claims active', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const stale = claimArtifact(dir, { artifact: 'old', owner: 'a', ttlMs: 1000 });
    const fresh = claimArtifact(dir, { artifact: 'new', owner: 'b', ttlMs: 60_000 });
    assert.equal(stale.ok, true);
    assert.equal(fresh.ok, true);
    const future = Date.now() + 5000;
    const result = evictOrphanedClaims(dir, { nowMs: future });
    assert.equal(result.count, 1);
    assert.deepEqual(result.evicted_ids, [stale.claim.id]);
    // Fresh claim still active.
    const state = readBlackboard(dir);
    const freshClaim = state.claims.data.claims.find((c) => c.id === fresh.claim.id);
    assert.equal(freshClaim.status, 'active');
  } finally {
    cleanup(dir);
  }
});

test('evictOrphanedClaims TTL is configurable via options.ttlMs (fallback for legacy claims)', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    // Write a legacy-shape claim (no ttl_ms) directly. Simulates pre-H5.3 data.
    const paths = blackboardPaths(dir);
    const legacy = {
      version: 1,
      claims: [
        {
          id: 'legacy:agent-a',
          artifact_id: 'legacy',
          agent: 'agent-a',
          paths: [],
          status: 'active',
          claimed_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
      updated_at: new Date().toISOString(),
    };
    writeFileSync(paths.claims, JSON.stringify(legacy, null, 2));
    // With a 10s TTL fallback, the 60s-old legacy claim should evict.
    const result = evictOrphanedClaims(dir, { ttlMs: 10_000 });
    assert.equal(result.count, 1);
    assert.equal(result.evicted_ids[0], 'legacy:agent-a');
    // With a 1h TTL fallback, it survives.
    initBlackboard(dir);
    writeFileSync(paths.claims, JSON.stringify(legacy, null, 2));
    const survived = evictOrphanedClaims(dir, { ttlMs: 60 * 60 * 1000 });
    assert.equal(survived.count, 0);
  } finally {
    cleanup(dir);
  }
});

test('evictOrphanedClaims records a claim.evicted event per orphan', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const res = claimArtifact(dir, { artifact: 'logme', owner: 'agent-c', ttlMs: 500 });
    assert.equal(res.ok, true);
    const future = Date.now() + 5000;
    const result = evictOrphanedClaims(dir, { nowMs: future });
    assert.equal(result.count, 1);
    const events = readBlackboard(dir).recent.events;
    const evict = events.find((e) => e.type === 'claim.evicted');
    assert.ok(evict, 'expected a claim.evicted event');
    assert.equal(evict.task_id, null);
    assert.deepEqual(evict.artifact_ids, ['logme']);
    assert.equal(evict.data.id, res.claim.id);
  } finally {
    cleanup(dir);
  }
});

test('updateClaimHeartbeat fails cleanly on missing claim', () => {
  const dir = makeTmp();
  try {
    initBlackboard(dir);
    const result = updateClaimHeartbeat(dir, { claim_id: 'does-not-exist' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'claim-not-found');
  } finally {
    cleanup(dir);
  }
});

// ── audit-MED-teams-#9: mtime-keyed readBlackboard memo ───────────────────

test('readBlackboard returns the same JSON shape on unchanged files (mtime cache)', () => {
  const dir = makeTmp();
  try {
    _resetBlackboardReadCache();
    initBlackboard(dir);
    const a = readBlackboard(dir);
    const b = readBlackboard(dir);
    // The cache returns the same parsed object reference on a hit, so the
    // tasks + claims pointers must be identical (not deep-equal copies).
    assert.equal(a.tasks, b.tasks, 'tasks should be served from the mtime cache');
    assert.equal(a.claims, b.claims, 'claims should be served from the mtime cache');
  } finally {
    cleanup(dir);
  }
});

test('readBlackboard re-parses after a write invalidates the mtime', async () => {
  const dir = makeTmp();
  try {
    _resetBlackboardReadCache();
    initBlackboard(dir);
    const before = readBlackboard(dir);
    // Wait long enough for the mtime to advance, then mutate tasks via the
    // public API.
    await new Promise((resolve) => setTimeout(resolve, 15));
    appendBlackboardEvent(dir, { type: 'test.poke' }); // unrelated jsonl write
    // Force a tasks.json write so its mtime changes.
    const { writeBlackboardTasks } = await import('./src/blackboard.js');
    writeBlackboardTasks(dir, [{ id: 't1', title: 'demo', status: 'todo', artifact_ids: ['x'] }]);
    const after = readBlackboard(dir);
    assert.notEqual(before.tasks, after.tasks, 'cache must invalidate after tasks.json mtime change');
    assert.equal(after.tasks.data.tasks.length, 1);
  } finally {
    cleanup(dir);
  }
});
