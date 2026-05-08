#!/usr/bin/env node
/**
 * test-d2-auto-index.js -- GA fix-wave GA-B3.
 *
 * Source authority: GA fix-wave finding GA-B3 + .planning/1.3.0/CROSS-AUDIT-GA.md
 *
 * Verifies the symbol-graph auto-population path. Pre-fix-wave nothing
 * called writeEdges except the explicit graph:index dispatch surface, so
 * kg_nodes / kg_edges stayed empty in production. Post-fix-wave:
 *
 *   - compute.safeWrite(raw|compiled, ...) auto-extracts entities and
 *     writes kg_nodes / kg_edges co-occurrence pairs.
 *   - memory.indexEntry(...) opens the compute db at the same projectRoot
 *     and does the same auto-population (best-effort, async).
 *   - IJFW_GRAPH_AUTO_INDEX=0 disables the auto-index for tests that need
 *     deterministic graph state.
 *
 * Tests:
 *   1. compute.safeWrite('raw', ...) populates kg_nodes after ingest
 *   2. compute.safeWrite('compiled', ...) populates kg_nodes after ingest
 *   3. compute.safeWrite('audit_finding', ...) does NOT populate (ledger row)
 *   4. IJFW_GRAPH_AUTO_INDEX=0 disables auto-index (kg_nodes empty)
 *   5. IJFW_GRAPH_AUTO_INDEX=false (case-insensitive) disables auto-index
 *   6. memory.indexEntry populates kg_nodes via the compute db
 *   7. Graph populated via auto-index supports propagateStale BFS
 *
 * Run: node --test mcp-server/test-d2-auto-index.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openDb as openComputeDb,
  closeDb as closeComputeDb,
  safeWrite,
} from './src/compute/fts5.js';
import {
  openDb as openMemoryDb,
  indexEntry,
  closeDb as closeMemoryDb,
  __getLastAutoIndexPromise,
} from './src/memory/fts5.js';
import { propagateStale } from './src/compute/staleness.js';
import { __test as autoIndexTest } from './src/compute/graph-auto-index.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

// --- isAutoIndexEnabled helper ---------------------------------------

test('GA-B3 -- isAutoIndexEnabled defaults to true when env unset', () => {
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  assert.equal(autoIndexTest.isAutoIndexEnabled(), true);
});

test('GA-B3 -- isAutoIndexEnabled returns false on "0"', () => {
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  try {
    assert.equal(autoIndexTest.isAutoIndexEnabled(), false);
  } finally {
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
  }
});

test('GA-B3 -- isAutoIndexEnabled returns false on "false" (case-insensitive)', () => {
  process.env.IJFW_GRAPH_AUTO_INDEX = 'False';
  try {
    assert.equal(autoIndexTest.isAutoIndexEnabled(), false);
  } finally {
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
  }
});

// --- compute auto-index ----------------------------------------------

test('GA-B3 -- compute.safeWrite raw auto-populates kg_nodes', async () => {
  const root = tmpRoot('ga-b3-compute-raw');
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  let db;
  try {
    db = await openComputeDb(root);

    // Body mentions two clean entities -- co-occurrence edge should land.
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's1',
      project_root: root,
      body: 'authLogin calls verifyToken to parse the bearer claim',
      ts: Date.now(),
    });

    const nodeCount = db.prepare(`SELECT COUNT(*) AS n FROM kg_nodes`).get().n;
    assert.ok(Number(nodeCount) >= 2,
      `auto-index populated kg_nodes after compute.safeWrite (got ${nodeCount})`);

    // At least one edge between any two nodes from the body.
    const edgeCount = db.prepare(`SELECT COUNT(*) AS n FROM kg_edges`).get().n;
    assert.ok(Number(edgeCount) >= 1,
      `auto-index populated kg_edges after compute.safeWrite (got ${edgeCount})`);
  } finally {
    if (db) closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B3 -- compute.safeWrite compiled auto-populates kg_nodes', async () => {
  const root = tmpRoot('ga-b3-compute-compiled');
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  let db;
  try {
    db = await openComputeDb(root);
    safeWrite(db, 'compiled', {
      topic: 'auth-flow',
      body: 'authLogin verifies bearer token via verifyToken handshake',
      source_raw_ids: '[1]',
      ts: Date.now(),
    });
    const nodeCount = db.prepare(`SELECT COUNT(*) AS n FROM kg_nodes`).get().n;
    assert.ok(Number(nodeCount) >= 2,
      `auto-index populated kg_nodes after compute.safeWrite compiled (got ${nodeCount})`);
  } finally {
    if (db) closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B3 -- compute.safeWrite trident_run does NOT populate kg_nodes', async () => {
  const root = tmpRoot('ga-b3-trident-skip');
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  let db;
  try {
    db = await openComputeDb(root);
    // trident_run is an allowed write table that is NOT an observation
    // surface, so the auto-index dispatcher should skip it cleanly even
    // when the body-shaped columns mention entity names.
    safeWrite(db, 'trident_run', {
      audit_id: 'a1',
      lineage: 'anthropic',
      cli_name: 'claude-code',
      cli_version: '1.0.0',
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_usd: 0.01,
      verdict: 'PASS',
      ts: Date.now(),
    });

    const nodeCount = db.prepare(`SELECT COUNT(*) AS n FROM kg_nodes`).get().n;
    assert.equal(Number(nodeCount), 0,
      'trident_run does not auto-populate (only raw/compiled do)');
  } finally {
    if (db) closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B3 -- IJFW_GRAPH_AUTO_INDEX=0 disables auto-index', async () => {
  const root = tmpRoot('ga-b3-disabled');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let db;
  try {
    db = await openComputeDb(root);
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's1',
      project_root: root,
      body: 'authLogin calls verifyToken to parse the bearer claim',
      ts: Date.now(),
    });
    const nodeCount = db.prepare(`SELECT COUNT(*) AS n FROM kg_nodes`).get().n;
    assert.equal(Number(nodeCount), 0, 'auto-index disabled -> kg_nodes stays empty');
  } finally {
    if (db) closeComputeDb(db);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

// --- memory auto-index -----------------------------------------------

test('GA-B3 -- memory.indexEntry triggers compute kg_nodes auto-populate', async () => {
  const root = tmpRoot('ga-b3-memory-ingest');
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  let memDb;
  let computeDb;
  try {
    memDb = await openMemoryDb(root);
    indexEntry(memDb, {
      body: 'authLogin handler invokes verifyToken to validate the bearer header',
      source: 'auth-notes.md',
    });
    // Auto-index is async; await the in-flight promise hidden in the
    // module so the kg_nodes write commits before assertion.
    const p = __getLastAutoIndexPromise();
    if (p && typeof p.then === 'function') await p;

    computeDb = await openComputeDb(root);
    const nodeCount = computeDb.prepare(`SELECT COUNT(*) AS n FROM kg_nodes`).get().n;
    assert.ok(Number(nodeCount) >= 2,
      `memory.indexEntry populates compute kg_nodes (got ${nodeCount})`);
  } finally {
    if (memDb) closeMemoryDb(memDb);
    if (computeDb) closeComputeDb(computeDb);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- ingest -> graph -> propagateStale --------------------------------

test('GA-B3 -- auto-populated graph supports propagateStale BFS', async () => {
  const root = tmpRoot('ga-b3-bfs');
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  let db;
  try {
    db = await openComputeDb(root);

    // Seed two co-mentioning observations so authLogin <-> verifyToken
    // edge (and authLogin <-> parseClaims edge) both land via auto-index.
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's1',
      project_root: root,
      body: 'authLogin calls verifyToken to validate bearer',
      ts: Date.now(),
    });
    safeWrite(db, 'raw', {
      source_kind: 'tool_result',
      session_id: 's1',
      project_root: root,
      body: 'authLogin then invokes parseClaims to read exp',
      ts: Date.now() + 1,
    });

    // Resolve authLogin's kg_node id.
    const a = db.prepare(`SELECT id FROM kg_nodes WHERE kind=? AND name=?`).get('function', 'authLogin');
    assert.ok(a && a.id, 'authLogin kg_node landed via auto-index');

    const env = propagateStale(db, Number(a.id));
    // Reached at least one neighbour at depth 1.
    const reachedAtDepthOne = env.reached_nodes.filter(n => n.depth === 1);
    assert.ok(reachedAtDepthOne.length >= 1,
      `BFS reaches at least one neighbour after auto-index (got ${reachedAtDepthOne.length})`);
  } finally {
    if (db) closeComputeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});
