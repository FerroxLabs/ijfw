// IJFW v1.5.0 -- memory migration 005: persistent embedding cache.
//
// Source authority: v1.5.0 audit MED #7 (memory-engine.md F-PRF-4). The
// cold-tier hybrid rerank in src/search-hybrid.js was re-embedding every
// candidate snippet on every query. For repeated queries over a stable
// corpus this is wasted work: the same (snippet_text, model_id) pair always
// produces the same vector. This migration adds a `memory_entry_vectors`
// table so embedding becomes a write-once-per-(content, model) operation.
//
// v1.5.0 wire-W1.C key change: PK is content-hash (sha256(snippet)) rather
// than memory_id. The hybrid rerank's input candidates do not carry a stable
// memory_entry id (the corpus is built per-query from heterogenous markdown
// + memory sources), so a content-hash PK is the only key that makes the
// cache actually wire into production. Migration 005 was new in v1.5.0 and
// never shipped under the memory_id schema, so the schema change is non-
// breaking -- no rows to migrate.
//
// Schema:
//   cache_key   TEXT NOT NULL    -- sha256(snippet) in hex, lowercase
//   model_id    TEXT NOT NULL    -- e.g. 'Xenova/all-MiniLM-L6-v2'
//   embedding   BLOB NOT NULL    -- Float32Array little-endian, 4B/float
//   created_at  TEXT NOT NULL    -- ISO 8601 UTC; defaults to "now"
//   PRIMARY KEY (cache_key, model_id)
//
// Indexes:
//   memory_entry_vectors_model_idx -- supports lookup by model_id during
//                                     model migrations (rare; ALTER-equiv).
//
// Crash safety: migration runner wraps up() in a transaction; a partial
// CREATE rolls back to user_version=4.

export const VERSION = 5;
export const DESCRIPTION = 'memory v1.5.0 -- persistent embedding cache (memory_entry_vectors, content-keyed)';

const SQL_CREATE = (
  'CREATE TABLE IF NOT EXISTS memory_entry_vectors (' +
    'cache_key TEXT NOT NULL,' +
    'model_id TEXT NOT NULL,' +
    'embedding BLOB NOT NULL,' +
    "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))," +
    'PRIMARY KEY (cache_key, model_id)' +
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
