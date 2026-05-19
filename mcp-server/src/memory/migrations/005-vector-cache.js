// IJFW v1.5.0 -- memory migration 005: persistent embedding cache.
//
// Source authority: v1.5.0 audit MED #7 (memory-engine.md F-PRF-4). The
// cold-tier hybrid rerank in src/search-hybrid.js currently re-embeds every
// candidate snippet on every query. For a stable corpus this is wasted work:
// the same (memory_entry_id, model_id) pair always produces the same vector.
// This migration adds an `memory_entry_vectors` table so embedding can become
// a write-once-per-(entry, model) operation. Re-embed only fires for:
//   - newly inserted entries (no row in this table)
//   - changed embedding model (different model_id)
//
// The vector itself lives as a BLOB; vectors.js / search-hybrid.js are the
// natural read sites and convert Float32Array <-> Buffer at the seam. The
// schema is intentionally narrow so adding a future "ann_index_id" column
// in v1.6 stays a non-breaking ALTER.
//
// Indexes:
//   memory_entry_vectors_model_idx -- supports lookup by model_id during
//                                     model migrations (rare; ALTER-equiv).
//
// Crash safety: migration runner wraps up() in BEGIN IMMEDIATE; a partial
// CREATE rolls back to user_version=4.

export const VERSION = 5;
export const DESCRIPTION = 'memory v1.5.0 -- persistent embedding cache (memory_entry_vectors)';

const SQL_CREATE = (
  'CREATE TABLE IF NOT EXISTS memory_entry_vectors (' +
    'memory_id INTEGER NOT NULL,' +
    'model_id TEXT NOT NULL,' +
    'embedding BLOB NOT NULL,' +
    "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))," +
    'PRIMARY KEY (memory_id, model_id)' +
  ')'
);

const SQL_MODEL_IDX = (
  'CREATE INDEX IF NOT EXISTS memory_entry_vectors_model_idx ' +
  'ON memory_entry_vectors(model_id)'
);

export function up(db) {
  db.exec(SQL_CREATE);
  db.exec(SQL_MODEL_IDX);
}

export default { version: VERSION, description: DESCRIPTION, up };
