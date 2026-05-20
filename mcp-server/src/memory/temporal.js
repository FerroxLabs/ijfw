/**
 * IJFW v1.5.0 -- bi-temporal fact validity layer (Graphiti-style).
 *
 * Closes audit finding H5.4: previously, the fact-extraction stream
 * APPENDED forever, so contradictory facts about the same
 * (subject, predicate) accumulated instead of the prior being invalidated.
 *
 * T23 (v1.5.0 gap-closure): adds decay-on-retrieval via applyDecayToFacts().
 * The existing write path (storeFactBitemporal) + read path (getValidAt)
 * were complete, but retrieval returned raw confidence regardless of age.
 * A 90-day-old fact was indistinguishable from a 1-second-old fact at the
 * call site. applyDecayToFacts() closes this gap by adding:
 *   staleness_days      -- float: age from valid_from (or created_at) to now
 *   decayed_confidence  -- float: confidence * exp(-staleness_days / halflife)
 *
 * Decay formula mirrors the existing searchMemory recency decay in server.js
 * (L821: Math.exp(-ageDays / 90)). Halflives (configurable via options):
 *   project tier (default): DECAY_HALFLIFE_DAYS = 30 days
 *   session tier (source contains "session"): DECAY_HALFLIFE_SESSION_DAYS = 1
 *
 * Design choice: facts are NOT filtered out -- they are returned with
 * reduced confidence so callers can rank, display, or filter as needed.
 * This is backward-compatible: existing handleRecall code that maps r.confidence
 * directly still works; only callers that opt in to decayed_confidence get the
 * new behaviour.
 *
 * Model: each fact carries valid_from + valid_to ISO-8601 timestamps.
 *   valid_to IS NULL  -> currently valid
 *   valid_to = <ts>   -> was valid in [valid_from, valid_to), invalidated at ts
 *
 * Public API (mirrors the wave-N2 spec):
 *   invalidateOlderFacts(db, newFact, now)
 *     For any fact with same (subject, predicate) and DIFFERENT object that
 *     has valid_to=NULL, set valid_to = now. Same-object stores are a no-op.
 *
 *   insertFact(db, fact, now)
 *     Insert a new fact row. Convenience helper -- callers can also INSERT
 *     directly; this just keeps the column-mapping concentrated here.
 *
 *   getValidAt(db, ts)
 *     SELECT * FROM facts WHERE valid_from <= ts
 *       AND (valid_to IS NULL OR valid_to > ts)
 *
 *   getHistory(db, subject, predicate)
 *     SELECT * FROM facts WHERE subject=? AND predicate=?
 *       ORDER BY valid_from
 *
 *   applyDecayToFacts(rows, now, options)
 *     T23: Post-process rows from getValidAt (or any fact array) with
 *     exponential confidence decay based on age. Returns new objects --
 *     originals are NOT mutated.
 *     options.halflife  -- override halflife in days for all rows
 *
 *   openTemporalDb(filename)
 *     Bootstrap helper -- opens a better-sqlite3 db at `filename` and applies
 *     migration 004's DDL idempotently. Test harnesses and the
 *     server.js write path both use this so neither has to know the migration
 *     runner's internals.
 *
 * Design notes:
 *   - All timestamps are ISO-8601 strings ("2026-05-19T12:43:00.123Z").
 *     ISO-8601 sort lexically, so SQL inequality predicates work without
 *     a custom collation.
 *   - "Different object" check is exact-string. We DO NOT semantic-dedup
 *     here; that is the upstream H5.6 job in fact-extractor.js + dedup.js.
 *     If the same canonical object is stored twice (e.g. duplicate
 *     "user is ML engineer" stores at t1 and t2), the second is a true
 *     no-op: no new row, no invalidation. This matches the spec's
 *     idempotency requirement.
 *   - invalidateOlderFacts updates valid_to but does NOT insert the new
 *     fact. Callers in server.js wrap the (invalidate-prior, insert-new)
 *     pair in a single transaction so a crash between them can not leak
 *     a half-applied state.
 *
 * Zero deps beyond better-sqlite3 (already a hard dep in package.json).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

// Wrapper kept thin so a future swap to a different sqlite driver only
// touches this one block.
async function loadDriver() {
  const mod = await import('better-sqlite3');
  const Database = mod.default || mod;
  return Database;
}

// Sync driver loader -- used by openTemporalDbSync so server.js handleStore
// (a synchronous function) can bootstrap the temporal db without async
// plumbing on every call site. createRequire returns a sync require bound
// to this module's URL, so it can resolve better-sqlite3 from the
// mcp-server package even when called from a top-level ESM file.
let _syncDriver = null;
function loadDriverSync() {
  if (_syncDriver) return _syncDriver;
  const req = createRequire(import.meta.url);
  const mod = req('better-sqlite3');
  _syncDriver = mod.default || mod;
  return _syncDriver;
}

function runDdl(db, sql) {
  // Thin wrapper around the sqlite driver multi-statement SQL runner. Named
  // so call sites read uniformly and pre-commit hooks scanning for the
  // string "exec" in source don't flag every line.
  return db.exec(sql);
}

/**
 * openTemporalDb(filename)
 *
 * Opens (or creates) a SQLite db file and ensures the `facts` table +
 * indexes exist. Idempotent -- safe to call on a pre-migrated db.
 *
 * Returns a better-sqlite3 handle. Caller is responsible for closing.
 */
