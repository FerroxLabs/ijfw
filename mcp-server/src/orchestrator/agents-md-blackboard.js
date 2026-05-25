/**
 * agents-md-blackboard.js — populate the AGENTS.md BLACKBOARD marker block.
 *
 * v1.5.0 S4 (initial landing): shelled out to
 *   claude/skills/ijfw-agents-md/scripts/merge-block-aware.sh
 * under `withFsLock(.AGENTS.md.lock)` via `execFile('bash', …)`. That
 * pattern HELD an fs-lock across a subprocess spawn — a STATE-SDK-CONTRACT
 * §3 violation:
 *     "No lock is held across a subprocess spawn. `merge-block-aware.sh` is
 *      ported to in-process JS (T8); any unavoidable spawn pre-renders its
 *      payload and runs outside the lock."
 *
 * v1.5.0 T8 (this rewrite):
 *   - The shell script is ported to in-process JS at
 *     `./merge-block-aware.js` (single-pair AGENTS.md block merge with
 *     parity-tested semantics — see `test-merge-block-aware.js`).
 *   - The AGENTS.md write happens under `withFsLock(lockPathFor(<AGENTS.md>))`
 *     — i.e. the STATE-SDK-CONTRACT §3 #8 tier lock — using the SAME lock
 *     primitive every other state writer uses. No subprocess is ever
 *     spawned anywhere in the call graph; the critical section is
 *     read → mergeBlocks() → writeAtomic().
 *   - The blackboard refresh is registered with the SDK as a fire-and-forget
 *     observability event via `query('event.emit', …)` AFTER the lock is
 *     released. This is the SDK-routing requirement from the T8 brief
 *     ("Blackboard writes route through verbs"): every blackboard write
 *     emits an `agents-md.blackboard.set` event, classifiable by replay.
 *
 * SDK-VERB GAP — T8-followup-1 (mirror of T7-followup-1):
 *   The frozen 20-verb state-SDK contract (`.planning/v150-gap-closure/
 *   STATE-SDK-CONTRACT.md` §7+§8) does NOT include a verb that writes
 *   `<projectRoot>/AGENTS.md`. The contract §1 table lists this module
 *   ("agents-md-blackboard.js (T8)") as the sole writer for the BLACKBOARD
 *   marker block, and the contract §3 lock hierarchy assigns AGENTS.md to
 *   tier #8 — but no verb signature emits that write today. T8 closes the
 *   subprocess-under-lock violation in-process; absorbing the actual file
 *   write into a future `agents-md.blackboard.set` verb is deferred to a
 *   later contract amendment (do-not-touch state-sdk.js per the T8 brief).
 *   The §3 #8 lock IS taken, the §3 §4 ordering invariant holds (no other
 *   tier locks are acquired by this writer), and the SDK is notified of the
 *   write via the `event.emit` verb after release — so the absence of a
 *   dedicated verb is purely a contract-API gap, not a correctness gap.
 *
 * Failure handling: non-throwing. Returns `{ok, reason?, error?}` so a
 * missing AGENTS.md / missing template / write-error degrades the blackboard
 * refresh to advisory (the wave-state checkpoint must never be blocked by an
 * AGENTS.md hiccup — see `wave-state.js#checkpointWave`).
 */

import { join } from 'node:path';

import { withFsLock, lockPathFor } from '../fs-lock.js';
import { readWaveState } from './wave-state.js';
import { mergeFile, MergeBlockAwareError } from './merge-block-aware.js';
import { query } from './state-sdk.js';
import {
  selectDisciplineTemplate,
  detectProjectTypeFromRepo,
} from './discipline-selector.js';
import { validateSafeRepoPath } from '../brain/path-guard.js';

/**
 * Render the BLACKBOARD marker-block payload from a wave's STATE.md
 * frontmatter slice. Stable shape — consumers (humans + the dashboard's
 * BLACKBOARD lens) read these keys directly.
 *
 * @param {string} waveId
 * @param {object} state  parsed STATE.md (`readWaveState` result)
 * @returns {string}      pretty-printed JSON (2-space indent — matches v1.5.0 S4)
 */
function renderBlackboardPayload(waveId, state) {
  const fm = state?.frontmatter || {};
  return JSON.stringify({
    wave_id: waveId,
    state_path: `.ijfw/wave-${waveId}/STATE.md`,
    status: fm.status,
    claims_active: fm.claims_active ?? 0,
    blockers_open: fm.blockers_open ?? [],
    findings_recent: fm.findings_recent ?? [],
    updated_at: new Date().toISOString(),
  }, null, 2);
}

