/**
 * profile/serve.js — Cross-system profile bus, PHASE P4 (P4.4 + P4.6 serving).
 *
 * The MCP-facing READ path for the user-global profile. Two operations, both
 * ZERO-LLM by construction (the moat): this module imports ONLY store.js
 * (read), render-brief.js (compose), egress.js (audit), sensitivity.js (gate) —
 * none of which reach the LLM tier. The P4.5 import-graph guard proves it.
 *
 *   profileGet(opts)   — the structured, sensitivity-filtered listing of what
 *                        the profile knows (style axes + expertise + the
 *                        inferences cleared for the caller's sensitivity tier).
 *                        Logs an egress entry (a `get` is an exfiltration).
 *   profileBrief(opts) — the short descriptive brief for passive injection
 *                        (renderBrief). Logs an egress entry for what left.
 *
 * COLD START — a missing/empty profile yields an empty result, NEVER an error
 * (design-v2 §5 + the P4 spec): the absence of a profile must be a graceful
 * "nothing yet", not a failure the host has to handle.
 *
 * The host + session identifiers (for the egress ledger) come from the caller's
 * context so the audit trail can answer "which host saw what, when".
 *
 * Zero deps, Node built-ins only. NO LLM calls.
 */

import { readProfile } from './store.js';
import { renderBrief, renderSnapshot, BRIEF_MIN_CONFIDENCE, BRIEF_MIN_EVIDENCE } from './render-brief.js';
import { appendEgress, appendExemplarEgress } from './egress.js';
// V3 voice few-shot seam. BOTH imports are zero-LLM by construction:
// exemplar-retrieve ranks the user's OWN writing with pure BM25 + register/
// recency (no LLM/network/embedder), and exemplar-capture's classifyRegister is
// a pure string heuristic. Pulling them here keeps the P4.5 moat intact — the
// serve read path still never reaches the LLM tier (the moat-guard import-graph
// test re-proves this on every run).
import { retrieveExemplars } from './exemplar-retrieve.js';
import { classifyRegister } from './exemplar-capture.js';
// S5 — serve.js is the ONLY profile read-path module that loads the approval
// registry from disk; render-brief stays pure and is handed the registry. audit
// imports only lock/store/egress/schema (zero-LLM), so the moat is unchanged.
import { readApprovals } from './audit.js';
import {
  fieldSensitivity,
  sensitivityAllowed,
  loadRedaction,
  killSwitchEngaged,
  isRedacted,
} from './sensitivity.js';
import { styleAxisConfirmed, expertiseBand } from './derive-heuristic.js';
import { STYLE_AXES } from './schema.js';

/**
 * isCloudHost(host) -> boolean. Conservative classifier for the exemplar-egress
 * cloud flag (V4). A voice exemplar is the user's OWN raw writing, so when it is
 * disclosed to a CLOUD host the egress record must say so distinctly. We default
 * to FALSE (local) and flag TRUE only when the resolved host string clearly names
 * a hosted/web surface. First-party LOCAL CLI hosts (claude-code, cursor,
 * windsurf, codex, gemini-cli, …) are local => false. Unknown => false (we never
 * over-claim cloud; the flag is an honesty marker, not a gate — the inject
 * decision is the user's opt-in, made upstream).
 */
export function isCloudHost(host) {
  const h = String(host || '').toLowerCase().trim();
  if (!h) return false;
  // Explicit cloud/web markers anywhere in the host string.
  if (/(^|[^a-z])(cloud|web|hosted|saas|server|remote)([^a-z]|$)/.test(h)) return true;
  // Known hosted assistant surfaces (web apps / hosted APIs), distinct from the
  // local CLIs of the same vendors (claude-code, gemini-cli stay local).
  const CLOUD_HOSTS = new Set([
    'claude-web', 'claude.ai', 'chatgpt', 'openai', 'gemini-web', 'gemini.google.com',
    'copilot-web', 'github-copilot-web', 'perplexity', 'poe',
  ]);
  if (CLOUD_HOSTS.has(h)) return true;
  return false;
}

