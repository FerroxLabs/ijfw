// IJFW v1.3.0 -- D4 memory-side cascading staleness propagation.
//
// Source authority: PRD-v2 section 9 Pillar D D4 + .planning/1.3.0/D-PILLAR-SPEC.md
// section 2 (cascading staleness propagation) + GA real fix-wave finding F2.
//
// PROBLEM (pre-F2): mcp-server/src/compute/staleness.js only mutates the
// COMPUTE store (`raw` + `compiled` tables in compute.db). The memory store
// has its own `memory_entries.stale_candidate` column (memory migration 003)
// and the memory search filter excludes flagged rows by default, but
// production never WRITES to that column. Memory rows that should be flagged
// stale by the dream cycle's BFS propagation never get flagged in practice;
// the column + filter are dead infrastructure.
//
// FIX: this module mirrors the compute-side `propagateStale` shape but
// operates on `memory_entries`. It is invoked by
// `mcp-server/src/dream/staleness-wiring.js` AFTER `propagateStale` runs
// against the compute db, so a single supersession event flags BOTH
// stores in the same dream cycle.
//
// The COMPUTE kg graph is the single source of truth for entity relations
// (per architecture: memory.indexEntry fires `autoIndexGraphFromMemoryBody`
// against the SAME compute kg). Memory propagation walks the same BFS
// surface but resolves matching rows by literal substring against
// `memory_entries.body`, mirroring `compute.staleness.js`'s name-pattern
// approach.
//
// Read-only access to compute kg: this module accepts a SECOND db handle
// (`computeDb`) opened by the caller. We never write the compute db here;
// we only walk kg_nodes + kg_edges to discover the BFS frontier. Writes
// land on `memory_entries.stale_candidate` only.
//
// Locking: caller holds .graph-write.lock for the dream cycle (per
// staleness-wiring.js header). This module performs reads against compute
// kg + writes against memory; the lock keeps concurrent kg writers out
// while we walk.

const DEFAULT_DEPTH_CAP = 2;
const DEFAULT_WEIGHT_THRESHOLD = 0.5;
const DEFAULT_EDGE_KINDS = ['co_occurs'];
const DEFAULT_STALE_VALUE = 1;

/**
 * propagateStaleMemory(memDb, computeDb, supersededNodeId, options) -> envelope
 *
 * Walk the COMPUTE kg graph from `supersededNodeId` (BFS, weight + depth
 * gated per D-PILLAR-SPEC §2). For every reachable node (excluding the
 * start node by default), find `memory_entries` rows whose `body` mentions
 * the node's name and flip their `stale_candidate` column to `staleValue`.
 *
 * options:
 *   weight_threshold (number, default 0.5)
 *   depth_cap        (integer, default 2)
 *   edge_kinds       (string[], default ['co_occurs'])
 *   stale_value      (integer, default 1)
 *   include_start    (boolean, default false)
 *
 * Returns:
 *   {
 *     flagged_count: number,            // memory_entries rows flipped
 *     reached_nodes: [{id,kind,name,depth,redacted}],
 *     edge_weights_sampled: number[],
 *     depth_distribution: {1:n, 2:n},
 *     traversal_path: number[],
 *     weight_threshold: number,
 *     depth_cap: number,
 *   }
 */
