// IJFW v1.5.0 -- memory migration 008: write-origin provenance.
//
// Adds `origin` column to memory_entries (Hermes BACKGROUND_REVIEW pattern,
// see tools/skill_provenance.py in Hermes — the operator's sibling project).
// Default 'foreground' so existing rows are treated as user-owned.
//
// Origin values established by v1.5.0 memory-moat:
//   'foreground'   user-originated handleStore call (default)
//   'auto-linker'  A-Mem auto-linker write-time evolution
//   'dream-cycle'  background consolidation / promotion writes
//
// Future curators (v1.6+) should only auto-modify rows whose origin is
// in {'auto-linker', 'dream-cycle'} to preserve the operator-owned
// 'foreground' tier.

export const VERSION = 8;
export const DESCRIPTION =
  'memory v1.5.0 -- write-origin provenance column on memory_entries';

export function up(db) {
  // ALTER TABLE ADD COLUMN is idempotent-by-guard since SQLite has no
  // "IF NOT EXISTS" clause for ALTER. Check PRAGMA table_info first.
  const cols = db
    .prepare('PRAGMA table_info(memory_entries)')
    .all()
    .map((c) => c.name);
  if (!cols.includes('origin')) {
    const ALTER_SQL = (
      "ALTER TABLE memory_entries " +
      "ADD COLUMN origin TEXT DEFAULT 'foreground'"
    );
    db.prepare(ALTER_SQL).run();
  }
  const IDX_SQL = (
    'CREATE INDEX IF NOT EXISTS memory_entries_origin_idx ' +
    'ON memory_entries(origin)'
  );
  db.prepare(IDX_SQL).run();
}

export default { version: VERSION, description: DESCRIPTION, up };