/** Pull host/session for the egress ledger from a caller context. */
function egressMeta(opts = {}) {
  const ctx = opts.context && typeof opts.context === 'object' ? opts.context : {};
  return {
    host: typeof ctx.host === 'string' ? ctx.host : (typeof opts.host === 'string' ? opts.host : null),
    session: typeof ctx.session === 'string' ? ctx.session : (typeof opts.session === 'string' ? opts.session : null),
  };
}

/**
 * profileBrief(opts) -> { ok, brief, fields, egress }. Renders the descriptive
 * brief and records exactly what left in the egress ledger. Cold start -> empty
 * brief (ok:true). Never throws.
 *
 * @param {object} [opts] forwarded to renderBrief (tokenBudget, context,
 *   shareSensitive, env, redactFile) plus context.host/context.session for the
 *   egress ledger.
 */
export function profileBrief(opts = {}) {
  let profile = null;
  try {
    const r = readProfile();
    // A corrupt/symlinked profile is NOT a serve error — serve nothing rather
    // than leak a half-read profile or throw at the host. Cold start semantics.
    profile = r && r.ok ? r.profile : null;
  } catch {
    profile = null;
  }

  // Thread the RESOLVED host (from caller context) into renderBrief so the
  // sensitivity gate can cross-check it against the share-hosts allowlist
  // (audit MED-2). forceLowOnly (audit MED-3) is honored when the caller marks
  // this a passive read (the MCP resource path sets it). Self-declared host in
  // the field payload is NEVER used — only the resolved context host.
  const meta = egressMeta(opts);
  const briefOpts = {
    ...opts,
    host: meta.host,
    forceLowOnly: opts.forceLowOnly === true,
    enforceHostAllowlist: true, // MED-2: every serve-path read binds to the host allowlist.
  };
  const { text, fields } = renderBrief(profile, briefOpts);

  // Record the egress ONLY when something actually left (empty brief => no
  // exfiltration => no ledger noise).
  let egress = null;
  if (fields.length > 0) {
    egress = appendEgress({ host: meta.host, session: meta.session, fields });
  }

  return { ok: true, brief: text, fields, egress };
}

/**
 * profileSnapshot(opts) -> { ok, snapshot, fields, egress }. Renders the flat
 * RULES-FILE snapshot (renderSnapshot) for cursor/windsurf/copilot-style standing
 * context, and — when `includePreferences` is set — appends ONLY corroborated +
 * approved + precision-eligible preference slugs (S5 gate). serve.js loads the S3
 * approval registry from disk ONCE and threads it into the pure renderer; an
 * absent/corrupt registry reads as "nothing approved" (fail-closed), so no
 * un-cleared preference can leak. Records what left in the egress ledger. Cold
 * start -> empty snapshot (ok:true). Never throws.
 *
 * @param {object} [opts] forwarded to renderSnapshot (tokenBudget, context,
 *   shareSensitive, env, redactFile, includePreferences) plus context.host/
 *   context.session for the egress ledger. `forceLowOnly` is honored for passive
 *   reads; the host allowlist is enforced on every serve-path read (MED-2).
 */
