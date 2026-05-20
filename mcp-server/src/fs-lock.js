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
 *
 * v1.5.0 T3 — heartbeat-refreshed locks. The fixed-30s stale window wrongly
 * reclaimed locks held by *live* long-running verbs. `withFsLock` now accepts
 * a `heartbeatMs` option: while `fn` runs, the holder refreshes `holder.json`
 * (and the lock dir mtime) on that interval, so a concurrent caller's stale
 * check sees a *recent* `acquired_at` and keeps waiting. A genuinely dead
 * holder stops refreshing → its lock still ages past `staleMs` and becomes
 * reclaimable. The heartbeat interval is always cleared on release (success
 * or throw), so a leaked timer can never touch a recreated lock dir.
 *
 * v1.5.0 T3 also exports `canonicalLockOrder` — the STATE-SDK-CONTRACT §3
 * lock-hierarchy sort. It is the single source of truth for the coarse-to-fine
 * acquire-order so the state-SDK's `_withLocks` cannot deadlock.
 */

import {
  mkdir, writeFile, readFile, rm, stat, utimes,
} from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const BACKOFF_START_MS = 25;
const BACKOFF_MAX_MS = 250;
/**
 * Default heartbeat interval. The refresh cadence must be comfortably shorter
 * than any `staleMs` a caller picks, so a live holder always renews the lock
 * before a concurrent caller's stale check fires. Callers needing a smaller
 * `staleMs` (the state-SDK uses ~10s) pass an explicit `heartbeatMs`.
 */
const DEFAULT_HEARTBEAT_MS = 5000;

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
 * Refresh a held lock's freshness anchor. Rewrites `holder.json` with a fresh
 * `acquired_at` and bumps the lock directory's own mtime — both are anchors the
 * stale check consults, so refreshing both keeps the holder.json path AND the
 * R12-M-01 mtime-fallback path in agreement. Best-effort: a transient failure
 * (e.g. the dir is mid-release) is swallowed; the next tick retries.
 */
async function refreshHolder(lockPath, holder) {
  const now = Date.now();
  holder.acquired_at = now;
  try {
    await writeFile(
      join(lockPath, 'holder.json'),
      JSON.stringify(holder),
      'utf8',
    );
  } catch {
    // Lock dir may be mid-release. Harmless — next tick retries, or the
    // interval is about to be cleared.
  }
  try {
    const d = new Date(now);
    await utimes(lockPath, d, d);
  } catch {
    // Same rationale as above.
  }
}

/**
 * withFsLock(lockPath, fn, { staleMs, acquireTimeoutMs, heartbeatMs })
 *
 * See module docstring for contract details. `heartbeatMs` (v1.5.0 T3): while
 * `fn` runs, refresh the lock's freshness anchor on this interval so a live
 * long-running holder is never wrongly reclaimed as stale. Pass `0` to disable
 * the heartbeat (legacy fixed-window behaviour). Default: 5000ms.
 */
