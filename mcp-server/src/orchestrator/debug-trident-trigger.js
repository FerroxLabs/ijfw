/**
 * debug-trident-trigger.js — v1.5.1: the LIVE production trigger for the
 * Trident-powered debug loop (T29, debug-trident.js).
 *
 * --------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * --------------------------------------------------------------------------
 *
 * debug-trident.js (`runDebugCampaign`) is the cross-AI debug pillar — when a
 * single-lens hypothesis tree stalls, it dispatches codex + gemini lenses in
 * parallel to generate competing hypotheses. v1.5.1 W2.C wired it into
 * `runPostDone` (post-done-runner.js) — but `runPostDone` is itself NOT on the
 * live subagent-completion path. The live path is the `subagent.post-done`
 * verb in state-sdk.js, which calls `runSelfCheck`, never `runPostDone`. So
 * T29 was "tested but never firing in production".
 *
 * This module is the genuine wiring. It exposes ONE entrypoint —
 * `maybeFireDebugTrident` — designed to be called fire-and-forget from the
 * live gate-failure branch of the `subagent.post-done` verb. It mirrors the
 * A-Mem auto-linking precedent in memory/fts5.js exactly:
 *
 *   - The caller does NOT await it. The verb's return value and timing are
 *     unchanged — STATE-SDK-CONTRACT §8 classes `subagent.post-done` as a
 *     fast read verb; an inline blocking multi-lens AI call would violate
 *     that contract. The campaign runs in the background.
 *   - Env-gated. `IJFW_DEBUG_TRIDENT=1` enables it; default is OFF. (A-Mem's
 *     auto-linker is default-ON with an `IJFW_AUTOLINK_OFF` kill switch;
 *     debug-trident spawns EXTERNAL codex/gemini processes, so the safe
 *     default for an unattended gate-failure path is opt-in — but the
 *     env-gate + silent-no-op shape is identical.)
 *   - Silent no-op on missing deps. No codex/gemini CLI reachable, no
 *     dispatcher, a thrown import — every failure mode resolves to a quiet
 *     skip. It NEVER throws into the caller.
 *   - Result persistence. The competing-hypotheses output is written to an
 *     append-only JSONL receipt under `.ijfw/receipts/debug-campaigns.jsonl`
 *     so the dashboard / next phase can read it. (mirrors receipts.js).
 *
 * --------------------------------------------------------------------------
 * THE DISPATCHER
 * --------------------------------------------------------------------------
 *
 * runDebugCampaign needs a `tridentDispatch({ lens, evidencePack,
 * currentHypotheses }) => { lens, hypotheses }`. IJFW's production multi-lens
 * dispatcher is `defaultConvergeDispatch` in cross-orchestrator.js (the same
 * one runPhaseEConverge + ijfw_cross_audit_converge use to spawn real
 * codex/gemini). We obtain it via a DYNAMIC import() — static import would
 * create a require cycle (cross-orchestrator.js → state-sdk.js telemetry →
 * back here), and truncation.js was wired the same way (state-sdk.js:1246,
 * commit 75e5894). The adapter wraps `defaultConvergeDispatch` (an audit
 * dispatcher returning `{ verdict, findings }`) into the hypothesis-gen shape
 * runDebugCampaign expects: each audit finding becomes one competing
 * hypothesis row.
 *
 * Zero new prod deps. ESM. Node ≥18. No emoji.
 */

import fs from 'node:fs';
import path from 'node:path';

import { runDebugCampaign } from './debug-trident.js';

/**
 * Env gate. `IJFW_DEBUG_TRIDENT=1` (or `true`/`on`) turns the live trigger
 * on. Default OFF — the campaign spawns external codex/gemini processes, so
 * an unattended gate-failure path stays opt-in. Read on every call so a test
 * harness can flip it without re-importing.
 */