/**
 * Refresh the BLACKBOARD marker block in `<projectRoot>/AGENTS.md` from the
 * given wave's STATE.md. Held under the §3 #8 AGENTS.md lock; in-process
 * (no spawn). Best-effort SDK event emit after lock release.
 *
 * Return shapes:
 *   `{ ok: true }`                          — wrote AGENTS.md
 *   `{ ok: false, reason: 'no-state' }`     — wave STATE.md absent (skip)
 *   `{ ok: false, reason: 'merge-error', error }`  — merger threw
 *
 * @param {string} waveId
 * @param {string} projectRoot
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function populateBlackboardBlock(waveId, projectRoot) {
  const state = await readWaveState(waveId, projectRoot);
  if (!state) return { ok: false, reason: 'no-state' };

  const payload = renderBlackboardPayload(waveId, state);
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const guard = validateSafeRepoPath(projectRoot, agentsMdPath);
  if (!guard.ok) return { ok: false, reason: 'unsafe-path', error: guard.error };
  const lockPath = lockPathFor(agentsMdPath);

  let mergeResult;
  let mergeError = null;
  try {
    mergeResult = await withFsLock(lockPath, async () => mergeFile(
      agentsMdPath,
      [{ block: 'BLACKBOARD', content: payload }],
    ));
  } catch (err) {
    mergeError = err;
  }

  if (mergeError) {
    // Surface the same shape callers expected from the legacy
    // `execFile`-of-merger failure mode: ok:false + a reason + an error
    // string. `reason` is the canonical T8 replacement for the v1.5.0 S4
    // `merger-failed`/`merger-missing` strings (the merger is now in-
    // process — the failure surface is "merge-error").
    const code = mergeError instanceof MergeBlockAwareError ? mergeError.code : null;
    return {
      ok: false,
      reason: code === 'ERR_TEMPLATE_MISSING' ? 'template-missing' : 'merge-error',
      error: String(mergeError.message || mergeError),
    };
  }

  // SDK-routed observability event — fire-and-forget AFTER the lock has been
  // released. STATE-SDK-CONTRACT §5 (Model 3): the event tap is observability,
  // not state. Failure here is swallowed (advisory by design).
  //
  // `event.emit` requires `subagentId` + `waveId` (both stable from the
  // checkpoint context). `dedupKey` uses the file bytes + waveId so two
  // identical refreshes within the same wave are idempotent on the event
  // log (matches the §6 append/dedup semantics).
  try {
    await query('event.emit', {
      subagentId: 'parent',
      waveId,
      eventType: 'agents-md.blackboard.set',
      data: {
        path: mergeResult?.path ?? agentsMdPath,
        bytes: mergeResult?.bytes ?? 0,
        seeded: !!mergeResult?.seeded,
        wave_status: state?.frontmatter?.status ?? null,
      },
      dedupKey: `agents-md.blackboard.set:${waveId}:${mergeResult?.bytes ?? 0}`,
    }, { projectRoot, subagentId: 'parent' });
  } catch {
    // Observability is best-effort; never demote a successful AGENTS.md
    // rewrite because the event tap had a hiccup.
  }

  return { ok: true };
}

/**
 * Populate the DISCIPLINE marker block in `<projectRoot>/AGENTS.md` with the
 * project-appropriate discipline template body. Held under the §3 #8 AGENTS.md
 * lock; in-process (no spawn). Best-effort SDK event emit after lock release.
 *
 * If `projectType` is not supplied, `detectProjectTypeFromRepo(projectRoot)`
 * is called to infer it. For `unknown` / `mixed` types the DISCIPLINE block
 * is written with an empty body (marker present, body empty) -- this is the
 * correct state, not an error.
 *
 * Return shapes:
 *   `{ ok: true }`                               -- wrote AGENTS.md
 *   `{ ok: false, reason: 'merge-error', error }` -- merger threw
 *   `{ ok: false, reason: 'template-missing', error }` -- template file absent
 *
 * @param {string} projectRoot
 * @param {string} [projectType]  optional; inferred when absent
 * @returns {Promise<{ok: boolean, reason?: string, error?: string}>}
 */
export async function populateDisciplineBlock(projectRoot, projectType) {
  const type = projectType !== undefined && projectType !== null
    ? String(projectType)
    : detectProjectTypeFromRepo(projectRoot);

  let content;
  try {
    content = selectDisciplineTemplate(type);
  } catch (err) {
    return {
      ok: false,
      reason: 'template-missing',
      error: String(err.message || err),
    };
  }

  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const guard = validateSafeRepoPath(projectRoot, agentsMdPath);
  if (!guard.ok) return { ok: false, reason: 'unsafe-path', error: guard.error };
  const lockPath = lockPathFor(agentsMdPath);

  let mergeResult;
  let mergeError = null;
  try {
    mergeResult = await withFsLock(lockPath, async () => mergeFile(
      agentsMdPath,
      [{ block: 'DISCIPLINE', content }],
    ));
  } catch (err) {
    mergeError = err;
  }

  if (mergeError) {
    const code = mergeError instanceof MergeBlockAwareError ? mergeError.code : null;
    return {
      ok: false,
      reason: code === 'ERR_TEMPLATE_MISSING' ? 'template-missing' : 'merge-error',
      error: String(mergeError.message || mergeError),
    };
  }

  // SDK-routed observability event -- fire-and-forget AFTER lock release.
  // Mirrors the agents-md.blackboard.set emit pattern above.
  try {
    await query('event.emit', {
      subagentId: 'parent',
      waveId: 'discipline',
      eventType: 'agents-md.discipline.set',
      data: {
        path: mergeResult?.path ?? agentsMdPath,
        bytes: mergeResult?.bytes ?? 0,
        seeded: !!mergeResult?.seeded,
        project_type: type,
      },
      dedupKey: `agents-md.discipline.set:${projectRoot}:${type}`,
    }, { projectRoot, subagentId: 'parent' });
  } catch {
    // Observability is best-effort; never demote a successful AGENTS.md
    // rewrite because the event tap had a hiccup.
  }

  return { ok: true };
}
