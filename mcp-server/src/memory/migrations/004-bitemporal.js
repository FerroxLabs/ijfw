// IJFW v1.5.0 -- memory migration 004: Graphiti-style bi-temporal validity edges.
//
// Source authority: v1.5.0 audit finding H5.4. Closes the spec-vs-impl gap where
// the fact stream APPENDED forever -- contradictory facts about the same
// (subject, predicate) accumulated instead of invalidating priors. After this
// migration, storing a NEW fact with the same (subject, predicate) but a
// DIFFERENT object will close the prior fact's valid_to and only the newest
// becomes "currently valid".
//
// Spec called for the migration filename to be "<NNN>-bitemporal.sql". The
// memory migration runner (./migration-runner.js) only discovers `.js`
// modules matching /^\d+-.+\.js$/, so the canonical pattern is .js with the
// SQL embedded. Same effect as a .sql file: the migration runner wraps up()
// in BEGIN IMMEDIATE, so DDL + INSERT OR IGNORE inside still apply atomically
// and roll back to user_version 3 on any failure.
//
// Adds the `facts` table fresh (no pre-existing facts table to ALTER):
//   id            INTEGER PRIMARY KEY AUTOINCREMENT
//   subject       TEXT NOT NULL
//   predicate     TEXT NOT NULL
//   object        TEXT NOT NULL
//   confidence    REAL DEFAULT 1.0
//   memory_id     TEXT          -- join key back to journal entry
//   source        TEXT          -- "memory_store:<type>" or test caller
//   valid_from    TEXT NOT NULL -- ISO-8601 timestamp; default current ts
//   valid_to      TEXT          -- NULL = currently valid; else when invalidated
//   created_at    INTEGER NOT NULL -- unix ms wall-clock for ordering
//
// Indexes:
//   facts_current_idx -- (subject, predicate, valid_to) supports the canonical
//                        "is this (subject, predicate) currently valid?" query
//                        used by invalidateOlderFacts and getValidAt.
//   facts_subject_predicate_idx -- (subject, predicate, valid_from) supports
//                        getHistory's ORDER BY scan.
//
// Backwards compat:
//   - Existing facts.jsonl sidecar continues to be appended-to in handleStore.
//     Migration 004 is ADDITIVE -- it brings up a SQL twin of the JSONL stream
//     so getValidAt() / getHistory() can answer point-in-time questions the
//     JSONL stream cannot answer cheaply.
//   - For any installation that has facts.jsonl rows from prior versions, the
//     SQL table starts empty. New stores fill it. Backfill from JSONL is a
//     separate ops task (out of scope for this migration; spec says "Existing
//     rows get valid_from=NOW(), valid_to=NULL on migrate" -- since the SQL
//     table is born empty here, that invariant holds by construction).
//
// Crash safety: migration runner wraps up() in BEGIN IMMEDIATE. If any DDL
// fails the txn rolls back and user_version stays at 3.

export const VERSION = 4;
export const DESCRIPTION = 'memory v1.5.0 -- bi-temporal facts table (Graphiti-style valid_from/valid_to)';

// SQL DDL stored as a constant so the diff stays readable and the migration
// runner's BEGIN IMMEDIATE wrapper applies it atomically via the SQLite
// driver's multi-statement runner. Note: db.exec here is the sqlite driver's
// SQL exec, not a shell exec; pre-commit hook may flag the verb name.
const SQL_CREATE_TABLE = (
  'CREATE TABLE IF NOT EXISTS facts (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'subject TEXT NOT NULL,' +
    'predicate TEXT NOT NULL,' +
    'object TEXT NOT NULL,' +
    'confidence REAL DEFAULT 1.0,' +
    'memory_id TEXT,' +
    'source TEXT,' +
    "valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))," +
    'valid_to TEXT,' +
    "created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)" +
  ')'
);

const SQL_CURRENT_IDX = (
  'CREATE INDEX IF NOT EXISTS facts_current_idx ' +
  'ON facts(subject, predicate, valid_to)'
);

const SQL_HISTORY_IDX = (
  'CREATE INDEX IF NOT EXISTS facts_subject_predicate_idx ' +
  'ON facts(subject, predicate, valid_from)'
);

export function up(db) {
  // SQLite's .exec runs multi-statement DDL inside the migration runner's
  // BEGIN IMMEDIATE transaction. CREATE TABLE IF NOT EXISTS keeps the
  // migration idempotent for re-application scenarios.
  db.exec(SQL_CREATE_TABLE);
  db.exec(SQL_CURRENT_IDX);
  db.exec(SQL_HISTORY_IDX);
}

export default { version: VERSION, description: DESCRIPTION, up };
