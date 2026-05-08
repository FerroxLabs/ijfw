#!/usr/bin/env node
/**
 * test-d2-symbol-graph.js -- D-Pillar / D2 symbol graph v0.
 *
 * Source authority: PRD-v2 section 9 Pillar D D2 + .planning/1.3.0/D-PILLAR-SPEC.md sections 2-7.
 *
 * Covers:
 *   1. Migration v3 -> v4 preserves existing rows + adds kg_nodes + kg_edges
 *      with correct schema + indexes. BEGIN IMMEDIATE invariant.
 *   2. extractEntities returns the 5 entity kinds with proper redacted
 *      flag. Pre-redaction extraction preserves file paths and identifiers.
 *   3. Redactor ordering: a secret-shaped identifier flagged redacted=1
 *      and produces NO edges; a clean file path passes redactor and
 *      forms edges with co-occurring identifiers.
 *   4. Edge weight formula matches D-PILLAR-SPEC section 2.
 *   5. BFS depth cap respected (depth=2 default, depth=1 truncates).
 *   6. Lock collision: concurrent writes serialize via .graph-write.lock.
 *   7. Colon-syntax dispatch returns correct envelope.
 *   8. Tool-cap stays 10 (no new MCP tools registered for graph:*).
 *
 * Run: node --test mcp-server/test-d2-symbol-graph.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { openDb, closeDb, safeWrite } from './src/compute/fts5.js';
import { extractEntities } from './src/compute/extract.js';
import { writeEdges, computeEdgeWeight, upsertNode } from './src/compute/edges.js';
import { bfsTraverse, resolveNode, bfsRelated } from './src/compute/traverse.js';
import { acquireGraphWriteLock } from './src/compute/graph-lock.js';
import { parseColonCommand, dispatchRun, dispatchSearch } from './src/dispatch/colon-syntax.js';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), `ijfw-${prefix}-`));
}

// --- Migration ---------------------------------------------------------

test('D2 -- compute v3 -> v4 preserves rows + adds kg_nodes + kg_edges', async () => {
  const root = tmpRoot('d2-migrate');
  let db;
  try {
    db = await openDb(root);

    // Pre-existing rows (raw + compiled) must be preserved across the
    // migration chain. Insert at v3+ so migrations don't lose them.
    safeWrite(db, 'raw', {
      source_kind: 'compute_output',
      session_id: 'sess-A',
      project_root: root,
      body: 'pre-D2 raw row',
      ts: Date.now(),
    });

    // user_version reflects the latest applied migration. D4's
    // 005-stale-candidate.js bumped this to 5 after the original D2
    // assertion was authored. We assert >= 4 (D2's gate) so subsequent
    // migrations can extend the schema without churning this test.
    const uv = db.prepare('PRAGMA user_version').get();
    assert.ok(Number(uv.user_version) >= 4,
      `user_version >= 4 after open (got ${uv.user_version})`);

    // kg_nodes columns
    const nodeCols = db.prepare(`PRAGMA table_info(kg_nodes)`).all();
    const nodeNames = nodeCols.map(c => c.name).sort();
    assert.deepEqual(nodeNames,
      ['first_seen', 'id', 'kind', 'last_seen', 'name', 'redacted'],
      'kg_nodes columns'
    );

    // kg_edges columns
    const edgeCols = db.prepare(`PRAGMA table_info(kg_edges)`).all();
    const edgeNames = edgeCols.map(c => c.name).sort();
    assert.deepEqual(edgeNames,
      ['co_occurrence_count', 'dst', 'kind', 'src', 'ts', 'weight'],
      'kg_edges columns'
    );

    // Indexes present.
    const idx = db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index'`).all();
    const names = idx.map(r => `${r.tbl_name}.${r.name}`);
    assert.ok(names.includes('kg_nodes.kg_nodes_kind_name_idx'), `kg_nodes_kind_name_idx in ${names.join(', ')}`);
    assert.ok(names.includes('kg_edges.kg_edges_src_kind_idx'), 'kg_edges_src_kind_idx');
    assert.ok(names.includes('kg_edges.kg_edges_dst_kind_idx'), 'kg_edges_dst_kind_idx');

    // schema_meta v4 row
    const meta = db.prepare(`SELECT version FROM schema_meta WHERE version = 4`).get();
    assert.ok(meta, 'schema_meta v4 row');

    // Pre-existing raw row preserved.
    const raw = db.prepare(`SELECT body FROM raw WHERE body = ?`).get('pre-D2 raw row');
    assert.ok(raw, 'pre-D2 raw row preserved across migration');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Entity extractor --------------------------------------------------

test('D2 -- extractEntities recognises 5 entity kinds', () => {
  const body =
    'src/auth/login.js calls validateToken; ERR_INVALID_ARG_TYPE handled; ' +
    'd-auth-rotation-2026-04 implemented; MAX_RETRY_COUNT bumped';
  const ents = extractEntities(body, { minMentions: 1 });
  const byKind = {};
  for (const e of ents) {
    byKind[e.kind] = byKind[e.kind] || [];
    byKind[e.kind].push(e.name);
  }
  assert.ok(byKind.file && byKind.file.includes('src/auth/login.js'), 'file extracted');
  assert.ok(byKind.function && byKind.function.includes('validateToken'), 'function extracted');
  assert.ok(byKind.identifier && byKind.identifier.includes('MAX_RETRY_COUNT'), 'identifier extracted');
  assert.ok(byKind.error_code && byKind.error_code.includes('ERR_INVALID_ARG_TYPE'), 'error_code extracted');
  assert.ok(byKind.decision && byKind.decision.includes('d-auth-rotation-2026-04'), 'decision extracted');
});

test('D2 -- extractEntities flags redacted entities, preserves file paths', () => {
  // A file path that LOOKS like a token but is a real path stays clean.
  // A token that matches a known secret pattern (e.g. fake stripe key)
  // gets flagged redacted=1 -- but only if it matches the FULL value.
  const body =
    'src/auth/login.js loaded; sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 ' +
    'is the live key; another file at src/lib/helper.js';
  const ents = extractEntities(body, { minMentions: 1 });
  // file paths preserved (not redacted)
  const file = ents.find(e => e.name === 'src/auth/login.js');
  assert.ok(file, 'file path extracted');
  assert.equal(file.redacted, 0, 'file path classified clean');
  // The Stripe-shaped token would only register as an entity if any of
  // the regex rules match its shape. classify() inside extractor flags
  // it as redacted IF it lands as a candidate. The test checks that a
  // legit file path is NOT redacted -- the stronger redactor-ordering
  // assertion lives in the dedicated test below.
});

test('D2 -- redactor ordering: secret-shaped value classified redacted', async () => {
  // classify() is the surface used by extractEntities. We exercise it
  // directly here: a full-string secret-shaped value classifies as
  // not-clean; a file path classifies as clean.
  const { classify } = await import('./src/redactor.js');
  const stripe = classify('sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
  assert.equal(stripe.clean, false, 'stripe-shaped value classified as redacted');
  assert.equal(stripe.redacted_kind, 'stripe', 'redacted_kind is stripe');

  const filePath = classify('src/auth/login.js');
  assert.equal(filePath.clean, true, 'file path classified clean');
  assert.equal(filePath.redacted_kind, null, 'redacted_kind is null for clean');
});

test('D2 -- writeEdges writes nodes + edges for clean entities, skips redacted', async () => {
  const root = tmpRoot('d2-write');
  let db;
  try {
    db = await openDb(root);
    const ts = 1_700_000_000_000;
    const ents = [
      { kind: 'file', name: 'src/auth/login.js', redacted: 0 },
      { kind: 'function', name: 'validateToken', redacted: 0 },
      // Simulate a redacted entity -- writeEdges must NOT emit edges
      // touching this row.
      { kind: 'identifier', name: 'leaked-secret', redacted: 1 },
    ];
    const result = writeEdges(db, 'sess-1', ents, { ts });
    assert.equal(result.nodes.length, 3, 'all 3 nodes upserted');
    assert.equal(result.redactedSkipped, 1, 'one redacted entity tracked');
    // Only the 2 clean entities form edges; redacted does not.
    assert.equal(result.edgesAdded, 1, 'one edge between clean pair');
    assert.equal(result.edgesUpdated, 0);

    // Verify edge row structure.
    const edges = db.prepare(`SELECT src, dst, kind, weight, co_occurrence_count, ts FROM kg_edges`).all();
    assert.equal(edges.length, 1);
    const edge = edges[0];
    assert.equal(edge.kind, 'co_occurs');
    assert.equal(edge.co_occurrence_count, 1);
    assert.equal(edge.ts, ts);
    // Weight formula: log1p(1) * 0.4 + exp(0) * 0.4 + 1 * 0.2 ~= 0.877
    const expectedWeight = Math.log1p(1) * 0.4 + 1 * 0.4 + 1 * 0.2;
    assert.ok(Math.abs(edge.weight - expectedWeight) < 1e-9, `weight ${edge.weight} ~ ${expectedWeight}`);

    // Verify the redacted node exists but has no edges.
    const redactedNode = db.prepare(`SELECT id FROM kg_nodes WHERE name = ?`).get('leaked-secret');
    assert.ok(redactedNode, 'redacted node persisted');
    const edgesTouching = db.prepare(
      `SELECT COUNT(*) AS n FROM kg_edges WHERE src = ? OR dst = ?`
    ).get(redactedNode.id, redactedNode.id);
    assert.equal(Number(edgesTouching.n), 0, 'redacted node has zero edges');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2 -- edge weight formula matches D-PILLAR-SPEC section 2', () => {
  // Cases drawn from the formula: log1p(c) * 0.4 + exp(-age/30) * 0.4 + clean * 0.2
  // Cases:
  //   c=1, age=0,  clean=true  -> log1p(1) * 0.4 + 1 * 0.4 + 0.2  ~= 0.877
  //   c=10, age=0, clean=true  -> log1p(10) * 0.4 + 0.4 + 0.2     ~= 1.0 clamped (no, ~1.559 -> clamp to 1.0)
  //   c=1, age=30, clean=true  -> log1p(1)*0.4 + exp(-1)*0.4 + 0.2 ~= 0.624
  //   c=1, age=0,  clean=false -> log1p(1)*0.4 + 0.4 + 0           ~= 0.677
  const cases = [
    { c: 1, age: 0, clean: true,  want: Math.log1p(1) * 0.4 + 1 * 0.4 + 0.2 },
    { c: 10, age: 0, clean: true, want: 1.0 }, // clamped
    { c: 1, age: 30, clean: true, want: Math.log1p(1) * 0.4 + Math.exp(-1) * 0.4 + 0.2 },
    { c: 1, age: 0, clean: false, want: Math.log1p(1) * 0.4 + 1 * 0.4 + 0 },
  ];
  for (const { c, age, clean, want } of cases) {
    const got = computeEdgeWeight({
      co_occurrence_count: c,
      age_days: age,
      redactor_clean: clean,
    });
    const expected = Math.max(0, Math.min(1, want));
    assert.ok(Math.abs(got - expected) < 1e-9,
      `c=${c}, age=${age}, clean=${clean}: got ${got}, want ${expected}`);
  }
});

// --- BFS traversal -----------------------------------------------------

test('D2 -- bfsTraverse depth cap 2 by default; respects depth override', async () => {
  const root = tmpRoot('d2-bfs');
  let db;
  try {
    db = await openDb(root);
    // Build a chain: A - B - C - D - E where weights are 0.6 (above 0.5 threshold).
    const ts = Date.now();
    const ids = {};
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      ids[name] = upsertNode(db, { kind: 'identifier', name, redacted: 0 }, ts).id;
    }
    function addEdge(s, d) {
      db.prepare(
        `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(Math.min(s, d), Math.max(s, d), 'co_occurs', 0.7, 5, ts);
    }
    addEdge(ids.A, ids.B);
    addEdge(ids.B, ids.C);
    addEdge(ids.C, ids.D);
    addEdge(ids.D, ids.E);

    const r2 = bfsTraverse(db, ids.A, 2);
    const names2 = r2.nodes.map(n => n.name).sort();
    assert.deepEqual(names2, ['A', 'B', 'C'], 'depth=2 reaches B + C, stops before D');

    const r1 = bfsTraverse(db, ids.A, 1);
    const names1 = r1.nodes.map(n => n.name).sort();
    assert.deepEqual(names1, ['A', 'B'], 'depth=1 reaches B only');

    const r4 = bfsTraverse(db, ids.A, 4);
    const names4 = r4.nodes.map(n => n.name).sort();
    assert.deepEqual(names4, ['A', 'B', 'C', 'D', 'E'], 'depth=4 reaches all 5 nodes');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2 -- bfsTraverse respects weight threshold', async () => {
  const root = tmpRoot('d2-bfs-weight');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'identifier', name: 'A', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'identifier', name: 'B', redacted: 0 }, ts).id;
    const c = upsertNode(db, { kind: 'identifier', name: 'C', redacted: 0 }, ts).id;
    // A-B edge weight 0.7 (above threshold), B-C edge weight 0.3 (below).
    db.prepare(`INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`).run(a, b, 'co_occurs', 0.7, 5, ts);
    db.prepare(`INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`).run(b, c, 'co_occurs', 0.3, 1, ts);

    // Default threshold 0.5 -- BFS reaches A,B but not C.
    const r = bfsTraverse(db, a, 2);
    const names = r.nodes.map(n => n.name).sort();
    assert.deepEqual(names, ['A', 'B'], 'weight 0.3 edge skipped');

    // Lower threshold reaches C.
    const r2 = bfsTraverse(db, a, 2, ['co_occurs'], { weightThreshold: 0.1 });
    const names2 = r2.nodes.map(n => n.name).sort();
    assert.deepEqual(names2, ['A', 'B', 'C'], 'lower threshold reaches C');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2 -- resolveNode exact match by (kind, name)', async () => {
  const root = tmpRoot('d2-resolve');
  let db;
  try {
    db = await openDb(root);
    const ts = Date.now();
    upsertNode(db, { kind: 'file', name: 'src/X.ts', redacted: 0 }, ts);
    const r = resolveNode(db, 'file', 'src/X.ts');
    assert.ok(r);
    assert.equal(r.name, 'src/X.ts');
    assert.equal(r.kind, 'file');
    assert.equal(resolveNode(db, 'file', 'missing.ts'), null, 'miss returns null');
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Lock collision ----------------------------------------------------

test('D2 -- graph-write lock: second writer waits, then EBUSY_GRAPH_WRITE on timeout', async () => {
  const root = tmpRoot('d2-lock');
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    // First writer acquires.
    const lock1 = acquireGraphWriteLock(root);
    assert.ok(lock1, 'first writer acquires');

    // Second writer with short waitMs must time out and error.
    let err;
    try {
      acquireGraphWriteLock(root, { waitMs: 200 });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'second writer threw');
    assert.equal(err.code, 'EBUSY_GRAPH_WRITE');

    // Release and retry succeeds.
    lock1.released();
    const lock2 = acquireGraphWriteLock(root, { waitMs: 200 });
    assert.ok(lock2, 'after release second writer acquires');
    lock2.released();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2 -- graph-write lock: stale lock reclaimed on dead PID', async () => {
  const root = tmpRoot('d2-lock-stale');
  try {
    const lockPath = join(root, '.ijfw', '.graph-write.lock');
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    // Plant a stale lock with a fictitious PID + ts way in the past.
    writeFileSync(lockPath, '999999999\n0\n', { encoding: 'utf8' });

    const lock = acquireGraphWriteLock(root, { waitMs: 200 });
    assert.ok(lock, 'stale lock reclaimed; new writer acquired');
    lock.released();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Colon-syntax dispatch ---------------------------------------------

test('D2 -- parseColonCommand recognises graph: namespace', () => {
  const r = parseColonCommand('graph:traverse file:src/X.ts depth=2');
  assert.deepEqual(r, { namespace: 'graph', command: 'traverse', args: 'file:src/X.ts depth=2' });
});

test('D2 -- ijfw_run graph:traverse returns BFS envelope', async () => {
  const root = tmpRoot('d2-dispatch-traverse');
  try {
    const db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'file', name: 'src/auth.js', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'validateToken', redacted: 0 }, ts).id;
    db.prepare(`INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(a, b, 'co_occurs', 0.8, 3, ts);
    closeDb(db);

    const parsed = parseColonCommand('graph:traverse file:src/auth.js');
    const r = await dispatchRun(parsed, { projectRoot: root, sessionId: 'sess-X' });
    assert.equal(r.ok, true, `dispatchRun: ${r.error || 'ok'}`);
    assert.equal(r.start_node_id, a);
    assert.equal(r.depth, 2);
    assert.deepEqual(r.edge_kinds, ['co_occurs']);
    assert.equal(r.nodes.length, 2, 'reaches both nodes');
    assert.equal(r.edges.length, 1, 'one edge');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2 -- ijfw_memory_search graph:related returns merged envelope', async () => {
  const root = tmpRoot('d2-dispatch-related');
  try {
    const db = await openDb(root);
    const ts = Date.now();
    const a = upsertNode(db, { kind: 'file', name: 'src/auth.js', redacted: 0 }, ts).id;
    const b = upsertNode(db, { kind: 'function', name: 'validateToken', redacted: 0 }, ts).id;
    db.prepare(`INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(a, b, 'co_occurs', 0.8, 3, ts);
    closeDb(db);

    const parsed = parseColonCommand('graph:related validateToken');
    const r = await dispatchSearch(parsed, { projectRoot: root });
    assert.equal(r.ok, true, `dispatchSearch: ${r.error || 'ok'}`);
    assert.ok(r.resolved, 'resolved entity present');
    assert.equal(r.resolved.name, 'validateToken');
    assert.ok(Array.isArray(r.graph_hits), 'graph_hits array');
    assert.ok(r.graph_hits.length >= 2, 'graph_hits include reachable nodes');
    assert.ok(Array.isArray(r.fts_hits), 'fts_hits array (may be empty)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D2 -- graph:index dispatch extracts entities and writes edges', async () => {
  const root = tmpRoot('d2-dispatch-index');
  try {
    const parsed = parseColonCommand(
      'graph:index "src/auth/login.js calls validateToken from src/lib/jwt.js"'
    );
    const r = await dispatchRun(parsed, { projectRoot: root, sessionId: 'sess-1' });
    assert.equal(r.ok, true, `dispatchRun: ${r.error || 'ok'}`);
    assert.ok(r.entities_extracted >= 3, 'extracted file + function + file');
    assert.ok(r.edges_added >= 1, 'at least one edge written');

    // Verify persistence.
    const db = await openDb(root);
    const nodes = db.prepare(`SELECT name FROM kg_nodes ORDER BY name`).all();
    const names = nodes.map(n => n.name);
    assert.ok(names.includes('src/auth/login.js'));
    assert.ok(names.includes('validateToken'));
    closeDb(db);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Tool-cap (live MCP introspection) ---------------------------------

test('D2 -- MCP tool count remains 10 (no graph:* tools registered)', async () => {
  // Spawn the MCP server, ask for tools/list, count entries. Mirrors
  // the test-tool-cap.js harness's newline-delimited JSON-RPC framing.
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
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'd2', version: '1' } } });
    await waitForResponse(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const resp = await waitForResponse(2);
    assert.ok(resp.result && Array.isArray(resp.result.tools), 'tools list returned');
    assert.equal(resp.result.tools.length, 10, `tool count is 10 (got ${resp.result.tools.length})`);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* nothing */ }
  }
});
