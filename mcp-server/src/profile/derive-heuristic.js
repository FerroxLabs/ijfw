/**
 * profile/derive-heuristic.js — Cross-system profile bus, PHASE P2.
 *
 * The ZERO-LLM heuristic derivation tier — *the default that carries the
 * profile* (design-v2 §5). It turns per-session METADATA (statistics about
 * your messages, never raw transcripts — data minimization, §6) + structured
 * feedback/outcome records into a single `ProfileDelta` that the P0 merge layer
 * (`applyDelta` in ./merge.js) folds into the one global profile.
 *
 * PURITY CONTRACT (P2.4): every function here is a pure data transform.
 *   - No network (`fetch`/`http`/`https`).
 *   - No `child_process`.
 *   - No LLM tier (`tiered-llm.js` et al.).
 *   - No store writes (this module imports nothing from ./store.js; persistence
 *     is the merge layer's job via `mergeAndWrite`).
 * A CI moat guard (P4.5) asserts the serving path never reaches the LLM tier;
 * this module keeps that promise at the source.
 *
 * ── The merge contract (why the shapes below look the way they do) ──────────
 * `applyDelta(profile, delta)` reads a delta of shape:
 *     {
 *       style?:      { axis: { sample:0..1, weight?:number } },
 *       inferences?: Inference[],          // see schema.makeInference
 *       expertise?:  { domain: { accepts:number, n:number } },
 *       overlays?:   { key: { style?, inferences? } },
 *       provenance?: { ...scalars },
 *     }
 *
 * EMA DOUBLE-APPLY DECISION (P2.1): merge.js `foldStyleAxis` OWNS the α≈0.15 EMA
 * step and the Beta(α,β) mass update — it folds the raw `sample` on WRITE. So
 * this derive step must emit the per-session OBSERVATION (`{sample,weight}`),
 * NOT a pre-smoothed EMA, or the α would be applied twice. `deriveStyle`
 * therefore returns normalized [0,1] samples; the merge does the smoothing.
 *
 * WILSON DECISION (P2.2): merge.js `mergeExpertise` accumulates `{accepts,n}`
 * and recomputes `wilsonLowerBound` on write. So `deriveExpertise` emits raw
 * `{accepts,n}` counts — NOT a precomputed band — and lets evidence accumulate
 * across sessions. `expertiseBand` is a read-side classifier (used by briefs /
 * tests) that requires N≥5 before naming a band. We re-implement the Wilson
 * formula locally (identical to merge.js `wilsonLowerBound`) rather than edit
 * P0 to export it — see the function comment.
 */

import { makeInference } from './schema.js';

/** Clamp into the unit interval; non-finite -> 0. Matches merge.js clamp01. */
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// P2.1 — EMA style fingerprint.
//
// Map per-session metadata signals onto the four style axes as [0,1] samples.
// Each mapping is a deterministic, monotone squash of an interpretable
// statistic. The merge applies the EMA — we only emit the observation.
// ---------------------------------------------------------------------------

/**
 * Logistic-ish saturating map of a non-negative magnitude `x` onto (0,1) with
 * `mid` as the ~0.5 crossover. Pure, monotone-increasing in x. Used so a
 * single extreme session can't pin a sample to a hard 0/1 (the Beta mass +
 * EMA already damp single observations; this keeps samples interior).
 */
function saturate(x, mid) {
  const v = Math.max(0, Number(x) || 0);
  const m = mid > 0 ? mid : 1;
  return v / (v + m); // x=0 ->0, x=mid ->0.5, x->∞ ->1, strictly increasing
}

/**
 * Inverse saturating map: large `x` -> low sample (e.g. long messages -> low
 * terseness). Monotone-decreasing in x.
 */
function saturateInverse(x, mid) {
  return 1 - saturate(x, mid);
}

/**
 * Formality-axis blend weights (FIX 1). `formality_markers` is the primary
 * authorship signal; `code_block_ratio` is a bounded nudge (code-heavy sessions
 * read slightly more formal). They sum to 1 so the convex blend stays in [0,1]
 * and a marker swing always dominates an equal-magnitude code swing.
 */
export const FORMALITY_MARKER_WEIGHT = 0.85;
export const FORMALITY_CODE_WEIGHT = 0.15;

