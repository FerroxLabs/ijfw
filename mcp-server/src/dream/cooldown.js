// IJFW v1.3.0 Alpha -- D3 dream-cycle cooldown helper.
//
// Reads / writes `.ijfw/.dream-state.json` to enforce a 4-hour cooldown
// between consolidation runs. Replaces the legacy `SESSION_NUM % 5 == 0`
// startup-flag mechanism: dream cycles now fire INLINE at SessionEnd via
// detached spawn (mirrors the Phase 3 cold-scan pattern).
//
// Atomic write contract: write to `<file>.tmp.<pid>` then rename to the
// canonical name. Crash-safe: a half-written tmp never replaces a good
// state file. Reader tolerates absent / malformed state by returning
// `{ onCooldown: false }` so a corrupted state file silently re-enables
// a run rather than locking dreams out forever.
//
// Discipline:
//   - ESM, zero deps.
//   - Hooks must never crash; every fs op caught and treated as "no
//     cooldown info available" -> safe to fire.
//   - 4-hour window is hardcoded; override via IJFW_DREAM_COOLDOWN_MS for
//     test fixtures (test-d3-dream-trigger.js relies on this).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 4 hours in ms. Override via env for test fixtures only -- the spec
// locks 4h as the production value.
export const COOLDOWN_MS_DEFAULT = 4 * 60 * 60 * 1000;

function cooldownMs() {
  const override = Number(process.env.IJFW_DREAM_COOLDOWN_MS);
  return Number.isFinite(override) && override >= 0 ? override : COOLDOWN_MS_DEFAULT;
}

function statePath(stateDir) {
  return join(stateDir, '.dream-state.json');
}

/**
 * Returns `true` when the last completed dream cycle finished within the
 * cooldown window. Returns `false` on any read failure (corrupt JSON,
 * absent file, missing dir) so dreams are never silently suppressed by
 * a partial / damaged state file.
 *
 * @param {string} stateDir -- typically `<projectRoot>/.ijfw`
 */
export function isOnCooldown(stateDir) {
  if (!stateDir) return false;
  try {
    const raw = readFileSync(statePath(stateDir), 'utf8');
    const obj = JSON.parse(raw);
    const lastRunAt = obj && obj.last_run_at;
    if (typeof lastRunAt !== 'string') return false;
    const t = Date.parse(lastRunAt);
    if (!Number.isFinite(t)) return false;
    const age = Date.now() - t;
    if (age < 0) return false; // clock skew -- treat as not-on-cooldown
    return age < cooldownMs();
  } catch {
    // Absent or corrupt -- treat as "no recent run", let dream fire.
    return false;
  }
}

/**
 * Atomically mark a dream cycle as completed. Writes
 * `{ last_run_at, version }` to a tmp file then renames into place so a
 * crash mid-write never leaves a half-formed state file.
 *
 * Returns `true` on success, `false` on any IO failure -- callers may
 * surface the failure in the dream log, but should NOT abort the run on
 * a bad mark; the runner finished successfully even if we couldn't
 * persist the timestamp.
 *
 * @param {string} stateDir -- typically `<projectRoot>/.ijfw`
 */
export function markCompleted(stateDir) {
  if (!stateDir) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    const target = statePath(stateDir);
    const tmp = `${target}.tmp.${process.pid}`;
    const payload = {
      version: 1,
      last_run_at: new Date().toISOString(),
    };
    writeFileSync(tmp, JSON.stringify(payload) + '\n', 'utf8');
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read raw state for diagnostic surfaces (`/ijfw doctor`, dream log).
 * Returns `null` on any failure.
 */
export function readState(stateDir) {
  if (!stateDir) return null;
  try {
    const raw = readFileSync(statePath(stateDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
