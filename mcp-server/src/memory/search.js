/**
 * Memory search -- D-Pillar / D0 (IJFW v1.3.0).
 *
 * Tiered pipeline:
 *   Hot   -- linear regex over markdown files (always available; the existing
 *            v1.2 path). Used both as the source for FTS5 auto-index and as
 *            the graceful-degradation fallback when FTS5 is unavailable or
 *            returns no hits.
 *   Warm  -- FTS5 over <repoRoot>/.ijfw/index/memory.db (porter unicode61).
 *            Auto-indexes from the file list when the index is empty.
 *            Synonym expansion via shared compute/synonyms.js so coding
 *            shorthand ("db" -> "database", "auth" -> "authentication") fires
 *            the same way as on the compute tier.
 *
 * Public surface preserved: searchMemory(q, files, limit) -> Array<result>
 * (synchronous) so the dashboard /api/memory/search handler keeps working
 * with no caller-side change. We achieve this by lazily resolving the
 * better-sqlite3 driver via a top-level await at module load and using its
 * synchronous open() inside searchMemory.
 *
 * Result-array decorations (non-enumerable):
 *   - synonym_matches  -- { token: [expansions] } when expansion fired
 *   - tier             -- 'warm-fts5' | 'hot-linear' | 'hot-linear-empty-fts5'
 * Legacy callers see no shape change because Object.keys() on an array
 * yields only the indices.
 *
 * Zero new deps. better-sqlite3 already ships from Phase 1.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, normalize, isAbsolute } from 'node:path';

import { expandQuery } from '../compute/synonyms.js';

const MAX_RESULTS  = 50;
const SNIPPET_HALF = 60;
const DB_FILENAME = 'memory.db';
const INDEX_DIR_NAME = 'index';
const IJFW_DIR_NAME = '.ijfw';

// --- Driver bootstrap (top-level await; resolves once at module load) -----

let DRIVER = null;
try {
  const mod = await import('better-sqlite3');
  const Database = mod.default || mod;
  DRIVER = { kind: 'better-sqlite3', Database };
} catch {
  DRIVER = null;
}

// Resolve migration modules synchronously at module load via top-level
// await. Replayed inside searchMemory's sync path. Keep in lockstep with
// ./migrations/.
const MEMORY_MIGRATIONS = await loadMemoryMigrationsSync();

async function loadMemoryMigrationsSync() {
  const v1 = await import('./migrations/001-fts5-init.js');
  const v2 = await import('./migrations/002-tier-semantic.js');
  const v3 = await import('./migrations/003-stale-candidate.js');
  return [
    { version: v1.VERSION, description: v1.DESCRIPTION, up: v1.up },
    { version: v2.VERSION, description: v2.DESCRIPTION, up: v2.up },
    { version: v3.VERSION, description: v3.DESCRIPTION, up: v3.up },
  ].sort((a, b) => a.version - b.version);
}

function highestMigrationVersion() {
  if (!MEMORY_MIGRATIONS.length) return 0;
  return MEMORY_MIGRATIONS[MEMORY_MIGRATIONS.length - 1].version;
}

// --- Snippet helper ---------------------------------------------------------

function snippet(body, pattern) {
  const idx = body.search(pattern);
  if (idx === -1) return body.slice(0, 120).trim();
  const start = Math.max(0, idx - SNIPPET_HALF);
  const end   = Math.min(body.length, idx + SNIPPET_HALF + pattern.source.length);
  let s = body.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0)             s = '...' + s;
  if (end < body.length)     s = s + '...';
  return s;
}

// --- Hot tier (legacy linear regex; preserved for fallback) -----------------

function searchLinear(q, files, limit) {
  if (!q || !q.trim() || !files.length) return [];

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern;
  try {
    pattern = new RegExp(escaped, 'gi');
  } catch {
    return [];
  }

  const results = [];

  for (const f of files) {
    let body = '';
    try {
      body = existsSync(f.path) ? readFileSync(f.path, 'utf8') : '';
    } catch { /* skip */ }

    const titleMatches = (f.title.match(pattern) || []).length;
    const bodyMatches  = (body.match(pattern) || []).length;
    const total        = titleMatches + bodyMatches;
    if (total === 0) continue;

    pattern.lastIndex = 0;
    const score = titleMatches * 3 + bodyMatches;

    results.push({
      path:     f.path,
      relpath:  f.relpath,
      title:    f.title,
      snippet:  snippet(body, pattern),
      score,
    });

    pattern.lastIndex = 0;
    if (results.length >= limit * 2) break;
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --- Warm tier (FTS5; synchronous via cached driver) ------------------------

function resolveProjectRoot(raw) {
  const v = raw || process.env.IJFW_PROJECT_DIR || process.cwd();
  if (typeof v !== 'string' || !v) return null;
  const abs = resolve(v);
  const norm = normalize(abs);
  if (!isAbsolute(norm)) return null;
  return norm;
}

function dbPathFor(root) {
  return join(root, IJFW_DIR_NAME, INDEX_DIR_NAME, DB_FILENAME);
}

