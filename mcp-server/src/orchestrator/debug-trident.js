/**
 * debug-trident.js — v1.5.0 T29 (W2): Trident-powered debug loop.
 *
 * The ijfw-debug stack (claude/agents/ijfw-debug-session-manager.md +
 * claude/agents/ijfw-debugger.md) drives a multi-cycle scientific-method
 * investigation: reproduce → hypothesise → falsify → resolve. Until W2 the
 * loop was *single-lens*: when the active hypothesis stalled (either
 * INVESTIGATION_INCONCLUSIVE or a byte-identical hypothesis tree two cycles
 * running), the only escape was to surface NEEDS_CONTEXT and ask the user
 * for more evidence. That collapses the debug strength of cross-AI
 * disagreement — a stuck Claude hypothesis tree is exactly where Codex's
 * dependency-call-graph reading or Gemini's broader-context cross-file
 * search would have produced a competing hypothesis the single lens missed.
 *
 * Moat #3 — "Trident-powered debug" — closes the gap by dispatching codex
 * and gemini lenses, in parallel, to generate competing hypotheses against
 * the same evidence pack. The lens responses are appended to the
 * hypothesis tree as new rows (status:'open') and the next cycle resumes
 * with a refreshed candidate set. A campaign exit telemetry record is
 * written via the state-SDK telemetry.record verb (kind:'debug-campaign').
 *
 * --------------------------------------------------------------------------
 * SCOPE — what this module is
 * --------------------------------------------------------------------------
 *
 *   * A pluggable orchestration shell (`runDebugCampaign`) that wraps an
 *     opaque per-cycle `dispatch` function — the same dependency-injection
 *     contract that runPhaseEConverge uses (cross-orchestrator.js §1190).
 *     The dispatch function returns one of the structured terminators the
 *     ijfw-debugger agent emits: ROOT_CAUSE_FOUND, INVESTIGATION_INCONCLUSIVE,
 *     CHECKPOINT_REACHED, TDD_CHECKPOINT, DEBUG_COMPLETE.
 *
 *   * Stall detection — two adjacent cycles whose hypothesis-tree signature
 *     is byte-identical OR an INVESTIGATION_INCONCLUSIVE terminator => the
 *     loop escalates to a Trident hypothesis-gen sub-step.
 *
 *   * Cross-lens hypothesis generation — calls `tridentDispatch({ lens,
 *     evidencePack, currentHypotheses })` for each non-stalled lens
 *     (default: codex + gemini, claude excluded because it owns the stall).
 *     The dispatcher is injected; production wires it through the existing
 *     cross-dispatcher.js MCP CLI surface, tests stub it.
 *
 *   * Hypothesis-tree merge — new candidates are appended with provenance
 *     `from:'trident:codex'` / `from:'trident:gemini'` so the receipt
 *     captures which lens contributed which hypothesis.
 *
 *   * Telemetry — `telemetry.record({ kind:'debug-campaign', metrics })`
 *     where metrics ⊇ { cycles, stalls, tridentInvocations, hypothesesAdded,
 *     hypothesesCompetingCount, resolved, resolutionLens }.
 *
 * --------------------------------------------------------------------------
 * NON-SCOPE — what this module is NOT
 * --------------------------------------------------------------------------
 *
 *   * The investigator. ijfw-debugger.md owns scientific method; this
 *     module orchestrates lens dispatch around the existing investigator
 *     contract.
 *
 *   * The state writer for checkpoint files. The session-manager agent
 *     persists `<session_id>.state.json` and `HYPOTHESES.md`; this module
 *     accepts them as opaque structured input.
 *
 *   * A consumer of state-sdk write-locks beyond `telemetry.record`. The
 *     campaign itself is in-memory; only the exit telemetry is persisted.
 *
 * Zero new prod deps. ESM. Node ≥18. No emoji.
 */

import { query as stateQuery } from './state-sdk.js';

