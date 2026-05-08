// IJFW v1.3.0 -- D2 edge writer.
//
// Source authority: D-PILLAR-SPEC.md section 2 (edge weight formula) +
// section 3 (redactor ordering).
//
// Pipeline:
//   1. extractEntities(body) yields candidates with redacted flag.
//   2. ./edges.js writes kg_nodes (find-or-create by (kind, name)),
//      flagging redacted=1 for secret-shaped entities.
//   3. For each unordered pair of CLEAN entities (redacted=0 on BOTH):
//      - INSERT OR IGNORE kg_edges row with co_occurrence_count=1
//      - On conflict, UPDATE: increment co_occurrence_count, refresh ts,
//        recompute weight via section 2 formula.
//   4. Locking: caller wraps the whole write in acquireGraphWriteLock().
//
// Edge weight formula (section 2):
//   weight = clamp_01(
//     log1p(co_occurrence_count) * 0.4 +
//     recency_decay_factor       * 0.4 +
//     redactor_clean_factor      * 0.2
//   )
//   recency_decay_factor = exp(-age_days / 30)
//   redactor_clean_factor = 1.0 if both clean, 0.0 if either redacted
//                          (the latter never reaches this code path)
//   clamp_01 = max(0, min(1, x))

const RECENCY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * upsertNode(db, ent, ts) -> { id, redacted }
 *
 * Find-or-create kg_nodes row by (kind, name). Updates last_seen on hit.
 * Returns the row id and the persisted redacted flag.
 */
export function upsertNode(db, ent, ts) {
  const now = Number(ts) || Date.now();
  const redactedFlag = ent.redacted ? 1 : 0;

  // Find first.
  const found = db.prepare(
    `SELECT id, redacted FROM kg_nodes WHERE kind = ? AND name = ?`
  ).get(ent.kind, ent.name);

  if (found) {
    db.prepare(
      `UPDATE kg_nodes SET last_seen = ?, redacted = ? WHERE id = ?`
    ).run(now, redactedFlag, found.id);
    return { id: Number(found.id), redacted: redactedFlag };
  }

  const insert = db.prepare(
    `INSERT INTO kg_nodes (kind, name, first_seen, last_seen, redacted) ` +
    `VALUES (?, ?, ?, ?, ?)`
  );
  const info = insert.run(ent.kind, ent.name, now, now, redactedFlag);
  return { id: Number(info.lastInsertRowid), redacted: redactedFlag };
}

/**
 * computeEdgeWeight({ co_occurrence_count, age_days, redactor_clean }) -> number
 *
 * Section 2 formula. Caller is responsible for computing age_days from
 * a stored ts. Returns clamped [0, 1] weight.
 */
export function computeEdgeWeight({ co_occurrence_count, age_days, redactor_clean }) {
  const co = Math.max(0, Number(co_occurrence_count) || 0);
  const age = Math.max(0, Number(age_days) || 0);
  const clean = redactor_clean ? 1 : 0;

  const log1p = Math.log1p(co);
  const recency = Math.exp(-age / RECENCY_HALF_LIFE_DAYS);
  const raw = log1p * 0.4 + recency * 0.4 + clean * 0.2;
  return Math.max(0, Math.min(1, raw));
}

/**
 * writeEdges(db, observationId, entities, opts?) -> { nodes, edgesAdded, edgesUpdated, redactedSkipped }
 *
 * Co-occurrence pairs all clean entities within the observation. Edge
 * weight follows D-PILLAR-SPEC section 2. Redacted entities are stored
 * as nodes (with redacted=1) but participate in NO edges (redactor_clean
 * factor is 0 for those endpoints, and per section 3 we skip the edge
 * write entirely rather than emit a zero-weight edge).
 *
 * `observationId` is included in the return value so callers can link
 * back to the observation ledger; it is not stored on edges directly.
 *
 * opts.ts (default Date.now()) -- co-occurrence timestamp; used for
 * recency decay calculation. Tests inject a fixed ts.
 */
export function writeEdges(db, observationId, entities, opts = {}) {
  const ts = Number(opts.ts) || Date.now();
  const nodes = [];
  let redactedSkipped = 0;
  for (const ent of entities) {
    const persisted = upsertNode(db, ent, ts);
    nodes.push({ ...ent, id: persisted.id });
    if (persisted.redacted) redactedSkipped++;
  }

  let edgesAdded = 0;
  let edgesUpdated = 0;

  const cleanNodes = nodes.filter(n => !n.redacted);
  for (let i = 0; i < cleanNodes.length; i++) {
    for (let j = i + 1; j < cleanNodes.length; j++) {
      // Stable ordering: src.id < dst.id ensures UPSERT keying matches
      // even if the caller iterates entities in a different order.
      const srcNode = cleanNodes[i].id < cleanNodes[j].id ? cleanNodes[i] : cleanNodes[j];
      const dstNode = cleanNodes[i].id < cleanNodes[j].id ? cleanNodes[j] : cleanNodes[i];

      const existing = db.prepare(
        `SELECT co_occurrence_count, ts FROM kg_edges ` +
        `WHERE src = ? AND dst = ? AND kind = ?`
      ).get(srcNode.id, dstNode.id, 'co_occurs');

      if (existing) {
        const newCount = Number(existing.co_occurrence_count) + 1;
        const ageDays = (ts - Number(existing.ts)) / MS_PER_DAY;
        const weight = computeEdgeWeight({
          co_occurrence_count: newCount,
          age_days: Math.max(0, ageDays),
          redactor_clean: true,
        });
        db.prepare(
          `UPDATE kg_edges SET co_occurrence_count = ?, weight = ?, ts = ? ` +
          `WHERE src = ? AND dst = ? AND kind = ?`
        ).run(newCount, weight, ts, srcNode.id, dstNode.id, 'co_occurs');
        edgesUpdated++;
      } else {
        const weight = computeEdgeWeight({
          co_occurrence_count: 1,
          age_days: 0,
          redactor_clean: true,
        });
        db.prepare(
          `INSERT INTO kg_edges (src, dst, kind, weight, co_occurrence_count, ts) ` +
          `VALUES (?, ?, ?, ?, ?, ?)`
        ).run(srcNode.id, dstNode.id, 'co_occurs', weight, 1, ts);
        edgesAdded++;
      }
    }
  }

  return {
    observationId,
    nodes,
    edgesAdded,
    edgesUpdated,
    redactedSkipped,
  };
}

export const __test = { RECENCY_HALF_LIFE_DAYS, MS_PER_DAY };
