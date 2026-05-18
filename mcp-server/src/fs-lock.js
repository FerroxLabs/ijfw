/**
 * fs-lock.js — Cross-platform directory-based exclusive lock primitive.
 *
 * Frozen contract for v1.4.3 W9-A (consumed by W9-A1 cache writes + W9-A3
 * quota counters). The directory itself is the lock; `mkdir` with
 * `recursive:false` is atomic on POSIX + Windows, so any two processes racing
 * to create the same path will see exactly one winner (EEXIST for the other).
 *
 * NO `process.on('exit')` cleanup. If a holder is SIGKILL'd between mkdir and
 * the `finally` clause, the next caller's stale-recovery path handles it
 * (single retry after rm).
 *
 * Closes SEC-H-01 (cross-process race) from v1.4.3 cross-audit round 1.
 */

import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const BACKOFF_START_MS = 25;
const BACKOFF_MAX_MS = 250;

export class FsLockBusyError extends Error {
  constructor(lockPath, timeoutMs) {
    super(
      `fs-lock: could not acquire "${lockPath}" within ${timeoutMs}ms (holder still alive)`,
    );
    this.name = 'FsLockBusyError';
    this.code = 'FS_LOCK_BUSY';
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export class FsLockStaleError extends Error {
  constructor(lockPath, cause) {
    super(
      `fs-lock: stale lock recovery failed for "${lockPath}"${
        cause ? `: ${cause.message || cause}` : ''
      }`,
    );
    this.name = 'FsLockStaleError';
    this.code = 'FS_LOCK_STALE';
    this.lockPath = lockPath;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHolder(lockPath) {
  try {
    const raw = await readFile(join(lockPath, 'holder.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.acquired_at === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    // holder.json may not exist yet (mkdir landed, write hadn't), or be
    // truncated. Treat as "no readable holder" — caller decides what to do.
    return null;
  }
}

async function tryAcquireOnce(lockPath) {
  await mkdir(lockPath, { recursive: false });
  // Write holder file inside the lock dir — purely forensic. The directory's
  // existence is what holds the lock.
  const holder = { pid: process.pid, acquired_at: Date.now() };
  try {
    await writeFile(
      join(lockPath, 'holder.json'),
      JSON.stringify(holder),
      'utf8',
    );
  } catch {
    // Best-effort. The lock is still held even if forensic write failed.
  }
  return holder;
}

/**
 * withFsLock(lockPath, fn, { staleMs, acquireTimeoutMs })
 *
 * See module docstring for contract details.
 */
export async function withFsLock(lockPath, fn, opts = {}) {
  const staleMs =
    typeof opts.staleMs === 'number' ? opts.staleMs : DEFAULT_STALE_MS;
  const acquireTimeoutMs =
    typeof opts.acquireTimeoutMs === 'number'
      ? opts.acquireTimeoutMs
      : DEFAULT_ACQUIRE_TIMEOUT_MS;

  // Ensure the lock's parent directory exists. `tryAcquireOnce` uses
  // `mkdir(lockPath, { recursive: false })` which fails with ENOENT when any
  // parent is missing — surfacing as a non-EEXIST error and breaking callers
  // that expect locks to "just work" in fresh tmp HOMEs. Single best-effort
  // recursive mkdir up-front is cheap (one stat on the common case) and makes
  // the lock primitive safe to invoke against any path under a writable root.
  // Surfaced as a Windows CI regression in v1.4.3 (test-extension-registry
  // tests 523/527/534/535 — Linux/macOS passed only because earlier tests
  // happened to create ~/.ijfw/state by side-effect).
  try {
    await mkdir(dirname(lockPath), { recursive: true });
  } catch {
    // Ignore — the subsequent mkdir(lockPath) will surface a clearer error.
  }

  const deadline = Date.now() + acquireTimeoutMs;
  let staleRecoveryUsed = false;
  let backoff = BACKOFF_START_MS;

  // Acquire loop. We try mkdir; if EEXIST, decide between waiting and stale
  // recovery; otherwise propagate the error.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tryAcquireOnce(lockPath);
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') {
        // Real filesystem error (ENOENT on parent, EACCES, etc.) — surface.
        throw err;
      }

      // R12-M-01: when holder.json is missing or unparseable (crash between
      // mkdir and the holder write, OR an attacker pre-creating an empty lock
      // dir to starve callers), fall back to the lock directory's own mtime so
      // stale-recovery can still fire. Without this fallback the local-DoS
      // surface is "mkdir <lockPath> && walk away".
      const holder = await readHolder(lockPath);
      let age = null;
      if (holder) {
        age = Date.now() - holder.acquired_at;
      } else {
        try {
          const st = await stat(lockPath);
          age = Date.now() - st.mtimeMs;
        } catch {
          // The lock dir vanished between EEXIST and stat — fall through to
          // the deadline check; the next loop iteration will try mkdir again.
          age = null;
        }
      }
      const isStale = age != null && age > staleMs;

      if (isStale && !staleRecoveryUsed) {
        staleRecoveryUsed = true;
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch (rmErr) {
          throw new FsLockStaleError(lockPath, rmErr);
        }
        try {
          await tryAcquireOnce(lockPath);
          break;
        } catch (retryErr) {
          if (retryErr && retryErr.code === 'EEXIST') {
            throw new FsLockStaleError(lockPath, retryErr);
          }
          throw retryErr;
        }
      }

      if (Date.now() >= deadline) {
        throw new FsLockBusyError(lockPath, acquireTimeoutMs);
      }

      // Bounded exponential backoff; clamp to remaining time so we don't
      // overshoot the deadline by a full BACKOFF_MAX_MS slice.
      const remaining = Math.max(0, deadline - Date.now());
      const waitMs = Math.min(backoff, BACKOFF_MAX_MS, remaining);
      if (waitMs > 0) await sleep(waitMs);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  // Lock acquired — run fn and ALWAYS release.
  let fnResult;
  let fnError;
  try {
    fnResult = await fn();
  } catch (err) {
    fnError = err;
  }

  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch {
    // Release failures don't override the caller's result/error. The next
    // caller's stale-recovery will reclaim if needed.
  }

  if (fnError !== undefined) throw fnError;
  return fnResult;
}