export function profileSnapshot(opts = {}) {
  let profile = null;
  try {
    const r = readProfile();
    profile = r && r.ok ? r.profile : null;
  } catch {
    profile = null;
  }

  // Load the approval registry ONCE here (the pure renderer never touches disk).
  // A symlinked/oversized/corrupt store degrades to an empty registry inside
  // readApprovals (fail-closed = nothing approved), so a tampered approvals file
  // can never GRANT injection — it can only withhold it.
  let registry = null;
  if (opts.includePreferences === true) {
    try {
      const ar = readApprovals();
      registry = ar && ar.registry && typeof ar.registry === 'object' ? ar.registry : null;
    } catch {
      registry = null; // fail-closed
    }
  }

  const meta = egressMeta(opts);

  // --- V3 VOICE FEW-SHOT SEAM (sibling of the S5 includePreferences gate) -----
  // Behind `opts.includeVoiceExemplars === true`, AND honoring the SAME kill-
  // switch the preference path respects, AND requiring a non-empty `opts.taskText`,
  // we retrieve the user's OWN writing samples (ZERO-LLM) and hand them to the
  // PURE renderer to few-shot a "match their voice" block. FAIL-CLOSED on every
  // axis: flag off, kill-switch engaged, empty taskText, retrieval throws, or no
  // exemplars => no voice block, no exemplar-egress disclosure. The gate is the
  // ONLY way `voiceExemplars` reaches renderSnapshot, so with the flag off the
  // output is byte-identical to today's (regression-guarded by the unit test).
  let voiceExemplars = null;
  const wantVoice = opts.includeVoiceExemplars === true;
  const taskText = typeof opts.taskText === 'string' ? opts.taskText.trim() : '';
  if (wantVoice && taskText) {
    // Kill-switch check, same source the preference/brief paths use. Engaged =>
    // never retrieve, never inject, never disclose.
    let killed = false;
    try {
      killed = killSwitchEngaged(loadRedaction({ env: opts.env || process.env, redactFile: opts.redactFile }));
    } catch {
      killed = false;
    }
    if (!killed) {
      try {
        const register = classifyRegister(taskText, 'prompt');
        const k = Number.isFinite(opts.voiceK) && opts.voiceK > 0 ? Math.floor(opts.voiceK) : 3;
        // DI: tests/callers may inject a candidate set; default loads via store.
        const got = retrieveExemplars({
          register,
          taskText,
          k,
          exemplars: Array.isArray(opts.exemplars) ? opts.exemplars : null,
          env: opts.env || process.env,
        });
        voiceExemplars = Array.isArray(got) && got.length > 0 ? got : null;
      } catch {
        voiceExemplars = null; // fail-closed: any retrieval failure => no voice.
      }
    }
  }

  const snapOpts = {
    ...opts,
    host: meta.host,
    forceLowOnly: opts.forceLowOnly === true,
    enforceHostAllowlist: true, // MED-2: every serve-path read binds to the host allowlist.
    registry,
    voiceExemplars, // null when the gate is off / fail-closed => renderer emits nothing.
  };
  const { text, fields, voice } = renderSnapshot(profile, snapOpts);

  let egress = null;
  if (fields.length > 0) {
    egress = appendEgress({ host: meta.host, session: meta.session, fields });
  }

  // Voice disclosure (V4): record ONLY the exemplars that ACTUALLY landed in the
  // block (renderSnapshot returns them in `voice` after its own budget cap), and
  // ONLY through the dedicated exemplar-egress channel. Cloud-host flagged when
  // the resolved host is a cloud surface. Empty `voice` => no disclosure line.
  let voiceEgress = null;
  const landed = Array.isArray(voice) ? voice : [];
  if (landed.length > 0) {
    voiceEgress = appendExemplarEgress({
      ids: landed.map((e) => e && e.id).filter(Boolean),
      host: meta.host,
      session: meta.session,
      cloudHost: isCloudHost(meta.host),
    });
  }

  return { ok: true, snapshot: text, fields, egress, voice: landed, voiceEgress };
}

/**
 * profileGet(opts) -> { ok, profile:{ style, expertise, inferences }, fields,
 * egress }. The structured, sensitivity-filtered listing. Mirrors the brief's
 * gates (sensitivity tier + redaction + kill-switch) so `get` can never leak
 * more than `brief` would. Cold start -> empty listing (ok:true). Never throws.
 */