function resolveIndexRoot(files) {
  if (process.env.IJFW_PROJECT_DIR) return resolveProjectRoot(process.env.IJFW_PROJECT_DIR);
  if (files && files.length > 0) {
    for (const f of files) {
      if (typeof f.path !== 'string') continue;
      // Match both POSIX and Windows path separators around .ijfw segment.
      const m = f.path.match(/[\\/]\.ijfw[\\/]/);
      if (m) return f.path.slice(0, m.index);
    }
  }
  return resolveProjectRoot(process.cwd());
}

function openMemoryDbSync(root) {
  if (!DRIVER) return null;
  if (!root) return null;

  const filename = dbPathFor(root);
  try {
    const dir = dirname(filename);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new DRIVER.Database(filename);
    db.__ijfw_filename = filename;

    try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* default fine */ }
    try { db.exec('PRAGMA synchronous = NORMAL'); } catch { /* default fine */ }
    try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* default fine */ }

    return db;
  } catch {
    return null;
  }
}

function readUserVersion(db) {
  try {
    const row = db.prepare('PRAGMA user_version').get();
    if (!row) return 0;
    return Number(row.user_version ?? row.USER_VERSION ?? 0);
  } catch {
    return 0;
  }
}

function runMemoryMigrationsSync(db, currentVersion, targetVersion) {
  if (currentVersion >= targetVersion) return currentVersion;
  for (const m of MEMORY_MIGRATIONS) {
    if (m.version <= currentVersion || m.version > targetVersion) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO schema_meta(version, applied_at, description) VALUES (?, ?, ?)'
      );
      stmt.run(m.version, Date.now(), m.description);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }
  return targetVersion;
}

function autoIndex(db, files) {
  let n = 0;
  const txfn = db.transaction((batch) => {
    const stmt = db.prepare(
      'INSERT INTO memory_entries (body, source, session_id, created_at) VALUES (?, ?, ?, ?)'
    );
    for (const item of batch) {
      stmt.run(item.body, item.source, null, item.created_at);
      n++;
    }
  });

  const batch = [];
  const now = Date.now();
  for (const f of files) {
    if (typeof f.path !== 'string') continue;
    if (!existsSync(f.path)) continue;
    let body;
    try { body = readFileSync(f.path, 'utf8'); } catch { continue; }
    if (!body) continue;
    batch.push({ body, source: f.relpath || f.path, created_at: now });
  }
  if (batch.length === 0) return 0;
  try { txfn.immediate(batch); } catch { /* one bad batch should not abort the search */ }
  return n;
}

// FTS5 search joined to the content table. When tier_semantic is provided,
// the join filters rows by the D1 axis (working/episodic/semantic/
// procedural/procedural_candidate). When undefined, all tiers return --
// preserves the pre-D1 default. tier_semantic is a defensive enum check
// inside this module; the SQL itself uses parameter binding so the value
// can never form an injection vector.
const VALID_TIER_SEMANTIC = new Set([
  'working', 'episodic', 'semantic', 'procedural', 'procedural_candidate',
]);

function searchFts5(db, query, k, tier_semantic, include_stale) {
  const limit = Math.min(Math.max(1, parseInt(k, 10) || 10), 1000);
  const tierFilter = tier_semantic && VALID_TIER_SEMANTIC.has(tier_semantic);
  // D4 GA-B2 retrieval guard: exclude rows with stale_candidate >= 1 by
  // default; opt-in via include_stale=true (mirrors compute/fts5.js search).
  // Pre-v3 dbs (no stale_candidate column) silently drop the WHERE filter
  // so older callers and fixture dbs keep working.
  const hasStaleCol = hasMemoryStaleColumn(db);
  const staleClause = (!include_stale && hasStaleCol)
    ? ' AND COALESCE(t.stale_candidate, 0) = 0'
    : '';
  const sql = `
    SELECT t.id, t.body, t.source, t.session_id, t.created_at, t.tier_semantic,
           bm25(memory_entries_fts) AS rank
      FROM memory_entries_fts f
      JOIN memory_entries t ON t.id = f.rowid
     WHERE memory_entries_fts MATCH ?
       ${tierFilter ? 'AND t.tier_semantic = ?' : ''}${staleClause}
     ORDER BY rank ASC
     LIMIT ?`;
  return tierFilter
    ? db.prepare(sql).all(query, tier_semantic, limit)
    : db.prepare(sql).all(query, limit);
}

// Cache PRAGMA table_info lookups per-db so repeated search() calls don't
// re-scan the schema. WeakMap keyed on the db handle gives us automatic
// cleanup when the db is closed.
const __memoryColumnCache = new WeakMap();
function hasMemoryStaleColumn(db) {
  let perDb = __memoryColumnCache.get(db);
  if (!perDb) {
    perDb = new Map();
    __memoryColumnCache.set(db, perDb);
  }
  if (perDb.has('stale_candidate')) return perDb.get('stale_candidate');
  let present = false;
  try {
    const rows = db.prepare(`PRAGMA table_info(memory_entries)`).all();
    present = rows.some(r => String(r.name) === 'stale_candidate');
  } catch { /* missing table -> treat column as absent */ }
  perDb.set('stale_candidate', present);
  return present;
}

