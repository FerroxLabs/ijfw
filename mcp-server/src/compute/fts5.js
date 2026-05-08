// IJFW v1.3.0 Alpha -- C9 Compute Lever / FTS5 layer.
//
// Per-project SQLite db at <projectRoot>/.ijfw/index/compute.db with FTS5
// virtual tables over the `raw` and `compiled` content tables. Schema is
// owned by ./schema.sql (V3-B4) and applied via the migration runner.
//
// Driver: better-sqlite3 (synchronous N-API binding, prebuild-binaries
// fallback). The mcp-server engines.node floor is >=18 which rules out the
// experimental built-in node:sqlite. A thin loader below tolerates
// node:sqlite ONLY when better-sqlite3 is unavailable AND Node >= 22 AND
// the explicit IJFW_COMPUTE_DRIVER=node-sqlite env opt-in is set -- this
// is a development-time escape hatch for local verification, NOT a
// shipping path.
//
// Integrity discipline:
//   - openDb()    -- enforces schema version; refuses downgrade.
//   - safeWrite() -- inserts inside a transaction and runs PRAGMA quick_check
//                    after each insert; throws IntegrityError on anything
//                    other than 'ok'.
//   - search()    -- FTS5 MATCH; top-k rows from the content table ordered
//                    by bm25 rank.
//   - closeDb()   -- clean close; suppresses double-close errors.

import { existsSync, mkdirSync } from 'fs';
import { join, resolve, normalize, isAbsolute, dirname } from 'path';
import { runMigrations, highestKnownVersion, SchemaVersionError } from './migration-runner.js';

export { SchemaVersionError };

export class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export class ComputeDbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComputeDbError';
  }
}

const DB_FILENAME = 'compute.db';
const INDEX_DIR_NAME = 'index';
const IJFW_DIR_NAME = '.ijfw';

// Tables that have a parallel <table>_fts FTS5 virtual table. search()
// rejects requests against any other content table.
const FTS_TABLES = new Set(['raw', 'compiled']);

const ALLOWED_WRITE_TABLES = new Set(['raw', 'compiled', 'trident_run', 'schema_meta']);

// Internal helper -- runs a multi-statement SQL string against the db
// handle. Both better-sqlite3 and node:sqlite expose .exec(sql) with the
// same shape; we route through this wrapper to keep call sites uniform.
function runSql(db, sql) {
  return db.exec(sql);
}

// --- Driver loader -----------------------------------------------------------