export function profileGet(opts = {}) {
  const env = opts.env || process.env;
  const redaction = loadRedaction({ env, redactFile: opts.redactFile });
  // Resolve the host from caller context (NOT self-declared) for the MED-2
  // share-hosts allowlist cross-check; honor forceLowOnly for passive reads.
  const meta = egressMeta(opts);
  const shareOpts = {
    env,
    shareSensitive: opts.shareSensitive,
    host: meta.host,
    forceLowOnly: opts.forceLowOnly === true,
    enforceHostAllowlist: true, // MED-2: bind med/high to the share-hosts allowlist.
    shareHostsFile: opts.shareHostsFile,
  };

  const empty = { ok: true, profile: { style: {}, expertise: {}, inferences: [] }, fields: [], egress: null };

  // Kill-switch: hard stop, return nothing.
  if (killSwitchEngaged(redaction)) return empty;

  let profile = null;
  try {
    const r = readProfile();
    profile = r && r.ok ? r.profile : null;
  } catch {
    profile = null;
  }
  if (!profile || typeof profile !== 'object' || !profile.global) return empty;

  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const overlayKey = typeof context.overlay === 'string' ? context.overlay : null;
  const overlay = overlayKey && profile.overlays ? profile.overlays[overlayKey] : null;

  const out = { style: {}, expertise: {}, inferences: [] };
  const fields = [];

  // Style — confirmed axes only, low-sensitivity, redaction-gated. Overlay
  // overrides global per axis.
  for (const axis of STYLE_AXES) {
    const a = (overlay && overlay.style && overlay.style[axis])
      || (profile.global.style && profile.global.style[axis]);
    if (!a || !styleAxisConfirmed(a)) continue;
    const fieldId = `style:${axis}`;
    if (!sensitivityAllowed(fieldSensitivity({ kind: 'style' }), shareOpts)) continue;
    if (isRedacted(fieldId, redaction)) continue;
    out.style[axis] = { ema: a.ema, evidence_count: a.evidence_count };
    fields.push(fieldId);
  }

  // Expertise — banded domains only, low-sensitivity, redaction-gated.
  if (profile.expertise && typeof profile.expertise === 'object') {
    for (const [domain, rec] of Object.entries(profile.expertise)) {
      const band = expertiseBand(rec);
      if (band === 'unknown') continue;
      const fieldId = `expertise:${domain}`;
      if (!sensitivityAllowed(fieldSensitivity({ kind: 'expertise' }), shareOpts)) continue;
      if (isRedacted(fieldId, redaction)) continue;
      out.expertise[domain] = { band, wilsonLB: rec.wilsonLB, n: rec.n };
      fields.push(fieldId);
    }
  }

  // Inferences — confidence/evidence floor + sensitivity tier + redaction.
  const byId = new Map();
  for (const inf of (Array.isArray(profile.global.dialectic) ? profile.global.dialectic : [])) {
    if (inf && inf.id) byId.set(inf.id, inf);
  }
  if (overlay && Array.isArray(overlay.dialectic)) {
    for (const inf of overlay.dialectic) if (inf && inf.id) byId.set(inf.id, inf);
  }
  for (const inf of byId.values()) {
    // Inclusion floor shared with the brief (audit L2): confidence > 0.45 AND
    // evidence_count >= 3 so a corroborated dialectic trait (conf 0.5) can
    // surface while the evidence gate remains the real corroboration barrier.
    if (!(Number(inf.confidence) > BRIEF_MIN_CONFIDENCE
        && (Number(inf.evidence_count) || 0) >= BRIEF_MIN_EVIDENCE)) continue;
    const sens = fieldSensitivity({ kind: 'inference', sensitivity: inf.sensitivity });
    if (!sensitivityAllowed(sens, shareOpts)) continue;
    if (isRedacted(inf.id, redaction)) continue;
    out.inferences.push({
      id: inf.id,
      kind: inf.kind,
      subject: inf.subject,
      value: inf.value,
      confidence: inf.confidence,
      evidence_count: inf.evidence_count,
      sensitivity: sens,
    });
    fields.push(inf.id);
  }

  let egress = null;
  if (fields.length > 0) {
    egress = appendEgress({ host: meta.host, session: meta.session, fields });
  }

  return { ok: true, profile: out, fields, egress };
}
