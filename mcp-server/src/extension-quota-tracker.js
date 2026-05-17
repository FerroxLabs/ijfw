/**
 * extension-quota-tracker.js — IJFW v1.4.3 W9-A3 (B16)
 *
 * Per-extension resource quotas. Counter state lives at
 * `~/.ijfw/state/extension-quotas.json`. Every read-modify-write goes through
 * `withFsLock(~/.ijfw/state/extension-quotas.json.lock, fn, { staleMs })` so
 * cross-process tool invocations cannot race the counter (SEC-H-01).
 *
 * "Session" semantics (SEC-M-02): one activation = one quota window. Counters
 * reset on `activate <name>` AND on `deactivate`. NO cumulative state across
 * activate/deactivate boundaries — a re-activated extension gets a clean slate.
 *
 * Wall-clock dimension (SEC-M-02): never incremented; computed on each check
 * as `Date.now() - activated_at`.
 *
 * Threat boundary (ARCH-M-01): API-level accounting, NOT OS-level resource
 * limits. See docs/EXTENSION-SECURITY.md.
 *
 * Frozen contract: `getQuotaUsage` return shape is the integration point with
 * B19 dashboard. See docstring on that function.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import { withFsLock } from './fs-lock.js';

const STATE_REL = ['.ijfw', 'state', 'extension-quotas.json'];

// R12-L-02 — acquireTimeoutMs sizing rationale.
//
// Default fs-lock timeout is 5s. That ceiling is wrong for THIS lock for a
// specific, measured reason: the quota tracker is the single chokepoint for
// every concurrent tool dispatch on a session. With BACKOFF_MAX_MS=250ms in
// fs-lock.js and ~100 contending Promise.all callers, the worst-case wait
// approaches `100 * 250ms = 25s`. The 100-parallel correctness test in
// test-extension-quota-tracker.js exercises exactly this; we pin
// QUOTA_LOCK_TIMEOUT_MS=30_000 with one second of margin.
//
// staleMs stays at 30_000 (crash recovery, unrelated to acquisition latency).
//
// Audit history: codex+gemini R12 flagged the literal 30_000 as "too long for
// hot path". The audit was treating the timeout as the *typical* wait when in
// reality it's the worst-case ceiling under a workload the test suite
// explicitly covers. Lowering it broke that test (see commits 45389ff +
// a996abd in the R12-fix branch).
const QUOTA_LOCK_TIMEOUT_MS = 30_000;
const QUOTA_LOCK_STALE_MS = 30_000;

/** Public dimensions. Manifest-side names are `max_<dim>`. */
export const QUOTA_DIMENSIONS = Object.freeze([
  'files_written',
  'bytes_written',
  'wall_clock_ms',
]);

