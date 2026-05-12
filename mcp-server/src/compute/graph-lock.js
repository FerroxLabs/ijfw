// IJFW v1.3.0 -- D2 graph-write lock.
//
// Source authority: D-PILLAR-SPEC.md section 5.
//
// Coordinates symbol-graph writes with the existing scan-state lock and
// session-counter lock. Each lock owns a separate concern and lives in a
// separate file under `<projectRoot>/.ijfw/`:
//
//   .scan-state.lock      -- Phase 3 cold scan resume coordination
//   .session-counter.lock -- session counter atomicity
//   .graph-write.lock     -- D2 kg_nodes/kg_edges write coordination
//
// Pattern (mirrors scan-resume.js acquireScanLock):
//   - Exclusive create via `wx` flag (noclobber CAS).
//   - Lock content: `${pid}\n${epoch_ms}\n`
//   - Stale reclamation: 60s OR dead PID.
//   - Reader (BFS traversal) does NOT acquire -- WAL mode handles reads.
//
// Concurrent invocation behavior (per D-PILLAR-SPEC section 5):
//   - Writer #1 acquires; writer #2 waits up to 5s polling, then errors
//     with EBUSY_GRAPH_WRITE.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOCK_FILE = '.graph-write.lock';
const LOCK_STALE_MS = 60_000;
const ACQUIRE_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

function lockPath(projectRoot) {
  return join(String(projectRoot), '.ijfw', LOCK_FILE);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function reclaimIfStale(lp) {
  if (!existsSync(lp)) return;
  let raw;
  try { raw = readFileSync(lp, 'utf8'); } catch { return; }
  const lines = String(raw).split(/\r?\n/);
  const pid = Number(lines[0]);
  const ts = Number(lines[1]);
  const ageOk = Number.isFinite(ts) && (Date.now() - ts) <= LOCK_STALE_MS;
  if (isPidAlive(pid) && ageOk) return;
  try { unlinkSync(lp); } catch { /* best-effort */ }
}

/**
 * acquireGraphWriteLock(projectRoot, opts?) -> { released } | throws
 *
 * Acquires the graph-write lock with up to ACQUIRE_WAIT_MS of busy
 * polling. Throws EBUSY_GRAPH_WRITE on timeout. Returns a handle whose
 * `released()` method releases the lock; idempotent.
 *
 * opts.waitMs (default ACQUIRE_WAIT_MS) -- caller-overridable for tests.
 */
export function acquireGraphWriteLock(projectRoot, opts = {}) {
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : ACQUIRE_WAIT_MS;
  const dir = join(String(projectRoot), '.ijfw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lp = lockPath(projectRoot);

  const deadline = Date.now() + waitMs;
  while (true) {
    reclaimIfStale(lp);
    const payload = String(process.pid) + '\n' + String(Date.now()) + '\n';
    try {
      writeFileSync(lp, payload, { encoding: 'utf8', flag: 'wx' });
      let released = false;
      return {
        released: () => {
          if (released) return;
          released = true;
          try { unlinkSync(lp); } catch { /* best-effort */ }
        },
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    if (Date.now() >= deadline) {
      const e = new Error(
        'EBUSY_GRAPH_WRITE: another writer holds .ijfw/.graph-write.lock; ' +
        `waited ${waitMs}ms.`
      );
      e.code = 'EBUSY_GRAPH_WRITE';
      throw e;
    }
    // Tight polling -- 50ms cadence is fine for short writes.
    sleepSync(POLL_INTERVAL_MS);
  }
}

// Synchronous sleep -- used inside acquireGraphWriteLock's polling loop.
// Atomics.wait on a SharedArrayBuffer-backed Int32Array is the standard
// Node sync-sleep idiom. No new deps.
function sleepSync(ms) {
  const ab = new SharedArrayBuffer(4);
  const ia = new Int32Array(ab);
  Atomics.wait(ia, 0, 0, ms);
}

export const __test = { lockPath, LOCK_STALE_MS, ACQUIRE_WAIT_MS };
