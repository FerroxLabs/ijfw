/**
 * profile/path-policy.js — Cross-system profile bus, audit HIGH-4 hardening.
 *
 * The user-global profile is deliberately homedir-rooted and EXEMPT from the
 * per-project namespacing (store.js KEY INVARIANT) — that is what lets two host
 * processes in two repos converge on ONE file. The env overrides
 * `IJFW_PROFILE_DIR` / `IJFW_PROFILE_STATE_DIR` exist for tests and power users,
 * but returned VERBATIM they are a privilege-escalation surface (audit HIGH-4):
 *
 *   - a parent process can relocate the ENTIRE global profile out from under the
 *     user (defeating identity partitioning / leaking one user's profile to
 *     another), or
 *   - point the lock dir at a pre-created, attacker-owned location to STARVE all
 *     writers (a fleet-wide denial of service on the global write path).
 *
 * POLICY — `resolveOverrideDir(override)` returns the override ONLY when it is
 * safe; otherwise null (caller falls back to the default path):
 *
 *   1. Test context (NODE_ENV==='test' OR the node:test runner marker
 *      NODE_TEST_CONTEXT is set) → honored verbatim. The suite points the
 *      override at a fresh `os.tmpdir()` scratch dir per case; that is NOT under
 *      homedir, so without this carve-out every profile test would break. The
 *      marker is set by `node --test` in the worker process, so it cannot be
 *      forged by a non-test parent in production.
 *   2. Production → the resolved real path must live UNDER os.homedir() (no `..`
 *      escape, no symlinked component that re-points outside homedir — checked
 *      via realpathSync on the nearest existing ancestor), AND, where the dir
 *      already exists, be owned by the current uid (anti-pre-created-by-attacker).
 *      Anything else → null.
 *
 * DEFAULT PATH (the no-safe-override fallback) — `homedirProfileDefault`:
 *
 *   - Production → the real homedir path `join(os.homedir(), ...subParts)`,
 *     UNCHANGED. Real users get their real `~/.ijfw/profile` (and `~/.ijfw/state`).
 *   - Test context → a PROCESS-UNIQUE scratch dir under `os.tmpdir()`, NEVER the
 *     real homedir. So a profile test (or a test-context child) that performs a
 *     write WITHOUT setting IJFW_PROFILE_DIR/IJFW_PROFILE_STATE_DIR is silently
 *     ISOLATED instead of clobbering the user's real profile. This is the
 *     test-isolation leak fix: the prior design THROWied here, which closed the
 *     leak but was brittle (any forgetful future test hard-fails, and a wrapping
 *     try/catch could mask it). The auto-tmpdir default is self-healing — there is
 *     no code path under a test context that returns the real homedir profile.
 *
 * Zero deps, Node built-ins only. NO LLM calls.
 */