function homeFromOpts(opts) {
  if (opts && opts.homeDir) return opts.homeDir;
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function statePath(home) {
  return join(home, ...STATE_REL);
}

function lockPath(home) {
  return statePath(home) + '.lock';
}

/**
 * Ensure ~/.ijfw/state exists before withFsLock tries to mkdir the lock
 * directory inside it. Cheap idempotent — first caller creates, subsequent
 * callers no-op. Without this, the first quota call on a fresh HOME would
 * ENOENT (parent missing).
 */
async function ensureStateDir(home) {
  await mkdir(dirname(statePath(home)), { recursive: true });
}

/**
 * Read raw quota state from disk. Returns `{}` when missing or unparseable.
 * Caller is responsible for holding `withFsLock` for R/M/W flows.
 */
export async function readQuotaState(home) {
  const h = home || homeFromOpts({});
  try {
    const raw = await readFile(statePath(h), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Atomic tmp+rename write of the entire quota state file. MUST be called
 * inside `withFsLock`.
 */
export async function writeQuotaState(home, state) {
  const h = home || homeFromOpts({});
  const path = statePath(h);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function emptyExt() {
  return {
    files_written: { current: 0, writes_by_path: {} },
    bytes_written: { current: 0 },
    activated_at: null,
  };
}

function ensureExt(state, extName) {
  if (!state[extName]) state[extName] = emptyExt();
  // Defensive: fill missing sub-fields so callers in older state files don't
  // crash. Reading is permissive; writing is canonical.
  if (!state[extName].files_written) state[extName].files_written = { current: 0, writes_by_path: {} };
  if (!state[extName].files_written.writes_by_path) state[extName].files_written.writes_by_path = {};
  if (typeof state[extName].files_written.current !== 'number') state[extName].files_written.current = 0;
  if (!state[extName].bytes_written) state[extName].bytes_written = { current: 0 };
  if (typeof state[extName].bytes_written.current !== 'number') state[extName].bytes_written.current = 0;
  if (state[extName].activated_at === undefined) state[extName].activated_at = null;
  return state[extName];
}

/**
 * checkAndIncrement(extName, dimension, increment, limit, opts)
 *
 * For `files_written`: `opts.path` provides the absolute path being written;
 * tracker deduplicates so writing the same file 10 times = 1 toward the cap.
 *
 * For `wall_clock_ms`: never incremented; the check compares
 * `Date.now() - activated_at` against `limit`. `increment` is ignored.
 *
 * Returns { allowed, current, limit, reason? }. When `limit` is null/undefined
 * (no quota declared), returns allowed=true and the current observed value.
 */
export async function checkAndIncrement(extName, dimension, increment, limit, opts = {}) {
  if (typeof extName !== 'string' || !extName) {
    return { allowed: false, current: 0, limit: limit ?? null, reason: 'invalid ext name' };
  }
  if (!QUOTA_DIMENSIONS.includes(dimension)) {
    return { allowed: false, current: 0, limit: limit ?? null, reason: `unknown dimension: ${dimension}` };
  }
  const home = homeFromOpts(opts);

  // Back-compat: no limit declared = no enforcement. Still record the
  // increment so getQuotaUsage reflects activity. EXCEPT wall_clock_ms which
  // is computed-not-stored, so skip the R/M/W entirely.
  const limitIsNull = limit === null || limit === undefined;

  await ensureStateDir(home);

  if (dimension === 'wall_clock_ms') {
    // Read-only path.
    return await withFsLock(lockPath(home), async () => {
      const state = await readQuotaState(home);
      const ext = state[extName];
      if (!ext || !ext.activated_at) {
        // Not active — wall clock is 0.
        return { allowed: true, current: 0, limit: limitIsNull ? null : limit };
      }
      const activatedMs = Date.parse(ext.activated_at);
      const elapsed = Number.isFinite(activatedMs) ? Math.max(0, Date.now() - activatedMs) : 0;
      if (!limitIsNull && elapsed > limit) {
        return {
          allowed: false,
          current: elapsed,
          limit,
          reason: `wall_clock_ms ${elapsed} > limit ${limit}`,
        };
      }
      return { allowed: true, current: elapsed, limit: limitIsNull ? null : limit };
    }, { staleMs: QUOTA_LOCK_STALE_MS, acquireTimeoutMs: QUOTA_LOCK_TIMEOUT_MS });
  }

  return await withFsLock(lockPath(home), async () => {
    const state = await readQuotaState(home);
    const ext = ensureExt(state, extName);

    let nextCurrent;
    if (dimension === 'files_written') {
      const path = opts && typeof opts.path === 'string' ? opts.path : null;
      if (path && ext.files_written.writes_by_path[path]) {
        // Already counted — dedupe.
        nextCurrent = ext.files_written.current;
      } else {
        nextCurrent = ext.files_written.current + (Number.isFinite(increment) ? increment : 1);
      }

      // Enforcement check BEFORE persisting the increment.
      if (!limitIsNull && nextCurrent > limit) {
        return {
          allowed: false,
          current: ext.files_written.current,
          limit,
          reason: `files_written ${nextCurrent} > limit ${limit}`,
        };
      }

      ext.files_written.current = nextCurrent;
      if (path) ext.files_written.writes_by_path[path] = true;
    } else {
      // bytes_written
      const inc = Number.isFinite(increment) ? increment : 0;
      nextCurrent = ext.bytes_written.current + inc;
      if (!limitIsNull && nextCurrent > limit) {
        return {
          allowed: false,
          current: ext.bytes_written.current,
          limit,
          reason: `bytes_written ${nextCurrent} > limit ${limit}`,
        };
      }
      ext.bytes_written.current = nextCurrent;
    }

    await writeQuotaState(home, state);
    return { allowed: true, current: nextCurrent, limit: limitIsNull ? null : limit };
  }, { staleMs: QUOTA_LOCK_STALE_MS, acquireTimeoutMs: QUOTA_LOCK_TIMEOUT_MS });
}

/**
 * resetExtensionQuotas(extName, opts) — clears all counters for one extension.
 * Called on `activate` (clears stale prior-session state) AND on `deactivate`.
 *
 * `opts.activated_at` may be passed to stamp the new activation window. When
 * omitted, the entry is removed entirely (deactivate semantics).
 */
export async function resetExtensionQuotas(extName, opts = {}) {
  if (typeof extName !== 'string' || !extName) return;
  const home = homeFromOpts(opts);
  await ensureStateDir(home);
  await withFsLock(lockPath(home), async () => {
    const state = await readQuotaState(home);
    if (opts && typeof opts.activated_at === 'string') {
      state[extName] = emptyExt();
      state[extName].activated_at = opts.activated_at;
    } else {
      delete state[extName];
    }
    await writeQuotaState(home, state);
  }, { staleMs: QUOTA_LOCK_STALE_MS, acquireTimeoutMs: QUOTA_LOCK_TIMEOUT_MS });
}

/**
 * getQuotaUsage(extName, opts) — frozen B19 contract.
 *
 * Shape:
 * {
 *   ext_name: string,
 *   activated_at: ISO string | null,
 *   dimensions: {
 *     files_written: { current: number, limit: number | null },
 *     bytes_written: { current: number, limit: number | null },
 *     wall_clock_ms: { current: number, limit: number | null }
 *   }
 * }
 *
 * `limit === null` → no quota declared for that dimension (chart renders
 * "unlimited"). Limits are sourced from `opts.limits` when provided (the
 * dashboard reads the active extension's manifest and passes them in);
 * otherwise null.
 *
 * For an extName with no recorded activity: returns the shape with zeros and
 * null limits. Never throws on missing extension.
 */
export async function getQuotaUsage(extName, opts = {}) {
  const home = homeFromOpts(opts);
  const limits = (opts && opts.limits) || {};
  await ensureStateDir(home);

  return await withFsLock(lockPath(home), async () => {
    const state = await readQuotaState(home);
    const ext = state[extName] || null;
    const filesCurrent = ext && ext.files_written ? (ext.files_written.current || 0) : 0;
    const bytesCurrent = ext && ext.bytes_written ? (ext.bytes_written.current || 0) : 0;
    let wallCurrent = 0;
    if (ext && ext.activated_at) {
      const t = Date.parse(ext.activated_at);
      if (Number.isFinite(t)) wallCurrent = Math.max(0, Date.now() - t);
    }
    const limitOrNull = (k) => {
      const v = limits[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    return {
      ext_name: extName,
      activated_at: ext && ext.activated_at ? ext.activated_at : null,
      dimensions: {
        files_written: { current: filesCurrent, limit: limitOrNull('max_files_written') },
        bytes_written: { current: bytesCurrent, limit: limitOrNull('max_bytes_written') },
        wall_clock_ms: { current: wallCurrent, limit: limitOrNull('max_wall_clock_ms') },
      },
    };
  }, { staleMs: QUOTA_LOCK_STALE_MS, acquireTimeoutMs: QUOTA_LOCK_TIMEOUT_MS });
}
