/**
 * profile/derive.js — Cross-system profile bus, PHASE P3.2.
 *
 * THE FALLBACK LADDER (moat-critical). deriveProfile() composes the two derive
 * tiers into ONE merged ProfileDelta the merge layer folds at SessionEnd:
 *
 *   RUNG 1 (always): deriveHeuristic() — the zero-LLM FLOOR. This is the default
 *     that carries the profile. It runs unconditionally, with no network, ever.
 *
 *   RUNG 2 (only if a LOCAL model is configured): deriveDialectic() — a bounded,
 *     corroborated local-LLM pass whose inferences ADD ON TOP of the heuristic
 *     floor (dialectic never overrides heuristic style/expertise; it only
 *     contributes additional, low-confidence, cross-session-corroborated
 *     inferences).
 *
 * SILENT-CLOUD PREVENTION (the whole point):
 *   - A LOCAL transport is used iff IJFW_PROFILE_LOCAL_URL (or the reused brain
 *     local tier endpoint IJFW_BRAIN_LOCAL_URL) is set, OR a test injects one.
 *   - On local-LLM ABSENT or ERROR -> heuristic-only. We NEVER silently fall
 *     through to a cloud model.
 *   - A CLOUD transport runs ONLY when BOTH (a) IJFW_PROFILE_CLOUD_OPT_IN is
 *     explicitly set AND (b) an explicit cloud transport is injected. This
 *     module NEVER CONSTRUCTS a cloud transport itself — so even with the opt-in
 *     flag, absent an injected cloud caller, nothing networks. That makes the
 *     silent-cloud path STRUCTURALLY impossible, not merely policy-gated.
 *
 * The default LOCAL transport here is a self-contained Ollama-compatible fetch
 * caller (re-implemented locally, NOT imported from brain/tiered-llm.js) so this
 * module's import graph never reaches the cloud path. serve/render modules must
 * never import derive.js / derive-dialectic.js — the P4.5 import-graph moat guard
 * depends on that, and this module keeps itself self-contained to preserve it.
 *
 * Zero deps. ESM. Node built-ins only.
 */

import { deriveHeuristic } from './derive-heuristic.js';
import { deriveDialectic } from './derive-dialectic.js';

/**
 * Resolve the LOCAL model endpoint. Prefer the profile-specific override, then
 * reuse the brain's local tier endpoint (so a user who already runs a local
 * model for the dream cycle gets profile dialectic for free). NEVER returns a
 * cloud endpoint.
 */
export function resolveLocalUrl(env = process.env) {
  const e = env || {};
  const u = e.IJFW_PROFILE_LOCAL_URL || e.IJFW_BRAIN_LOCAL_URL;
  return typeof u === 'string' && u.trim() ? u.trim() : null;
}

/**
 * A self-contained Ollama-compatible local transport. Re-implemented here (NOT
 * imported from tiered-llm.js) so derive.js's import graph never reaches the
 * cloud caller. Single-response (stream:false) /api/generate.
 */
function makeLocalTransport(url) {
  return async ({ prompt, maxTokens, model }) => {
    const res = await fetch(url.replace(/\/$/, '') + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama3',
        prompt,
        stream: false,
        options: { num_predict: maxTokens },
      }),
    });
    if (!res.ok) throw new Error(`profile local LLM HTTP ${res.status}`);
    const data = await res.json();
    return { text: (data && data.response) || '', via: 'local' };
  };
}

/**
 * deriveProfile(signals, opts) -> Promise<ProfileDelta>.
 *
 * @param {object} signals  the same bundle deriveHeuristic reads:
 *   { metadata?, outcomes?, feedback?, style?, sessionId?, host? }
 *   (`style` is the per-session metadata array the dialectic corroborates over;
 *   `metadata` is the CURRENT session's style metadata for the heuristic floor.)
 * @param {object} [opts]
 *   @param {object}   [opts.env]             defaults to process.env
 *   @param {Function} [opts._localTransport] test/override local transport
 *   @param {Function} [opts._cloudTransport] explicit cloud transport (opt-in only)
 *   @param {Function} [opts.log]             structured logger (degrades are LOGGED)
 *
 * ALWAYS returns the heuristic floor; ADDS dialectic inferences when a local (or
 * explicitly opted-in cloud) transport is available and succeeds. Never throws.
 */
export async function deriveProfile(signals = {}, opts = {}) {
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  // RUNG 1 — the zero-LLM heuristic floor. Always. Pure, no network.
  const heuristic = deriveHeuristic(signals || {});

  // Decide which transport (if any) may run the dialectic RUNG 2.
  //   - LOCAL: a configured local URL, OR an injected local transport.
  //   - CLOUD: ONLY with explicit opt-in AND an explicitly injected cloud
  //     transport. derive.js never constructs a cloud transport itself.
  const localUrl = resolveLocalUrl(env);
  let transport = null;
  let lane = null;
  if (typeof opts._localTransport === 'function') {
    transport = opts._localTransport;
    lane = 'local';
  } else if (localUrl) {
    transport = makeLocalTransport(localUrl);
    lane = 'local';
  } else if (env && env.IJFW_PROFILE_CLOUD_OPT_IN && typeof opts._cloudTransport === 'function') {
    // Explicit two-key gate: the flag AND an injected cloud caller. Without the
    // injected caller this branch is unreachable -> no silent cloud.
    transport = opts._cloudTransport;
    lane = 'cloud';
  }

  if (!transport) {
    // Heuristic-only. This is the default and the safe path (no local model
    // configured, or opt-in set but no cloud transport injected).
    return heuristic;
  }

  // RUNG 2 — bounded, corroborated dialectic. ADD ON TOP of the heuristic floor.
  let dialectic = { inferences: [] };
  try {
    dialectic = await deriveDialectic(signals || {}, {
      transport,
      host: signals && signals.host,
      sessionId: signals && signals.sessionId,
      log: (m) => log(`dialectic (${lane}): ${m}`),
    });
  } catch (err) {
    // Local/cloud error -> heuristic-only. LOGGED, never swallowed (the audit
    // flagged a swallowed-error class; we surface the degrade explicitly) and
    // NEVER a silent cloud fallback.
    log(`profile dialectic (${lane}) degraded to heuristic-only: ${err && err.message ? err.message : err}`);
    return heuristic;
  }

  const addInferences = Array.isArray(dialectic && dialectic.inferences)
    ? dialectic.inferences : [];
  if (addInferences.length === 0) {
    // Nothing to add (no corroboration / empty model output) — floor stands.
    return heuristic;
  }

  // MERGE: dialectic ADDS, never overrides. Concatenate inferences; the
  // CRDT merge (applyDelta) dedupes by id and keeps MAX confidence, so even if a
  // dialectic subject collides with a heuristic preference, the heuristic's
  // (higher) confidence wins on write — the floor is preserved by construction.
  const merged = { ...heuristic };
  merged.inferences = [...(heuristic.inferences || []), ...addInferences];
  return merged;
}

export default { deriveProfile, resolveLocalUrl };