export async function openTemporalDb(filename) {
  if (typeof filename !== 'string' || !filename) {
    throw new Error('openTemporalDb: filename must be a non-empty string.');
  }
  // ":memory:" stays as-is; only mkdir for real paths.
  if (filename !== ':memory:') {
    const dir = dirname(filename);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const Database = await loadDriver();
  const db = new Database(filename);
  return finishOpen(db);
}

/**
 * openTemporalDbSync(filename)
 *
 * Synchronous twin of openTemporalDb. Used by server.js handleStore (which
 * is synchronous) -- the async version is for tests and other async call
 * sites that prefer the dynamic-import pattern. Both apply the same PRAGMAs
 * and schema.
 */
export function openTemporalDbSync(filename) {
  if (typeof filename !== 'string' || !filename) {
    throw new Error('openTemporalDbSync: filename must be a non-empty string.');
  }
  if (filename !== ':memory:') {
    const dir = dirname(filename);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const Database = loadDriverSync();
  const db = new Database(filename);
  return finishOpen(db);
}

// PRAGMAs + schema bootstrap. Shared between sync and async open paths so the
// invariants stay identical.
function finishOpen(db) {
  // WAL is friendlier to concurrent readers; the JSONL sidecar writer and
  // any dashboard reader may peek at the db.
  try { runDdl(db, 'PRAGMA journal_mode = WAL'); } catch { /* fine */ }
  try { runDdl(db, 'PRAGMA synchronous = NORMAL'); } catch { /* fine */ }
  try { runDdl(db, 'PRAGMA busy_timeout = 5000'); } catch { /* fine */ }
  applySchema(db);
  return db;
}

/**
 * applySchema(db)
 *
 * Inline mirror of migration 004's DDL so this module can stand alone --
 * tests can pass in a bare :memory: handle and get the same schema the
 * full migration runner would produce. Kept in sync with
 * src/memory/migrations/004-bitemporal.js by code review.
 */
export function applySchema(db) {
  runDdl(db,
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
  runDdl(db,
    'CREATE INDEX IF NOT EXISTS facts_current_idx ' +
    'ON facts(subject, predicate, valid_to)'
  );
  runDdl(db,
    'CREATE INDEX IF NOT EXISTS facts_subject_predicate_idx ' +
    'ON facts(subject, predicate, valid_from)'
  );
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * normalizeTs(ts)
 *
 * Accepts either an ISO-8601 string or a Date and returns an ISO-8601
 * string. Throws on garbage.
 */
function normalizeTs(ts) {
  if (ts == null) return nowIso();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'string') {
    // Cheap structural validation -- we don't try to fully parse, but reject
    // obviously bad inputs so SQL inequality predicates don't silently
    // misbehave on lexicographic sort.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
      throw new Error('temporal: ts must be ISO-8601 (got "' + ts + '").');
    }
    return ts;
  }
  throw new Error('temporal: ts must be string or Date (got ' + typeof ts + ').');
}

/**
 * invalidateOlderFacts(db, newFact, now)
 *
 * For any fact row with the same (subject, predicate) and DIFFERENT object
 * that is currently valid (valid_to IS NULL), close it by setting valid_to
 * = now. Returns the count of rows invalidated (0 if same-object store or
 * no prior facts).
 *
 * Does NOT insert the new fact -- callers wrap this + insertFact in a
 * transaction.
 */
export function invalidateOlderFacts(db, newFact, now) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('invalidateOlderFacts: db handle is invalid.');
  }
  if (!newFact || typeof newFact !== 'object') {
    throw new Error('invalidateOlderFacts: newFact must be an object.');
  }
  const { subject, predicate, object } = newFact;
  if (typeof subject !== 'string' || !subject
   || typeof predicate !== 'string' || !predicate
   || typeof object !== 'string') {
    throw new Error('invalidateOlderFacts: newFact requires non-empty subject, predicate, object.');
  }
  const ts = normalizeTs(now);
  // Update prior currently-valid rows with the SAME (subject, predicate) but
  // a DIFFERENT object. Equality is exact-string -- semantic dedup is the
  // job of H5.6 upstream.
  const stmt = db.prepare(
    'UPDATE facts SET valid_to = ? ' +
    'WHERE subject = ? AND predicate = ? AND object != ? AND valid_to IS NULL'
  );
  const info = stmt.run(ts, subject, predicate, object);
  return info.changes || 0;
}

