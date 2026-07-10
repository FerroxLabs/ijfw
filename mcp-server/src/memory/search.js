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

import { vetProjectRoot } from '../lib/project-root-guard.js';
import { expandQuery } from '../compute/synonyms.js';
import { loadMigrations } from './migration-runner.js';
// v1.5.1 R4-H2 — auto-index rows must flow through indexEntry so the
// v1.5.0 memory-moat (M1 Obsidian indexing + M2 A-Mem auto-linking) fires
// for warm-tier rebuilds, not just the benchmark harness. obsidian-parser
// is imported directly so M1 runs synchronously inside the same txn batch.
import { indexObsidianRelations } from './obsidian-parser.js';
import { autoLink } from './auto-linker.js';
// Ingest scrub gate (D-PILLAR-SPEC section 12) -- the warm-tier rebuild
// reads raw markdown from disk, which is NOT guaranteed pre-scrubbed
// (hand-edited notes, hook-written files, imports never went through
// handleStore's redaction). autoIndex must apply the same redactSecrets
// pass as fts5.js#indexEntry or secrets land cleartext in memory.db.
import { redactSecrets } from '../redactor.js';

const MAX_RESULTS  = 50;
const SNIPPET_HALF = 60;
const DB_FILENAME = 'memory.db';
const INDEX_DIR_NAME = 'index';
const IJFW_DIR_NAME = '.ijfw';

// --- W1.3 (v1.6.0): natural-language OR-query construction ------------------
//
// FTS5 treats a space-separated MATCH as implicit AND -- every token must
// co-occur in one indexed entry. A real natural-language recall ("what
// database did we pick for the auth service") almost never has all its tokens
// in a single entry, so the implicit-AND query starves and retrieves nothing.
// expandQuery() only OR-groups *synonyms* ("(db OR database) AND user"); the
// inter-token relation stays AND. The fix (proven by the v1.6.0 bench harness)
// is to OR the salient terms: drop stopwords + sub-3-char tokens, dedup, fold
// each surviving token's synonym group in, and OR-join. Single-token and
// exact-phrase queries are unaffected (one quoted term / one OR-group).
const FTS_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'from',
  'who', 'what', 'when', 'where', 'which', 'whom', 'whose', 'why', 'how',
  'did', 'does', 'has', 'had', 'have', 'been', 'being', 'into', 'than',
  'same', 'both', 'also', 'about', 'between', 'their', 'they', 'them',
  'his', 'her', 'its', 'our', 'your', 'you', 'she', 'him',
]);

