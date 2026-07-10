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
//   - safeWrite() -- runs `redactSecrets()` over `body` and `topic` BEFORE
//                    inserting (D-PILLAR-SPEC section 12 ingest scrub gate), then
//                    inserts inside a transaction and runs PRAGMA quick_check
//                    after each insert; throws IntegrityError on anything
//                    other than 'ok'. The scrub default is on; setting
//                    IJFW_INGEST_SCRUB=0 disables it for local debugging
//                    only -- never a production posture.
//   - search()    -- FTS5 MATCH; top-k rows from the content table ordered
//                    by bm25 rank.
//   - closeDb()   -- clean close; suppresses double-close errors.
//
// Security model (D-PILLAR-SPEC section 12, real fix-wave C3):
//   Secrets are scrubbed at the observation-ingest boundary. By the time a
//   row reaches the FTS index, the entity extractor, or the kg layer, all
//   `redactSecrets`-recognised tokens have been replaced with
//   `[REDACTED:<kind>]` placeholders. The scrub is the security gate; the
//   `kg_nodes.redacted=1` flag downstream is a residual-safety belt for
//   the rare case where an entity-regex match's value happens to look
//   secret-shaped (e.g. a function name `validateSk_live_xxx`).

import { existsSync, mkdirSync } from 'fs';
import { join, resolve, normalize, isAbsolute, dirname } from 'path';
import { vetProjectRoot } from '../lib/project-root-guard.js';
import { runMigrations, highestKnownVersion, SchemaVersionError } from './migration-runner.js';
import { autoIndexGraphFromBody } from './graph-auto-index.js';
import { redactSecrets } from '../redactor.js';

// D-PILLAR-SPEC section 12 ingest scrub gate. Default-on; the only escape hatch
// is the IJFW_INGEST_SCRUB=0 env var, which exists for local debugging
// (e.g. asserting raw body shape in a fixture) and is NOT a shipping
// posture. Read on every safeWrite call so test harnesses can flip it
// without re-importing the module.
function ingestScrubEnabled() {
  return process.env.IJFW_INGEST_SCRUB !== '0';
}

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
  // wayland#755 round 2: openDb() mkdirs <root>/.ijfw/index -- every
  // candidate must pass the shared bundle gate before becoming a write root.
  const raw = vetProjectRoot(projectRoot);
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

// quick_check throttle state, keyed per db handle. First write per handle
// always checks; then every Nth write or once the time floor elapses.
const QUICK_CHECK_EVERY_N = 100;
const QUICK_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const quickCheckState = new WeakMap(); // db handle -> { writes, lastTs }

function shouldQuickCheck(db, now = Date.now()) {
  let st = quickCheckState.get(db);
  if (!st) {
    st = { writes: 0, lastTs: 0 };
    quickCheckState.set(db, st);
  }
  st.writes++;
  if (
    st.writes === 1 ||
    st.writes % QUICK_CHECK_EVERY_N === 0 ||
    (now - st.lastTs) >= QUICK_CHECK_MIN_INTERVAL_MS
  ) {
    st.lastTs = now;
    return true;
  }
  return false;
}

