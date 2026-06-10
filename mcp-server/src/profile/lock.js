/**
 * profile/lock.js — Cross-system profile bus, P0.4.
 *
 * The GLOBAL profile lock. Concurrency is a first-class threat (design-v2 §7
 * "Concurrency", audit HIGH): N per-repo SessionEnd cycles all write ONE global
 * file. The per-repo dream lock does NOT cover that contention, so this is a
 * SEPARATE, user-global lock at `~/.ijfw/state/.profile.lock`.
 *
 * It reuses the proven `withFsLock` directory-lock primitive (atomic mkdir,
 * heartbeat-refreshed, stale-recovering). All profile writes (P0.5 merge) MUST
 * route through `withProfileLock`, and the read-merge-write + backup all happen
 * INSIDE the held lock so two converging processes can never lose an update.
 *
 * Zero deps beyond the existing fs-lock. NO LLM calls.
 */

import { join } from 'node:path';

import { withFsLock } from '../fs-lock.js';
import { resolveOverrideDir, homedirProfileDefault } from './path-policy.js';

/**
 * The user-global state directory. Override via IJFW_PROFILE_STATE_DIR (tests).
 * Default `~/.ijfw/state`. Homedir-rooted, NOT REPO_ROOT — the lock is global,
 * matching the global file it protects.
 *
 * SECURITY (audit HIGH-4): a verbatim override lets a parent point the lock at a
 * pre-created/attacker-owned dir to STARVE all writers (fleet-wide DoS on the
 * global write path). `resolveOverrideDir` honors the override only under a test
 * runner OR when it resolves under os.homedir() and is uid-owned; otherwise we
 * fall back to the default homedir path.
 *
 * TEST-ISOLATION: with no safe override, the default is resolved by
 * `homedirProfileDefault`, which under a test context returns a process-unique
 * `os.tmpdir()` scratch dir (never the real homedir) — so a profile test that
 * forgot to set IJFW_PROFILE_STATE_DIR is auto-isolated and can never create the
 * real `~/.ijfw/state/.profile.lock`. Production behavior is unchanged.
 */
export function profileStateDir() {
  const safe = resolveOverrideDir(process.env.IJFW_PROFILE_STATE_DIR);
  if (safe) return safe;
  return homedirProfileDefault(['.ijfw', 'state']);
}

/** `~/.ijfw/state/.profile.lock` — distinct from any per-repo dream/wave lock. */
export function profileLockPath() {
  return join(profileStateDir(), '.profile.lock');
}

/**
 * withProfileLock(fn, opts?) — run `fn` under the global profile lock.
 * Forwards to withFsLock; callers may tune staleMs/acquireTimeoutMs but the
 * default heartbeat keeps a live long-running merge from being stale-reclaimed.
 *
 * `opts.lockPath` overrides the lock location (tests inject a per-case path so
 * concurrent test cases don't fight over one shared env-var-derived path).
 *
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function withProfileLock(fn, opts = {}) {
  const { lockPath, ...rest } = opts;
  return withFsLock(lockPath || profileLockPath(), fn, rest);
}