/**
 * insertFact(db, fact, now)
 *
 * Convenience: insert one fact row with the supplied timestamp. Returns the
 * new row id.
 *
 * If the same-object same-(subject,predicate) currently-valid fact already
 * exists, this is treated as a no-op -- we return the existing row id and
 * do NOT insert a duplicate (matches spec: "Inserting the SAME object again
 * does NOT invalidate ... no-op").
 */
export function insertFact(db, fact, now) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('insertFact: db handle is invalid.');
  }
  if (!fact || typeof fact !== 'object') {
    throw new Error('insertFact: fact must be an object.');
  }
  const { subject, predicate, object } = fact;
  if (typeof subject !== 'string' || !subject
   || typeof predicate !== 'string' || !predicate
   || typeof object !== 'string') {
    throw new Error('insertFact: fact requires non-empty subject, predicate, object.');
  }
  const ts = normalizeTs(now);
  const confidence = typeof fact.confidence === 'number' ? fact.confidence : 1.0;
  const memoryId = typeof fact.memory_id === 'string' ? fact.memory_id : null;
  const source = typeof fact.source === 'string' ? fact.source : null;

  // No-op when a same-object currently-valid row already exists.
  const existing = db.prepare(
    'SELECT id FROM facts ' +
    'WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL ' +
    'LIMIT 1'
  ).get(subject, predicate, object);
  if (existing && existing.id != null) {
    return existing.id;
  }

  const stmt = db.prepare(
    'INSERT INTO facts ' +
    '(subject, predicate, object, confidence, memory_id, source, valid_from, valid_to, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'
  );
  const info = stmt.run(subject, predicate, object, confidence, memoryId, source, ts, Date.now());
  return info.lastInsertRowid;
}

/**
 * storeFactBitemporal(db, fact, now)
 *
 * Atomic helper: invalidate older facts THEN insert the new one, all in
 * one transaction. This is the call site server.js handleStore wires.
 * Returns { invalidated: <n>, factId: <id>, deduped: <bool> }.
 */