// Returns { kind, open } where open(filename) yields a synchronous handle
// exposing .exec(sql), .prepare(sql).{run,get,all}(...), .close(), and a
// .txn(fn) helper that returns a callable wrapping fn in BEGIN/COMMIT/
// ROLLBACK semantics. better-sqlite3 already has .transaction() with
// matching semantics; node:sqlite gets a shim.
async function loadDriver() {
  // Preferred: better-sqlite3 (the shipping path).
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default || mod;
    return {
      kind: 'better-sqlite3',
      open(filename) {
        const db = new Database(filename);
        // H2: write transactions use BEGIN IMMEDIATE so we acquire the
        // RESERVED lock at txn start (not at first INSERT). This converts
        // racing writers from a SQLITE_BUSY explosion into a clean queue
        // (paired with PRAGMA busy_timeout=5000 in openDb).
        db.txn = (fn) => {
          // better-sqlite3 >= 7 supports `.immediate` on the returned txn fn.
          const wrapped = db.transaction(fn);
          if (wrapped && typeof wrapped.immediate === 'function') {
            return wrapped.immediate;
          }
          // Fallback: wrap with explicit BEGIN IMMEDIATE / COMMIT / ROLLBACK.
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
  } catch { /* fall through to node:sqlite escape hatch */ }

  // Escape hatch: node:sqlite (Node >= 22). NOT a shipping path. Documented
  // and gated by env to avoid accidentally substituting it for production.
  if (process.env.IJFW_COMPUTE_DRIVER === 'node-sqlite') {
    const major = parseInt(String(process.versions.node).split('.')[0], 10);
    if (major < 22) {
      throw new ComputeDbError(
        'IJFW_COMPUTE_DRIVER=node-sqlite requested but Node < 22 does not provide node:sqlite.'
      );
    }
    const { DatabaseSync } = await import('node:sqlite');
    return {
      kind: 'node-sqlite',
      open(filename) {
        const db = new DatabaseSync(filename);
        // Shim a better-sqlite3-style transaction helper. node:sqlite has
        // no equivalent; we use BEGIN/COMMIT/ROLLBACK around the callback.
        db.txn = (fn) => {
          return (...args) => {
            // H2: BEGIN IMMEDIATE matches the better-sqlite3 path -- writers
            // acquire RESERVED lock immediately rather than upgrading mid-txn.
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

  throw new ComputeDbError(
    'Compute db driver unavailable: install better-sqlite3 (npm i better-sqlite3) ' +
    'or set IJFW_COMPUTE_DRIVER=node-sqlite on Node 22+ for local development only.'
  );
}

// --- Path resolution ---------------------------------------------------------

function resolveProjectRoot(projectRoot) {
  const raw = projectRoot || process.env.IJFW_PROJECT_DIR || process.cwd();
  if (typeof raw !== 'string' || !raw) {
    throw new ComputeDbError('Project root must be a non-empty string.');
  }
  const abs = resolve(raw);
  const norm = normalize(abs);
  if (!isAbsolute(norm)) {
    throw new ComputeDbError(`Project root resolves to non-absolute path: ${raw}`);
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

// Open or create the per-project compute db. On a fresh file, runs every
// migration up to the highest known version. On an existing file, refuses
// to operate if user_version is higher than this build supports.
export async function openDb(projectRoot) {
  const filename = dbPathFor(projectRoot);
  ensureDbDir(filename);

  const driver = await loadDriver();
  const db = driver.open(filename);
  db.__ijfw_driver = driver.kind;
  db.__ijfw_filename = filename;

  // Useful pragmas: WAL for concurrent readers; foreign_keys off (we don't
  // use FKs and FTS5 contentless tables don't tolerate them anyway).
  try { runSql(db, 'PRAGMA journal_mode = WAL'); } catch { /* fall back to default */ }
  try { runSql(db, 'PRAGMA synchronous = NORMAL'); } catch { /* default fine */ }
  // H2: concurrent-write protection. busy_timeout makes the driver retry on
  // SQLITE_BUSY for up to 5s before throwing -- prevents racing writers from
  // collapsing into a hard error when WAL contention spikes briefly.
  try { runSql(db, 'PRAGMA busy_timeout = 5000'); } catch { /* nothing */ }

  const target = await highestKnownVersion();
  const current = readUserVersion(db);

  if (current > target) {
    db.close();
    throw new SchemaVersionError(
      `Compute db schema version ${current} at ${filename} is newer than this build supports (max ${target}). ` +
      `Refusing to downgrade.`
    );
  }
  if (current < target) {
    await runMigrations(db, current, target);
  }
  return db;
}

function readUserVersion(db) {
  // Both better-sqlite3 and node:sqlite expose .prepare(...).get() with the
  // same shape for PRAGMA reads.
  const row = db.prepare('PRAGMA user_version').get();
  if (!row) return 0;
  return Number(row.user_version ?? row.USER_VERSION ?? 0);
}

// Insert one row into a content table inside a transaction, then run
// PRAGMA quick_check on the whole db. Throws IntegrityError on anything
// other than 'ok'. Returns { id } of the inserted row.
//
// Allowed tables: raw, compiled, trident_run, schema_meta. Caller passes a
// row object whose keys match the table's columns; binding is positional
// via INSERT (col, ...) VALUES (?, ?, ...).
export function safeWrite(db, table, row) {
  if (!db || typeof db.prepare !== 'function') {
    throw new ComputeDbError('safeWrite: db handle is invalid.');
  }
  if (!ALLOWED_WRITE_TABLES.has(table)) {
    throw new ComputeDbError(`safeWrite: refusing to write to table "${table}".`);
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new ComputeDbError('safeWrite: row must be a plain object.');
  }
  const cols = Object.keys(row);
  if (cols.length === 0) {
    throw new ComputeDbError('safeWrite: row has no columns.');
  }
  // Validate column names match SQL identifier shape -- defence-in-depth
  // against caller passing user-controlled keys.
  for (const c of cols) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c)) {
      throw new ComputeDbError(`safeWrite: invalid column name "${c}".`);
    }
  }
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  const values = cols.map(c => row[c]);

  // Run insert + quick_check inside a single transaction. Rollback on
  // either failure so we never leave a half-written FTS index behind.
  let inserted;
  const tx = db.txn(() => {
    const stmt = db.prepare(sql);
    const info = stmt.run(...values);
    inserted = { id: info && info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    const qc = db.prepare('PRAGMA quick_check').get();
    const status = qc && (qc.quick_check ?? qc.QUICK_CHECK);
    if (status !== 'ok') {
      throw new IntegrityError(
        `PRAGMA quick_check failed after insert into ${table}: ${status || '(no result)'}.`
      );
    }
  });
  tx();
  return inserted;
}

// FTS5 search against <table>_fts. Returns top-k rows from the content
// table joined on rowid, ordered by relevance (FTS5 default rank: bm25).
//
// Query syntax: standard FTS5 MATCH expressions (terms, phrases, NEAR,
// prefix*, AND/OR/NOT). Caller is responsible for sanitising user-supplied
// queries (FTS5 syntax errors throw -- caught and reported here).
export function search(db, table, query, k = 10) {
  if (!db || typeof db.prepare !== 'function') {
    throw new ComputeDbError('search: db handle is invalid.');
  }
  if (!FTS_TABLES.has(table)) {
    throw new ComputeDbError(`search: no FTS5 index for table "${table}".`);
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    return [];
  }
  const limit = Math.min(Math.max(1, parseInt(k, 10) || 10), 1000);
  const ftsTable = `${table}_fts`;
  // Join FTS5 rowid back to the content table to recover full row data.
  const sql = `
    SELECT t.*, bm25(${ftsTable}) AS rank
      FROM ${ftsTable} f
      JOIN ${table} t ON t.id = f.rowid
     WHERE ${ftsTable} MATCH ?
     ORDER BY rank ASC
     LIMIT ?`;
  try {
    return db.prepare(sql).all(query, limit);
  } catch (err) {
    throw new ComputeDbError(`search failed for ${table}: ${err.message}`);
  }
}

// Clean close. Tolerates double-close (already-closed handles).
export function closeDb(db) {
  if (!db) return;
  try { db.close(); } catch { /* already closed or driver-specific noop */ }
}

export default { openDb, safeWrite, search, closeDb, dbPathFor, IntegrityError, SchemaVersionError, ComputeDbError };
