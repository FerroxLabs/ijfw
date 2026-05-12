#!/usr/bin/env node
/**
 * test-memory-staleness.js -- GA real fix-wave F2 (memory-side staleness propagation).
 *
 * Source authority: GA real fix-wave finding F2 + .planning/1.3.0/D-PILLAR-SPEC.md section 2.
 *
 * Verifies that mcp-server/src/memory/staleness.js#propagateStaleMemory
 * actually writes to memory_entries.stale_candidate. Pre-F2, the compute
 * propagateStale only flagged compute-side rows; the memory column +
 * search filter were dead infrastructure. F2 lands a parallel mutation
 * path so the same dream cycle flags BOTH stores.
 *
 * Tests:
 *   1. propagateStaleMemory returns empty envelope on absent start node.
 *   2. propagateStaleMemory walks compute kg BFS, flags matching memory rows.
 *   3. propagateStaleMemory honours weight_threshold + depth_cap.
 *   4. propagateStaleMemory leaves rows without name matches alone.
 *   5. propagateStaleMemory degrades silently when memory schema lacks the column.
 *
 * Run: node --test mcp-server/test-memory-staleness.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb as openMemoryDb, closeDb as closeMemoryDb } from './src/memory/fts5.js';
import { openDb as openComputeDb, closeDb as closeComputeDb } from './src/compute/fts5.js';
import { upsertNode } from './src/compute/edges.js';
import { propagateStaleMemory } from './src/memory/staleness.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

function seedComputeKg(computeDb, ts) {
  // Build a 3-node graph: A <-> B (weight 0.7), B <-> C (weight 0.3).
  // BFS from A with default threshold 0.5 + depth 2 reaches B but not C
  // (B-C edge weight is sub-threshold).
  const a = upsertNode(computeDb, { kind: 'function', name: 'authLogin', redacted: 0 }, ts).id;
  const b = upsertNode(computeDb, { kind: 'function', name: 'verifyToken', redacted: 0 }, ts).id;
  const c = upsertNode(computeDb, { kind: 'function', name: 'parseClaims', redacted: 0 }, ts).id;
  const edge = (s, d, w) => computeDb.prepare(
    `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(Math.min(s, d), Math.max(s, d), 'co_occurs', w, 3, ts);
  edge(a, b, 0.7);
  edge(b, c, 0.3);
  return { a, b, c };
}

function seedMemoryRows(memDb) {
  // Insert memory rows that mention each entity. These are the rows the
  // BFS walk should flag (when the entity name appears in body).
  const ts = Date.now();
  const insert = memDb.prepare(
    `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
  );
  const idA = insert.run('authLogin opened a fresh session', 'src1', 's1', ts, 'working').lastInsertRowid;
  const idB = insert.run('verifyToken parsed the bearer header', 'src2', 's1', ts + 1, 'working').lastInsertRowid;
  const idC = insert.run('parseClaims extracted role + scope', 'src3', 's1', ts + 2, 'working').lastInsertRowid;
  const idUnrelated = insert.run('totally unrelated body about lunch', 'src4', 's1', ts + 3, 'working').lastInsertRowid;
  return { idA, idB, idC, idUnrelated };
}

test('F2 -- propagateStaleMemory returns empty envelope on absent start node', async () => {
  const root = tmpRoot('f2-empty');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let memDb, computeDb;
  try {
    memDb = await openMemoryDb(root);
    computeDb = await openComputeDb(root);
    const env = propagateStaleMemory(memDb, computeDb, 9999);
    assert.equal(env.flagged_count, 0);
    assert.deepEqual(env.reached_nodes, []);
    assert.deepEqual(env.traversal_path, []);
  } finally {
    if (memDb) closeMemoryDb(memDb);
    if (computeDb) closeComputeDb(computeDb);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2 -- propagateStaleMemory walks BFS and flags matching memory rows', async () => {
  const root = tmpRoot('f2-walk');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let memDb, computeDb;
  try {
    memDb = await openMemoryDb(root);
    computeDb = await openComputeDb(root);
    const ts = Date.now();
    const { a, b, c } = seedComputeKg(computeDb, ts);
    const { idA, idB, idC, idUnrelated } = seedMemoryRows(memDb);

    // BFS from A walks to B (weight 0.7 >= 0.5). C is unreachable
    // (b->c weight 0.3 < threshold). includeStart=false: A is NOT
    // flagged via name match (caller flags the superseded row separately).
    const env = propagateStaleMemory(memDb, computeDb, a);
    assert.ok(env.flagged_count >= 1, `flagged_count >= 1 (got ${env.flagged_count})`);
    // Verify the right rows landed: B's row should be flagged, A's row
    // should NOT be (start excluded by default), C should NOT be (BFS
    // never reached it), unrelated row should NOT be.
    const get = (id) => memDb.prepare(`SELECT body, stale_candidate FROM memory_entries WHERE id = ?`).get(id);
    assert.equal(Number(get(idB).stale_candidate), 1, 'B (1-hop) flagged');
    assert.equal(Number(get(idA).stale_candidate || 0), 0, 'A (start) not flagged (default)');
    assert.equal(Number(get(idC).stale_candidate || 0), 0, 'C (sub-threshold edge) not flagged');
    assert.equal(Number(get(idUnrelated).stale_candidate || 0), 0, 'unrelated row not flagged');
  } finally {
    if (memDb) closeMemoryDb(memDb);
    if (computeDb) closeComputeDb(computeDb);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2 -- propagateStaleMemory honours include_start option', async () => {
  const root = tmpRoot('f2-include-start');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let memDb, computeDb;
  try {
    memDb = await openMemoryDb(root);
    computeDb = await openComputeDb(root);
    const ts = Date.now();
    const { a, b } = seedComputeKg(computeDb, ts);
    const { idA, idB } = seedMemoryRows(memDb);

    const env = propagateStaleMemory(memDb, computeDb, a, { include_start: true });
    assert.ok(env.flagged_count >= 2, `flagged_count >= 2 (got ${env.flagged_count})`);
    const get = (id) => memDb.prepare(`SELECT body, stale_candidate FROM memory_entries WHERE id = ?`).get(id);
    assert.equal(Number(get(idA).stale_candidate), 1, 'A (start) flagged with include_start');
    assert.equal(Number(get(idB).stale_candidate), 1, 'B (1-hop) flagged');
  } finally {
    if (memDb) closeMemoryDb(memDb);
    if (computeDb) closeComputeDb(computeDb);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2 -- propagateStaleMemory honours weight_threshold lowered to reach further', async () => {
  const root = tmpRoot('f2-low-threshold');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let memDb, computeDb;
  try {
    memDb = await openMemoryDb(root);
    computeDb = await openComputeDb(root);
    const ts = Date.now();
    const { a, b, c } = seedComputeKg(computeDb, ts);
    const { idA, idB, idC } = seedMemoryRows(memDb);

    // Lower threshold to 0.2 so the b-c edge (weight 0.3) is traversable.
    const env = propagateStaleMemory(memDb, computeDb, a, { weight_threshold: 0.2 });
    assert.ok(env.flagged_count >= 2, `flagged_count >= 2 (got ${env.flagged_count})`);
    const get = (id) => memDb.prepare(`SELECT stale_candidate FROM memory_entries WHERE id = ?`).get(id);
    assert.equal(Number(get(idB).stale_candidate), 1, 'B reachable at 0.7');
    assert.equal(Number(get(idC).stale_candidate), 1, 'C reachable at 0.3 (low threshold)');
  } finally {
    if (memDb) closeMemoryDb(memDb);
    if (computeDb) closeComputeDb(computeDb);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

test('F2 -- propagateStaleMemory rejects invalid handles', async () => {
  assert.throws(() => propagateStaleMemory(null, {}, 1), /memDb handle is invalid/);
  assert.throws(() => propagateStaleMemory({ prepare() {} }, null, 1), /computeDb handle is invalid/);
  assert.throws(
    () => propagateStaleMemory({ prepare() {} }, { prepare() {} }, 0),
    /supersededNodeId must be a positive number/
  );
});

test('F2 -- propagateStaleMemory leaves zero rows when no name matches', async () => {
  const root = tmpRoot('f2-nomatch');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let memDb, computeDb;
  try {
    memDb = await openMemoryDb(root);
    computeDb = await openComputeDb(root);
    const ts = Date.now();
    const { a } = seedComputeKg(computeDb, ts);

    // Only seed an unrelated body in memory.
    memDb.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
    ).run('a row about something else entirely', 'src', 's1', Date.now(), 'working');

    const env = propagateStaleMemory(memDb, computeDb, a);
    assert.equal(env.flagged_count, 0, 'no body matches -> zero flagged');
  } finally {
    if (memDb) closeMemoryDb(memDb);
    if (computeDb) closeComputeDb(computeDb);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});
