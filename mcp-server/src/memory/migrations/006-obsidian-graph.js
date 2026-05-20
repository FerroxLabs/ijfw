// IJFW v1.5.0 -- memory migration 006: Obsidian-grade graph indexing.
//
// Adds three tables that make IJFW's hot markdown semantically deeper than
// "Obsidian-readable": backlinks, hierarchical tags, and inline metadata.
//
//   memory_links  -- directed edges parsed from [[wikilink]] syntax.
//                   to_target is the link target as written, normalised
//                   to lowercase + dash-collapsed. Resolution happens at
//                   query time so unresolved targets do not break ingest.
//   memory_tags   -- nested tag mentions. #project/r17/audit splits into
//                   path + depth; queries can match prefix.
//   memory_meta   -- Dataview-style inline metadata: [key:: value].

export const VERSION = 6;
export const DESCRIPTION = 'obsidian-graph — memory_links, memory_tags, memory_meta tables';

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_links (
      from_id TEXT NOT NULL,
      to_target TEXT NOT NULL,
      line INTEGER,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (from_id, to_target, line)
    );
    CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links(to_target);

    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL,
      tag_path TEXT NOT NULL,
      depth INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (memory_id, tag_path)
    );
    CREATE INDEX IF NOT EXISTS memory_tags_path_idx ON memory_tags(tag_path);

    CREATE TABLE IF NOT EXISTS memory_meta (
      memory_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (memory_id, key, value)
    );
    CREATE INDEX IF NOT EXISTS memory_meta_key_idx ON memory_meta(key);
  `);
}