/**
 * deriveStyle(meta) -> { axis: { sample:0..1, weight } }.
 *
 * `meta` is per-session aggregate metadata (NOT transcripts):
 *   - avg_msg_chars        — mean user message length  -> terseness (inverse)
 *   - emoji_per_msg        — mean emoji per message     -> emoji_use
 *   - code_block_ratio     — fraction of msgs w/ code   -> formality (bounded nudge)
 *   - formality_markers    — 0..1 formal-marker density -> formality
 *   - turn_cadence_per_min — turns/minute               -> energy
 *
 * Missing signals fall back to the neutral 0.5 prior with a LOW weight, so an
 * absent metric neither moves nor anchors the axis. Only an axis with a real
 * observed signal gets full weight.
 */
export function deriveStyle(meta = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};

  // weight reflects how strong the per-session evidence is for the axis. A
  // present signal => weight 1; an absent one => a small weight on the neutral
  // prior (so it barely nudges and never anchors). Weight is also passed to the
  // merge, which scales the EMA step (still bounded by α + the δ cap).
  //
  // FIX 2 (CRITICAL-1 / M1 / H4): thread the per-host `trust` through every
  // emitted observation so the merge fold can apply the documented trust
  // weighting. `meta.trust_weight` is carried by capture.js `toDeriveMeta`; a
  // missing trust is left undefined (the merge defaults to full trust only when
  // truly absent). We clamp here so a forged out-of-range trust cannot amplify.
  const trust = (m.trust_weight !== undefined && m.trust_weight !== null && Number.isFinite(Number(m.trust_weight)))
    ? clamp01(m.trust_weight)
    : undefined;
  const obs = (sample, present) => {
    const o = { sample: clamp01(sample), weight: present ? 1 : 0.1 };
    if (trust !== undefined) o.trust = trust;
    return o;
  };

  const hasLen = m.avg_msg_chars !== undefined && m.avg_msg_chars !== null;
  const hasEmoji = m.emoji_per_msg !== undefined && m.emoji_per_msg !== null;
  const hasFormal = m.formality_markers !== undefined && m.formality_markers !== null;
  const hasCode = m.code_block_ratio !== undefined && m.code_block_ratio !== null;
  const hasCadence = m.turn_cadence_per_min !== undefined && m.turn_cadence_per_min !== null;

  // terseness: short messages => terse. ~120 chars is the 0.5 crossover.
  const terseness = obs(saturateInverse(m.avg_msg_chars, 120), hasLen);

  // emoji_use: emoji density. ~0.5 emoji/msg is the 0.5 crossover.
  const emoji_use = obs(saturate(m.emoji_per_msg, 0.5), hasEmoji);

  // formality: a convex blend of two already-[0,1] signals.
  //   sample = FORMALITY_MARKER_WEIGHT*formality_markers
  //          + FORMALITY_CODE_WEIGHT  *code_block_ratio
  // formality_markers is the PRIMARY signal (weight 0.85); code_block_ratio is a
  // bounded NUDGE (weight 0.15) — code-heavy sessions skew slightly formal. The
  // weights sum to 1 so the blend is automatically clamped to [0,1] when both
  // inputs are in [0,1] (clamp01 belt-and-braces against out-of-range metadata),
  // and it is monotone-increasing in BOTH inputs (FIX 1: code_block_ratio was a
  // documented input with zero effect — it now contributes without unseating
  // markers as primary). The axis counts as OBSERVED (full weight) when EITHER
  // signal is present; a missing input contributes 0 to the blend.
  const formality = obs(
    clamp01(
      FORMALITY_MARKER_WEIGHT * (hasFormal ? clamp01(m.formality_markers) : 0)
        + FORMALITY_CODE_WEIGHT * (hasCode ? clamp01(m.code_block_ratio) : 0),
    ),
    hasFormal || hasCode,
  );

  // energy: turn cadence. ~4 turns/min is the 0.5 crossover.
  const energy = obs(saturate(m.turn_cadence_per_min, 4), hasCadence);

  return { formality, energy, terseness, emoji_use };
}

/** Minimum merged Beta evidence before an axis counts as "confirmed". */
export const STYLE_CONFIRM_MIN_SESSIONS = 5;

/**
 * styleAxisConfirmed(axis) -> boolean. Reads a MERGED style axis object
 * ({ema,alpha,beta,evidence_count}); an axis is "unconfirmed" (cold start)
 * until ≥5 sessions of evidence have accrued. Briefs omit unconfirmed axes.
 *
 * We key on `evidence_count` (the merge's per-session counter) rather than Beta
 * mass, because a high-weight single session can inflate α+β; sessions are the
 * honest unit. A fresh axis has evidence_count 0 (Beta(1,1) uniform prior).
 */
export function styleAxisConfirmed(axis) {
  if (!axis || typeof axis !== 'object') return false;
  return (Number(axis.evidence_count) || 0) >= STYLE_CONFIRM_MIN_SESSIONS;
}

