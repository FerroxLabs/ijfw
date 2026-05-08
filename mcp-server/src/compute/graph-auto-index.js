// IJFW v1.3.0 -- D2 graph auto-population on ingest (GA fix-wave GA-B3).
//
// Source authority: PRD-v2 section 9 Pillar D D2 + .planning/1.3.0/D-PILLAR-SPEC.md
// section 3 (entity extraction ordering) + GA fix-wave finding GA-B3.
//
// PROBLEM (pre-fix-wave): graph:index colon-syntax dispatch is the ONLY
// caller of writeEdges in production. Nothing wires the symbol graph into
// the actual ingest path, so kg_nodes / kg_edges stay empty and D4's
// propagateStale BFS has nothing to walk.
//
// FIX: this module is invoked as a side-effect of every successful
// observation insert (compute safeWrite + memory indexEntry). It runs
// extractEntities on the just-written body, upserts kg_nodes, and writes
// co-occurrence edges via the existing edges.js writeEdges. Failure is
// always swallowed -- ingest must never fail because the graph layer is
// unhappy.
//
// OPT-OUT: env var IJFW_GRAPH_AUTO_INDEX. Default is on. Set to '0' or
// 'false' to disable (used by fixture tests that want to seed graphs
// manually without auto-index races).
//
// LOCK: acquireGraphWriteLock is acquired for the write window. The
// caller is allowed to be running inside a memory-side or compute-side
// txn -- the graph lock is a separate file-level CAS, not a DB lock, so
// there's no SQLite-level conflict.

import { extractEntities } from './extract.js';
import { writeEdges } from './edges.js';
import { acquireGraphWriteLock } from './graph-lock.js';

// Cached driver loader. We reuse the same better-sqlite3 module the rest
// of the compute layer uses; the import is awaited once on first call.
let __computeOpenDb = null;
async function getComputeOpenDb() {
  if (__computeOpenDb) return __computeOpenDb;
  const mod = await import('./fts5.js');
  __computeOpenDb = { openDb: mod.openDb, closeDb: mod.closeDb };
  return __computeOpenDb;
}

function isAutoIndexEnabled() {
  const v = process.env.IJFW_GRAPH_AUTO_INDEX;
  if (v === undefined || v === null || v === '') return true;
  if (v === '0' || /^false$/i.test(String(v))) return false;
  return true;
}

/**
 * autoIndexGraphFromBody({ db, body, sessionId, ts? }) -> result|null
 *
 * Synchronous wrapper used when the caller already holds a compute db
 * handle (e.g. compute safeWrite). Extracts entities from body, acquires
 * the graph-write lock, upserts nodes + edges. Returns the writeEdges
 * envelope on success, null on opt-out or any swallowed failure.
 *
 * Caller invariants:
 *   - db is a compute db handle (has kg_nodes / kg_edges tables).
 *   - projectRoot is read from db.__ijfw_filename so the lock file lands
 *     next to the db.
 */
export function autoIndexGraphFromBody({ db, body, sessionId, ts }) {
  if (!isAutoIndexEnabled()) return null;
  if (!db || typeof db.prepare !== 'function') return null;
  if (typeof body !== 'string' || body.length === 0) return null;

  // Resolve projectRoot from the db filename (always set by openDb).
  // db.__ijfw_filename is `<projectRoot>/.ijfw/index/compute.db`.
  const filename = String(db.__ijfw_filename || '');
  const projectRoot = filename
    ? filename.replace(/\/\.ijfw\/index\/[^/]+\.db$/, '').replace(/\\\.ijfw\\index\\[^\\]+\.db$/, '')
    : null;
  if (!projectRoot) return null;

  // kg_nodes presence check (tolerates fixture dbs that opened without
  // running migrations). When the table is absent, silently skip.
  if (!hasGraphTables(db)) return null;

  let entities;
  try {
    entities = extractEntities(body, { minMentions: 1 });
  } catch {
    return null;
  }
  if (!entities || entities.length === 0) return null;

  let lock;
  try {
    lock = acquireGraphWriteLock(projectRoot, { waitMs: 1500 });
  } catch {
    // Lock contention -- skip auto-index this round; the next ingest
    // covers the same body if it lands again, and graph:index can be
    // called explicitly to backfill.
    return null;
  }

  try {
    // Wrap inside a single tx so kg_nodes + kg_edges writes are atomic.
    let result = null;
    if (typeof db.txn === 'function') {
      const tx = db.txn(() => {
        result = writeEdges(db, sessionId || null, entities, { ts });
      });
      tx();
    } else {
      result = writeEdges(db, sessionId || null, entities, { ts });
    }
    return result;
  } catch {
    return null;
  } finally {
    if (lock) lock.released();
  }
}

/**
 * autoIndexGraphFromMemoryBody({ memoryDb, body, sessionId, ts? }) -> result|null
 *
 * Called from the memory ingest path. Memory db doesn't carry the
 * symbol graph; we open the compute db at the same projectRoot, run
 * extract + writeEdges there, then close the compute handle. Failures
 * are swallowed so memory ingest never breaks because of graph issues.
 *
 * Async because we have to open the compute db on demand. Memory
 * indexEntry callers that want truly synchronous behavior can fire-and-
 * forget the returned promise; ingest correctness does not depend on
 * the auto-index landing.
 */
export async function autoIndexGraphFromMemoryBody({ memoryDb, body, sessionId, ts }) {
  if (!isAutoIndexEnabled()) return null;
  if (typeof body !== 'string' || body.length === 0) return null;

  const filename = String(memoryDb && memoryDb.__ijfw_filename || '');
  const projectRoot = filename
    ? filename.replace(/\/\.ijfw\/index\/[^/]+\.db$/, '').replace(/\\\.ijfw\\index\\[^\\]+\.db$/, '')
    : null;
  if (!projectRoot) return null;

  let entities;
  try {
    entities = extractEntities(body, { minMentions: 1 });
  } catch {
    return null;
  }
  if (!entities || entities.length === 0) return null;

  const { openDb, closeDb } = await getComputeOpenDb();
  let computeDb = null;
  let lock = null;
  try {
    computeDb = await openDb(projectRoot);
    if (!hasGraphTables(computeDb)) return null;
    lock = acquireGraphWriteLock(projectRoot, { waitMs: 1500 });
    let result = null;
    if (typeof computeDb.txn === 'function') {
      const tx = computeDb.txn(() => {
        result = writeEdges(computeDb, sessionId || null, entities, { ts });
      });
      tx();
    } else {
      result = writeEdges(computeDb, sessionId || null, entities, { ts });
    }
    return result;
  } catch {
    return null;
  } finally {
    if (lock) lock.released();
    if (computeDb) {
      try { closeDb(computeDb); } catch { /* best-effort */ }
    }
  }
}

// --- helpers --------------------------------------------------------------

function hasGraphTables(db) {
  try {
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='kg_nodes'`
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

export const __test = { isAutoIndexEnabled, hasGraphTables };

export default {
  autoIndexGraphFromBody,
  autoIndexGraphFromMemoryBody,
};