export function propagateStaleMemory(memDb, computeDb, supersededNodeId, options = {}) {
  if (!memDb || typeof memDb.prepare !== 'function') {
    throw new Error('propagateStaleMemory: memDb handle is invalid.');
  }
  if (!computeDb || typeof computeDb.prepare !== 'function') {
    throw new Error('propagateStaleMemory: computeDb handle is invalid.');
  }
  const startId = Number(supersededNodeId);
  if (!Number.isFinite(startId) || startId <= 0) {
    throw new Error(`propagateStaleMemory: supersededNodeId must be a positive number; got ${supersededNodeId}`);
  }

  const weightThreshold = Number.isFinite(options.weight_threshold)
    ? Number(options.weight_threshold)
    : DEFAULT_WEIGHT_THRESHOLD;
  const depthCap = Number.isInteger(options.depth_cap) && options.depth_cap >= 0
    ? options.depth_cap
    : DEFAULT_DEPTH_CAP;
  const edgeKinds = Array.isArray(options.edge_kinds) && options.edge_kinds.length > 0
    ? options.edge_kinds.map(String)
    : DEFAULT_EDGE_KINDS;
  const staleValue = Number.isInteger(options.stale_value) && options.stale_value >= 0
    ? options.stale_value
    : DEFAULT_STALE_VALUE;
  const includeStart = options.include_start === true;

  // Verify start node exists in compute kg.
  const startNode = computeDb.prepare(
    `SELECT id, kind, name, redacted FROM kg_nodes WHERE id = ?`
  ).get(startId);
  if (!startNode) {
    return emptyEnvelope();
  }

  // BFS over the compute kg (read-only).
  const visited = new Map();
  visited.set(startNode.id, { node: startNode, depth: 0 });
  const traversalPath = [startNode.id];
  const edgeWeightsSampled = [];

  const placeholders = edgeKinds.map(() => '?').join(', ');
  const queryNeighbours = computeDb.prepare(
    `SELECT src, dst, kind, weight, co_occurrence_count, ts FROM kg_edges ` +
    `WHERE (src = ? OR dst = ?) AND kind IN (${placeholders}) AND weight >= ?`
  );
  const queryNode = computeDb.prepare(
    `SELECT id, kind, name, redacted FROM kg_nodes WHERE id = ?`
  );

  let frontier = [startNode.id];
  for (let hop = 0; hop < depthCap && frontier.length > 0; hop++) {
    const next = [];
    for (const nodeId of frontier) {
      const rows = queryNeighbours.all(nodeId, nodeId, ...edgeKinds, weightThreshold);
      for (const row of rows) {
        const otherId = Number(row.src) === nodeId ? Number(row.dst) : Number(row.src);
        if (visited.has(otherId)) continue;
        const nrow = queryNode.get(otherId);
        if (!nrow) continue;
        const depth = hop + 1;
        visited.set(otherId, { node: nrow, depth });
        traversalPath.push(otherId);
        edgeWeightsSampled.push(Number(row.weight));
        if (!nrow.redacted) next.push(otherId);
      }
    }
    frontier = next;
  }

  // Build the set of names to flag against memory_entries.
  const namesToFlag = [];
  const reachedNodes = [];
  const depthDist = {};
  for (const { node, depth } of visited.values()) {
    if (depth === 0 && !includeStart) {
      reachedNodes.push({ id: node.id, kind: node.kind, name: node.name, depth, redacted: !!node.redacted });
      continue;
    }
    reachedNodes.push({ id: node.id, kind: node.kind, name: node.name, depth, redacted: !!node.redacted });
    depthDist[depth] = (depthDist[depth] || 0) + 1;
    if (!node.redacted && typeof node.name === 'string' && node.name.length >= 2) {
      namesToFlag.push(node.name);
    }
  }

  // Defence: if the memory schema predates migration 003, the column
  // doesn't exist; degrade silently rather than throw. (Production callers
  // run migrations before opening; tests that bypass openDb may not.)
  if (!hasStaleCandidateColumn(memDb)) {
    return {
      flagged_count: 0,
      reached_nodes: reachedNodes,
      edge_weights_sampled: edgeWeightsSampled,
      depth_distribution: depthDist,
      traversal_path: traversalPath,
      weight_threshold: weightThreshold,
      depth_cap: depthCap,
    };
  }

  let flagged = 0;
  if (namesToFlag.length > 0) {
    const updateMem = memDb.prepare(
      `UPDATE memory_entries SET stale_candidate = ? ` +
      `WHERE COALESCE(stale_candidate, 0) < ? AND body LIKE ?`
    );

    const txWrap = (typeof memDb.transaction === 'function')
      ? memDb.transaction(() => doFlag())
      : (typeof memDb.txn === 'function' ? memDb.txn(() => doFlag()) : null);

    function doFlag() {
      for (const name of namesToFlag) {
        const pattern = `%${escapeLike(name)}%`;
        const info = updateMem.run(staleValue, staleValue, pattern);
        flagged += Number(info.changes || 0);
      }
    }

    if (typeof txWrap === 'function') txWrap();
    else doFlag();
  }

  return {
    flagged_count: flagged,
    reached_nodes: reachedNodes,
    edge_weights_sampled: edgeWeightsSampled,
    depth_distribution: depthDist,
    traversal_path: traversalPath,
    weight_threshold: weightThreshold,
    depth_cap: depthCap,
  };
}

// LIKE escape -- mirrors compute.staleness.js.
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, '\\$&');
}

function hasStaleCandidateColumn(db) {
  try {
    const rows = db.prepare(`PRAGMA table_info(memory_entries)`).all();
    return rows.some(r => String(r.name) === 'stale_candidate');
  } catch {
    return false;
  }
}

function emptyEnvelope() {
  return {
    flagged_count: 0,
    reached_nodes: [],
    edge_weights_sampled: [],
    depth_distribution: {},
    traversal_path: [],
    weight_threshold: DEFAULT_WEIGHT_THRESHOLD,
    depth_cap: DEFAULT_DEPTH_CAP,
  };
}

export const __test = {
  DEFAULT_DEPTH_CAP,
  DEFAULT_WEIGHT_THRESHOLD,
  DEFAULT_EDGE_KINDS,
  DEFAULT_STALE_VALUE,
  escapeLike,
  hasStaleCandidateColumn,
};

export default { propagateStaleMemory };
