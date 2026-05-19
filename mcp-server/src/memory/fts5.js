// IJFW v1.3.0 -- D-Pillar / D0 memory FTS5 layer.
//
// Per-project SQLite db at <projectRoot>/.ijfw/index/memory.db with FTS5
// virtual table mirroring `memory_entries`. This is the warm tier of the
// memory pipeline (hot = markdown files; warm = FTS5; cold = vectors).
// Schema is owned by ./schema.sql and applied via ./migration-runner.js.
//
// Mirrors src/compute/fts5.js patterns:
//   - WAL journal mode for concurrent readers
//   - PRAGMA busy_timeout = 5000 + BEGIN IMMEDIATE for racing writers
//   - PRAGMA quick_check post-write enforces integrity
//
// Security model (D-PILLAR-SPEC section 12, real fix-wave C3):
//   indexEntry runs `redactSecrets()` over `entry.body` AND `entry.source`
//   BEFORE the INSERT. The scrub is the security gate that ensures secret-
//   shaped tokens are never persisted in `memory_entries`, the FTS index,
//   or fed forward into the D2 graph layer. Default on; opt out only via
//   IJFW_INGEST_SCRUB=0 for local debugging. Source is scrubbed because
//   while file paths are typical, callers may pass arbitrary text-of-origin
//   strings (chat title, tool result label, etc.) that could include keys.
//
// Public surface is intentionally narrow:
//   - openDb(projectRoot)       -> handle
//   - indexEntry(db, entry)     -> { id }
//   - searchFts5(db, q, k)      -> [{id, body, source, session_id, created_at, rank}]
//   - closeDb(db)
//
// Driver loader uses better-sqlite3 (already a hard dep in package.json).

import { existsSync, mkdirSync } from 'fs';
import { join, resolve, normalize, isAbsolute, dirname } from 'path';
import {
  runMigrations,
  highestKnownVersion,
  SchemaVersionError,
} from './migration-runner.js';
import { autoIndexGraphFromMemoryBody } from '../compute/graph-auto-index.js';
import { redactSecrets } from '../redactor.js';

// D-PILLAR-SPEC section 12 ingest scrub gate. Default-on; the only escape hatch
// is the IJFW_INGEST_SCRUB=0 env var, used for local debugging only and
// never a shipping posture. Read on every indexEntry so test harnesses
// can flip it without re-importing.
function ingestScrubEnabled() {
  return process.env.IJFW_INGEST_SCRUB !== '0';
}

export { SchemaVersionError };

export class MemoryDbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryDbError';
  }
}

export class MemoryIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryIntegrityError';
  }
}

const DB_FILENAME = 'memory.db';
const INDEX_DIR_NAME = 'index';
const IJFW_DIR_NAME = '.ijfw';

// Thin wrapper around the sqlite driver's multi-statement runner so call
// sites stay uniform between better-sqlite3 and any future shim.
function runSql(db, sql) {
  const fn = db.exec.bind(db);
  return fn(sql);
}

// --- Driver loader -----------------------------------------------------------
//
// Shipping path: better-sqlite3. Already pinned by package.json so this is
// a hot path. We do NOT duplicate the node:sqlite escape hatch from
// src/compute/fts5.js -- the compute tier owns the dev-only fallback; the
// memory tier is shipping-only.

async function loadDriver() {
  const mod = await import('better-sqlite3');
  const Database = mod.default || mod;
  return {
    kind: 'better-sqlite3',
    open(filename) {
      const db = new Database(filename);
      // BEGIN IMMEDIATE invariant: write transactions must acquire RESERVED
      // at txn start, not at first INSERT. Paired with busy_timeout=5000
      // below this converts racing writers from a SQLITE_BUSY explosion
      // into a clean queue. Phase 5 caught this on the compute side; the
      // memory tier ships with it correct from day one.
      db.txn = (fn) => {
        const wrapped = db.transaction(fn);
        if (wrapped && typeof wrapped.immediate === 'function') {
          return wrapped.immediate;
        }
        return (...args) => {
          runSql(db, 'BEGIN IMMEDIATE');
          try {
            const r = fn(...args);
            runSql(db, 'COMMIT');
            return r;
          } catch (err) {
            try { runSql(db, 'ROLLBACK'); } catch { /* ignore */ }
            throw err;
          }
        };
      };
      return db;
    },
  };
}

// --- Path resolution ---------------------------------------------------------

