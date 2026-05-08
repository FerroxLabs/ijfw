// IJFW v1.3.0 -- compute migration 004: symbol-graph kg_nodes + kg_edges (D2).
//
// Source authority: PRD-v2 section 9 Pillar D D2 + .planning/1.3.0/D-PILLAR-SPEC.md sections 2-7.
//
// Bumps compute schema 3 -> 4. Adds two ADD-ONLY tables that back the
// regex-only symbol graph:
//
//   kg_nodes  -- one row per (kind, name) pair extracted from observations.
//                kind in {file, function, identifier, error_code, decision}
//                redacted=1 means the entity matched the secret redactor and
//                MUST NOT participate in edges (per D-PILLAR-SPEC section 3
//                ordering invariant).
//
//   kg_edges  -- weighted, kind-typed edge between two clean kg_nodes.
//                Co-occurrence counter + weight column carry the section 2
//                formula output. Edges are undirected at the read layer
//                (BFS looks at both src and dst indexes), but stored with
//                a stable (src, dst) ordering by id ascending so
//                UPSERT-on-co-occurrence stays deterministic.
//
// ADD-ONLY: pure CREATE TABLE / CREATE INDEX. No drops, no FTS5 touch.
// Migration 003 left compute db at user_version=3 with tier_semantic on
// raw + compiled; this migration is layered on top with no backfill.
//
// Crash safety: BEGIN IMMEDIATE wrap by the migration runner. If any
// statement fails, ROLLBACK leaves user_version at 3.

export const VERSION = 4;
export const DESCRIPTION = 'symbol-graph kg_nodes + kg_edges (D2 regex extractor)';

export function up(db) {
  // --- kg_nodes ----------------------------------------------------------
  // Composite UNIQUE on (kind, name) so the entity extractor's "find or
  // create" path can use INSERT OR IGNORE + SELECT id by (kind, name).
  // first_seen / last_seen are observation timestamps so D4 cascading
  // staleness can compute recency_decay without a separate ledger join.
  // redacted is a boolean (0/1) -- redactor.classify() result is captured
  // here per D-PILLAR-SPEC section 3.
  runDdl(db, `
    CREATE TABLE IF NOT EXISTS kg_nodes (
      id          INTEGER PRIMARY KEY,
      kind        TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      redacted    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(kind, name)
    )
  `);
  runDdl(db, `CREATE INDEX IF NOT EXISTS kg_nodes_kind_name_idx ON kg_nodes(kind, name)`);
  runDdl(db, `CREATE INDEX IF NOT EXISTS kg_nodes_last_seen_idx ON kg_nodes(last_seen)`);

  // --- kg_edges ----------------------------------------------------------
  // src + dst are kg_nodes.id values. kind is the edge label
  // (co_occurs in alpha; D4 will introduce supersedes/implements/references).
  // weight is the section 2 formula output (clamp_01). co_occurrence_count
  // is the raw counter the formula's log1p term reads from.
  // ts is the most-recent co-occurrence ts, used for recency_decay refresh.
  // PRIMARY KEY (src, dst, kind) gives UPSERT-on-co-occurrence semantics
  // without a separate UNIQUE index.
  runDdl(db, `
    CREATE TABLE IF NOT EXISTS kg_edges (
      src                  INTEGER NOT NULL,
      dst                  INTEGER NOT NULL,
      kind                 TEXT    NOT NULL,
      weight               REAL    NOT NULL DEFAULT 0,
      co_occurrence_count  INTEGER NOT NULL DEFAULT 0,
      ts                   INTEGER NOT NULL,
      PRIMARY KEY (src, dst, kind),
      FOREIGN KEY (src) REFERENCES kg_nodes(id),
      FOREIGN KEY (dst) REFERENCES kg_nodes(id)
    )
  `);
  runDdl(db, `CREATE INDEX IF NOT EXISTS kg_edges_src_kind_idx ON kg_edges(src, kind)`);
  runDdl(db, `CREATE INDEX IF NOT EXISTS kg_edges_dst_kind_idx ON kg_edges(dst, kind)`);
  runDdl(db, `CREATE INDEX IF NOT EXISTS kg_edges_weight_idx   ON kg_edges(weight)`);
}

function runDdl(db, sql) {
  return db.exec(sql);
}

export default { version: VERSION, description: DESCRIPTION, up };