/**
 * Reasons the campaign loop terminates. Surfaced on the return value as
 * `outcome` so callers can branch and the receipt can render a one-line
 * narrative without re-deriving from cycle history.
 */
export const DEBUG_OUTCOMES = Object.freeze({
  RESOLVED:     'resolved',
  ROOT_CAUSE:   'root_cause_found',
  CHECKPOINT:   'awaiting_context',
  EXHAUSTED:    'cycles_exhausted',
  TRIDENT_DRY:  'trident_no_new_hypotheses',
  FAILED:       'campaign_failed',
});

/**
 * Stall signature — a stable, order-independent serialization of the
 * current open hypothesis tree. Used to detect "no new ground covered" two
 * cycles in a row. Sorting both the row list and the per-row key set means
 * two trees with identical content but different insertion order produce
 * the same signature.
 *
 * Input shape (matches HYPOTHESES.md table):
 *   [{ id:'H1', hypothesis:'…', status:'open|testing|confirmed|refuted',
 *      evidence:'…', refuted_by:'…' }, …]
 */
export function hypothesisTreeSignature(hypotheses) {
  if (!Array.isArray(hypotheses) || hypotheses.length === 0) return '';
  const rows = hypotheses.map((row) => {
    if (!row || typeof row !== 'object') return '';
    const keys = Object.keys(row).sort();
    const parts = keys.map((k) => `${k}=${JSON.stringify(row[k] ?? '')}`);
    return parts.join('|');
  });
  rows.sort();
  return rows.join('||');
}

/**
 * Decide whether the most recent cycle qualifies as a STALL — the trigger
 * for Trident hypothesis generation.
 *
 * Stall conditions (any one):
 *   (a) The just-returned terminator was INVESTIGATION_INCONCLUSIVE.
 *   (b) The hypothesis tree signature is byte-identical to the prior
 *       cycle's signature AND no terminal status (DEBUG_COMPLETE /
 *       ROOT_CAUSE_FOUND) was returned.
 *   (c) Caller forced via `forceTrident:true` (test hook).
 *
 * Returns a small object `{ stalled, reason }` so the receipt can record
 * which condition fired.
 */
export function detectStall({ terminator, signature, priorSignature, forceTrident = false } = {}) {
  if (forceTrident) {
    return { stalled: true, reason: 'forced' };
  }
  const term = String(terminator || '').toUpperCase();
  if (term === 'INVESTIGATION_INCONCLUSIVE') {
    return { stalled: true, reason: 'inconclusive_terminator' };
  }
  if (term === 'DEBUG_COMPLETE' || term === 'ROOT_CAUSE_FOUND') {
    return { stalled: false, reason: 'progress' };
  }
  if (priorSignature && signature && priorSignature === signature) {
    return { stalled: true, reason: 'byte_identical_tree' };
  }
  return { stalled: false, reason: 'progress' };
}

/**
 * Validate a Trident-lens hypothesis-gen response. Each lens returns:
 *   { lens, hypotheses: [ { hypothesis: string, rationale?: string } ] }
 *
 * A malformed response is treated as zero contributions (defensive: a
 * single bad lens never crashes the campaign).
 */
export function normaliseLensResponse(raw, lens) {
  if (!raw || typeof raw !== 'object') {
    return { lens, hypotheses: [], ok: false, reason: 'non-object' };
  }
  const list = Array.isArray(raw.hypotheses) ? raw.hypotheses : [];
  const cleaned = [];
  for (const h of list) {
    if (!h || typeof h !== 'object') continue;
    const text = typeof h.hypothesis === 'string' ? h.hypothesis.trim() : '';
    if (!text) continue;
    cleaned.push({
      hypothesis: text,
      rationale: typeof h.rationale === 'string' ? h.rationale.trim() : '',
    });
  }
  return { lens, hypotheses: cleaned, ok: true };
}