import { realpathSync, lstatSync, existsSync, mkdirSync } from 'node:fs';
import { homedir, userInfo, tmpdir } from 'node:os';
import { resolve, sep, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** True iff the process is running under a test runner. */
export function inTestContext(env = process.env) {
  if (env && String(env.NODE_ENV).toLowerCase() === 'test') return true;
  // node:test sets NODE_TEST_CONTEXT in the worker process; it is the canonical,
  // runner-set marker present for every `node --test` invocation.
  if (env && typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT) return true;
  return false;
}

/**
 * `isTestContext` — canonical name used by the fail-closed default guard
 * (`homedirProfileDefault`). Alias of `inTestContext`; both are exported so
 * older call sites and the audit HIGH-4 documentation keep resolving.
 */
export const isTestContext = inTestContext;

/** True iff `child` (already resolved) is `base` or strictly under it. */
function isUnder(base, child) {
  const b = resolve(base);
  const c = resolve(child);
  if (c === b) return true;
  return c.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Resolve the override to a REAL path, following symlinks on whatever portion of
 * the path already exists. A path whose existing ancestors realpath OUTSIDE
 * homedir (a symlinked component pointing away) is rejected by the caller via
 * the isUnder check on the returned real path. Returns the realpath of the
 * nearest existing ancestor joined with the remaining (non-existent) tail.
 */
function realResolved(p) {
  const abs = resolve(p);
  // Walk up to the nearest existing ancestor and realpath THAT (so a symlinked
  // existing component is dereferenced); re-append the not-yet-created tail.
  let cur = abs;
  const tail = [];
  // Guard against an unbounded loop on a pathological path.
  for (let i = 0; i < 4096; i += 1) {
    if (existsSync(cur)) {
      let real;
      try {
        real = realpathSync(cur);
      } catch {
        real = cur;
      }
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    tail.push(cur.slice(parent.length + 1));
    cur = parent;
  }
  return abs;
}

/** Current process uid, or null on platforms without uids (Windows). */
function currentUid() {
  try {
    const info = userInfo();
    return typeof info.uid === 'number' && info.uid >= 0 ? info.uid : null;
  } catch {
    return null;
  }
}

/**
 * resolveOverrideDir(override, env?) -> string|null.
 *
 * Returns the override to use, or null when the caller must fall back to the
 * default homedir path. See the module header for the full policy.
 */
export function resolveOverrideDir(override, env = process.env) {
  if (!override || !String(override).trim()) return null;

  // (1) Test context — honored verbatim so the suite's tmpdir scratch dirs work.
  if (inTestContext(env)) return override;

  // (2) Production — must resolve under homedir, no symlink escape.
  const home = realResolved(homedir());
  const real = realResolved(override);
  if (!isUnder(home, real)) return null;

  // Ownership: if the dir already exists it must be owned by the current uid
  // (an attacker-pre-created dir under a shared-home path is rejected). A
  // not-yet-existent dir is fine — we create it ourselves. uid-less platforms
  // (Windows) skip this leg; the homedir-containment check is the guard there.
  const uid = currentUid();
  if (uid != null) {
    const abs = resolve(override);
    if (existsSync(abs)) {
      try {
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) return null; // never honor a symlinked override dir
        if (typeof st.uid === 'number' && st.uid !== uid) return null;
      } catch {
        return null;
      }
    }
  }

  return override;
}

/**
 * Per-process root for the auto-isolated test-context profile scratch dirs.
 * Lazily created once per process, unique per pid+random so two test processes
 * (or a test parent and its spawned child) never collide on disk. Memoized so
 * every `homedirProfileDefault` call in one process agrees on the SAME path —
 * `profileDir()` and `profilePath()` and `profileStateDir()` must be stable
 * within a process or a read wouldn't find what a prior write put down.
 *
 * @type {string|null}
 */
let testScratchRoot = null;

/**
 * Resolve (creating once) the process-unique scratch root under os.tmpdir().
 * Kept out of homedir on purpose: an isolated tmpdir can NEVER be the user's
 * real profile, which is the whole point of the leak fix.
 */
function testScratchRootDir() {
  if (testScratchRoot) return testScratchRoot;
  const unique = `ijfw-test-profile-${process.pid}-${randomBytes(6).toString('hex')}`;
  testScratchRoot = join(tmpdir(), unique);
  try {
    mkdirSync(testScratchRoot, { recursive: true });
  } catch {
    // Best-effort: the consuming store/lock layer also mkdirs before writing.
    // If creation here races/fails, the path is still a tmpdir (never homedir),
    // so the isolation guarantee holds regardless.
  }
  return testScratchRoot;
}

/**
 * homedirProfileDefault(subParts, env?) -> string.
 *
 * The default profile path for a helper. Callers reach here ONLY when there is
 * NO safe override (resolveOverrideDir returned null).
 *
 *   - Production (non-test) → `join(os.homedir(), ...subParts)`, UNCHANGED.
 *   - Test context (NODE_ENV==='test' OR NODE_TEST_CONTEXT set) → a
 *     process-unique scratch dir under os.tmpdir(), so a test (or test-context
 *     child) that forgot to set IJFW_PROFILE_DIR/IJFW_PROFILE_STATE_DIR is
 *     ISOLATED to tmpdir and can never write into the user's real
 *     `~/.ijfw/profile`. See the module header for the rationale (auto-tmpdir is
 *     the robust successor to the prior fail-closed THROW).
 *
 * The same `subParts` always maps to the same path within one process (the
 * scratch root is memoized), so read-after-write inside a test works.
 *
 * @param {string[]} subParts path segments, e.g. ['.ijfw','profile']
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the real homedir default (prod) or an isolated tmpdir (test)
 */
export function homedirProfileDefault(subParts, env = process.env) {
  if (isTestContext(env)) {
    return join(testScratchRootDir(), ...subParts);
  }
  return join(homedir(), ...subParts);
}