// ---------------------------------------------------------------------------
// P2.2 — Wilson-score expertise.
//
// Per-domain lower-bound 95% CI on the accept-without-edit ratio. Outcome
// semantics (design-v2 §4):
//   - accept     -> strong positive  (accepts += 1, n += 1)
//   - edit-after -> negative         (n += 1; NOT counted in accepts)
//   - discard    -> neutral          (excluded from n entirely — no signal)
//
// We emit raw `{accepts,n}` counts; merge.js `mergeExpertise` accumulates them
// across sessions and recomputes `wilsonLowerBound` on write. `expertiseBand`
// classifies a MERGED record (which already carries the recomputed wilsonLB),
// requiring N>=5 before naming any band — below that, evidence is too thin.
// ---------------------------------------------------------------------------

/** Minimum sample size before expertise can be banded (design-v2 §4: N>=5). */
export const EXPERTISE_MIN_N = 5;

/**
 * Band cut-points on the Wilson 95% LOWER bound (FIX 3 — previously inline magic
 * numbers). Cutting on the lower bound (not the point estimate) keeps the band
 * honest under small N. Reference calibration that fixes the expert cut: a user
 * with 8/10 accepts has a Wilson LB ≈ 0.49, which must read as 'expert'; 0.45
 * sits just under that so an 8/10 record clears it with margin while a noisier
 * record (e.g. a few accepts in a larger sample) does not. The proficient cut
 * 0.25 marks "clearly better than chance, not yet expert". Both bounds are
 * inclusive (>=). These are read-side classifier constants only; the merge owns
 * the persisted wilsonLB.
 */
export const EXPERT_WILSON_THRESHOLD = 0.45;
export const PROFICIENT_WILSON_THRESHOLD = 0.25;

/**
 * Outcomes that contribute to the denominator `n` (a real authorship signal).
 *
 * FIX 2: the P2.2 spec (design-v2 §4) defines EXACTLY three authorship outcomes
 * — accept / edit-after / discard — of which two are counted (discard is
 * neutral, excluded from `n` below). The earlier set also carried `reject` and
 * the `edit_after`/`edit` aliases; none of those are spec outcomes and NO repo
 * source emits them: `deriveExpertise` has no caller yet (it is a P2 building
 * block ahead of its P3/P4 wiring), and the only structured-feedback emitter,
 * `src/feedback-detector.js`, produces the SEPARATE *preference-kind* vocabulary
 * {correction, confirmation, preference, rule} consumed by `derivePreferences`
 * — not authorship outcomes. Treating an unknown string as `edit-after` would
 * silently inflate `n` and depress the Wilson lower bound, so the set is kept to
 * the spec's two countable outcomes. When a real authorship-outcome emitter
 * lands, extend this set deliberately (with a citation), not by guessing aliases.
 */
const EXPERTISE_COUNTED = new Set(['accept', 'edit-after']);
/** Outcomes that count as a positive (accept-without-edit). */
const EXPERTISE_POSITIVE = new Set(['accept']);

/**
 * Wilson score lower bound (95%, z=1.96). Re-implemented here IDENTICALLY to
 * merge.js `wilsonLowerBound` rather than editing P0 to widen its surface — the
 * formula is five lines and keeping it local preserves the P2/P0 boundary (the
 * derive step is self-contained and the band classifier needs it for cold
 * `{accepts,n}` records that haven't been through the merge yet). The merge
 * remains the source of truth for the persisted `wilsonLB`.
 */
function wilsonLB(accepts, n, z = 1.96) {
  if (!n || n <= 0) return 0;
  const phat = accepts / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return clamp01((center - margin) / denom);
}

/**
 * deriveExpertise(records) -> { domain: { accepts, n } }.
 *
 * `records` is an array of `{ domain, outcome }` authorship outcomes for the
 * session (e.g. a suggested edit was accepted/edited/discarded). Emits raw
 * counts in the shape merge.js `mergeExpertise` consumes; the merge recomputes
 * the Wilson lower bound after accumulation.
 */
export function deriveExpertise(records = []) {
  const out = {};
  if (!Array.isArray(records)) return out;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const domain = typeof rec.domain === 'string' ? rec.domain.trim() : '';
    if (!domain) continue;
    const outcome = String(rec.outcome || '').toLowerCase();
    if (!EXPERTISE_COUNTED.has(outcome)) continue; // discard/unknown = neutral, no signal
    if (!out[domain]) out[domain] = { accepts: 0, n: 0 };
    out[domain].n += 1;
    if (EXPERTISE_POSITIVE.has(outcome)) out[domain].accepts += 1;
  }
  return out;
}