export async function withFsLock(lockPath, fn, opts = {}) {
  const staleMs =
    typeof opts.staleMs === 'number' ? opts.staleMs : DEFAULT_STALE_MS;
  const acquireTimeoutMs =
    typeof opts.acquireTimeoutMs === 'number'
      ? opts.acquireTimeoutMs
      : DEFAULT_ACQUIRE_TIMEOUT_MS;
  const heartbeatMs =
    typeof opts.heartbeatMs === 'number'
      ? opts.heartbeatMs
      : DEFAULT_HEARTBEAT_MS;

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

  // The holder object for THIS acquisition — the heartbeat refreshes it in
  // place so its `acquired_at` stays current while `fn` runs.
  let heldHolder = null;

  // Acquire loop. We try mkdir; if EEXIST, decide between waiting and stale
  // recovery; otherwise propagate the error.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      heldHolder = await tryAcquireOnce(lockPath);
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

  // Lock acquired — start the heartbeat, run fn, and ALWAYS clear + release.
  //
  // The heartbeat keeps a *live* long-running holder's lock fresh so a
  // concurrent caller never wrongly stale-reclaims it. The interval is cleared
  // in the `finally` before the lock dir is removed, so a leaked timer can
  // never touch a recreated lock dir. `unref()` ensures the interval cannot
  // keep the process alive on its own.
  let heartbeat = null;
  if (heartbeatMs > 0 && heldHolder) {
    heartbeat = setInterval(() => {
      // Fire-and-forget — refreshHolder swallows its own transient errors.
      refreshHolder(lockPath, heldHolder);
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  let fnResult;
  let fnError;
  try {
    fnResult = await fn();
  } catch (err) {
    fnError = err;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
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

// ===========================================================================
// v1.5.0 T3 — STATE-SDK-CONTRACT §3 canonical lock-hierarchy ordering.
//
// `canonicalLockOrder(targets)` sorts an arbitrary set of physical state-file
// paths into the exact coarse-to-fine acquire-order from §3 of
// `.planning/v150-gap-closure/STATE-SDK-CONTRACT.md`. A verb touching N files
// acquires its locks in this order and releases in reverse — because the order
// is total and deterministic, no two verbs can form a lock-ordering cycle, so
// the state-SDK is deadlock-free by construction.
//
// This lives in fs-lock.js (not state-sdk.js) so the ordering rule sits next
// to the lock primitive it governs — one module owns "how locks behave".
// ===========================================================================

/**
 * §3 tier table. Each entry: a tier number (1-based, the §3 list position) and
 * a `match(path)` predicate. The FIRST matching entry wins, so more-specific
 * patterns are listed where ambiguity could arise (none currently overlap).
 *
 * `sub(path)` extracts the same-tier discriminator (`waveId` / `subId`) so
 * multiple files at one tier sort deterministically by their natural ascending
 * order — §3 "sub-orders them by the natural ascending sort of the
 * discriminator". `null` when a tier has no discriminator.
 */
const LOCK_TIERS = [
  // #1 — intent journal (always first)
  { tier: 1, match: (p) => /[\\/]\.ijfw[\\/]state[\\/]intent-journal\.jsonl$/.test(p) },
  // #2 — workflow phase state
  { tier: 2, match: (p) => /[\\/]\.ijfw[\\/]state[\\/]workflow\.json$/.test(p) },
  // #3 — wave index
  { tier: 3, match: (p) => /[\\/]\.ijfw[\\/]state[\\/]waves\.json$/.test(p) },
  // #4 — per-wave STATE.md (sub-ordered by waveId)
  {
    tier: 4,
    match: (p) => /[\\/]\.ijfw[\\/]wave-[^\\/]+[\\/]STATE\.md$/.test(p),
    sub: (p) => {
      const m = /[\\/]\.ijfw[\\/]wave-([^\\/]+)[\\/]STATE\.md$/.exec(p);
      return m ? m[1] : null;
    },
  },
  // #5 — per-subagent checkpoint (sub-ordered by subId, then waveId)
  {
    tier: 5,
    match: (p) => /[\\/]\.ijfw[\\/]wave-[^\\/]+[\\/]subagent-[^\\/]+\.checkpoint\.json$/.test(p),
    sub: (p) => {
      const m = /[\\/]\.ijfw[\\/]wave-([^\\/]+)[\\/]subagent-([^\\/]+)\.checkpoint\.json$/.exec(p);
      // Discriminator: "<subId> <waveId>" — subId is the primary key per
      // §3, waveId breaks ties when one verb touches the same subId in two
      // waves (no current verb does, but the order stays total).
      return m ? `${m[2]} ${m[1]}` : null;
    },
  },
  // #6 — generated roster
  { tier: 6, match: (p) => /[\\/]\.ijfw[\\/]team[\\/]workflow\.json$/.test(p) },
  // #7 — decision / blocker append log
  { tier: 7, match: (p) => /[\\/]\.ijfw[\\/]blackboard[\\/]decisions\.jsonl$/.test(p) },
  // #8 — AGENTS.md blackboard rollup
  { tier: 8, match: (p) => /(^|[\\/])AGENTS\.md$/.test(p) },
  // #9 — Trident convergence telemetry
  { tier: 9, match: (p) => /[\\/]\.ijfw[\\/]telemetry[\\/]convergence\.json$/.test(p) },
  // #10 — per-subagent event log (sub-ordered by subId, then waveId)
  {
    tier: 10,
    match: (p) => /[\\/]\.ijfw[\\/]wave-[^\\/]+[\\/]events-[^\\/]+\.jsonl$/.test(p),
    sub: (p) => {
      const m = /[\\/]\.ijfw[\\/]wave-([^\\/]+)[\\/]events-([^\\/]+)\.jsonl$/.exec(p);
      return m ? `${m[2]} ${m[1]}` : null;
    },
  },
  // #11 — homedir active-extension state (always last — different fs root)
  { tier: 11, match: (p) => /[\\/]\.ijfw[\\/]state[\\/]active-extension\.json$/.test(p) },
];

/**
 * Natural ascending comparison for same-tier discriminators: numeric runs
 * compare numerically (so `W2 < W10`), non-numeric runs compare
 * lexicographically. Makes `wave-W1, wave-W2, wave-W10` sort in human order.
 */
function naturalCompare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const ra = String(a).match(/\d+|\D+/g) || [];
  const rb = String(b).match(/\d+|\D+/g) || [];
  const n = Math.min(ra.length, rb.length);
  for (let i = 0; i < n; i += 1) {
    const sa = ra[i];
    const sb = rb[i];
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const d = Number(sa) - Number(sb);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  if (ra.length !== rb.length) return ra.length < rb.length ? -1 : 1;
  return 0;
}

/** Classify one path -> its §3 tier descriptor. Unknown paths land at tier 99. */
function classify(path) {
  for (const t of LOCK_TIERS) {
    if (t.match(path)) {
      return { tier: t.tier, sub: t.sub ? t.sub(path) : null };
    }
  }
  // An unknown path is acquired AFTER every known tier — still deterministic
  // (sorts by path string), so a future/typo path can never wedge the order.
  return { tier: 99, sub: null };
}

/**
 * canonicalLockOrder(targets) — return `targets` sorted into the §3 canonical
 * coarse-to-fine acquire-order, de-duplicated. The total order is:
 *
 *   1. tier number ascending (§3 list position #1 … #11)
 *   2. within a tier, the natural ascending sort of the discriminator
 *      (`waveId` / `subId`) — §3 same-tier sub-ordering
 *   3. final tie-break on the full path string (keeps the order total even
 *      for paths a tier cannot otherwise distinguish)
 *
 * Pure + idempotent: `canonicalLockOrder(canonicalLockOrder(x))` deep-equals
 * `canonicalLockOrder(x)`. Callers are NOT trusted to pre-sort — the state-SDK
 * always routes its lock-target list through here (defense in depth).
 *
 * @param {string[]} targets  physical state-file paths (any order, may repeat)
 * @returns {string[]}  the §3-ordered, de-duplicated path list
 */
export function canonicalLockOrder(targets) {
  if (!Array.isArray(targets)) {
    throw new TypeError('canonicalLockOrder: targets must be a string[]');
  }
  const seen = new Set();
  const decorated = [];
  for (const path of targets) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError(
        `canonicalLockOrder: every target must be a non-empty string (got ${JSON.stringify(path)})`,
      );
    }
    if (seen.has(path)) continue;
    seen.add(path);
    decorated.push({ path, ...classify(path) });
  }
  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const s = naturalCompare(a.sub, b.sub);
    if (s !== 0) return s;
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
  return decorated.map((d) => d.path);
}

/**
 * lockPathFor(targetPath) — the dotfile-sibling lock path for a target, per
 * STATE-SDK-CONTRACT §1 ("Lock files are the dotfile sibling of each target",
 * e.g. `.ijfw/state/workflow.json` -> `.ijfw/state/.workflow.json.lock`).
 *
 * @param {string} targetPath  a physical state file path
 * @returns {string}  the lock directory path to pass to `withFsLock`
 */
export function lockPathFor(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new TypeError('lockPathFor: targetPath must be a non-empty string');
  }
  return join(dirname(targetPath), `.${basename(targetPath)}.lock`);
}