// Strip FTS5 special / column-separator chars to spaces, collapse whitespace.
// Keeps alphanumerics + underscore + spaces. (Mirrors the bench harness's
// sanitiser; inlined so the hot search path stays uncoupled from bench code.)
function sanitizeFtsQuery(q) {
  if (typeof q !== 'string') return '';
  return q.replace(/[^a-zA-Z0-9_\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Build an OR-of-salient-terms FTS5 query from a natural-language string.
// Each surviving token is folded through expandQuery so synonym groups still
// fire (e.g. "auth" -> "(auth OR authentication)"); non-expanding tokens are
// quoted as literals (safe against any residual FTS5 keyword). Returns '' when
// nothing salient survives, so the caller can fall back to the raw query.
function buildOrQuery(q) {
  const sanitized = sanitizeFtsQuery(q);
  if (!sanitized) return '';
  const seen = new Set();
  const groups = [];
  for (const tok of sanitized.split(/\s+/)) {
    const t = tok.toLowerCase();
    if (t.length < 3 || FTS_STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    const { expanded, applied } = expandQuery(tok);
    groups.push(applied ? expanded : `"${tok}"`);
  }
  return groups.join(' OR ');
}

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
// await. Replayed inside searchMemory's sync path.
//
// v1.5.1 W3.B: discovery is delegated to memory/migration-runner.js
// (readdirSync over ./migrations/) so a single source of truth governs
// which migrations search.js knows about. Prior to this, search.js
// carried its OWN hardcoded list -- the v1.5.0 INT.7 hotfix patched
// the symptom (006/007/008 missing); this kills the dual-registry bug
// class outright. Drop migration 009 into ./migrations/, and search.js
// will pick it up automatically.
const MEMORY_MIGRATIONS = await loadMigrations();

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
  // wayland#755 round 2: shared bundle gate before any .ijfw write root.
  const v = vetProjectRoot(raw);
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
  // v1.5.1 R4-H2 — capture the rowid of every inserted entry so the
  // memory-moat aux indexing (M1 Obsidian relations, M2 auto-link) can run
  // over the warm-tier rebuild, not just the benchmark harness. The bulk
  // INSERT stays in one transaction for FTS write performance; M1/M2 run
  // AFTER commit so a parse/link failure can never abort the rebuild.
  //
  // Rollback safety: ids are collected in a transaction-local array and
  // only published to `inserted` after txfn commits. If the batch rolls
  // back, the rowids it produced no longer exist (and AUTOINCREMENT will
  // reuse them), so running M1/M2 over them would attach links/tags/meta
  // to the WRONG future entries.
  const inserted = [];
  const txfn = db.transaction((batch) => {
    const stmt = db.prepare(
      'INSERT INTO memory_entries (body, source, session_id, created_at) VALUES (?, ?, ?, ?)'
    );
    const out = [];
    for (const item of batch) {
      const info = stmt.run(item.body, item.source, null, item.created_at);
      const id = info && info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null;
      out.push({ id, body: item.body });
    }
    return out;
  });

  // Same ingest scrub gate as fts5.js#indexEntry (IJFW_INGEST_SCRUB=0 is
  // the only escape hatch, local debugging only). Body AND source are
  // scrubbed so the FTS index and downstream M1/M2 only see safe text.
  const scrub = process.env.IJFW_INGEST_SCRUB !== '0';
  const batch = [];
  const now = Date.now();
  for (const f of files) {
    if (typeof f.path !== 'string') continue;
    if (!existsSync(f.path)) continue;
    let body;
    try { body = readFileSync(f.path, 'utf8'); } catch { continue; }
    if (!body) continue;
    const rawSource = f.relpath || f.path;
    batch.push({
      body: scrub ? redactSecrets(body) : body,
      source: scrub ? redactSecrets(String(rawSource)) : rawSource,
      created_at: now,
    });
  }
  if (batch.length === 0) return 0;
  let n = 0;
  try {
    const committed = txfn.immediate(batch);
    if (Array.isArray(committed)) {
      inserted.push(...committed);
      n = committed.length;
    }
  } catch { /* one bad batch should not abort the search; rollback discards ids */ }

  // v1.5.1 R4-H2 — M1: Obsidian wikilink/tag/meta indexing into
  // memory_links/_tags/_meta. Synchronous + idempotent (indexObsidianRelations
  // clears prior rows for the id before re-inserting). Best-effort: a missing
  // migration-006 schema or a parse failure must never break the search path.
  // M2: A-Mem auto-linking — fire-and-forget, env-gated (IJFW_AUTOLINK_OFF),
  // budget-capped (IJFW_AUTOLINK_BUDGET_USD); returns skipped cleanly when no
  // API key, so a bulk rebuild without credentials does no LLM work.
  for (const row of inserted) {
    if (row.id == null) continue;
    try {
      indexObsidianRelations(db, String(row.id), row.body);
    } catch { /* M1 best-effort -- never abort the search */ }
    try {
      const p = autoLink(db, { id: row.id, body: row.body });
      if (p && typeof p.catch === 'function') p.catch(() => {});
      // expose for tests that want deterministic completion
      autoIndex.__lastAutoLinkPromise = p;
    } catch { /* M2 dispatch best-effort */ }
  }
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

// --- Structured provenance helpers -----------------------------------------

/**
 * Convert a raw FTS row + fileBySource map to a structured provenance object.
 * Used when opts.format === 'structured'.
 *
 * Fields that aren't computed in the existing pipeline are returned as
 * null / 0 rather than introducing new compute work (Task 28 spec).
 *
 * @param {object} row  - raw DB row from searchFts5
 * @param {Map}    fileBySource
 * @param {string} rawQuery  - original user query (for whyMatched extraction)
 * @param {object} db        - open DB handle (for backlink count query)
 * @returns {object}
 */
function ftsRowToStructured(row, fileBySource, rawQuery, db) {
  const src = row.source || '';
  const meta = fileBySource.get(src) || null;
  const source = (meta && meta.path) || src;
  const text = String(row.body || '');
  const snip = text.slice(0, 200).replace(/\s+/g, ' ').trim();

  // confidence: bm25 rank is negative (more negative = better). Convert to 0..1.
  // rank returned from searchFts5 can be 0 or negative; we use the same
  // score formula as ftsRowToResult (100 - rank) but normalise to 0..1 by
  // clamping to [0, 100] and dividing.
  const rawRank = Number(row.rank || 0);
  const scoreRaw = 100 - rawRank;         // same as ftsRowToResult
  const confidence = Math.min(1, Math.max(0, scoreRaw / 100));

  // ageDays: created_at is unix ms
  const createdAt = Number(row.created_at || 0);
  const ageDays = createdAt > 0
    ? Math.max(0, (Date.now() - createdAt) / 86400000)
    : 0;

  // decayFactor: not yet computed in pipeline — return null per spec
  const decayFactor = null;

  // whyMatched: tokenise the raw query into distinct non-trivial terms
  const whyMatched = rawQuery
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/['"*()]/g, '').toLowerCase())
    .filter(t => t.length > 0);

  // backlinkCount: count rows in memory_links where to_target matches source
  let backlinkCount = 0;
  if (db && row.id != null) {
    try {
      const idStr = String(row.id);
      const r = db.prepare(
        'SELECT COUNT(*) AS n FROM memory_links WHERE to_target = ?'
      ).get(idStr);
      backlinkCount = r ? Number(r.n) : 0;
    } catch { /* memory_links may not exist in older dbs */ }
  }

  return {
    source,
    anchor: null,
    snippet: snip,
    confidence,
    ageDays,
    decayFactor,
    whyMatched,
    backlinkCount,
  };
}

/**
 * Convert a hot-linear result to a structured provenance object.
 * Linear results lack a DB row id so backlinkCount is always 0.
 *
 * @param {object} result  - from searchLinear
 * @param {string} rawQuery
 * @returns {object}
 */
function linearResultToStructured(result, rawQuery) {
  const scoreRaw = Number(result.score || 0);
  // Hot-linear score is titleMatches*3 + bodyMatches; normalise loosely to 0..1
  // by capping at 50 matches (arbitrary but safe)
  const confidence = Math.min(1, scoreRaw / 50);

  const whyMatched = rawQuery
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/['"*()]/g, '').toLowerCase())
    .filter(t => t.length > 0);

  return {
    source: result.path || result.relpath || '',
    anchor: null,
    snippet: result.snippet || '',
    confidence,
    ageDays: 0,
    decayFactor: null,
    whyMatched,
    backlinkCount: 0,
  };
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
 * format option (Task 28 — structured provenance):
 *   opts.format === 'structured' returns an Array of provenance objects:
 *     [{source, anchor, snippet, confidence, ageDays, decayFactor,
 *       whyMatched, backlinkCount}]
 *   Default (no format) returns Array<{path,relpath,title,snippet,score,
 *   tier_semantic}> — byte-identical to pre-Task-28 behaviour.
 *
 * @param {string} q
 * @param {Array<{path,relpath,title,preview}>} files
 * @param {number} limit
 * @param {object|undefined} options
 * @returns {Array<{path,relpath,title,snippet,score,tier_semantic}>|Array<provenance>}
 */
export function searchMemory(q, files, limit = MAX_RESULTS, options) {
  if (!q || !q.trim() || !files || files.length === 0) return [];

  // Normalise options. Allow undefined / { tier_semantic, include_stale,
  // format } / a bare string (treated as the tier_semantic value) for
  // ergonomic call sites. include_stale defaults to false -- D4 GA-B2
  // retrieval guard. format === 'structured' enables Task-28 provenance.
  let tier_semantic;
  let include_stale = false;
  let format;
  if (typeof options === 'string') {
    tier_semantic = options;
  } else if (options && typeof options === 'object') {
    tier_semantic = options.tier_semantic;
    include_stale = options.include_stale === true;
    format = options.format;
  }

  const { expanded, synonym_matches, applied } = expandQuery(q);

  let warmHits = null;
  let warmRawRows = null;  // preserved for structured format (Task 28)
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
        // W1.3: OR the salient terms so NL queries don't starve under FTS5's
        // implicit AND. Falls back to the synonym-expanded (or raw) query when
        // no salient term survives. Final catch retries the raw query so a
        // malformed rewrite can never regress to fewer results than today.
        const orQuery = buildOrQuery(q);
        const ftsQuery = orQuery || (applied ? expanded : q);
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
          if (format === 'structured') {
            // Task 28: map raw rows to provenance objects while db is still open
            // (backlinkCount query needs the handle)
            warmRawRows = rows.map(r => ftsRowToStructured(r, fileBySource, q, db));
          }
          warmHits = rows.map(r => ftsRowToResult(r, fileBySource));
        } else {
          warmEmpty = true;
        }
      }
    }
  } catch {
    warmHits = null;
    warmRawRows = null;
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }

  let results;
  if (warmHits && warmHits.length > 0) {
    results = format === 'structured'
      ? warmRawRows.slice(0, limit)
      : warmHits.slice(0, limit);
  } else if (tier_semantic) {
    // Tier filter active and warm tier has no matches -- the hot-linear
    // tier doesn't carry tier metadata so it can't honour the filter.
    // Returning [] here keeps the contract honest ("only matching tier").
    results = [];
  } else {
    const linearResults = searchLinear(q, files, limit);
    results = format === 'structured'
      ? linearResults.map(r => linearResultToStructured(r, q))
      : linearResults;
  }

  // Structured results are plain arrays — no non-enumerable decorations needed.
  // Legacy path: attach non-enumerable metadata as before (byte-identical).
  if (format !== 'structured') {
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
  }
  return results;
}