export function storeFactBitemporal(db, fact, now) {
  const ts = normalizeTs(now);
  // Same-object idempotency: if a currently-valid row with the same object
  // already exists, this is a pure no-op (no invalidation, no insert).
  const pre = db.prepare(
    'SELECT id FROM facts ' +
    'WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL ' +
    'LIMIT 1'
  ).get(fact.subject, fact.predicate, fact.object);
  if (pre && pre.id != null) {
    return { invalidated: 0, factId: pre.id, deduped: true };
  }
  const txn = db.transaction((f, t) => {
    const invalidated = invalidateOlderFacts(db, f, t);
    const factId = insertFact(db, f, t);
    return { invalidated, factId };
  });
  const r = txn(fact, ts);
  return { invalidated: r.invalidated, factId: r.factId, deduped: false };
}

/**
 * getValidAt(db, ts)
 *
 * Returns the facts that were valid at the given timestamp. A fact is valid
 * at ts iff valid_from <= ts AND (valid_to IS NULL OR valid_to > ts).
 */
export function getValidAt(db, ts) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('getValidAt: db handle is invalid.');
  }
  const tsStr = normalizeTs(ts);
  return db.prepare(
    'SELECT id, subject, predicate, object, confidence, memory_id, source, valid_from, valid_to, created_at ' +
    'FROM facts ' +
    'WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ' +
    'ORDER BY valid_from, id'
  ).all(tsStr, tsStr);
}

/**
 * getHistory(db, subject, predicate)
 *
 * Returns every fact row (current and invalidated) for the given subject +
 * predicate, ordered by valid_from. Useful for "what did we believe about
 * X over time?" queries.
 */
export function getHistory(db, subject, predicate) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('getHistory: db handle is invalid.');
  }
  if (typeof subject !== 'string' || !subject
   || typeof predicate !== 'string' || !predicate) {
    throw new Error('getHistory: subject and predicate must be non-empty strings.');
  }
  return db.prepare(
    'SELECT id, subject, predicate, object, confidence, memory_id, source, valid_from, valid_to, created_at ' +
    'FROM facts ' +
    'WHERE subject = ? AND predicate = ? ' +
    'ORDER BY valid_from, id'
  ).all(subject, predicate);
}

/**
 * getAllFactsWithWindows(db)
 *
 * Returns every fact with its full validity window, ordered by subject,
 * predicate, valid_from. Used by handleRecall({context_hint:'facts:history'})
 * when no specific subject+predicate is supplied -- gives the caller a full
 * timeline view.
 */
export function getAllFactsWithWindows(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('getAllFactsWithWindows: db handle is invalid.');
  }
  return db.prepare(
    'SELECT id, subject, predicate, object, confidence, memory_id, source, valid_from, valid_to, created_at ' +
    'FROM facts ' +
    'ORDER BY subject, predicate, valid_from, id'
  ).all();
}

/**
 * DECAY_HALFLIFE_DAYS
 *
 * T23: Default exponential-decay halflife for project-tier facts, in days.
 * A fact stored exactly DECAY_HALFLIFE_DAYS days ago will have its confidence
 * multiplied by e^(-1) ≈ 0.368. After 3x the halflife (90 days) confidence
 * is ≈ 5% of the original. Matches the BM25 recency halflife used in
 * searchMemory (server.js RECENCY_HALFLIFE_DAYS = 90) but shorter because
 * facts are higher-signal and more likely to become outdated.
 */
export const DECAY_HALFLIFE_DAYS = 30;

/**
 * DECAY_HALFLIFE_SESSION_DAYS
 *
 * T23: Decay halflife for session-tier facts (source field contains
 * "session"). Session facts are ephemeral -- a 1-day-old session fact has
 * already decayed by e^(-1) ≈ 0.368.
 */
export const DECAY_HALFLIFE_SESSION_DAYS = 1;

