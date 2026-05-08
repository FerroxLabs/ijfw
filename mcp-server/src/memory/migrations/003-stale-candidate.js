// IJFW v1.3.0 -- memory migration 003: stale_candidate guard column (D4 wiring).
//
// Source authority: PRD-v2 section 9 Pillar D D4 + .planning/1.3.0/D-PILLAR-SPEC.md
// section 2 (cascading staleness propagation) + GA fix-wave finding GA-B2.
//
// Adds the `stale_candidate` column to memory_entries so the D4 cascading
// staleness propagation can flag entries whose semantic neighbourhood has
// been superseded. Memory-side search filters stale rows by default,
// mirroring the compute-side filter that landed in compute migration 005.
//
// Column semantics (identical to compute migration 005):
//   stale_candidate INTEGER DEFAULT 0
//     0 = fresh (default; never set by D4)
//     1 = flagged by cascading staleness BFS (excluded from search by
//         default; surface only with include_stale=true override)
//     2 = confirmed stale (reserved for 1.4.0 contradiction-detection;
//         alpha never writes this value)
//
// Defaults to 0 on every existing row -- ADD-ONLY column with explicit
// DEFAULT clause so the migration is backfill-free.
//
// Indexes:
//   memory_entries_stale_candidate_idx -- partial index on stale_candidate > 0
//                                          so the search() WHERE filter is
//                                          fast on the common case (most
//                                          rows fresh).
//
// ADD-ONLY: no column drops, no FTS5 touch. The FTS5 mirror is content-
// table backed and indexes only `body`, so adding a non-FTS column never
// touches the FTS5 schema.
//
// Crash safety: BEGIN IMMEDIATE wrap by the migration runner. If any
// statement fails, ROLLBACK leaves user_version at 2.

export const VERSION = 3;
export const DESCRIPTION = 'memory v1.3.0 -- stale_candidate guard column (D4 retrieval suppression)';

export function up(db) {
  if (!hasColumn(db, 'memory_entries', 'stale_candidate')) {
    runDdl(db, `ALTER TABLE memory_entries ADD COLUMN stale_candidate INTEGER DEFAULT 0`);
  }
  runDdl(db,
    `CREATE INDEX IF NOT EXISTS memory_entries_stale_candidate_idx ` +
    `ON memory_entries(stale_candidate) WHERE stale_candidate > 0`
  );
}

// runDdl -- thin wrapper that runs multi-statement DDL via the sqlite
// driver's .exec method. Mirrors helpers in earlier migrations.
function runDdl(db, sql) {
  return db.exec(sql);
}

// hasColumn -- defence against re-application; mirrors helper from 002.
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => String(r.name) === column);
}

export default { version: VERSION, description: DESCRIPTION, up };