/**
 * expertiseBand(record) -> 'unknown' | 'novice' | 'proficient' | 'expert'.
 *
 * `record` is a MERGED expertise entry `{ accepts, n, wilsonLB? }`. Requires
 * N>=5 (EXPERTISE_MIN_N) before naming a band; otherwise 'unknown' (cold start).
 * Bands are cut on the Wilson LOWER bound (conservative) at the named constants
 * EXPERT_WILSON_THRESHOLD / PROFICIENT_WILSON_THRESHOLD — see their definitions
 * for the 8/10-accepts -> LB≈0.49 -> 'expert' reference calibration.
 */
export function expertiseBand(record) {
  if (!record || typeof record !== 'object') return 'unknown';
  const n = Number(record.n) || 0;
  if (n < EXPERTISE_MIN_N) return 'unknown';
  const lb = Number.isFinite(Number(record.wilsonLB))
    ? Number(record.wilsonLB)
    : wilsonLB(Number(record.accepts) || 0, n);
  if (lb >= EXPERT_WILSON_THRESHOLD) return 'expert';
  if (lb >= PROFICIENT_WILSON_THRESHOLD) return 'proficient';
  return 'novice';
}

// ---------------------------------------------------------------------------
// P2.3 — Preference tags from .session-feedback.jsonl.
//
// Record schema (verified against src/feedback-detector.js):
//   { ts, kind, phrase, context }   kind ∈ {correction, confirmation, preference, rule}
//
// Each record becomes a preference Inference (schema.makeInference shape) the
// merge dedupes by id (kind+subject) and evidence-accumulates. `correction` is
// the strongest signal (design-v2 §5: "corrections=strongest signal"); a bare
// `confirmation` is the weakest (it only reinforces, it doesn't assert a new
// preference).
//
// The subject is a normalized slug of the phrase so two sessions reporting the
// "same" preference dedupe to one atom across hosts. The original feedback kind
// is preserved in `value.kind` (a brief renders it; the merge keeps the most
// recent confirmation's value). We sequester these at confidence < a confirmed
// heuristic measurement so the dialectic tier (P3) can corroborate, never
// silently override (design-v2 §5 "heuristic is the floor").
// ---------------------------------------------------------------------------

/**
 * FIX 4 (CRITICAL-2) — value-level special-category + direct-PII deny/scrub gate
 * for the FEEDBACK path.
 *
 * `capture.js assertNoSpecialCategory` gates special-category attribute KEYS on
 * the wire record; the feedback path is different — the risk is the free-text
 * `phrase`/`context` carrying special-category meaning OR direct identifiers
 * INTO the global (exfiltrable) store. We therefore run a VALUE-level scan here.
 * It is co-located (not imported from capture.js) deliberately: capture.js pulls
 * in node:fs/os/crypto, and derive-heuristic must keep its zero-LLM/zero-network
 * import graph clean (the P2.4 moat-at-source guard). The special-category
 * VOCABULARY mirrors capture.js SPECIAL_CATEGORY_KEYS in spirit — these are word
 * forms (not attribute keys) so they cannot share the literal list; keep them in
 * sync deliberately if the key list grows.
 *
 * `special` => REFUSE the whole inference (never mint). `pii` patterns =>
 * the phrase is scrubbed of the direct identifier before slugging, so no raw
 * email/phone/etc. can reach the store even in the slug.
 */
const SPECIAL_CATEGORY_TERMS = [
  /\breligion\b/i, /\breligious\b/i, /\bfaith\b/i, /\bchurch\b/i, /\bmosque\b/i, /\bsynagogue\b/i,
  /\brace\b/i, /\bethnic(?:ity)?\b/i,
  /\bpolitical\b/i, /\bpolitics\b/i, /\baffiliation\b/i,
  /\bsexual orientation\b/i, /\bsex life\b/i,
  /\bhealth\b/i, /\bmedical\b/i, /\bdiagnos(?:is|ed)\b/i, /\bcondition\b/i, /\bdisease\b/i,
  /\bdisab(?:led|ility)\b/i, /\bgenetic\b/i, /\bbiometric\b/i,
  /\btrade union\b/i, /\bcriminal\b/i, /\bconviction\b/i,
];