function resolveProjectRoot(projectRoot) {
  const raw = projectRoot || process.env.IJFW_PROJECT_DIR || process.cwd();
  if (typeof raw !== 'string' || !raw) {
    throw new MemoryDbError('Project root must be a non-empty string.');
  }
  const abs = resolve(raw);
  const norm = normalize(abs);
  if (!isAbsolute(norm)) {
    throw new MemoryDbError(`Project root resolves to non-absolute path: ${raw}`);
  }
  return norm;
}

export function dbPathFor(projectRoot) {
  const root = resolveProjectRoot(projectRoot);
  return join(root, IJFW_DIR_NAME, INDEX_DIR_NAME, DB_FILENAME);
}

function ensureDbDir(filename) {
  const dir = dirname(filename);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// --- Public API --------------------------------------------------------------

// Open or create the per-project memory db. On a fresh file, applies every
// migration up to highestKnownVersion(). On an existing file, refuses to
// operate if user_version is higher than this build supports.
export async function openDb(projectRoot) {
  const filename = dbPathFor(projectRoot);
  ensureDbDir(filename);

  const driver = await loadDriver();
  const db = driver.open(filename);
  db.__ijfw_driver = driver.kind;
  db.__ijfw_filename = filename;

  try { runSql(db, 'PRAGMA journal_mode = WAL'); } catch { /* default fine */ }
  try { runSql(db, 'PRAGMA synchronous = NORMAL'); } catch { /* default fine */ }
  try { runSql(db, 'PRAGMA busy_timeout = 5000'); } catch { /* default fine */ }

  const target = await highestKnownVersion();
  const current = readUserVersion(db);

  if (current > target) {
    db.close();
    throw new SchemaVersionError(
      `Memory db schema version ${current} at ${filename} is newer than this build supports (max ${target}). ` +
      `Refusing to downgrade.`
    );
  }
  if (current < target) {
    await runMigrations(db, current, target);
  }
  return db;
}

function readUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  if (!row) return 0;
  return Number(row.user_version ?? row.USER_VERSION ?? 0);
}

// Insert one row into memory_entries inside a BEGIN IMMEDIATE transaction,
// then run PRAGMA quick_check on the whole db. Throws MemoryIntegrityError
// on anything other than 'ok'. Returns { id } of the inserted row.
//
// Caller passes { body, source?, session_id? }. created_at is set here
// (unix ms) so callers don't have to remember the convention.
export function indexEntry(db, entry) {
  if (!db || typeof db.prepare !== 'function') {
    throw new MemoryDbError('indexEntry: db handle is invalid.');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new MemoryDbError('indexEntry: entry must be a plain object.');
  }
  if (typeof entry.body !== 'string' || entry.body.length === 0) {
    throw new MemoryDbError('indexEntry: entry.body must be a non-empty string.');
  }
  // D-PILLAR-SPEC section 12 ingest scrub gate. Replace `body` and `source`
  // with their redacted forms BEFORE the INSERT, so the FTS index, the
  // graph auto-index pass below, and any downstream reader only ever
  // see scrubbed text. After this branch `entry` is unchanged for the
  // caller; we work off a local copy.
  const scrub = ingestScrubEnabled();
  const safeBody = scrub ? redactSecrets(entry.body) : entry.body;
  const safeSource = entry.source != null
    ? (scrub ? redactSecrets(String(entry.source)) : String(entry.source))
    : null;
  const row = {
    body: safeBody,
    source: safeSource,
    session_id: entry.session_id != null ? String(entry.session_id) : null,
    created_at: typeof entry.created_at === 'number' ? entry.created_at : Date.now(),
  };

  let inserted;
  const tx = db.txn(() => {
    const stmt = db.prepare(
      'INSERT INTO memory_entries (body, source, session_id, created_at) VALUES (?, ?, ?, ?)'
    );
    const info = stmt.run(row.body, row.source, row.session_id, row.created_at);
    inserted = {
      id: info && info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
    };
    const qc = db.prepare('PRAGMA quick_check').get();
    const status = qc && (qc.quick_check ?? qc.QUICK_CHECK);
    if (status !== 'ok') {
      throw new MemoryIntegrityError(
        `PRAGMA quick_check failed after insert into memory_entries: ${status || '(no result)'}.`
      );
    }
  });
  tx();

  // GA-B3: fire D2 graph auto-population on memory ingest. The graph
  // lives in the compute db at the same projectRoot, so we open compute
  // on demand. Async-but-fire-and-forget: the indexEntry contract stays
  // synchronous (callers don't see a Promise), and a graph failure never
  // affects ingest correctness. Tests that need to await the auto-index
  // promise can read __lastAutoIndexPromise (set below for diagnostic
  // visibility only).
  try {
    const ts = row.created_at;
    const sessionId = row.session_id;
    const body = row.body;
    // v1.5.0 audit-LOW-memory-#14: dead-letter receipt for auto-index failures.
    // Fire-and-forget was already swallowed silently; now we append an
    // append-only JSONL receipt so silent indexer breakage is detectable in
    // post-mortems. Best-effort: file write failures themselves are swallowed
    // because indexEntry must never throw on diagnostic-write failure.
    const p = autoIndexGraphFromMemoryBody({ memoryDb: db, body, sessionId, ts })
      .catch((err) => {
        try {
          // Lazy import; node:fs/promises is always available.
          import('node:fs/promises').then(({ appendFile, mkdir }) => {
            try {
              const indexDir = '.ijfw/index';
              return mkdir(indexDir, { recursive: true })
                .then(() => appendFile(
                  `${indexDir}/graph-errors.jsonl`,
                  JSON.stringify({
                    ts: new Date().toISOString(),
                    session_id: sessionId || null,
                    err: err && err.message ? String(err.message) : String(err),
                  }) + '\n',
                ))
                .catch(() => {});
            } catch { /* swallow */ }
          }).catch(() => {});
        } catch { /* swallow */ }
        return null;
      });
    __lastAutoIndexPromise = p;
  } catch {
    // never throw out of indexEntry due to auto-index
  }

  return inserted;
}

