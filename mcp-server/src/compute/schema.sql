-- IJFW v1.3.0 Alpha -- C9 Compute Lever / FTS5 schema
-- Source of truth: .planning/1.3.0/PLAN-alpha.md V3-B4
-- Companion ADR: .planning/1.3.0/ADR-alpha-schema-reservations.md
--
-- Reservations are intentional: blackboard-compatible columns on `raw`
-- (Pillar B forward-compat), `compiled` tier for C4 Karpathy compiled
-- memory (empty in alpha), `trident_run` for C1 KS-stat convergence-stop.
-- See ADR for migration triggers + risk assessment.
--
-- v2 additions (PRD section 9 Pillar C9.4 + C9.6):
--   - FTS5 tokenizer flipped to `porter unicode61` so morphological
--     variants ("authenticate"/"authenticating"/"running"/"ran") collapse
--     to a shared stem. Migration 002 recreates raw_fts + compiled_fts.
--   - `raw.source` column captures origin pointer (file path, observation
--     kind, skill name) so search hits cite where the row came from.
--     Nullable -- legacy rows + non-attributed inserts leave it NULL.
--   - C9.5 (synonym expansion) is query-time only; no schema change.

PRAGMA user_version = 2;

-- Raw findings: agent dumps via ijfw_run index:*
CREATE TABLE IF NOT EXISTS raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,           -- 'compute_output' | 'memory_dump' | 'tool_result' | 'audit_finding'
  source TEXT,                          -- C9.6: provenance pointer (file path / observation kind / skill name); nullable
  brief_id TEXT,                        -- nullable; populated when running under blackboard (Pillar B forward-compat)
  session_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  profile TEXT,                         -- Wayland profile when applicable
  event_type TEXT,                      -- 'output' | 'progress' | 'error' | 'halt'
  halt_status TEXT,                     -- 'GREEN' | 'YELLOW' | 'RED' | NULL
  raw_output_pointer TEXT,              -- path to on-disk full log
  body TEXT NOT NULL,                   -- the indexed content
  ts INTEGER NOT NULL,                  -- unix ms
  CHECK (halt_status IN ('GREEN','YELLOW','RED') OR halt_status IS NULL)
);
CREATE INDEX IF NOT EXISTS raw_session_idx ON raw(session_id, ts);
CREATE INDEX IF NOT EXISTS raw_brief_idx ON raw(brief_id) WHERE brief_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_kind_idx ON raw(source_kind);
CREATE INDEX IF NOT EXISTS raw_source_idx ON raw(source) WHERE source IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(
  body,
  content='raw',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- External-content sync triggers for raw_fts (SQLite FTS5 standard pattern)
CREATE TRIGGER IF NOT EXISTS raw_ai AFTER INSERT ON raw BEGIN
  INSERT INTO raw_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS raw_ad AFTER DELETE ON raw BEGIN
  INSERT INTO raw_fts(raw_fts, rowid, body) VALUES('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS raw_au AFTER UPDATE ON raw BEGIN
  INSERT INTO raw_fts(raw_fts, rowid, body) VALUES('delete', old.id, old.body);
  INSERT INTO raw_fts(rowid, body) VALUES (new.id, new.body);
END;

-- Compiled tier reserved for C4 Karpathy compiled memory (empty in alpha)
CREATE TABLE IF NOT EXISTS compiled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  source_raw_ids TEXT NOT NULL,        -- JSON array of raw.id values
  cross_links TEXT,                     -- JSON array of compiled.id values
  ts INTEGER NOT NULL,
  schema_v INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS compiled_topic_idx ON compiled(topic);
CREATE VIRTUAL TABLE IF NOT EXISTS compiled_fts USING fts5(
  topic,
  body,
  content='compiled',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- External-content sync triggers for compiled_fts
CREATE TRIGGER IF NOT EXISTS compiled_ai AFTER INSERT ON compiled BEGIN
  INSERT INTO compiled_fts(rowid, topic, body) VALUES (new.id, new.topic, new.body);
END;
CREATE TRIGGER IF NOT EXISTS compiled_ad AFTER DELETE ON compiled BEGIN
  INSERT INTO compiled_fts(compiled_fts, rowid, topic, body) VALUES('delete', old.id, old.topic, old.body);
END;
CREATE TRIGGER IF NOT EXISTS compiled_au AFTER UPDATE ON compiled BEGIN
  INSERT INTO compiled_fts(compiled_fts, rowid, topic, body) VALUES('delete', old.id, old.topic, old.body);
  INSERT INTO compiled_fts(rowid, topic, body) VALUES (new.id, new.topic, new.body);
END;

-- Trident run telemetry reserved for C1 KS-stat convergence-stop
CREATE TABLE IF NOT EXISTS trident_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL,               -- groups multi-lineage runs
  lineage TEXT NOT NULL,                -- 'openai' | 'google' | 'anthropic'
  cli_name TEXT NOT NULL,               -- 'codex' | 'gemini' | 'claude-code'
  cli_version TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  verdict TEXT NOT NULL,                -- 'PASS' | 'CONDITIONAL' | 'BLOCKER' | 'FAIL'
  divergence_score REAL,                -- KS-statistic; nullable in alpha (binary consensus)
  ts INTEGER NOT NULL,
  CHECK (lineage IN ('openai','google','anthropic'))
);
CREATE INDEX IF NOT EXISTS trident_audit_idx ON trident_run(audit_id);

-- Schema version table for migration runner
CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);
INSERT OR IGNORE INTO schema_meta(version, applied_at, description)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000, 'alpha v1.3.0');
INSERT OR IGNORE INTO schema_meta(version, applied_at, description)
  VALUES (2, CAST(strftime('%s','now') AS INTEGER) * 1000, 'alpha v1.3.0 -- porter stemming + source column');