// Insert one row into a content table inside a transaction, then run
// PRAGMA quick_check on the whole db (throttled; see above). Throws
// IntegrityError on anything other than 'ok'. Returns { id } of the
// inserted row.
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

  // D-PILLAR-SPEC section 12 ingest scrub gate. Replace `body` and `topic` with
  // their redacted forms BEFORE the INSERT runs, so the FTS index, the
  // entity extractor (D2), and any downstream reader only ever see the
  // scrubbed text. This applies to every `safeWrite` regardless of table
  // (body/topic are user-supplied content surfaces wherever they appear).
  // Trident audit metadata (trident_run.summary) and schema_meta rows
  // don't carry body/topic columns so they're untouched.
  if (ingestScrubEnabled() && (table === 'raw' || table === 'compiled')) {
    if (typeof row.body === 'string' && row.body.length > 0) {
      row = { ...row, body: redactSecrets(row.body) };
    }
    if (typeof row.topic === 'string' && row.topic.length > 0) {
      row = { ...row, topic: redactSecrets(row.topic) };
    }
  }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  const values = cols.map(c => row[c]);

  // Run insert + (throttled) quick_check inside a single transaction.
  // Rollback on either failure so we never leave a half-written FTS index
  // behind. quick_check is a full-database scan, so it can't run on every
  // insert (O(db size) per write while the lock is held); the corruption
  // tripwire fires on the FIRST write per handle (compute callers hold
  // long-lived handles, so reopen-after-corruption is still caught), then
  // every Nth write or after a time floor, whichever comes first. State is
  // keyed per HANDLE (WeakMap), unlike memory/fts5.js which keys per
  // filename because server.js re-opens that db per store.
  let inserted;
  const tx = db.txn(() => {
    const stmt = db.prepare(sql);
    const info = stmt.run(...values);
    inserted = { id: info && info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    if (shouldQuickCheck(db)) {
      const qc = db.prepare('PRAGMA quick_check').get();
      const status = qc && (qc.quick_check ?? qc.QUICK_CHECK);
      if (status !== 'ok') {
        throw new IntegrityError(
          `PRAGMA quick_check failed after insert into ${table}: ${status || '(no result)'}.`
        );
      }
    }
  });
  tx();

  // GA-B3: D2 graph auto-population. Fires after the content tx commits
  // so a graph-extraction failure can never roll back the observation
  // write. Auto-index runs only on `raw` + `compiled` content tables
  // (the observation surfaces); audit_finding / trident_run rows skip.
  // Helper swallows all internal errors -- ingest correctness never
  // depends on the graph layer succeeding.
  if (table === 'raw' || table === 'compiled') {
    try {
      const body = typeof row.body === 'string' ? row.body : null;
      if (body) {
        autoIndexGraphFromBody({
          db,
          body,
          sessionId: row.session_id || null,
          ts: typeof row.ts === 'number' ? row.ts : Date.now(),
        });
      }
    } catch { /* auto-index is best-effort; never fail safeWrite */ }
  }

  return inserted;
}

// FTS5 search against <table>_fts. Returns top-k rows from the content
// table joined on rowid, ordered by relevance (FTS5 default rank: bm25).
//
// Query syntax: standard FTS5 MATCH expressions (terms, phrases, NEAR,
// prefix*, AND/OR/NOT). Caller is responsible for sanitising user-supplied
// queries (FTS5 syntax errors throw -- caught and reported here).
//
// Args:
//   db, table, query, k    -- as before
//   opts.include_stale     -- D4 retrieval guard. When false (default),
//                             rows with stale_candidate >= 1 are excluded
//                             so cascading-staleness flags actually gate
//                             retrieval. When true, all rows return
//                             (debug + grader path).
//                             Back-compat: callers passing a number for
//                             the 4th arg still get k-as-limit; opts is
//                             optional 5th arg.
//
// Tolerance: pre-D4 dbs may not have the stale_candidate column (e.g.
// fixture dbs created at a lower user_version). When the column is
// absent, the WHERE filter is silently dropped so older callers and
// tests don't break.
export function search(db, table, query, k = 10, opts = {}) {
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
  const includeStale = opts && opts.include_stale === true;

  // D4: stale-candidate filter. Default behaviour excludes rows with
  // stale_candidate >= 1 from search results. Override via include_stale
  // to surface flagged rows for debugging.
  const hasStaleColumn = tableHasColumn(db, table, 'stale_candidate');
  const staleClause = (!includeStale && hasStaleColumn)
    ? ' AND COALESCE(t.stale_candidate, 0) = 0'
    : '';

  // Join FTS5 rowid back to the content table to recover full row data.
  const sql = `
    SELECT t.*, bm25(${ftsTable}) AS rank
      FROM ${ftsTable} f
      JOIN ${table} t ON t.id = f.rowid
     WHERE ${ftsTable} MATCH ?${staleClause}
     ORDER BY rank ASC
     LIMIT ?`;
  try {
    return db.prepare(sql).all(query, limit);
  } catch (err) {
    throw new ComputeDbError(`search failed for ${table}: ${err.message}`);
  }
}

// Cache table_info lookups so repeated search() calls don't re-scan the
// schema each invocation. WeakMap keyed on the db handle so a closed/
// reopened db gets a fresh cache automatically.
const __tableInfoCache = new WeakMap();
function tableHasColumn(db, table, column) {
  let perDb = __tableInfoCache.get(db);
  if (!perDb) {
    perDb = new Map();
    __tableInfoCache.set(db, perDb);
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

// Clean close. Tolerates double-close (already-closed handles).
export function closeDb(db) {
  if (!db) return;
  try { db.close(); } catch { /* already closed or driver-specific noop */ }
}

export default { openDb, safeWrite, search, closeDb, dbPathFor, IntegrityError, SchemaVersionError, ComputeDbError };
