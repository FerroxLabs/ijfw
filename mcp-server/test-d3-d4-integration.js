#!/usr/bin/env node
/**
 * test-d3-d4-integration.js -- GA fix-wave GA-B1 end-to-end.
 *
 * Source authority: GA fix-wave finding GA-B1 + .planning/1.3.0/CROSS-AUDIT-GA.md
 *
 * Verifies that the D3 dream-cycle wiring fires D4 propagateStale on
 * Episodic->Semantic supersession events. Pre-fix-wave the chain was:
 *
 *   Working -> Episodic (D1) -> Semantic (D1) -> [STOPS HERE]
 *
 * Post-fix-wave:
 *
 *   Working -> Episodic (D1) -> Semantic (D1) -> propagateStale (D4)
 *                                              -> stale_candidate flag
 *                                              -> memory.search excludes
 *
 * Tests:
 *   1. promoteEpisodicToSemantic exposes superseded[] with id+body+reason
 *   2. propagateStaleForSupersessions resolves entities, fires
 *      propagateStale, returns aggregate summary
 *   3. propagateStaleForSupersessions skips redacted entities
 *   4. propagateStaleForSupersessions tolerates missing kg_nodes graph
 *      (returns empty summary; never throws)
 *   5. End-to-end pipeline: ingest body -> auto-graph-populate ->
 *      promoteEpisodicToSemantic -> propagateStale fires -> downstream
 *      observation rows flagged stale_candidate=1
 *
 * Run: node --test mcp-server/test-d3-d4-integration.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb as openMemoryDb, indexEntry, closeDb as closeMemoryDb } from './src/memory/fts5.js';
import {
  promoteEpisodicToSemantic,
  promoteWorkingToEpisodic,
  TIERS,
} from './src/memory/tier-promotion.js';
import { openDb as openComputeDb, closeDb as closeComputeDb, safeWrite, search as computeSearch } from './src/compute/fts5.js';
import { upsertNode } from './src/compute/edges.js';
import { propagateStaleForSupersessions } from './src/dream/staleness-wiring.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

// --- D1 surface -------------------------------------------------------

test('GA-B1 -- promoteEpisodicToSemantic exposes superseded[] with id+body+reason', async () => {
  const root = tmpRoot('ga-b1-d1-shape');
  const memDb = await openMemoryDb(root);
  try {
    // Two highly-similar Episodic rows -> Jaccard supersession fires.
    memDb.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
    ).run('authLogin verifies the bearer token via parseClaims', 'src1', 'sX', Date.now() - 2000, TIERS.EPISODIC);
    memDb.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
    ).run('authLogin verifies the bearer token via parseClaims (refined)', 'src2', 'sX', Date.now() - 1000, TIERS.EPISODIC);

    const result = promoteEpisodicToSemantic(memDb);
    assert.equal(result.promoted, 1, 'one Episodic promoted to Semantic');
    assert.ok(Array.isArray(result.superseded), 'superseded array exposed');
    assert.equal(result.superseded.length, 1);
    const sup = result.superseded[0];
    assert.ok(typeof sup.id === 'number' && sup.id > 0, 'id is positive number');
    assert.ok(typeof sup.body === 'string' && sup.body.length > 0, 'body present');
    assert.match(String(sup.reason), /jaccard=/, 'reason is jaccard-based');
  } finally {
    closeMemoryDb(memDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B1 -- promoteEpisodicToSemantic returns empty superseded[] when nothing fires', async () => {
  const root = tmpRoot('ga-b1-d1-empty');
  const memDb = await openMemoryDb(root);
  try {
    const result = promoteEpisodicToSemantic(memDb);
    assert.equal(result.promoted, 0);
    assert.deepEqual(result.superseded, []);
  } finally {
    closeMemoryDb(memDb);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- propagateStaleForSupersessions ----------------------------------

test('GA-B1 -- propagateStaleForSupersessions resolves entities + fires propagateStale', async () => {
  const root = tmpRoot('ga-b1-wiring-fires');
  // Disable graph auto-index so we can seed kg_nodes deterministically
  // without ingest-time auto-population racing.
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  let computeDb;
  try {
    computeDb = await openComputeDb(root);
    const ts = Date.now();

    // Seed a tiny graph: authLogin <-> verifyToken (weight 0.7).
    const a = upsertNode(computeDb, { kind: 'function', name: 'authLogin', redacted: 0 }, ts).id;
    const b = upsertNode(computeDb, { kind: 'function', name: 'verifyToken', redacted: 0 }, ts).id;
    computeDb.prepare(
      `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(Math.min(a, b), Math.max(a, b), 'co_occurs', 0.7, 3, ts);

    // Seed two observation rows in compute.raw referencing the entity
    // names so propagateStale has something to flag.
    safeWrite(computeDb, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'authLogin entry', ts });
    safeWrite(computeDb, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'verifyToken bearer mismatch', ts });

    // Close compute db so the wiring can re-open it.
    closeComputeDb(computeDb);
    computeDb = null;

    // Drive the wiring with a synthetic supersession event whose body
    // mentions authLogin. extractEntities will pull it out, the wiring
    // looks up kg_nodes by (kind=function, name=authLogin), then fires
    // propagateStale at that node id.
    const sum = await propagateStaleForSupersessions({
      projectRoot: root,
      supersededEntries: [{ id: 99, body: 'authLogin diff: refined token check', reason: 'jaccard=0.84' }],
    });
    assert.equal(sum.superseded_count, 1);
    assert.ok(sum.entities_resolved >= 1, `entities_resolved >= 1 (got ${sum.entities_resolved})`);
    assert.ok(sum.nodes_propagated >= 1, `nodes_propagated >= 1 (got ${sum.nodes_propagated})`);
    assert.ok(sum.flagged_total >= 1, `flagged_total >= 1 (got ${sum.flagged_total})`);

    // Re-open compute to verify the row got flagged.
    computeDb = await openComputeDb(root);
    const rows = computeDb.prepare(`SELECT body, stale_candidate FROM raw ORDER BY id`).all();
    const flaggedCount = rows.filter(r => Number(r.stale_candidate) === 1).length;
    assert.ok(flaggedCount >= 1, 'at least one raw row flagged stale_candidate=1');

    // Search excludes flagged rows by default.
    const fresh = computeSearch(computeDb, 'raw', 'verifyToken', 10);
    assert.ok(fresh.every(h => Number(h.stale_candidate || 0) === 0), 'default search excludes stale rows');
    const all = computeSearch(computeDb, 'raw', 'verifyToken', 10, { include_stale: true });
    assert.ok(all.length >= fresh.length, 'include_stale=true returns at least as many rows');
  } finally {
    if (computeDb) closeComputeDb(computeDb);
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B1 -- propagateStaleForSupersessions skips when no kg_nodes match', async () => {
  const root = tmpRoot('ga-b1-no-match');
  process.env.IJFW_GRAPH_AUTO_INDEX = '0';
  try {
    const sum = await propagateStaleForSupersessions({
      projectRoot: root,
      supersededEntries: [{ id: 1, body: 'a body that mentions nothing in any kg_nodes table', reason: 'explicit' }],
    });
    assert.equal(sum.superseded_count, 1);
    assert.equal(sum.entities_resolved, 0, 'no entities resolved');
    assert.equal(sum.nodes_propagated, 0, 'no propagateStale calls');
    assert.equal(sum.flagged_total, 0);
  } finally {
    delete process.env.IJFW_GRAPH_AUTO_INDEX;
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B1 -- propagateStaleForSupersessions returns empty summary on empty input', async () => {
  const root = tmpRoot('ga-b1-empty-input');
  try {
    const sum = await propagateStaleForSupersessions({
      projectRoot: root,
      supersededEntries: [],
    });
    assert.equal(sum.superseded_count, 0);
    assert.equal(sum.nodes_propagated, 0);
    assert.equal(sum.flagged_total, 0);
    assert.deepEqual(sum.errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GA-B1 -- propagateStaleForSupersessions throws nothing without projectRoot', async () => {
  const sum = await propagateStaleForSupersessions({
    projectRoot: '',
    supersededEntries: [{ id: 1, body: 'authLogin foo', reason: 'explicit' }],
  });
  assert.equal(sum.superseded_count, 1);
  assert.ok(sum.errors.length >= 1, 'records error rather than throwing');
});

// --- End-to-end pipeline ---------------------------------------------

test('GA-B1+B2+B3 -- end-to-end pipeline ingest -> auto-index -> supersede -> propagate -> search excludes', async () => {
  const root = tmpRoot('ga-e2e-pipeline');
  // Default-on auto-index covers GA-B3 wiring.
  delete process.env.IJFW_GRAPH_AUTO_INDEX;
  let computeDb;
  let memDb;
  try {
    // 1. Ingest two co-mentioning observations into compute -- auto-index
    //    populates kg_nodes + kg_edges via GA-B3 path.
    computeDb = await openComputeDb(root);
    const ts = Date.now();
    safeWrite(computeDb, 'raw', { source_kind: 'tool_result', session_id: 's1', project_root: root, body: 'authLogin verifies bearer via verifyToken handshake', ts });
    safeWrite(computeDb, 'raw', { source_kind: 'tool_result', session_id: 's1', project_root: root, body: 'verifyToken parses the bearer claim chain', ts: ts + 1 });

    // Confirm graph populated.
    const nodeCount = computeDb.prepare(`SELECT COUNT(*) AS n FROM kg_nodes`).get().n;
    assert.ok(Number(nodeCount) >= 2, `kg_nodes auto-populated (got ${nodeCount})`);

    closeComputeDb(computeDb);
    computeDb = null;

    // 2. Seed Episodic rows into memory db; one similar pair triggers
    //    Jaccard supersession.
    memDb = await openMemoryDb(root);
    const baseTs = Date.now() - 5000;
    memDb.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
    ).run('authLogin verifies bearer via verifyToken handshake (initial)', 'src1', 's1', baseTs, TIERS.EPISODIC);
    memDb.prepare(
      `INSERT INTO memory_entries (body, source, session_id, created_at, tier_semantic) VALUES (?, ?, ?, ?, ?)`
    ).run('authLogin verifies bearer via verifyToken handshake (refined)', 'src2', 's1', baseTs + 1000, TIERS.EPISODIC);

    const promo = promoteEpisodicToSemantic(memDb);
    assert.ok(promo.promoted >= 1, 'supersession fires');
    assert.ok(promo.superseded.length >= 1, 'superseded array populated');

    closeMemoryDb(memDb);
    memDb = null;

    // 3. Drive the staleness wiring (this is what runner.mjs does).
    const sum = await propagateStaleForSupersessions({
      projectRoot: root,
      supersededEntries: promo.superseded,
    });
    assert.ok(sum.entities_resolved >= 1, `pipeline resolves entities (got ${sum.entities_resolved})`);
    assert.ok(sum.nodes_propagated >= 1, `pipeline propagates over kg_nodes (got ${sum.nodes_propagated})`);

    // 4. Verify compute search now suppresses the flagged rows.
    computeDb = await openComputeDb(root);
    const allRows = computeDb.prepare(`SELECT id, body, stale_candidate FROM raw ORDER BY id`).all();
    const flagged = allRows.filter(r => Number(r.stale_candidate) === 1);
    assert.ok(flagged.length >= 1, `at least one row flagged stale (got ${flagged.length})`);

    const filtered = computeSearch(computeDb, 'raw', 'verifyToken', 10);
    assert.ok(filtered.every(h => Number(h.stale_candidate || 0) === 0),
      'default search excludes stale rows end-to-end');

    // 5. GA real fix-wave F2: BOTH compute AND memory rows must end up
    //    flagged after the dream cycle. Pre-F2 only the compute side
    //    propagated; the memory column existed but was never written.
    //    The end-to-end pipeline now writes BOTH stores.
    memDb = await openMemoryDb(root);
    const memRows = memDb.prepare(
      `SELECT id, body, stale_candidate, tier_semantic FROM memory_entries ORDER BY id`
    ).all();
    const memFlagged = memRows.filter(r => Number(r.stale_candidate) === 1);
    assert.ok(memFlagged.length >= 1,
      `F2: at least one memory_entries row flagged stale (got ${memFlagged.length}/${memRows.length})`);
    assert.ok(sum.flagged_memory >= 1,
      `F2: summary.flagged_memory >= 1 (got ${sum.flagged_memory})`);
    assert.ok(sum.flagged_compute >= 1,
      `F2: summary.flagged_compute >= 1 (got ${sum.flagged_compute})`);
  } finally {
    if (computeDb) closeComputeDb(computeDb);
    if (memDb) closeMemoryDb(memDb);
    rmSync(root, { recursive: true, force: true });
  }
});
