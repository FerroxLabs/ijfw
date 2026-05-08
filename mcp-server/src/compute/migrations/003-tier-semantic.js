// IJFW v1.3.0 -- compute migration 003: 4-tier semantic axis (D1).
//
// Source authority: PRD-v2 §9 Pillar D D1 + .planning/1.3.0/D-PILLAR-SPEC.md §1.
//
// Bumps compute schema 2 -> 3. Adds `tier_semantic` to BOTH content tables
// in the compute db so dream-cycle promotions (Episodic -> Semantic via
// supersession; Procedural candidate emit) can land on the compiled tier
// with the correct semantic label and query back through FTS5 by tier.
//
// Defaults differ by table on purpose:
//   - raw.tier_semantic       DEFAULT 'working'   (raw observations are
//                                                   session-bound by
//                                                   definition; Working tier)
//   - compiled.tier_semantic  DEFAULT 'semantic'  (per D-PILLAR-SPEC §1 the
//                                                   compiled table IS the
//                                                   natural Semantic tier;
//                                                   procedural_candidate /
//                                                   procedural / episodic
//                                                   write explicit values
//                                                   when needed)
//
// ADD-ONLY: no column drops, no FTS5 recreation -- the FTS5 index is
// content-table backed and indexes only `body` (raw) / `topic, body`
// (compiled), so adding a non-FTS column doesn't touch the FTS5 schema.
//
// Crash safety: BEGIN IMMEDIATE wrap by the migration runner. If any
// statement fails, ROLLBACK leaves user_version at 2.

export const VERSION = 3;
export const DESCRIPTION = 'tier_semantic axis on raw + compiled (working/episodic/semantic/procedural)';

export function up(db) {
  // --- raw.tier_semantic --------------------------------------------------
  if (!hasColumn(db, 'raw', 'tier_semantic')) {
    runDdl(db, `ALTER TABLE raw ADD COLUMN tier_semantic TEXT DEFAULT 'working'`);
  }
  runDdl(db,
    `CREATE INDEX IF NOT EXISTS raw_tier_semantic_idx ` +
    `ON raw(tier_semantic, ts)`
  );

  // --- compiled.tier_semantic --------------------------------------------
  // Compiled rows are the natural Semantic tier per D-PILLAR-SPEC §1.
  // Procedural candidate / procedural rows override the default at write
  // time. Episodic rows that get promoted to Semantic via supersession
  // also write into compiled with this default.
  if (!hasColumn(db, 'compiled', 'tier_semantic')) {
    runDdl(db, `ALTER TABLE compiled ADD COLUMN tier_semantic TEXT DEFAULT 'semantic'`);
  }
  runDdl(db,
    `CREATE INDEX IF NOT EXISTS compiled_tier_semantic_idx ` +
    `ON compiled(tier_semantic, ts)`
  );
}

// runDdl -- thin wrapper that runs multi-statement DDL via the sqlite
// driver's exec method (better-sqlite3 / node:sqlite both expose .exec).
// Mirrors the helper in compute/migrations/002. NOT child_process.exec.
function runDdl(db, sql) {
  return db.exec(sql);
}

// hasColumn -- defence against re-application; mirrors the helper in 002.
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => String(r.name) === column);
}

export default { version: VERSION, description: DESCRIPTION, up };
