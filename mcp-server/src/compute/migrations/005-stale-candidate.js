// IJFW v1.3.0 -- compute migration 005: D4 cascading staleness column.
//
// Source authority: PRD-v2 section 9 Pillar D D4 + .planning/1.3.0/D-PILLAR-SPEC.md
// section 2 (cascading staleness propagation threshold) + section 7 (50-fixture
// grader for D4 cascading staleness).
//
// Bumps compute schema 4 -> 5. Adds the `stale_candidate` column to BOTH
// content tables (`raw` + `compiled`) so D4's BFS-from-superseded-node
// propagation can flag related observations without touching retrieval
// until the grader proves >85% precision.
//
// Column semantics:
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
//   raw_stale_candidate_idx       -- partial index on stale_candidate > 0
//                                    so the search() WHERE filter is fast
//                                    on the common case (most rows fresh).
//   compiled_stale_candidate_idx  -- same pattern on the compiled tier.
//
// ADD-ONLY: no column drops, no FTS5 touch. The FTS5 index is content-
// table backed and indexes only `body` / `topic+body`, so adding a
// non-FTS column doesn't touch the FTS5 schema.
//
// Crash safety: BEGIN IMMEDIATE wrap by the migration runner. If any
// statement fails, ROLLBACK leaves user_version at 4.

export const VERSION = 5;
export const DESCRIPTION = 'stale_candidate column on raw + compiled (D4 cascading staleness)';

export function up(db) {
  // --- raw.stale_candidate ----------------------------------------------
  if (!hasColumn(db, 'raw', 'stale_candidate')) {
    runDdl(db, `ALTER TABLE raw ADD COLUMN stale_candidate INTEGER DEFAULT 0`);
  }
  runDdl(db,
    `CREATE INDEX IF NOT EXISTS raw_stale_candidate_idx ` +
    `ON raw(stale_candidate) WHERE stale_candidate > 0`
  );

  // --- compiled.stale_candidate -----------------------------------------
  if (!hasColumn(db, 'compiled', 'stale_candidate')) {
    runDdl(db, `ALTER TABLE compiled ADD COLUMN stale_candidate INTEGER DEFAULT 0`);
  }
  runDdl(db,
    `CREATE INDEX IF NOT EXISTS compiled_stale_candidate_idx ` +
    `ON compiled(stale_candidate) WHERE stale_candidate > 0`
  );
}

// runDdl -- thin wrapper that runs multi-statement DDL via the sqlite
// driver's `.exec` method (better-sqlite3 + node:sqlite both expose it).
// Mirrors the helper in compute/migrations/003. Not a child_process call.
function runDdl(db, sql) {
  return db.exec(sql);
}

// hasColumn -- defence against re-application; mirrors the helper in 003.
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => String(r.name) === column);
}

export default { version: VERSION, description: DESCRIPTION, up };
