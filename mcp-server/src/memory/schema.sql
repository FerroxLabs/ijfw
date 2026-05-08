-- IJFW v1.3.0 -- D-Pillar / D0 memory FTS5 schema.
-- Source of truth: .planning/1.3.0/D-PILLAR-SPEC.md (D0)
--
-- Memory tier of the dual-tier index. Compute tier already ships its own
-- FTS5 schema in ../compute/schema.sql (V3-B4). This is the parallel
-- structure for the warm tier of the memory pipeline:
--
--   Hot   -- markdown files on disk (existing readers/walkers, unchanged)
--   Warm  -- this FTS5 index (rebuilt-on-demand from the hot tier)
--   Cold  -- optional vector layer (deferred, future milestone)
--
-- Tokenizer: porter unicode61. Same as compute/schema.sql v2 -- morphological
-- variants ("authenticate"/"authenticating"/"running") collapse to a shared
-- stem so memory recall isn't brittle to verb form. Porter does NOT handle
-- irregular verbs ("ran" stays "ran"); documented limitation.
--
-- Schema is ADD-ONLY. user_version starts at 1 (this file = migration 001).

PRAGMA user_version = 1;

-- Content table: indexed memory entries.
--   id           -- autoinc primary key
--   body         -- the indexed text (full markdown body or excerpt)
--   source       -- provenance pointer: file path, "session:N", "tier:auto",
--                   etc. Nullable for free-form inserts.
--   session_id   -- caller's session correlation id. Nullable; populated when
--                   indexEntry is called from a session-aware path.
--   created_at   -- unix ms; set by indexEntry when row is written.
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  source TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_entries_source_idx
  ON memory_entries(source) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_entries_session_idx
  ON memory_entries(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_entries_created_idx
  ON memory_entries(created_at);

-- FTS5 mirror over the body column. External-content table so the FTS5
-- index stays a thin view over memory_entries; updates flow through the
-- AI/AD/AU triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
  body,
  content='memory_entries',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- External-content sync triggers (FTS5 standard pattern).
CREATE TRIGGER IF NOT EXISTS memory_entries_ai
  AFTER INSERT ON memory_entries BEGIN
    INSERT INTO memory_entries_fts(rowid, body) VALUES (new.id, new.body);
  END;
CREATE TRIGGER IF NOT EXISTS memory_entries_ad
  AFTER DELETE ON memory_entries BEGIN
    INSERT INTO memory_entries_fts(memory_entries_fts, rowid, body)
      VALUES('delete', old.id, old.body);
  END;
CREATE TRIGGER IF NOT EXISTS memory_entries_au
  AFTER UPDATE ON memory_entries BEGIN
    INSERT INTO memory_entries_fts(memory_entries_fts, rowid, body)
      VALUES('delete', old.id, old.body);
    INSERT INTO memory_entries_fts(rowid, body) VALUES (new.id, new.body);
  END;

-- Schema version table -- mirrors compute/schema.sql shape so a future
-- merger of the two dbs (if ever attempted) lines up.
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
INSERT OR IGNORE INTO schema_meta(version, applied_at, description)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000,
          'memory v1.3.0 -- memory_entries + memory_entries_fts (porter unicode61)');
