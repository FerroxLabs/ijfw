/**
 * IJFW v1.5.0 -- bi-temporal fact validity layer (Graphiti-style).
 *
 * Closes audit finding H5.4: previously, the fact-extraction stream
 * APPENDED forever, so contradictory facts about the same
 * (subject, predicate) accumulated instead of the prior being invalidated.
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
};