/** Direct-identifier patterns scrubbed from the phrase before it is slugged. */
const PII_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,                 // email
  // eslint-disable-next-line security/detect-unsafe-regex -- linear-time PII redactor: each repetition consumes a mandatory digit, no ambiguous/overlapping quantifier; not ReDoS-exploitable.
  /(?:\+?\d[\s().-]?){7,}\d/g,                               // phone-ish run of digits
  /\b\d{3}-\d{2}-\d{4}\b/g,                                  // US SSN shape
  // eslint-disable-next-line security/detect-unsafe-regex -- linear-time PII redactor: each repetition consumes a mandatory digit, no ambiguous/overlapping quantifier; not ReDoS-exploitable.
  /\b(?:\d[ -]?){13,19}\b/g,                                 // card-ish long digit run
];

/**
 * scrubPhrase(content, phrase, context) -> { ok, scrubbed }.
 *
 * Returns ok:false when EITHER the trigger `phrase`, the surrounding `context`,
 * OR the extracted `content` carries a special-category signal (REFUSE — never
 * mint). The deny scan covers the FULL feedback surface (phrase + context +
 * content), so a special-category term anywhere in the message blocks the
 * inference — DEFECT 3 widened the deny scan to the extracted content too, so a
 * term that lives only in the content (and would now be slugged) is still
 * caught. Otherwise returns the EXTRACTED CONTENT with direct-PII identifiers
 * removed (so a slug derived from it can never carry a raw email/phone/SSN/card).
 * Pure.
 */
function scrubPhrase(content, phrase, context) {
  const hay = `${String(phrase || '')} ${String(context || '')} ${String(content || '')}`;
  for (const re of SPECIAL_CATEGORY_TERMS) {
    if (re.test(hay)) return { ok: false, scrubbed: '' };
  }
  let scrubbed = String(content || '');
  for (const re of PII_PATTERNS) {
    scrubbed = scrubbed.replace(re, ' ');
  }
  return { ok: true, scrubbed };
}

/** Per-kind base confidence — correction strongest, confirmation weakest. */
const FEEDBACK_KIND_CONFIDENCE = Object.freeze({
  correction: 0.7,
  rule: 0.65,
  preference: 0.55,
  confirmation: 0.4,
});

/** Sensitivity tier per kind (a preference/correction is more revealing than a confirmation). */
const FEEDBACK_KIND_SENSITIVITY = Object.freeze({
  correction: 'med',
  rule: 'med',
  preference: 'med',
  confirmation: 'low',
});

/**
 * DEFECT 3 — extract the preference OBJECT from a feedback row.
 *
 * The shipped `src/feedback-detector.js` is a SHARED file consumed by the
 * memory/correction system too, so we do NOT change its wire contract. In that
 * contract `phrase` is the matched TRIGGER TOKEN ONLY ("No,", "always use",
 * "I prefer") and `context` is the fuller surrounding message (the snippet
 * window) — i.e. the actual preference CONTENT lives in `context`, not `phrase`.
 *
 * Slugging `phrase` alone keyed every real correction on the trigger word
 * ("no") — meaningless, and the brief could never surface the real preference
 * ("use tabs not spaces"). This profile-side extractor recovers the content:
 *
 *   1. Pick the richer of {phrase, context} (context is the fuller message in
 *      the live contract; phrase wins only when context is empty/shorter — the
 *      shape the integration/PII tests author, where content is IN `phrase`).
 *   2. If the trigger token appears within the chosen text, drop everything up
 *      to AND INCLUDING it, keeping the trailing preference object (the trigger
 *      and any lead-in fluff like "Going forward," are not the preference).
 *   3. Strip leading snippet artifacts (ellipsis/punctuation) and fall back to
 *      the trigger only if nothing else remains.
 *
 * Pure + deterministic. The result is fed through the SAME `phraseToSubject`
 * slug + the SAME `scrubPhrase` PII/special-category gate, so CRITICAL-2 holds:
 * the served atom is still slug-only, special-category rows are still refused,
 * and direct PII is still scrubbed before slugging.
 */
function preferenceContent(phrase, context) {
  const p = String(phrase || '').trim();
  const c = String(context || '').trim();
  // context is the fuller message in the live detector contract; prefer it when
  // it carries more than the bare trigger. When context is empty/shorter (the
  // phrase-only wire shape the integration/PII tests use), keep `phrase`.
  let base = c.length > p.length ? c : p;
  if (p) {
    const idx = base.toLowerCase().indexOf(p.toLowerCase());
    if (idx >= 0) {
      const after = base.slice(idx + p.length).trim();
      // Adopt the trailing remainder only when it carries real content; if the
      // trigger was the whole/last of the text, keep `base` (don't blank it).
      if (after) base = after;
    }
  }
  // Drop leading snippet artifacts (the detector's '…' lead-in marker, stray
  // separators) so they never pollute the slug.
  base = base.replace(/^[…\s,.!:;-]+/, '').trim();
  return base || p;
}