export function debugTridentEnabled() {
  const v = String(process.env.IJFW_DEBUG_TRIDENT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Receipt path — append-only JSONL, sibling of the cross-run receipts file.
 */
export function debugCampaignReceiptPath(projectRoot) {
  return path.join(projectRoot, '.ijfw', 'receipts', 'debug-campaigns.jsonl');
}

// Cap on receipt entries — same MAX_RECEIPTS posture as receipts.js so the
// file never grows unbounded under a flapping gate.
const MAX_DEBUG_RECEIPTS = 100;

/**
 * Append one debug-campaign record to the JSONL receipt. Best-effort: a
 * write failure is swallowed (the campaign verdict is never altered by a
 * diagnostic-write failure — mirrors fts5.js graph-errors.jsonl discipline).
 */
function writeDebugCampaignReceipt(projectRoot, record) {
  try {
    const dest = debugCampaignReceiptPath(projectRoot);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(record) + '\n');
    // Prune to the last MAX_DEBUG_RECEIPTS lines.
    try {
      const raw = fs.readFileSync(dest, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      if (lines.length > MAX_DEBUG_RECEIPTS) {
        fs.writeFileSync(dest, lines.slice(-MAX_DEBUG_RECEIPTS).join('\n') + '\n');
      }
    } catch { /* prune is best-effort */ }
  } catch { /* receipt write must never throw into the caller */ }
}

/**
 * Read all debug-campaign receipts for a project. Skips corrupt lines.
 * Used by the integration test + (future) the dashboard.
 */
export function readDebugCampaignReceipts(projectRoot) {
  const file = debugCampaignReceiptPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  const out = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  } catch { /* unreadable -> empty */ }
  return out;
}

/**
 * Build the production `tridentDispatch` function runDebugCampaign needs.
 *
 * `defaultConvergeDispatch` (cross-orchestrator.js) is an AUDIT dispatcher:
 * it spawns a lens CLI with an audit prompt and returns
 * `{ lens, verdict, findings:[...] }`. runDebugCampaign instead wants a
 * hypothesis generator returning `{ lens, hypotheses:[{hypothesis,rationale}] }`.
 * The adapter bridges the two: the evidence pack is handed to the lens as the
 * audit target, and each returned finding is mapped to one competing
 * hypothesis (finding text → hypothesis, severity/category → rationale).
 *
 * A lens that is unreachable returns verdict UNREACHABLE / zero findings,
 * which the adapter passes through as zero hypotheses — runDebugCampaign
 * already treats that as a non-contributing lens (no crash).
 *
 * Returns `null` when the dispatcher cannot be loaded at all (missing
 * module) — the caller treats that as a silent no-op.
 */
export async function buildTridentDispatch() {
  let defaultConvergeDispatch;
  try {
    // DYNAMIC import — avoids a static require cycle through
    // cross-orchestrator.js -> receipts/telemetry -> state-sdk.js.
    ({ defaultConvergeDispatch } = await import('../cross-orchestrator.js'));
  } catch {
    return null;
  }
  if (typeof defaultConvergeDispatch !== 'function') return null;

  return async function tridentDispatch({ lens, evidencePack, currentHypotheses, signal } = {}) {
    // Embed the already-tried hypotheses so the lens avoids re-proposing
    // refuted theory (runDebugCampaign also dedups, this just saves tokens).
    const triedBlock = Array.isArray(currentHypotheses) && currentHypotheses.length > 0
      ? '\n\n## Hypotheses already considered (propose DIFFERENT ones)\n'
        + currentHypotheses
          .map((h) => `- ${h && h.hypothesis ? h.hypothesis : ''} `
            + `[${h && h.status ? h.status : 'open'}]`)
          .join('\n')
      : '';
    const target = `## Stalled debug investigation — generate competing root-cause hypotheses\n\n`
      + `${typeof evidencePack === 'string' ? evidencePack : ''}${triedBlock}`;
    let raw;
    try {
      raw = await defaultConvergeDispatch({
        lens,
        commitRange: target,
        iteration: 1,
        cycleSummary: null,
        signal: signal || null,
      });
    } catch (err) {
      return { lens, hypotheses: [], ok: false, reason: err && err.message ? err.message : String(err) };
    }
    const findings = raw && Array.isArray(raw.findings) ? raw.findings : [];
    const hypotheses = findings
      .map((f) => {
        if (!f || typeof f !== 'object') return null;
        const text = typeof f.finding === 'string' && f.finding.trim()
          ? f.finding.trim()
          : (typeof f.title === 'string' ? f.title.trim() : '');
        if (!text) return null;
        const rationaleParts = [];
        if (f.severity) rationaleParts.push(`severity:${f.severity}`);
        if (f.category) rationaleParts.push(`category:${f.category}`);
        if (typeof f.rationale === 'string' && f.rationale.trim()) {
          rationaleParts.push(f.rationale.trim());
        }
        return { hypothesis: text, rationale: rationaleParts.join(' ') };
      })
      .filter(Boolean);
    return { lens, hypotheses };
  };
}

/**
 * Fire-and-forget entrypoint — call this from the LIVE `subagent.post-done`
 * gate-failure branch. It returns IMMEDIATELY; the actual campaign runs in a
 * detached promise. The verb's return value and timing are unchanged.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot   project root (where `.ijfw/` lives)
 * @param {string} [opts.subagentId]  the subagent whose gate failed
 * @param {string} [opts.reason]      the gate-failure reason string
 * @param {string} [opts.reportText]  the subagent's DONE report (evidence)
 * @param {object} [opts.selfCheck]   the failed self-check result (evidence)
 * @returns {void}                    nothing — never throws
 *
 * Diagnostic hook: `maybeFireDebugTrident.__lastCampaignPromise` holds the
 * most recent background promise so integration tests can `await` it before
 * asserting on the receipt (mirrors `indexEntry.__lastAutoLinkPromise` in
 * memory/fts5.js). Production callers do NOT read this.
 */
export function maybeFireDebugTrident(opts = {}) {
  // Gate 1 — env opt-in. Disabled => true no-op. No promise, no receipt.
  if (!debugTridentEnabled()) {
    maybeFireDebugTrident.__lastCampaignPromise = null;
    return;
  }
  const projectRoot = typeof opts.projectRoot === 'string' && opts.projectRoot
    ? opts.projectRoot : null;
  if (!projectRoot) {
    maybeFireDebugTrident.__lastCampaignPromise = null;
    return;
  }

  const subagentId = typeof opts.subagentId === 'string' && opts.subagentId
    ? opts.subagentId : 'unknown';
  const reason = typeof opts.reason === 'string' ? opts.reason : 'gate-failure';
  const reportText = typeof opts.reportText === 'string' ? opts.reportText : '';
  const selfCheck = opts.selfCheck && typeof opts.selfCheck === 'object'
    ? opts.selfCheck : null;
  // A test-supplied dispatcher (stub) short-circuits the dynamic import —
  // lets the integration test prove the wiring fires WITHOUT spawning real
  // codex/gemini. Production callers never pass this.
  const injectedDispatch = typeof opts.tridentDispatch === 'function'
    ? opts.tridentDispatch : null;

  // Compose the evidence pack from the gate-failure context. This is what
  // the codex/gemini lenses reason over.
  const evidenceLines = [
    `Subagent ${subagentId} failed its post-done self-check gate.`,
    `Gate-failure reason: ${reason}`,
  ];
  if (selfCheck) {
    if (Array.isArray(selfCheck.files_missing) && selfCheck.files_missing.length) {
      evidenceLines.push(`Missing claimed files: ${selfCheck.files_missing.join(', ')}`);
    }
    if (Array.isArray(selfCheck.commits_missing) && selfCheck.commits_missing.length) {
      evidenceLines.push(`Missing claimed commits: ${selfCheck.commits_missing.join(', ')}`);
    }
  }
  if (reportText) {
    evidenceLines.push('', '--- Subagent DONE report ---', reportText.slice(0, 4000));
  }
  const evidencePack = evidenceLines.join('\n');

  // The seed hypothesis — the single-lens reading that "stalled" (the gate
  // failed). Trident dispatches codex+gemini for competing alternatives.
  const seedHypotheses = [
    {
      id: 'H1',
      hypothesis: `Subagent ${subagentId} reported DONE but did not produce the claimed artifacts (${reason}).`,
      status: 'open',
      evidence: reason,
      refuted_by: '',
    },
  ];

  // Fire-and-forget — NOT awaited. Any failure resolves to a quiet skip.
  const campaignPromise = (async () => {
    let tridentDispatch = injectedDispatch;
    if (!tridentDispatch) {
      tridentDispatch = await buildTridentDispatch();
    }
    if (typeof tridentDispatch !== 'function') {
      // No dispatcher (missing module / missing CLIs) — silent no-op.
      writeDebugCampaignReceipt(projectRoot, {
        ts: new Date().toISOString(),
        subagentId,
        reason,
        outcome: 'skipped',
        skipReason: 'no-trident-dispatcher',
      });
      return { skipped: true, skipReason: 'no-trident-dispatcher' };
    }

    // The per-cycle `dispatch` for the live trigger: cycle 1 reports the
    // single-lens stall (INVESTIGATION_INCONCLUSIVE) so the campaign
    // immediately escalates to Trident; cycle 2 reports inconclusive again
    // so the campaign terminates cleanly once competing hypotheses exist.
    // The point of the LIVE trigger is to GENERATE the competing-hypotheses
    // set off a real gate failure, not to auto-resolve the bug — resolution
    // is the ijfw-debugger agent's job, this just seeds it.
    let stallCycles = 0;
    const dispatch = async () => {
      stallCycles += 1;
      return { terminator: 'INVESTIGATION_INCONCLUSIVE' };
    };

    let campaign;
    try {
      campaign = await runDebugCampaign({
        sessionId: `gate-failure-${subagentId}`,
        symptoms: `post-done self-check FAILED for ${subagentId} — ${reason}`,
        hypotheses: seedHypotheses,
        dispatch,
        tridentDispatch,
        tridentLenses: ['codex', 'gemini'],
        maxCycles: 2,
        evidencePack,
        projectRoot,
        // recordTelemetry stays on (default) — the campaign also writes a
        // telemetry.record via the state-SDK, same as the unit-tested path.
      });
    } catch (err) {
      writeDebugCampaignReceipt(projectRoot, {
        ts: new Date().toISOString(),
        subagentId,
        reason,
        outcome: 'failed',
        error: err && err.message ? err.message : String(err),
      });
      return { skipped: false, error: err && err.message ? err.message : String(err) };
    }
    void stallCycles;

    // Persist the competing-hypotheses output. This is the receipt the
    // dashboard / next phase reads — the campaign output is NOT lost.
    const competing = Array.isArray(campaign.hypothesesFinal)
      ? campaign.hypothesesFinal.filter(
        (h) => h && typeof h.from === 'string' && h.from.startsWith('trident:'),
      )
      : [];
    writeDebugCampaignReceipt(projectRoot, {
      ts: new Date().toISOString(),
      subagentId,
      reason,
      outcome: campaign.outcome,
      sessionId: campaign.sessionId,
      cycles: campaign.cycles,
      stalls: campaign.stalls,
      tridentInvocations: campaign.tridentInvocations,
      hypothesesAdded: campaign.hypothesesAdded,
      competingHypotheses: competing.map((h) => ({
        id: h.id,
        from: h.from,
        hypothesis: h.hypothesis,
        rationale: h.rationale || '',
      })),
      durationMs: campaign.duration_ms,
    });
    return { skipped: false, campaign };
  })().catch((err) => {
    // Last-resort guard — the background promise must NEVER surface an
    // unhandled rejection. Best-effort receipt, then swallow.
    try {
      writeDebugCampaignReceipt(projectRoot, {
        ts: new Date().toISOString(),
        subagentId,
        reason,
        outcome: 'failed',
        error: err && err.message ? err.message : String(err),
      });
    } catch { /* nothing more we can do */ }
    return { skipped: false, error: err && err.message ? err.message : String(err) };
  });

  // Expose for deterministic test awaiting only.
  maybeFireDebugTrident.__lastCampaignPromise = campaignPromise;
}

maybeFireDebugTrident.__lastCampaignPromise = null;