/**
 * Run the Trident hypothesis-generation sub-step.
 *
 * The DI hook `tridentDispatch` is invoked once per lens IN PARALLEL with
 * an evidence pack + the current hypothesis tree (so the lens can avoid
 * proposing duplicates of what's already been refuted). A lens that
 * throws is captured as `ok:false`; a lens that returns malformed JSON is
 * normalised to zero hypotheses — neither crashes the campaign.
 *
 * Returns `{ perLens, totalAdded, novelHypotheses }`:
 *   - perLens: array of { lens, hypotheses, ok, reason? }
 *   - totalAdded: count of novel hypothesis rows after dedup
 *   - novelHypotheses: the merged-in rows (with provenance)
 *
 * "Novel" = the hypothesis text (case-insensitive, whitespace-collapsed)
 * does not match any existing row's hypothesis. Refuted rows still count
 * as "existing" — a lens proposing the same refuted theory does NOT get
 * to re-raise it; the orchestrator's job is to break out of stuck space,
 * not loop.
 */
export async function generateCompetingHypotheses({
  evidencePack,
  currentHypotheses,
  lenses,
  tridentDispatch,
  abortSignal,
} = {}) {
  if (typeof tridentDispatch !== 'function') {
    throw new Error('generateCompetingHypotheses: tridentDispatch is required');
  }
  if (!Array.isArray(lenses) || lenses.length === 0) {
    throw new Error('generateCompetingHypotheses: lenses must be non-empty');
  }
  // Normalise the existing-hypothesis text set for dedup.
  const existingNorm = new Set();
  for (const row of currentHypotheses || []) {
    if (row && typeof row.hypothesis === 'string') {
      existingNorm.add(row.hypothesis.trim().toLowerCase().replace(/\s+/g, ' '));
    }
  }

  // Dispatch lenses in parallel — defensive Promise.all that converts a
  // thrown dispatch into { ok:false, error } rather than rejecting the
  // whole batch (one stuck lens can't kill the campaign).
  const perLens = await Promise.all(
    lenses.map(async (lens) => {
      try {
        const raw = await tridentDispatch({
          lens,
          evidencePack,
          currentHypotheses: Array.isArray(currentHypotheses) ? currentHypotheses : [],
          signal: abortSignal,
        });
        return normaliseLensResponse(raw, lens);
      } catch (err) {
        return {
          lens,
          hypotheses: [],
          ok: false,
          reason: err && err.message ? err.message : String(err),
        };
      }
    })
  );

  // Merge — append novel rows with provenance. Two lenses can independently
  // converge on the same hypothesis text; the first lens wins the row, the
  // second is dropped (recorded in the receipt as a consensus signal).
  const novelHypotheses = [];
  // Determine the next id by scanning existing row ids of form H<N>.
  const idsTaken = (currentHypotheses || [])
    .map((r) => (r && typeof r.id === 'string' ? r.id : ''))
    .filter((s) => /^H\d+$/.test(s))
    .map((s) => parseInt(s.slice(1), 10));
  let nextId = (idsTaken.length === 0 ? 0 : Math.max(...idsTaken)) + 1;
  const seenThisRound = new Set();
  for (const lensRow of perLens) {
    for (const h of lensRow.hypotheses) {
      const norm = h.hypothesis.trim().toLowerCase().replace(/\s+/g, ' ');
      if (existingNorm.has(norm)) continue;
      if (seenThisRound.has(norm)) continue;
      seenThisRound.add(norm);
      novelHypotheses.push({
        id: `H${nextId++}`,
        hypothesis: h.hypothesis.trim(),
        status: 'open',
        evidence: '',
        refuted_by: '',
        from: `trident:${lensRow.lens}`,
        rationale: h.rationale || '',
      });
    }
  }
  return {
    perLens,
    totalAdded: novelHypotheses.length,
    novelHypotheses,
  };
}

