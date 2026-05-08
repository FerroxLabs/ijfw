#!/usr/bin/env node
/**
 * test-d4-cascading-staleness.js -- D-Pillar / D4 cascading staleness.
 *
 * Source authority: PRD-v2 section 9 Pillar D D4 + .planning/1.3.0/D-PILLAR-SPEC.md
 * section 2 (edge weight + propagation threshold) + section 7 (50-fixture
 * grader spec).
 *
 * Covers:
 *   1. Migration v4 -> v5 preserves rows + adds stale_candidate column
 *      to BOTH raw + compiled with default 0 + partial index.
 *   2. propagateStale on simple 3-node graph: superseded -> BFS reaches
 *      2 nodes within depth-2 + weight>=0.5; flags observation rows.
 *   3. Edge weight 0.4 (below threshold) does NOT propagate.
 *   4. Edge weight 0.6 + depth 2 DOES propagate.
 *   5. Depth-3 node NOT flagged (cap respected).
 *   6. Redacted node terminates BFS at its boundary; nodes beyond
 *      redacted boundary stay fresh; redacted node's name is NOT used
 *      to flag observations (per D-PILLAR-SPEC section 3 ordering).
 *   7. Search excludes stale_candidate=1 by default.
 *   8. Search with include_stale=true returns all rows.
 *   9. propagateStale envelope shape: flagged_count, depth_distribution,
 *      edge_weights_sampled, traversal_path.
 *  10. Tool-cap stays 10 (no new MCP tools registered for D4).
 *
 * Run: node --test mcp-server/test-d4-cascading-staleness.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { openDb, closeDb, safeWrite, search } from './src/compute/fts5.js';
import { upsertNode } from './src/compute/edges.js';
import { propagateStale } from './src/compute/staleness.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

function addEdge(db, srcId, dstId, weight, ts, kind = 'co_occurs', count = 3) {
  const lo = Math.min(srcId, dstId);
  const hi = Math.max(srcId, dstId);
  db.prepare(
    `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(lo, hi, kind, weight, count, ts);
}

// --- Migration ---------------------------------------------------------

test('D4 -- compute v4 -> v5 adds stale_candidate to raw + compiled, preserves rows', async () => {
  const root = tmpRoot('d4-migrate');
  let db;
  try {
    db = await openDb(root);

    // Insert pre-existing rows on both content tables; migration must
    // preserve them with stale_candidate defaulted to 0.
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'sess-A',
      project_root: root,
      body: 'pre-D4 raw row',
      ts: Date.now(),
    });
    safeWrite(db, 'compiled', {
      topic: 'pre-D4',
      body: 'pre-D4 compiled row',
      source_raw_ids: '[1]',
      ts: Date.now(),
    });

    const uv = db.prepare('PRAGMA user_version').get();
    assert.equal(Number(uv.user_version), 5, 'user_version is 5 after open');

    // raw.stale_candidate present with default 0.
    const rawCols = db.prepare(`PRAGMA table_info(raw)`).all();
    const rawStale = rawCols.find(c => c.name === 'stale_candidate');
    assert.ok(rawStale, 'raw.stale_candidate column present');
    assert.equal(Number(rawStale.dflt_value), 0, 'raw.stale_candidate default=0');

    // compiled.stale_candidate present with default 0.
    const compCols = db.prepare(`PRAGMA table_info(compiled)`).all();
    const compStale = compCols.find(c => c.name === 'stale_candidate');
    assert.ok(compStale, 'compiled.stale_candidate column present');
    assert.equal(Number(compStale.dflt_value), 0, 'compiled.stale_candidate default=0');

    // Indexes present (partial index on stale_candidate > 0).
    const idx = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index'`).all();
    const names = idx.map(r => `${r.tbl_name}.${r.name}`);
    assert.ok(names.includes('raw.raw_stale_candidate_idx'), `raw_stale_candidate_idx in ${names.join(', ')}`);
    assert.ok(names.includes('compiled.compiled_stale_candidate_idx'), 'compiled_stale_candidate_idx');

    // schema_meta v5 row present.
    const meta = db.prepare(`SELECT version FROM schema_meta WHERE version = 5`).get();
    assert.ok(meta, 'schema_meta v5 row');

    // Pre-existing rows preserved with stale_candidate = 0.
    const rawRow = db.prepare(`SELECT body, stale_candidate FROM raw WHERE body = ?`).get('pre-D4 raw row');
    assert.ok(rawRow, 'raw row preserved');
    assert.equal(Number(rawRow.stale_candidate), 0, 'raw row stale_candidate defaulted to 0');

    const compRow = db.prepare(`SELECT body, stale_candidate FROM compiled WHERE body = ?`).get('pre-D4 compiled row');
    assert.ok(compRow, 'compiled row preserved');
    assert.equal(Number(compRow.stale_candidate), 0, 'compiled row stale_candidate defaulted to 0');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Core propagateStale behaviour ------------------------------------

test('D4 -- propagateStale on 3-node graph reaches depth-2 + flags observations', async () => {
  const root = tmpRoot('d4-3node');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'function', name: 'authLogin', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'verifyToken', redacted: 0 }, ts).id;
    const c = upsertNode(db, { kind: 'function', name: 'parseClaims', redacted: 0 }, ts).id;
    addEdge(db, a, b, 0.7, ts);
    addEdge(db, b, c, 0.6, ts);

    // Seed observations referencing each node by name.
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'authLogin called from handler', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'verifyToken: signature mismatch', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'parseClaims returned exp claim', ts });

    const env = propagateStale(db, a);
    // Reached: A (depth 0), B (depth 1), C (depth 2).
    const reachedNames = env.reached_nodes.map(n => `${n.name}@${n.depth}`).sort();
    assert.deepEqual(reachedNames, ['authLogin@0', 'parseClaims@2', 'verifyToken@1']);
    // depth_distribution counts depth>0 only (depth 0 excluded by default).
    assert.deepEqual(env.depth_distribution, { 1: 1, 2: 1 });
    // edge_weights_sampled is the weights of the edges actually walked.
    assert.equal(env.edge_weights_sampled.length, 2, 'two edges sampled');
    // flagged_count = 2 (B's row + C's row; A skipped because include_start=false).
    assert.equal(env.flagged_count, 2, 'two observations flagged');
    assert.equal(env.flagged_raw, 2);

    // Verify rows: A still fresh, B + C flagged.
    const rows = db.prepare(`SELECT body, stale_candidate FROM raw ORDER BY id`).all();
    assert.equal(Number(rows[0].stale_candidate), 0, 'authLogin row stays fresh');
    assert.equal(Number(rows[1].stale_candidate), 1, 'verifyToken row flagged');
    assert.equal(Number(rows[2].stale_candidate), 1, 'parseClaims row flagged');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale skips edges with weight below 0.5 threshold', async () => {
  const root = tmpRoot('d4-belowthresh');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'function', name: 'rootNode', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'belowEdge', redacted: 0 }, ts).id;
    // Edge weight 0.4 -- below default 0.5 threshold.
    addEdge(db, a, b, 0.4, ts);

    const env = propagateStale(db, a);
    // BFS does not traverse the edge.
    assert.equal(env.reached_nodes.length, 1, 'only the start node reached');
    assert.equal(env.reached_nodes[0].name, 'rootNode');
    assert.equal(env.flagged_count, 0, 'no observations flagged');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale edge weight 0.6 propagates through both hops', async () => {
  const root = tmpRoot('d4-0p6');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'function', name: 'rootCallSite', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'midHelper', redacted: 0 }, ts).id;
    const c = upsertNode(db, { kind: 'function', name: 'endHelper', redacted: 0 }, ts).id;
    addEdge(db, a, b, 0.6, ts);
    addEdge(db, b, c, 0.6, ts);

    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'midHelper observed', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'endHelper observed', ts });

    const env = propagateStale(db, a);
    const reachedNames = env.reached_nodes.filter(n => n.depth > 0).map(n => n.name).sort();
    assert.deepEqual(reachedNames, ['endHelper', 'midHelper'], 'both hops walked');
    assert.equal(env.flagged_count, 2, 'both observations flagged');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale depth cap 2 means depth-3 node NOT flagged', async () => {
  const root = tmpRoot('d4-depth3');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    // Chain A-B-C-D with weights all above threshold. With depth_cap=2,
    // BFS reaches B (depth 1) + C (depth 2) but NOT D (depth 3).
    const a = upsertNode(db, { kind: 'function', name: 'depth0Node', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'depth1Node', redacted: 0 }, ts).id;
    const c = upsertNode(db, { kind: 'function', name: 'depth2Node', redacted: 0 }, ts).id;
    const d = upsertNode(db, { kind: 'function', name: 'depth3Node', redacted: 0 }, ts).id;
    addEdge(db, a, b, 0.7, ts);
    addEdge(db, b, c, 0.7, ts);
    addEdge(db, c, d, 0.7, ts);

    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'depth1Node hit', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'depth2Node hit', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'depth3Node hit', ts });

    const env = propagateStale(db, a);
    const reachedNames = env.reached_nodes.map(n => n.name).sort();
    assert.deepEqual(reachedNames, ['depth0Node', 'depth1Node', 'depth2Node'],
      'depth-3 node beyond cap');
    // Verify depth3 row stays fresh.
    const d3Row = db.prepare(`SELECT stale_candidate FROM raw WHERE body LIKE ?`).get('%depth3Node%');
    assert.equal(Number(d3Row.stale_candidate), 0, 'depth-3 observation stays fresh');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale depth_cap override raises reach', async () => {
  const root = tmpRoot('d4-depthcap-override');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const ids = {};
    for (const name of ['rootZ', 'l1Z', 'l2Z', 'l3Z']) {
      ids[name] = upsertNode(db, { kind: 'function', name, redacted: 0 }, ts).id;
    }
    addEdge(db, ids.rootZ, ids.l1Z, 0.7, ts);
    addEdge(db, ids.l1Z, ids.l2Z, 0.7, ts);
    addEdge(db, ids.l2Z, ids.l3Z, 0.7, ts);

    // Default depth_cap=2: l3Z not reached.
    const env2 = propagateStale(db, ids.rootZ);
    assert.ok(!env2.reached_nodes.some(n => n.name === 'l3Z'), 'l3Z not reached at depth 2');

    // depth_cap=3: l3Z reached.
    const env3 = propagateStale(db, ids.rootZ, { depth_cap: 3 });
    assert.ok(env3.reached_nodes.some(n => n.name === 'l3Z'), 'l3Z reached at depth 3 override');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale weight_threshold override changes propagation', async () => {
  const root = tmpRoot('d4-weight-override');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'function', name: 'srcW', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'mediumW', redacted: 0 }, ts).id;
    addEdge(db, a, b, 0.55, ts);

    // Default threshold 0.5 -- propagates.
    const envDefault = propagateStale(db, a);
    assert.ok(envDefault.reached_nodes.some(n => n.name === 'mediumW'), 'reached at default 0.5');

    // Tighter threshold 0.6 -- does NOT propagate.
    // Reset stale_candidate flag first so the second run is independent.
    db.prepare(`UPDATE raw SET stale_candidate = 0`).run();
    const envTight = propagateStale(db, a, { weight_threshold: 0.6 });
    assert.ok(!envTight.reached_nodes.some(n => n.name === 'mediumW'),
      'NOT reached at threshold 0.6');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Redacted boundary -------------------------------------------------

test('D4 -- propagateStale terminates BFS at redacted node boundary', async () => {
  const root = tmpRoot('d4-redacted');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const r = upsertNode(db, { kind: 'function', name: 'rootCallerR', redacted: 0 }, ts).id;
    const x = upsertNode(db, { kind: 'identifier', name: 'redactedSecretR', redacted: 1 }, ts).id;
    const beyondX = upsertNode(db, { kind: 'function', name: 'beyondRedactedR', redacted: 0 }, ts).id;
    const y = upsertNode(db, { kind: 'function', name: 'cleanSiblingR', redacted: 0 }, ts).id;
    const z = upsertNode(db, { kind: 'function', name: 'cleanGrandchildR', redacted: 0 }, ts).id;

    addEdge(db, r, x, 0.7, ts);          // R -> X (redacted) at depth 1
    addEdge(db, x, beyondX, 0.7, ts);    // X -> beyond, blocked by redact
    addEdge(db, r, y, 0.7, ts);          // R -> Y (clean) at depth 1
    addEdge(db, y, z, 0.6, ts);          // Y -> Z (clean) at depth 2

    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'redactedSecretR observed', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'beyondRedactedR observed', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'cleanSiblingR observed', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'cleanGrandchildR observed', ts });

    const env = propagateStale(db, r);
    const reachedClean = env.reached_nodes.filter(n => n.depth > 0 && !n.redacted).map(n => n.name).sort();
    assert.deepEqual(reachedClean, ['cleanGrandchildR', 'cleanSiblingR'],
      'clean siblings + grandchildren reached; redacted node not in clean reach');

    // The redacted node IS reached (BFS visits it) but the predicted/
    // flagged set excludes it: redacted nodes don't seed observation
    // flags. Verify via flagged_count + actual rows.
    const redactedReached = env.reached_nodes.find(n => n.redacted);
    assert.ok(redactedReached, 'redacted node visited by BFS');

    const rows = db.prepare(`SELECT body, stale_candidate FROM raw ORDER BY id`).all();
    const stateByBody = Object.fromEntries(rows.map(r => [r.body, Number(r.stale_candidate)]));
    assert.equal(stateByBody['redactedSecretR observed'], 0, 'redacted observation NOT flagged via name');
    assert.equal(stateByBody['beyondRedactedR observed'], 0, 'beyond redacted boundary stays fresh');
    assert.equal(stateByBody['cleanSiblingR observed'], 1, 'clean sibling flagged');
    assert.equal(stateByBody['cleanGrandchildR observed'], 1, 'clean grandchild flagged');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Retrieval guard ---------------------------------------------------

test('D4 -- search excludes stale_candidate=1 rows by default', async () => {
  const root = tmpRoot('d4-search-default');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'fresh observation about validateToken', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'stale observation about validateToken', ts });

    db.prepare(`UPDATE raw SET stale_candidate = 1 WHERE id = 2`).run();

    const hits = search(db, 'raw', 'validateToken', 10);
    assert.equal(hits.length, 1, 'default search returns only fresh row');
    assert.equal(hits[0].id, 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- search returns all rows when include_stale=true', async () => {
  const root = tmpRoot('d4-search-include');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'fresh observation about validateToken', ts });
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'stale observation about validateToken', ts });
    db.prepare(`UPDATE raw SET stale_candidate = 1 WHERE id = 2`).run();

    const hits = search(db, 'raw', 'validateToken', 10, { include_stale: true });
    assert.equal(hits.length, 2, 'include_stale=true returns both rows');
    const ids = hits.map(h => Number(h.id)).sort();
    assert.deepEqual(ids, [1, 2]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- search guard works on compiled table too', async () => {
  const root = tmpRoot('d4-search-compiled');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    safeWrite(db, 'compiled', { topic: 'fresh-summary', body: 'fresh body about authLogin', source_raw_ids: '[1]', ts });
    safeWrite(db, 'compiled', { topic: 'stale-summary', body: 'stale body about authLogin', source_raw_ids: '[2]', ts });
    db.prepare(`UPDATE compiled SET stale_candidate = 1 WHERE id = 2`).run();

    const hits = search(db, 'compiled', 'authLogin', 10);
    assert.equal(hits.length, 1, 'compiled search excludes stale by default');
    const all = search(db, 'compiled', 'authLogin', 10, { include_stale: true });
    assert.equal(all.length, 2, 'compiled include_stale=true returns both');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- search retains back-compat (4-arg call signature)', async () => {
  const root = tmpRoot('d4-search-backcompat');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'simple body validateToken', ts });
    // 4-arg call (no opts) returns the row, opts treated as {}.
    const hits = search(db, 'raw', 'validateToken', 5);
    assert.equal(hits.length, 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Envelope shape ----------------------------------------------------

test('D4 -- propagateStale envelope shape includes all required fields', async () => {
  const root = tmpRoot('d4-envelope');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'function', name: 'envSrc', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'envDst', redacted: 0 }, ts).id;
    addEdge(db, a, b, 0.7, ts);
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'envDst body content', ts });

    const env = propagateStale(db, a);
    assert.ok(typeof env.flagged_count === 'number', 'flagged_count');
    assert.ok(typeof env.flagged_raw === 'number', 'flagged_raw');
    assert.ok(typeof env.flagged_compiled === 'number', 'flagged_compiled');
    assert.ok(Array.isArray(env.reached_nodes), 'reached_nodes array');
    assert.ok(Array.isArray(env.edge_weights_sampled), 'edge_weights_sampled array');
    assert.ok(env.depth_distribution && typeof env.depth_distribution === 'object', 'depth_distribution object');
    assert.ok(Array.isArray(env.traversal_path), 'traversal_path array');
    assert.equal(env.weight_threshold, 0.5, 'weight_threshold echoed');
    assert.equal(env.depth_cap, 2, 'depth_cap echoed');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale on missing superseded node returns empty envelope', async () => {
  const root = tmpRoot('d4-missing');
  let db;
  try {
    db = await openDb(root);
    const env = propagateStale(db, 999_999);
    assert.equal(env.flagged_count, 0);
    assert.deepEqual(env.reached_nodes, []);
    assert.deepEqual(env.traversal_path, []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4 -- propagateStale rejects non-positive supersededNodeId', async () => {
  const root = tmpRoot('d4-bad-id');
  let db;
  try {
    db = await openDb(root);
    assert.throws(() => propagateStale(db, 0), /positive number/);
    assert.throws(() => propagateStale(db, -1), /positive number/);
    assert.throws(() => propagateStale(db, 'abc'), /positive number/);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Idempotence -------------------------------------------------------

test('D4 -- propagateStale is idempotent across repeated calls', async () => {
  const root = tmpRoot('d4-idem');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'function', name: 'idemSrc', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'idemDst', redacted: 0 }, ts).id;
    addEdge(db, a, b, 0.7, ts);
    safeWrite(db, 'raw', { source_kind: 'tool_result', session_id: 's', project_root: root, body: 'idemDst observed twice', ts });

    const first = propagateStale(db, a);
    const second = propagateStale(db, a);
    assert.equal(first.flagged_count, 1, 'first call flagged 1');
    // Second call: stale_candidate already 1, WHERE stale_candidate < 1
    // means no rows updated. But reached_nodes still mirrors traversal.
    assert.equal(second.flagged_count, 0, 'second call no-op (already flagged)');
    assert.equal(second.reached_nodes.length, first.reached_nodes.length,
      'traversal envelope identical');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Tool-cap (live MCP introspection) ---------------------------------

test('D4 -- MCP tool count remains 10 (no D4 tools registered)', async () => {
  const BIN = join(__dirname, 'bin', 'ijfw-memory');
  if (!existsSync(BIN)) return; // skip when bin not built

  const child = spawn(BIN, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, IJFW_DISABLE_STARTUP_REPORT: '1' },
  });
  function waitForResponse(id, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => {
        reject(new Error(`timed out waiting for id=${id}; buf=${buf.slice(0, 240)}`));
      }, timeoutMs);
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let p;
          try { p = JSON.parse(line); } catch { continue; }
          if (p && p.id === id) {
            clearTimeout(t);
            child.stdout.off('data', onData);
            resolve(p);
            return;
          }
        }
      };
      child.stdout.on('data', onData);
    });
  }
  function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'd4', version: '1' } } });
    await waitForResponse(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const resp = await waitForResponse(2);
    assert.ok(resp.result && Array.isArray(resp.result.tools), 'tools list returned');
    assert.equal(resp.result.tools.length, 10, `tool count is 10 (got ${resp.result.tools.length})`);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* nothing */ }
  }
});