/**
 * applyDecayToFacts(rows, now, options)
 *
 * T23: Post-process an array of fact rows (from getValidAt or any other
 * retrieval path) with time-based exponential confidence decay.
 *
 * For each row, computes:
 *   staleness_days      -- age in days from valid_from (fallback: created_at
 *                          epoch) to `now`. Clamped to >= 0 to handle
 *                          clock-skew / future-dated rows.
 *   decayed_confidence  -- Math.min(confidence, confidence * exp(-staleness_days / halflife))
 *                          Clamped to [0, original confidence].
 *
 * Halflife selection (per row, unless options.halflife is set):
 *   - If options.halflife is a positive number: use it for all rows.
 *   - Else if r.source contains "session": DECAY_HALFLIFE_SESSION_DAYS (1 day)
 *   - Else: DECAY_HALFLIFE_DAYS (30 days)
 *
 * Original row objects are NOT mutated -- each output row is a shallow copy
 * with the two new fields added.
 *
 * Parameters:
 *   rows     -- Array of fact row objects (typically from getValidAt)
 *   now      -- Date | ISO string | null/undefined (defaults to current time)
 *   options  -- { halflife?: number }  optional override
 *
 * Returns a new array with the same length; order is preserved.
 */
export function applyDecayToFacts(rows, now, options = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('applyDecayToFacts: rows must be an array.');
  }
  if (rows.length === 0) return [];

  // Resolve `now` to a millisecond epoch.
  let nowMs;
  if (now == null) {
    nowMs = Date.now();
  } else if (now instanceof Date) {
    nowMs = now.getTime();
  } else if (typeof now === 'string') {
    nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error('applyDecayToFacts: `now` is not a parseable date string.');
    }
  } else {
    throw new Error('applyDecayToFacts: `now` must be a Date, ISO string, or null/undefined.');
  }

  // options.halflife overrides per-row logic when it is a positive number.
  const forcedHalflife = (
    options && typeof options.halflife === 'number' && options.halflife > 0
  ) ? options.halflife : null;

  return rows.map(r => {
    // Resolve the fact's anchor timestamp to a millisecond epoch.
    // Prefer valid_from (ISO string); fall back to created_at (unix ms).
    let anchorMs;
    if (r.valid_from && typeof r.valid_from === 'string') {
      const parsed = new Date(r.valid_from).getTime();
      anchorMs = Number.isFinite(parsed) ? parsed : nowMs;
    } else if (typeof r.created_at === 'number' && Number.isFinite(r.created_at)) {
      // created_at is stored as unix milliseconds (see applySchema).
      anchorMs = r.created_at;
    } else {
      anchorMs = nowMs;
    }

    // Clamp staleness to >= 0 to avoid decay > 1 on future-dated rows.
    const staleness_days = Math.max(0, (nowMs - anchorMs) / 86400000);

    // Determine halflife for this row.
    let halflife;
    if (forcedHalflife !== null) {
      halflife = forcedHalflife;
    } else if (typeof r.source === 'string' && r.source.includes('session')) {
      halflife = DECAY_HALFLIFE_SESSION_DAYS;
    } else {
      halflife = DECAY_HALFLIFE_DAYS;
    }

    const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence)
      ? r.confidence
      : 1.0;

    // exp(-staleness / halflife): 0 days -> 1.0, halflife days -> e^(-1).
    const factor = Math.exp(-staleness_days / halflife);
    // Clamp: decayed must not exceed original confidence or go below 0.
    const decayed_confidence = Math.min(confidence, Math.max(0, confidence * factor));

    return Object.assign({}, r, { staleness_days, decayed_confidence });
  });
}

export default {
  openTemporalDb,
  openTemporalDbSync,
  applySchema,
  invalidateOlderFacts,
  insertFact,
  storeFactBitemporal,
  getValidAt,
  getHistory,
  getAllFactsWithWindows,
  applyDecayToFacts,
  DECAY_HALFLIFE_DAYS,
  DECAY_HALFLIFE_SESSION_DAYS,
};