/**
 * Run a Trident-powered debug campaign.
 *
 * @param {object} opts
 * @param {string} opts.sessionId            slug — e.g. 'auth-redirect-loop'
 * @param {string} opts.symptoms             one-line expected vs actual
 * @param {Array<object>} [opts.hypotheses]  initial hypothesis tree (rows)
 * @param {Function} opts.dispatch           async ({ cycle, hypotheses, evidencePack }) =>
 *                                             { terminator, hypothesesPatch?, fix?, rootCause? }
 *                                           terminator ∈ ROOT_CAUSE_FOUND | DEBUG_COMPLETE |
 *                                             INVESTIGATION_INCONCLUSIVE | CHECKPOINT_REACHED |
 *                                             TDD_CHECKPOINT
 * @param {Function} opts.tridentDispatch    async ({ lens, evidencePack, currentHypotheses }) =>
 *                                             { lens, hypotheses: [ { hypothesis, rationale? } ] }
 * @param {Array<string>} [opts.tridentLenses]  default ['codex','gemini']; claude
 *                                              omitted because it owns the stall
 * @param {number} [opts.maxCycles]          default 6
 * @param {string} [opts.evidencePack]       opaque blob forwarded to dispatches
 * @param {string} [opts.projectRoot]        forwarded to telemetry.record
 * @param {string} [opts.runStamp]           ISO timestamp seed (deterministic in tests)
 * @param {AbortSignal} [opts.abortSignal]   propagates into dispatch calls
 * @param {boolean} [opts.recordTelemetry]   default true; off in unit tests that
 *                                           don't supply a projectRoot
 * @returns {Promise<object>}                campaign record (see CAMPAIGN_RECORD_SHAPE)
 *
 * CAMPAIGN_RECORD_SHAPE:
 *   {
 *     sessionId, symptoms, outcome (DEBUG_OUTCOMES), cycles, stalls,
 *     tridentInvocations, hypothesesAdded, resolutionLens, rootCause,
 *     fix, cyclesLog: [...], hypothesesFinal: [...], duration_ms
 *   }
 */
