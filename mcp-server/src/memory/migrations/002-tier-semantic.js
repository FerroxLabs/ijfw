// IJFW v1.3.0 -- memory migration 002: 4-tier semantic axis (D1).
//
// Source authority: PRD-v2 section 9 Pillar D D1 + .planning/1.3.0/D-PILLAR-SPEC.md section 1
// (tier promotion rules).
//
// Adds `tier_semantic` column ORTHOGONAL to existing tier_access (hot/warm/cold
// in the storage layer). Two axes, both queryable:
//   - tier_access    : hot=md files / warm=this FTS5 db / cold=vectors (deferred)
//   - tier_semantic  : working / episodic / semantic / procedural
//
// ADD-ONLY semantics. Default 'working' protects every legacy row -- existing
// memory_entries pre-D1 are by definition session-bound observations, which is
// the exact definition of Working in D-PILLAR-SPEC section 1. Promotion to other
// tiers happens via tier-promotion.js (separate module, not this migration).
//
// CREATE INDEX on (tier_semantic, created_at) so the search filter
// `WHERE tier_semantic = ? ORDER BY created_at DESC` is index-served at
// any scale.
//
// Crash safety: migration runner wraps the whole up() in BEGIN IMMEDIATE.
// If ALTER TABLE or CREATE INDEX fails the txn rolls back and user_version
// stays at 1.

export const VERSION = 2;
export const DESCRIPTION = 'memory v1.3.0 -- tier_semantic axis (working/episodic/semantic/procedural)';

export function up(db) {
  // ALTER TABLE ADD COLUMN with a TEXT DEFAULT is constant-time in SQLite
  // (writes the default into the schema, not into existing rows). Legacy
  // rows on read return 'working'. Composite index supports tier-filtered
  // scans without a table rewrite.
  if (!hasColumn(db, 'memory_entries', 'tier_semantic')) {
    runDdl(db, `ALTER TABLE memory_entries ADD COLUMN tier_semantic TEXT DEFAULT 'working'`);
  }

  // Composite index (tier_semantic, created_at) supports the canonical
  // tier-filtered scan: pick a tier, sort by recency. SQLite uses the
  // index for both the equality filter and the ORDER BY.
  runDdl(db,
    `CREATE INDEX IF NOT EXISTS memory_entries_tier_semantic_idx ` +
    `ON memory_entries(tier_semantic, created_at)`
  );
}

// runDdl -- thin wrapper so the migration reads with a single verb that
// mirrors compute/migrations/002. Runs multi-statement DDL inside the
// migration runner's BEGIN IMMEDIATE transaction.
function runDdl(db, sql) {
  return db.exec(sql);
}

// hasColumn -- defensive check so an out-of-band re-application doesn't
// trip ADD COLUMN's "duplicate column" error. Mirrors the helper in
// compute/migrations/002-porter-stemming-source.js.
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => String(r.name) === column);
}

export default { version: VERSION, description: DESCRIPTION, up };