function ftsRowToResult(row, fileBySource) {
  const src = row.source || '';
  const meta = fileBySource.get(src) || null;
  const path = (meta && meta.path) || src;
  const relpath = (meta && meta.relpath) || src;
  const title = (meta && meta.title) || src.split('/').pop() || src;
  const score = 100 - Number(row.rank || 0);
  const text = String(row.body || '');
  const snip = text.slice(0, 200).replace(/\s+/g, ' ').trim();
  // tier_semantic surfaced per result so callers building tier-aware
  // dashboards / consolidation views can read it without a separate
  // lookup. Pre-D1 rows return 'working' from the column DEFAULT.
  const tier_semantic = row.tier_semantic || 'working';
  return { path, relpath, title, snippet: snip, score, tier_semantic };
}

function rowCount(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get();
    return row ? Number(row.n) : 0;
  } catch {
    return 0;
  }
}

// --- Public API -------------------------------------------------------------

/**
 * Search memory files for query string.
 *
 * Tries FTS5 (auto-indexes if empty) with synonym expansion, falls back to
 * linear regex on empty/miss/error. Stays synchronous to preserve the
 * existing public contract.
 *
 * D1 (tier_semantic) filter:
 *   The fourth argument may be either an `options` object or a tier string
 *   (legacy positional shorthand). Recognised:
 *     - { tier_semantic: 'working' | 'episodic' | 'semantic'
 *                       | 'procedural' | 'procedural_candidate' | undefined }
 *     - undefined (default) returns all tiers -- pre-D1 behaviour preserved.
 *   When the tier filter is set the warm-tier search restricts results;
 *   the hot-linear fallback is unfiltered (D1 does not yet write tier
 *   metadata into the markdown surface).
 *
 * @param {string} q
 * @param {Array<{path,relpath,title,preview}>} files
 * @param {number} limit
 * @param {object|undefined} options
 * @returns {Array<{path,relpath,title,snippet,score,tier_semantic}>}
 */
export function searchMemory(q, files, limit = MAX_RESULTS, options) {
  if (!q || !q.trim() || !files || files.length === 0) return [];

  // Normalise options. Allow undefined / { tier_semantic, include_stale } /
  // a bare string (treated as the tier_semantic value) for ergonomic call
  // sites. include_stale defaults to false -- D4 GA-B2 retrieval guard.
  let tier_semantic;
  let include_stale = false;
  if (typeof options === 'string') {
    tier_semantic = options;
  } else if (options && typeof options === 'object') {
    tier_semantic = options.tier_semantic;
    include_stale = options.include_stale === true;
  }

  const { expanded, synonym_matches, applied } = expandQuery(q);

  let warmHits = null;
  let warmEmpty = false;
  let db = null;

  try {
    const root = resolveIndexRoot(files);
    db = openMemoryDbSync(root);

    if (db) {
      const target = highestMigrationVersion();
      const current = readUserVersion(db);
      if (current < target) {
        runMemoryMigrationsSync(db, current, target);
      } else if (current > target) {
        // Newer schema -- refuse rather than downgrade. Legacy fallback.
        try { db.close(); } catch { /* ignore */ }
        db = null;
      }

      if (db) {
        if (rowCount(db) === 0 && files.length > 0) {
          autoIndex(db, files);
        }
        const ftsQuery = applied ? expanded : q;
        let rows;
        try {
          rows = searchFts5(db, ftsQuery, limit, tier_semantic, include_stale);
        } catch {
          try { rows = searchFts5(db, q, limit, tier_semantic, include_stale); } catch { rows = []; }
        }
        if (rows.length > 0) {
          const fileBySource = new Map();
          for (const f of files) {
            if (f.relpath) fileBySource.set(f.relpath, f);
            if (f.path) fileBySource.set(f.path, f);
          }
          warmHits = rows.map(r => ftsRowToResult(r, fileBySource));
        } else {
          warmEmpty = true;
        }
      }
    }
  } catch {
    warmHits = null;
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }

  let results;
  if (warmHits && warmHits.length > 0) {
    results = warmHits.slice(0, limit);
  } else if (tier_semantic) {
    // Tier filter active and warm tier has no matches -- the hot-linear
    // tier doesn't carry tier metadata so it can't honour the filter.
    // Returning [] here keeps the contract honest ("only matching tier").
    results = [];
  } else {
    results = searchLinear(q, files, limit);
  }

  Object.defineProperty(results, 'synonym_matches', {
    value: applied ? synonym_matches : {},
    enumerable: false,
  });
  Object.defineProperty(results, 'tier', {
    value: warmHits && warmHits.length > 0
      ? 'warm-fts5'
      : (warmEmpty ? 'hot-linear-empty-fts5' : 'hot-linear'),
    enumerable: false,
  });
  return results;
}
