// IJFW v1.3.0 -- D2 BFS traversal.
//
// Source authority: D-PILLAR-SPEC.md section 2 (depth cap 2, weight
// threshold 0.5) + section 4 (BFS query surface).
//
// Reads kg_nodes / kg_edges via the compute db. Reads do NOT acquire
// .graph-write.lock -- WAL mode allows concurrent reads with writers.
//
// API:
//   bfsTraverse(db, startNodeId, depth=2, edgeKinds=['co_occurs'])
//     -> { nodes, edges, traversal_path }
//
//   resolveNode(db, kind, name)
//     -> { id, kind, name, ... } | null
//
//   bfsRelated(db, query, opts?)
//     -> { nodes, edges, traversal_path } using entity-resolution heuristic

const DEFAULT_DEPTH = 2;
const DEFAULT_WEIGHT_THRESHOLD = 0.5;
const DEFAULT_EDGE_KINDS = ['co_occurs'];

/**
 * resolveNode(db, kind, name) -> kg_nodes row | null
 *
 * Exact (kind, name) match. Returns null on miss. Used by graph:traverse
 * dispatch to convert a string identifier into a node id.
 */
export function resolveNode(db, kind, name) {
  if (!db || typeof db.prepare !== 'function') return null;
  if (!kind || !name) return null;
  return db.prepare(
    `SELECT id, kind, name, first_seen, last_seen, redacted ` +
    `FROM kg_nodes WHERE kind = ? AND name = ?`
  ).get(String(kind), String(name)) || null;
}

/**
 * bfsTraverse(db, startNodeId, depth, edgeKinds, opts?) -> { nodes, edges, traversal_path }
 *
 * Breadth-first walk from startNodeId. Traverses kg_edges where:
 *   - kind in edgeKinds
 *   - weight >= opts.weightThreshold (default 0.5 per D-PILLAR-SPEC section 2)
 * Up to `depth` hops. Both src and dst indexes are queried so traversal
 * is undirected at the read layer.
 *
 * Returns:
 *   nodes -- distinct kg_nodes rows reached (including the start node)
 *   edges -- kg_edges rows traversed (deduped by (src, dst, kind))
 *   traversal_path -- array of node ids in BFS visitation order
 */
export function bfsTraverse(db, startNodeId, depth = DEFAULT_DEPTH, edgeKinds = DEFAULT_EDGE_KINDS, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('bfsTraverse: db handle is invalid.');
  }
  const startId = Number(startNodeId);
  if (!Number.isFinite(startId) || startId <= 0) {
    throw new Error(`bfsTraverse: startNodeId must be a positive number; got ${startNodeId}`);
  }
  const maxDepth = Number.isInteger(depth) && depth >= 0 ? depth : DEFAULT_DEPTH;
  const kinds = Array.isArray(edgeKinds) && edgeKinds.length > 0
    ? edgeKinds.map(String)
    : DEFAULT_EDGE_KINDS;
  const weightThreshold = Number.isFinite(opts.weightThreshold)
    ? Number(opts.weightThreshold)
    : DEFAULT_WEIGHT_THRESHOLD;

  // Verify start node exists.
  const startNode = db.prepare(
    `SELECT id, kind, name, first_seen, last_seen, redacted FROM kg_nodes WHERE id = ?`
  ).get(startId);
  if (!startNode) {
    return { nodes: [], edges: [], traversal_path: [] };
  }

  // BFS state.
  const visitedNodes = new Map(); // id -> node row
  const visitedEdges = new Map(); // edgeKey -> edge row
  const traversalPath = [];
  visitedNodes.set(startNode.id, startNode);
  traversalPath.push(startNode.id);

  // Pre-compile edge query (kinds expanded inline; param count varies).
  const placeholders = kinds.map(() => '?').join(', ');
  const queryNeighbours = db.prepare(
    `SELECT src, dst, kind, weight, co_occurrence_count, ts FROM kg_edges ` +
    `WHERE (src = ? OR dst = ?) AND kind IN (${placeholders}) AND weight >= ?`
  );

  const queryNode = db.prepare(
    `SELECT id, kind, name, first_seen, last_seen, redacted FROM kg_nodes WHERE id = ?`
  );

  let frontier = [startNode.id];
  for (let hop = 0; hop < maxDepth && frontier.length > 0; hop++) {
    const next = [];
    for (const nodeId of frontier) {
      const rows = queryNeighbours.all(nodeId, nodeId, ...kinds, weightThreshold);
      for (const row of rows) {
        const otherId = Number(row.src) === nodeId ? Number(row.dst) : Number(row.src);
        // Skip if other endpoint is the start AND already visited (no
        // self-loops at hop 1 etc.).
        const ek = `${Math.min(Number(row.src), Number(row.dst))}|${Math.max(Number(row.src), Number(row.dst))}|${row.kind}`;
        if (!visitedEdges.has(ek)) visitedEdges.set(ek, row);

        if (!visitedNodes.has(otherId)) {
          const nrow = queryNode.get(otherId);
          if (nrow) {
            visitedNodes.set(otherId, nrow);
            traversalPath.push(otherId);
            // Only follow non-redacted neighbours into the next hop --
            // redacted nodes terminate the traversal at their boundary.
            if (!nrow.redacted) next.push(otherId);
          }
        }
      }
    }
    frontier = next;
  }

  return {
    nodes: [...visitedNodes.values()],
    edges: [...visitedEdges.values()],
    traversal_path: traversalPath,
  };
}

/**
 * bfsRelated(db, query, opts?) -> { nodes, edges, traversal_path }
 *
 * Lightweight entity-resolution wrapper for `ijfw_memory_search graph:related`.
 * Tries exact (kind, name) match first; if no match, attempts case-
 * insensitive substring across all kinds and uses the first hit.
 *
 * If no entity resolves, returns empty result. Caller (server.js) merges
 * with FTS5 hits for the search response envelope.
 */
export function bfsRelated(db, query, opts = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    return { nodes: [], edges: [], traversal_path: [], resolved: null };
  }
  const q = query.trim();

  // Try exact name match across kinds (most specific first).
  const exact = db.prepare(
    `SELECT id, kind, name FROM kg_nodes WHERE name = ? LIMIT 1`
  ).get(q);
  let startNode = exact || null;

  if (!startNode) {
    // Substring match (case-insensitive). First hit wins; deterministic
    // tiebreaker = lowest id (oldest entity).
    const sub = db.prepare(
      `SELECT id, kind, name FROM kg_nodes ` +
      `WHERE name LIKE ? COLLATE NOCASE ORDER BY id ASC LIMIT 1`
    ).get(`%${q}%`);
    startNode = sub || null;
  }

  if (!startNode) {
    return { nodes: [], edges: [], traversal_path: [], resolved: null };
  }

  const result = bfsTraverse(
    db,
    startNode.id,
    opts.depth != null ? opts.depth : DEFAULT_DEPTH,
    opts.edgeKinds || DEFAULT_EDGE_KINDS,
    { weightThreshold: opts.weightThreshold }
  );
  return { ...result, resolved: { id: startNode.id, kind: startNode.kind, name: startNode.name } };
}

export const __test = {
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT_THRESHOLD,
  DEFAULT_EDGE_KINDS,
};

export default { bfsTraverse, resolveNode, bfsRelated };