/**
 * Normalize a feedback phrase into a stable, deterministic subject slug so the
 * "same" preference dedupes across sessions/hosts. Lowercased, punctuation
 * stripped, whitespace collapsed, length-capped. Pure.
 */
function phraseToSubject(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ') // drop punctuation/emoji (apostrophes too)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * derivePreferences(records, ctx?) -> Inference[].
 *
 * @param {Array<{ts,kind,phrase,context}>} records  .session-feedback.jsonl rows
 * @param {{sessionId?:string, host?:string}} [ctx]   provenance for this session
 *
 * Maps each known-kind, non-empty-phrase record to a preference Inference.
 * Unknown kinds and empty phrases are dropped (high precision, low recall —
 * mirrors the detector's own posture). Deterministic + pure.
 */
export function derivePreferences(records = [], ctx = {}) {
  const out = [];
  if (!Array.isArray(records)) return out;
  const sessionId = ctx && typeof ctx.sessionId === 'string' ? ctx.sessionId : null;
  const host = ctx && typeof ctx.host === 'string' ? ctx.host : null;

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const kind = String(rec.kind || '').toLowerCase();
    const confidence = FEEDBACK_KIND_CONFIDENCE[kind];
    if (confidence === undefined) continue; // unknown kind -> ignore

    // DEFECT 3 — recover the preference OBJECT. The live detector sets `phrase`
    // to the trigger token only and carries the content in `context`; slugging
    // `phrase` keyed the inference on the trigger ("no") instead of the
    // preference ("use tabs not spaces"). Extract the content FIRST, then slug
    // it. (When `context` is empty/shorter the extractor returns `phrase`, so
    // the phrase-only wire shape the integration/PII tests author is unchanged.)
    const content = preferenceContent(rec.phrase, rec.context);

    // FIX 4 (CRITICAL-2) — value-level deny/scrub BEFORE minting. A phrase, its
    // context, OR the extracted content carrying a special-category signal is
    // REFUSED outright (never reaches the global store); direct-PII identifiers
    // are scrubbed from the content so even the slug cannot carry a raw
    // email/phone/SSN/card. The deny scan covers the full surface (phrase +
    // context + content) so DEFECT 3's content extraction cannot smuggle a
    // special-category term past the gate.
    const gate = scrubPhrase(content, rec.phrase, rec.context);
    if (!gate.ok) continue; // special-category -> refuse this inference

    const subject = phraseToSubject(gate.scrubbed);
    if (!subject) continue; // empty/punctuation-only (or fully-scrubbed) phrase -> ignore

    const ts = typeof rec.ts === 'string' && Date.parse(rec.ts) > 0
      ? rec.ts
      : undefined; // fall back to makeInference's epoch sentinel

    out.push(makeInference({
      kind: 'preference',
      subject,
      // FIX 4 (CRITICAL-2) — SLUG ONLY. We do NOT persist the verbatim user
      // phrase anywhere in the served atom (it was exfiltrable PII into the
      // global store). The slugged `subject` (already lowercased / punctuation-
      // stripped / PII-scrubbed) is the dedupe key a brief renders; the value
      // carries only the structured feedback kind, never raw user text. The
      // single-row poison vector is neutralized by the cross-session
      // corroboration barrier: evidence_count stays 1 here, BELOW the brief
      // surfacing floor (evidence_count >= 3), so one session cannot mint a
      // brief-surfacing preference — only cross-session accumulation can.
      value: { kind },
      confidence,
      evidence_count: 1,
      last_confirmed: ts,
      source_sessions: sessionId ? [sessionId] : [],
      source_hosts: host ? [host] : [],
      sensitivity: FEEDBACK_KIND_SENSITIVITY[kind] || 'low',
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// S4 — EDIT-DELTA derivation: the CORRECTION LOOP (the HEART of the product).
//
// A preference grounded in an ACTUAL edit-delta (diff of agent-proposal vs the
// user's committed final) is the strongest, cleanest signal — categorically
// above a regex trigger in a prompt. `derivePreferences` (above) maps the
// REGEX-detected feedback rows; THIS path maps the EDIT-DELTA evidence rows
// produced by capture.js `captureEditDelta` (the .session-edits.jsonl stream).
//
// An `edit-after` row (the user changed what the agent wrote — outcome
// 'edit-after', changed:true) becomes a `correction`-kind preference Inference,
// SUBJECT-slugged on the SCOPE + the cited committed direction so the SAME
// correction in the same scope dedupes/corroborates across sessions. The value
// carries the CITATION (the proposed/committed hashes + the bounded cited span)
// so the admission gate can prove the preference is grounded in a real edit.
//
// An `accept` row (the agent's edit landed unchanged) is NOT a preference — it
// is an authorship OUTCOME that flows into the expertise tier (deriveExpertise:
// accept = positive, edit-after = negative) via `editOutcomes` below.
// ---------------------------------------------------------------------------

/** Confidence floor for an edit-delta-grounded correction (strongest signal). */
export const EDIT_CORRECTION_CONFIDENCE = 0.7;

/**
 * editScopeKey(scope) -> a short, stable slug for the scope an edit applies to.
 * Prefers language, falls back to file_pattern. Pure.
 */
function editScopeKey(scope) {
  const s = scope && typeof scope === 'object' ? scope : {};
  return phraseToSubject(String(s.language || s.file_pattern || 'unknown'));
}

/**
 * deriveEditPreferences(editRows, ctx?) -> Inference[].
 *
 * Maps each `edit-after` (changed) edit-delta row to a `correction`-kind
 * preference Inference grounded in the cited edit. `accept` / no-op rows produce
 * no preference (they are expertise signal, handled separately). The subject is
 * `scope::<cited-committed-slug>` so the same correction in the same scope is
 * ONE atom that corroborates across sessions; below the admission floor
 * (evidence_count >= 3 across non-adjacent sessions, enforced in merge.js) it
 * stays UNCONFIRMED — a single accidental edit cannot mint a confirmed
 * preference (prefer under-learning to mis-learning). Pure + deterministic.
 */
export function deriveEditPreferences(editRows = [], ctx = {}) {
  const out = [];
  if (!Array.isArray(editRows)) return out;
  const sessionId = ctx && typeof ctx.sessionId === 'string' ? ctx.sessionId : null;
  const host = ctx && typeof ctx.host === 'string' ? ctx.host : null;
  const ordinal = ctx && Number.isFinite(Number(ctx.sessionOrdinal)) ? Number(ctx.sessionOrdinal) : undefined;

  for (const row of editRows) {
    if (!row || typeof row !== 'object') continue;
    const outcome = String(row.outcome || '').toLowerCase();
    if (outcome !== 'edit-after' || row.changed === false) continue; // accepts/no-ops -> not a preference

    // The cited committed span IS the citation; scrub-and-slug it (the capture
    // layer already PII-scrubbed it, but we re-scan the full surface so a
    // special-category term in the span blocks the inference — never mint).
    const cited = String(row.cited_span || row.direction || '');
    const gate = scrubPhrase(cited, '', '');
    if (!gate.ok) continue; // special-category -> refuse this inference
    const citedSlug = phraseToSubject(gate.scrubbed);
    if (!citedSlug) continue; // empty / fully-scrubbed cited span -> no usable citation

    const scopeKey = editScopeKey(row.scope);
    const subject = `${scopeKey}::${citedSlug}`.slice(0, 80);

    const ts = (typeof row.ts === 'string' && Date.parse(row.ts) > 0)
      ? row.ts
      : (Number.isFinite(Number(row.ts)) && Number(row.ts) > 0
        ? new Date(Number(row.ts)).toISOString()
        : undefined);

    out.push(makeInference({
      kind: 'correction',
      subject,
      // VALUE carries the CITATION — the diff IS the citation. We persist the
      // proposed/committed content HASHES (dedupe keys, never raw bodies) + the
      // scope, so a brief can prove the preference is grounded in a real edit.
      // No raw user text leaves capture's bounded/scrubbed cited span.
      value: {
        kind: 'correction',
        scope: row.scope && typeof row.scope === 'object' ? row.scope : undefined,
        cited: { proposed_hash: row.proposed_hash, committed_hash: row.committed_hash },
      },
      confidence: EDIT_CORRECTION_CONFIDENCE,
      evidence_count: 1,
      last_confirmed: ts,
      source_sessions: sessionId ? [sessionId] : [],
      source_hosts: host ? [host] : [],
      sensitivity: 'med',
    }));
    // Thread the session ordinal so the merge's non-adjacency admission gate can
    // tell apart "3 corroborations from 3 spread-out sessions" (confirm) from
    // "3 edits in one session / back-to-back sessions" (do NOT confirm).
    if (ordinal !== undefined) out[out.length - 1].source_ordinals = [ordinal];
  }
  return out;
}

/**
 * editOutcomes(editRows) -> [{ domain, outcome }] for deriveExpertise.
 *
 * Routes the edit-delta stream into the authorship-outcome vocabulary the
 * (previously DORMANT) `deriveExpertise` emitter consumes: an `accept` row is a
 * positive (the agent's edit landed unchanged), an `edit-after` row is a
 * negative (the user corrected it). The domain is the edit's language scope, so
 * expertise accrues per-language. Pure.
 */
export function editOutcomes(editRows = []) {
  const out = [];
  if (!Array.isArray(editRows)) return out;
  for (const row of editRows) {
    if (!row || typeof row !== 'object') continue;
    const outcome = String(row.outcome || '').toLowerCase();
    if (outcome !== 'accept' && outcome !== 'edit-after') continue;
    const scope = row.scope && typeof row.scope === 'object' ? row.scope : {};
    const domain = String(scope.language || scope.file_pattern || '').trim();
    if (!domain) continue;
    out.push({ domain, outcome });
  }
  return out;
}

// ---------------------------------------------------------------------------
// P2.4 — Top-level: emit a single ProfileDelta.
//
// Composes the three heuristic signals into ONE delta the merge layer folds.
// No store writes (this module never imports ./store.js); persistence is
// `mergeAndWrite`'s job. PURE + DETERMINISTIC: the provenance recency stamp is
// derived from CONTENT (the max feedback timestamp), NOT a wall clock — so two
// calls with the same input produce a deep-equal delta and the merge's
// commutative `updated` invariant is preserved.
// ---------------------------------------------------------------------------

/**
 * deriveHeuristic(input) -> ProfileDelta.
 *
 * @param {object} input
 *   @param {object}  [input.metadata]  per-session style metadata (see deriveStyle)
 *   @param {Array}   [input.outcomes]  authorship outcomes (see deriveExpertise)
 *   @param {Array}   [input.feedback]  .session-feedback.jsonl rows (see derivePreferences)
 *   @param {Array}   [input.edits]     .session-edits.jsonl edit-delta rows (S4 — see
 *                                       deriveEditPreferences / editOutcomes). The
 *                                       CORRECTION LOOP: a preference grounded in an
 *                                       actual edit-delta, NOT a regex trigger.
 *   @param {string}  [input.sessionId] provenance for derived inferences
 *   @param {string}  [input.host]      provenance for derived inferences
 *   @param {number}  [input.sessionOrdinal] monotonic session index (S4 non-adjacency gate)
 *
 * Returns `{ style, expertise, inferences, provenance }` — every field shaped
 * exactly as `applyDelta` reads it. Omits a field when its source signal is
 * absent so an empty input yields a clean no-op delta.
 */
export function deriveHeuristic(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const ctx = { sessionId: src.sessionId, host: src.host, sessionOrdinal: src.sessionOrdinal };

  const delta = {};
  const edits = Array.isArray(src.edits) ? src.edits : [];

  // Style — only emit when metadata was supplied (else deriveStyle would
  // anchor every axis at the low-weight neutral prior, adding noise sessions).
  if (src.metadata && typeof src.metadata === 'object') {
    delta.style = deriveStyle(src.metadata);
  }

  // Expertise — raw {domain:{accepts,n}} counts; omit when empty. The DORMANT
  // accept/edit-after emitter is now fed by BOTH any explicit outcomes AND the
  // S4 edit-delta stream (editOutcomes: accept=positive, edit-after=negative).
  const outcomes = [
    ...(Array.isArray(src.outcomes) ? src.outcomes : []),
    ...editOutcomes(edits),
  ];
  const expertise = deriveExpertise(outcomes);
  if (Object.keys(expertise).length) delta.expertise = expertise;

  // Preferences -> inferences; omit when empty. TWO grounded sources, deduped by
  // the merge on id (kind+subject): (a) the S4 EDIT-DELTA corrections (the HEART
  // — grounded in an actual diff), and (b) the regex-detected feedback rows.
  const inferences = [
    ...deriveEditPreferences(edits, ctx),
    ...derivePreferences(Array.isArray(src.feedback) ? src.feedback : [], ctx),
  ];
  if (inferences.length) delta.inferences = inferences;

  // Provenance: a CONTENT-derived recency stamp (max inference last_confirmed),
  // never a wall clock — keeps deriveHeuristic deterministic and the merge's
  // `updated` MAX commutative. Omit entirely when there is no dated signal so
  // the merge falls back to its own recency logic.
  let maxTs = -Infinity;
  for (const inf of inferences) {
    const t = Date.parse(inf.last_confirmed);
    if (Number.isFinite(t) && t > maxTs) maxTs = t;
  }
  if (Number.isFinite(maxTs) && maxTs > 0) {
    delta.provenance = { updated: new Date(maxTs).toISOString() };
  }

  return delta;
}