// Diagnostic hook for tests -- holds the most recent auto-index promise
// from indexEntry so end-to-end tests can `await __getLastAutoIndexPromise()`
// before asserting on graph state. Production callers do not read this.
let __lastAutoIndexPromise = null;
export function __getLastAutoIndexPromise() {
  return __lastAutoIndexPromise;
}

// FTS5 search against memory_entries_fts. Returns top-k content rows with
// a `rank` column (bm25; lower is better). Empty/whitespace queries return
// an empty array. Caller is responsible for sanitising user-supplied
// queries (FTS5 syntax errors throw -- caught and reported here).
//
// opts.include_stale (D4 GA-B2): when false (default), rows with
// stale_candidate >= 1 are excluded so cascading-staleness flags actually
// gate retrieval. When true, all rows return (debug + grader path).
// Pre-v3 dbs (no stale_candidate column) silently drop the WHERE filter
// so back-compat is preserved.
export function searchFts5(db, query, k = 10, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new MemoryDbError('searchFts5: db handle is invalid.');
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    return [];
  }
  const limit = Math.min(Math.max(1, parseInt(k, 10) || 10), 1000);
  const includeStale = opts && opts.include_stale === true;
  const hasStaleCol = tableHasColumn(db, 'memory_entries', 'stale_candidate');
  const staleClause = (!includeStale && hasStaleCol)
    ? ' AND COALESCE(t.stale_candidate, 0) = 0'
    : '';
  const sql = `
    SELECT t.id, t.body, t.source, t.session_id, t.created_at,
           bm25(memory_entries_fts) AS rank
      FROM memory_entries_fts f
      JOIN memory_entries t ON t.id = f.rowid
     WHERE memory_entries_fts MATCH ?${staleClause}
     ORDER BY rank ASC
     LIMIT ?`;
  try {
    return db.prepare(sql).all(query, limit);
  } catch (err) {
    throw new MemoryDbError(`searchFts5 failed: ${err.message}`);
  }
}

// Cached PRAGMA table_info lookups per-db so repeated calls don't re-scan.
const __memTableInfoCache = new WeakMap();
function tableHasColumn(db, table, column) {
  let perDb = __memTableInfoCache.get(db);
  if (!perDb) {
    perDb = new Map();
    __memTableInfoCache.set(db, perDb);
  }
  const key = `${table}.${column}`;
  if (perDb.has(key)) return perDb.get(key);
  let present = false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    present = rows.some(r => String(r.name) === column);
  } catch { /* missing table -> treat column as absent */ }
  perDb.set(key, present);
  return present;
}

// Total row count -- cheap helper used by callers that want to decide
// whether the index is empty (and thus needs an auto-rebuild from hot tier).
export function rowCount(db) {
  if (!db || typeof db.prepare !== 'function') return 0;
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get();
    return row ? Number(row.n) : 0;
  } catch {
    return 0;
  }
}

// Clean close. Tolerates double-close.
export function closeDb(db) {
  if (!db) return;
  try { db.close(); } catch { /* already closed or driver-specific noop */ }
}

export default {
  openDb,
  indexEntry,
  searchFts5,
  rowCount,
  closeDb,
  dbPathFor,
  MemoryDbError,
  MemoryIntegrityError,
  SchemaVersionError,
};