export async function runDebugCampaign({
  sessionId,
  symptoms,
  hypotheses = [],
  dispatch,
  tridentDispatch,
  tridentLenses = ['codex', 'gemini'],
  maxCycles = 6,
  evidencePack = '',
  projectRoot,
  runStamp,
  abortSignal,
  recordTelemetry = true,
} = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('runDebugCampaign: sessionId is required');
  }
  if (typeof symptoms !== 'string' || !symptoms.trim()) {
    throw new Error('runDebugCampaign: symptoms is required');
  }
  if (typeof dispatch !== 'function') {
    throw new Error('runDebugCampaign: dispatch is required');
  }
  if (typeof tridentDispatch !== 'function') {
    throw new Error('runDebugCampaign: tridentDispatch is required');
  }
  if (!Array.isArray(tridentLenses) || tridentLenses.length === 0) {
    throw new Error('runDebugCampaign: tridentLenses must be a non-empty array');
  }
  if (!Number.isFinite(maxCycles) || maxCycles < 1) {
    throw new Error('runDebugCampaign: maxCycles must be a positive integer');
  }

  const t0 = Date.now();
  const _runStamp = runStamp || new Date().toISOString();

  // Mutable campaign state. The hypotheses array is the source of truth —
  // dispatch may return a `hypothesesPatch` (replacement or delta) that the
  // orchestrator merges; Trident escalation also mutates it.
  let workingHypotheses = Array.isArray(hypotheses) ? [...hypotheses] : [];
  let priorSignature = hypothesisTreeSignature(workingHypotheses);
  let outcome = DEBUG_OUTCOMES.EXHAUSTED;
  let resolutionLens = null;
  let rootCause = null;
  let fix = null;
  let stalls = 0;
  let tridentInvocations = 0;
  let hypothesesAdded = 0;
  let lastError = null;
  const cyclesLog = [];

  // The main investigation loop.
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (abortSignal && abortSignal.aborted) {
      outcome = DEBUG_OUTCOMES.FAILED;
      lastError = 'aborted';
      break;
    }

    let dispatchResult;
    try {
      dispatchResult = await dispatch({
        cycle,
        hypotheses: workingHypotheses,
        evidencePack,
        sessionId,
        symptoms,
        signal: abortSignal,
      });
    } catch (err) {
      outcome = DEBUG_OUTCOMES.FAILED;
      lastError = err && err.message ? err.message : String(err);
      cyclesLog.push({
        cycle,
        terminator: 'DISPATCH_THREW',
        error: lastError,
      });
      break;
    }

    const terminator = String(dispatchResult?.terminator || '').toUpperCase();

    // Merge dispatcher-supplied hypothesis updates BEFORE stall detection so
    // we evaluate the post-cycle tree (mirrors what HYPOTHESES.md would
    // look like on disk after the investigator wrote its row updates).
    if (Array.isArray(dispatchResult?.hypothesesPatch)) {
      workingHypotheses = mergeHypothesesPatch(workingHypotheses, dispatchResult.hypothesesPatch);
    } else if (Array.isArray(dispatchResult?.hypothesesReplacement)) {
      workingHypotheses = [...dispatchResult.hypothesesReplacement];
    }

    const signature = hypothesisTreeSignature(workingHypotheses);
    const cycleEntry = {
      cycle,
      terminator,
      hypothesisCount: workingHypotheses.length,
      signature: signature.slice(0, 64),
    };

    // Terminal happy paths.
    if (terminator === 'DEBUG_COMPLETE') {
      outcome = DEBUG_OUTCOMES.RESOLVED;
      fix = typeof dispatchResult.fix === 'string' ? dispatchResult.fix : null;
      rootCause = typeof dispatchResult.rootCause === 'string' ? dispatchResult.rootCause : null;
      resolutionLens = dispatchResult.resolutionLens || 'claude';
      cyclesLog.push(cycleEntry);
      break;
    }
    if (terminator === 'ROOT_CAUSE_FOUND') {
      outcome = DEBUG_OUTCOMES.ROOT_CAUSE;
      rootCause = typeof dispatchResult.rootCause === 'string' ? dispatchResult.rootCause : null;
      resolutionLens = dispatchResult.resolutionLens || 'claude';
      cyclesLog.push(cycleEntry);
      break;
    }
    if (terminator === 'CHECKPOINT_REACHED') {
      outcome = DEBUG_OUTCOMES.CHECKPOINT;
      cyclesLog.push(cycleEntry);
      break;
    }

    // Stall detection.
    const stall = detectStall({
      terminator,
      signature,
      priorSignature,
      forceTrident: !!dispatchResult?.forceTrident,
    });

    if (stall.stalled) {
      stalls += 1;
      cycleEntry.stalled = true;
      cycleEntry.stallReason = stall.reason;

      // Trident escalation — generate competing cross-lens hypotheses.
      tridentInvocations += 1;
      let tridentResult;
      try {
        tridentResult = await generateCompetingHypotheses({
          evidencePack,
          currentHypotheses: workingHypotheses,
          lenses: tridentLenses,
          tridentDispatch,
          abortSignal,
        });
      } catch (err) {
        // A throw from the Trident sub-step itself (NOT from a per-lens
        // dispatch — those are already caught above) is a campaign-level
        // failure: we cannot recover the stall without competing hypotheses
        // and continuing would just loop on the same signature.
        outcome = DEBUG_OUTCOMES.FAILED;
        lastError = err && err.message ? err.message : String(err);
        cycleEntry.tridentError = lastError;
        cyclesLog.push(cycleEntry);
        break;
      }
      cycleEntry.trident = {
        lensesInvoked: tridentResult.perLens.map((p) => p.lens),
        lensesOk: tridentResult.perLens.filter((p) => p.ok).map((p) => p.lens),
        lensesFailed: tridentResult.perLens.filter((p) => !p.ok).map((p) => ({
          lens: p.lens,
          reason: p.reason,
        })),
        hypothesesAdded: tridentResult.totalAdded,
        novelHypothesesPreview: tridentResult.novelHypotheses
          .slice(0, 3)
          .map((h) => ({ id: h.id, from: h.from, hypothesis: h.hypothesis })),
      };
      hypothesesAdded += tridentResult.totalAdded;

      if (tridentResult.totalAdded === 0) {
        // No new ground from Trident either — terminate as exhausted (the
        // single-lens AND the cross-lens swarm both stalled on the same
        // hypothesis space).
        outcome = DEBUG_OUTCOMES.TRIDENT_DRY;
        cyclesLog.push(cycleEntry);
        break;
      }

      // Append novel hypotheses; refresh the signature so the NEXT cycle
      // doesn't immediately re-trigger stall detection on the merged tree.
      workingHypotheses = workingHypotheses.concat(tridentResult.novelHypotheses);
    }

    cyclesLog.push(cycleEntry);
    priorSignature = hypothesisTreeSignature(workingHypotheses);
  }

  // -------- Telemetry: write campaign exit metrics via state-SDK.
  // OFF the critical path — failure must NEVER alter the returned outcome
  // (mirrors cross-orchestrator.js T21 convergence-telemetry discipline).
  if (recordTelemetry && projectRoot) {
    const metrics = {
      sessionId,
      outcome,
      cycles: cyclesLog.length,
      stalls,
      tridentInvocations,
      hypothesesAdded,
      hypothesesCompetingCount: workingHypotheses.filter((h) => typeof h?.from === 'string' && h.from.startsWith('trident:')).length,
      resolved: outcome === DEBUG_OUTCOMES.RESOLVED,
      resolutionLens,
      durationMs: Date.now() - t0,
      runStamp: _runStamp,
    };
    const dedupKey = `debug-campaign:${sessionId}:${_runStamp}`;
    try {
      await stateQuery('telemetry.record', {
        kind: 'debug-campaign',
        metrics,
        dedupKey,
      }, { projectRoot });
    } catch {
      // Swallow — telemetry never alters campaign verdict.
    }
  }

  return {
    sessionId,
    symptoms,
    outcome,
    cycles: cyclesLog.length,
    stalls,
    tridentInvocations,
    hypothesesAdded,
    resolutionLens,
    rootCause,
    fix,
    cyclesLog,
    hypothesesFinal: workingHypotheses,
    duration_ms: Date.now() - t0,
    runStamp: _runStamp,
    lastError,
  };
}

/**
 * Merge a hypothesis-tree patch from the investigator. The patch is a list
 * of rows: rows whose id matches an existing row REPLACE that row; rows
 * whose id is new are APPENDED. A row with no id is appended with a fresh
 * H<N> id. Stable, no-throw — a malformed patch entry is silently dropped.
 */
export function mergeHypothesesPatch(existing, patch) {
  const out = Array.isArray(existing) ? [...existing] : [];
  if (!Array.isArray(patch)) return out;
  const byId = new Map();
  out.forEach((row, idx) => {
    if (row && typeof row.id === 'string') byId.set(row.id, idx);
  });
  const idsTaken = out
    .map((r) => (r && typeof r.id === 'string' ? r.id : ''))
    .filter((s) => /^H\d+$/.test(s))
    .map((s) => parseInt(s.slice(1), 10));
  let nextId = (idsTaken.length === 0 ? 0 : Math.max(...idsTaken)) + 1;
  for (const row of patch) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.id === 'string' && byId.has(row.id)) {
      out[byId.get(row.id)] = { ...out[byId.get(row.id)], ...row };
    } else if (typeof row.id === 'string') {
      out.push({ ...row });
      byId.set(row.id, out.length - 1);
      // Advance nextId past any explicitly-appended H<N> id so that
      // subsequent auto-id rows don't collide with it.
      if (/^H\d+$/.test(row.id)) {
        const n = parseInt(row.id.slice(1), 10);
        if (n >= nextId) nextId = n + 1;
      }
    } else {
      const id = `H${nextId++}`;
      out.push({ id, ...row });
      byId.set(id, out.length - 1);
    }
  }
  return out;
}
