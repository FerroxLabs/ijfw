/**
 * profile/merge.js — Cross-system profile bus, P0.5 (+ P0.6 bounds helpers).
 *
 * CRDT-ish read-merge-write. The convergence mechanism: every per-host/per-repo
 * SessionEnd derives a `ProfileDelta` (P2, not this phase) and folds it into the
 * one global file under the global profile lock. The merge MUST be:
 *   - non-clobbering (read current, fold delta, write back),
 *   - evidence-accumulating (two sessions about the same trait reinforce it),
 *   - commutative on disjoint fields (order of two independent merges can't
 *     change the result — required because N processes interleave arbitrarily).
 *
 * Merge rules (design-v2 §4, plan P0.5):
 *   - style axes:  EMA fold of `sample` (α from weight) + Beta(α,β) mass update.
 *   - inferences:  dedupe by id; SUM evidence_count; UNION source_sessions /
 *                  source_hosts; MAX-recency last_confirmed; MAX confidence.
 *   - expertise:   accumulate accepts/n; recompute Wilson lower-bound.
 *   - overlays:    same style fold, per overlay key; global layer untouched.
 *
 * `applyDelta` is PURE (no I/O, no mutation of its input). `mergeAndWrite`
 * performs the read→merge→bound→write INSIDE the global lock, taking the backup
 * inside the lock (design-v2 §7 Concurrency).
 *
 * Zero deps. NO LLM calls.
 */

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { withProfileLock } from './lock.js';
import {
  readProfile, writeProfile, archiveDir,
} from './store.js';
import {
  makeProfile,
  makeInference,
  inferenceId,
} from './schema.js';
// FIX 2 (CRITICAL-1 / M1 / H4): the per-host trust weighting, single-session
// influence cap, and asymmetric decay are DEFINED in capture.js but were never
// applied in the live fold. We REUSE those constants here (import, do NOT
// duplicate-and-diverge the numbers) so the merge actually enforces the
// documented anti-poison levers.
import {
  STYLE_DELTA_CAP,
  CONFIRM_ALPHA,
  CONTRADICT_ALPHA,
} from './capture.js';

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Wilson score lower bound (95%, z=1.96) on a proportion — the conservative
 * expertise estimate from accept-without-edit ratios (design-v2 §4). N=0 → 0.
 */
export function wilsonLowerBound(accepts, n, z = 1.96) {
  if (!n || n <= 0) return 0;
  const phat = accepts / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const lb = (center - margin) / denom;
  return clamp01(lb);
}

/** Deep-ish clone good enough for our plain-data profile (no functions/dates). */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Fold one style sample into an axis object {ema,alpha,beta,evidence_count}.
 *
 * FIX 2 (CRITICAL-1 / M1 / H4) — the three documented anti-poison levers, now
 * ACTUALLY ENFORCED here (they were inert before: `weight` was only guarded `>0`,
 * so weight:1000 -> step=min(1, 0.15*1000)=1 -> a single delta overwrote the
 * axis; trust was dropped entirely; the per-session δ cap was never applied):
 *
 *   (a) WEIGHT CLAMP — the incoming sample weight is clamped to [0,1]. A weight
 *       above 1 (forged or buggy) behaves as 1, never as a step multiplier.
 *   (b) TRUST SCALING — the effective weight is multiplied by the row's
 *       per-host `trust` (also clamped to [0,1]); a low-trust host moves the
 *       axis strictly less than a full-trust one.
 *   (c) ASYMMETRIC STEP — a CONTRADICTING observation (sample on the opposite
 *       side of the 0.5 midpoint from the current EMA) uses the FASTER
 *       CONTRADICT_ALPHA; a confirming one uses the slower CONFIRM_ALPHA
 *       ("trust slowly, distrust quickly"). Same semantics as capture.js
 *       `asymmetricStep` — constants imported, not re-derived.
 *   (d) HARD δ CAP — the NET EMA move per merge is hard-clamped to
 *       ±STYLE_DELTA_CAP (capture.js `cappedDelta` semantics). No combination of
 *       weight*trust/extremity can move an axis past the cap in ONE merge. This
 *       is the structural single-session anti-drift guarantee.
 *
 * The Beta mass uses the SAME effective (clamped*trust) weight so a forged
 * weight cannot inflate α+β either.
 */
function foldStyleAxis(axis, sample, weight, trust) {
  const s = clamp01(Number(sample));
  // (a) clamp weight to [0,1] — a >1 weight is NOT a multiplier. Default to 1
  // when absent/non-finite (a present observation), 0 only when explicitly 0/neg.
  const wRaw = Number(weight);
  const w = Number.isFinite(wRaw) ? clamp01(wRaw) : 1;
  // (b) trust scaling — clamp to [0,1], default full trust when absent.
  const tRaw = Number(trust);
  const t = Number.isFinite(tRaw) ? clamp01(tRaw) : 1;
  const effW = w * t;

  // (c) asymmetric α — contradiction (opposite side of the 0.5 midpoint) adapts
  // faster. Mirrors capture.js asymmetricStep's side comparison.
  const currentSide = axis.ema >= 0.5 ? 1 : -1;
  const sampleSide = s >= 0.5 ? 1 : -1;
  const contradicting = sampleSide !== currentSide;
  const alpha = contradicting ? CONTRADICT_ALPHA : CONFIRM_ALPHA;

  // EMA step scaled by the effective weight, then (d) HARD-clamped to ±cap.
  const rawStep = (s - axis.ema) * alpha * effW;
  const cappedStep = Math.max(-STYLE_DELTA_CAP, Math.min(STYLE_DELTA_CAP, rawStep));
  const ema = clamp01(axis.ema + cappedStep);

  // Beta mass: treat the sample as a soft success/failure split, using the SAME
  // effective weight so a forged weight cannot inflate the mass either.
  return {
    ...axis,
    ema,
    alpha: axis.alpha + s * effW,
    beta: axis.beta + (1 - s) * effW,
    evidence_count: (axis.evidence_count || 0) + 1,
  };
}

/**
 * Fold a `{axis:{sample,weight,trust}}` style delta into a style map. `trust`
 * is the per-host trust weight threaded from capture (toDeriveMeta carries
 * trust_weight; deriveStyle emits it per observation). Absent trust -> full.
 */
function mergeStyle(styleMap, styleDelta) {
  const out = clone(styleMap || {});
  for (const [axis, obs] of Object.entries(styleDelta || {})) {
    if (!obs || typeof obs !== 'object' || obs.sample === undefined) continue;
    const current = out[axis] || { ema: 0.5, alpha: 1, beta: 1, evidence_count: 0 };
    out[axis] = foldStyleAxis(current, obs.sample, obs.weight, obs.trust);
  }
  return out;
}

// ===========================================================================
// S4 — ADMISSION GATE: cite-or-drop, corroborate-or-stay-unconfirmed.
//
// Nothing becomes "you" without enough INDEPENDENT evidence. A derived
// preference / correction stays UNCONFIRMED until it has been corroborated by
// >= EVIDENCE_CONFIRM_MIN edit-deltas across NON-ADJACENT sessions. The bar is
// deliberately high: prefer UNDER-learning (a real preference takes a few
// sessions to confirm) to MIS-learning (a single accidental edit minting a
// confirmed "you"). Three levers:
//
//   (1) NON-ADJACENT corroboration — we count DISTINCT sessions, and require
//       that they are not all back-to-back (a real recurring preference shows up
//       across spread-out work, not three edits in one sitting). The session
//       ORDINAL threaded from derive (source_ordinals) drives this.
//   (2) DECAY / HALF-LIFE — a confirmed preference that is not re-validated
//       within CONFIRM_HALF_LIFE_MS drops back to UNCONFIRMED (its confidence
//       decays). A stale "you" must re-earn its standing.
//   (3) CONTRADICTION FLIPS THE SIGN, with HISTORY — a later edit-delta that
//       contradicts the current direction (different committed_hash for the same
//       scope-subject) does NOT silently overwrite: it pushes the prior belief
//       into `history[]` (invalidate-with-history, forensic + reversible) and
//       resets corroboration so the NEW direction must itself re-earn confirmed.
// ===========================================================================

/** Distinct non-adjacent sessions required before a derived preference confirms. */
export const EVIDENCE_CONFIRM_MIN = 3;
/** A confirmed preference not re-validated within this window decays to unconfirmed. */
export const CONFIRM_HALF_LIFE_MS = 1000 * 60 * 60 * 24 * 60; // 60 days
/** Confidence multiplier applied when a confirmed preference goes stale. */
export const CONFIRM_DECAY_FACTOR = 0.5;
/** Max retained prior-belief history entries per inference (bounded forensics). */
export const MAX_INFERENCE_HISTORY = 8;

/** True when the corroborating session ordinals are NOT all consecutive. */
function hasNonAdjacentSpread(ordinals) {
  const uniq = [...new Set(ordinals.filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  if (uniq.length < EVIDENCE_CONFIRM_MIN) return false;
  // At least one gap > 1 between consecutive corroborations => spread-out work,
  // not a single back-to-back burst. If we have no ordinal info at all, fall
  // back to distinct-session count only (handled by the caller).
  for (let i = 1; i < uniq.length; i += 1) {
    if (uniq[i] - uniq[i - 1] > 1) return true;
  }
  return false;
}

/**
 * confirmationState(inference, { now }) -> 'unconfirmed' | 'confirmed'.
 *
 * Pure. A derived preference/correction is CONFIRMED only when it has been
 * corroborated by >= EVIDENCE_CONFIRM_MIN distinct sessions AND (when ordinals
 * are present) those sessions are non-adjacent AND it has been re-validated
 * within CONFIRM_HALF_LIFE_MS. Otherwise UNCONFIRMED — the brief must not
 * surface it as an established preference.
 */
export function confirmationState(inference, { now = Date.now() } = {}) {
  if (!inference || typeof inference !== 'object') return 'unconfirmed';
  const distinct = new Set(inference.source_sessions || []).size;
  if (distinct < EVIDENCE_CONFIRM_MIN) return 'unconfirmed';

  const ordinals = Array.isArray(inference.source_ordinals) ? inference.source_ordinals : [];
  // When ordinal evidence exists, demand non-adjacency. When it is absent
  // entirely (legacy rows / feedback path), distinct-session count alone gates.
  if (ordinals.length >= EVIDENCE_CONFIRM_MIN && !hasNonAdjacentSpread(ordinals)) {
    return 'unconfirmed';
  }

  // Half-life: a confirmed preference must have been re-validated recently.
  const last = Date.parse(inference.last_confirmed) || 0;
  if (last > 0 && (now - last) > CONFIRM_HALF_LIFE_MS) return 'unconfirmed';
  return 'confirmed';
}

/** Direction key for a derived preference: which committed span it points at. */
function directionKey(inf) {
  const v = inf && inf.value;
  if (v && typeof v === 'object' && v.cited && typeof v.cited === 'object') {
    return String(v.cited.committed_hash || '');
  }
  return '';
}

/**
 * Evidence-accumulate one incoming inference into a dialectic[] list. Applies
 * the S4 admission gate: distinct + non-adjacent session corroboration, the
 * confirmed/unconfirmed flag, half-life recompute, and contradiction-flips-with-
 * history (a later opposite-direction edit invalidates-with-history rather than
 * overwriting).
 */
function mergeInference(list, incoming, now = Date.now()) {
  const id = incoming.id || inferenceId(incoming.kind, incoming.subject);
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) {
    const seeded = makeInference(incoming);
    // Carry the S4 non-adjacency ordinals + the cold confirmation flag.
    if (Array.isArray(incoming.source_ordinals)) {
      seeded.source_ordinals = [...new Set(incoming.source_ordinals.filter((n) => Number.isFinite(n)))];
    }
    // S2 — carry the precision-gate verdict (stamped by precision-stamp.mjs at
    // derive time). makeInference drops unknown fields, so without this the flag
    // never reaches the stored atom and the snapshot gate (render-brief.js) stays
    // dead. Fail-closed: absent stamp => false (held back), never silently true.
    seeded.precision_eligible = incoming.precision_eligible === true;
    seeded.confirmed = confirmationState(seeded, { now }) === 'confirmed';
    list.push(seeded);
    return;
  }
  const cur = list[idx];
  const curDir = directionKey(cur);
  const incDir = directionKey(incoming);
  const curTs = Date.parse(cur.last_confirmed) || 0;
  const incTs = Date.parse(incoming.last_confirmed) || 0;

  // (3) CONTRADICTION — a later edit-delta points at a DIFFERENT committed span
  // for the SAME scope-subject. Do NOT overwrite: push the prior belief to
  // history (invalidate-with-history) and RESET corroboration so the new
  // direction must itself re-earn confirmed from scratch.
  const contradicts = curDir && incDir && curDir !== incDir && incTs >= curTs;
  if (contradicts) {
    const history = Array.isArray(cur.history) ? cur.history.slice() : [];
    history.push({
      value: cur.value,
      confidence: cur.confidence,
      evidence_count: cur.evidence_count,
      last_confirmed: cur.last_confirmed,
      invalidated_at: new Date(now).toISOString(),
      reason: 'contradicted-by-later-edit',
    });
    const flipped = makeInference({
      ...cur,
      value: incoming.value,
      confidence: Number(incoming.confidence) || 0,
      evidence_count: incoming.evidence_count || 1,
      last_confirmed: incoming.last_confirmed,
      source_sessions: [...(incoming.source_sessions || [])],
      source_hosts: [...(incoming.source_hosts || [])],
      sensitivity: cur.sensitivity, // sticky
    });
    flipped.source_ordinals = Array.isArray(incoming.source_ordinals)
      ? [...new Set(incoming.source_ordinals.filter((n) => Number.isFinite(n)))]
      : [];
    // S2 — the FLIPPED (new-direction) atom must re-earn precision eligibility:
    // take the incoming stamp (fail-closed to false). The old direction's verdict
    // does not carry over to a contradicting belief.
    flipped.precision_eligible = incoming.precision_eligible === true;
    flipped.history = history.slice(-MAX_INFERENCE_HISTORY);
    flipped.confirmed = confirmationState(flipped, { now }) === 'confirmed';
    list[idx] = flipped;
    return;
  }

  // CONFIRMING corroboration — accumulate evidence, union sources/ordinals.
  const sessions = new Set([...(cur.source_sessions || []), ...(incoming.source_sessions || [])]);
  const hosts = new Set([...(cur.source_hosts || []), ...(incoming.source_hosts || [])]);
  const ordinals = new Set([
    ...(Array.isArray(cur.source_ordinals) ? cur.source_ordinals : []),
    ...(Array.isArray(incoming.source_ordinals) ? incoming.source_ordinals : []),
  ].filter((n) => Number.isFinite(n)));
  const merged = makeInference({
    ...cur,
    // value follows the most recent confirmation
    value: incTs >= curTs ? incoming.value : cur.value,
    confidence: Math.max(Number(cur.confidence) || 0, Number(incoming.confidence) || 0),
    evidence_count: (cur.evidence_count || 0) + (incoming.evidence_count || 0),
    last_confirmed: incTs >= curTs ? incoming.last_confirmed : cur.last_confirmed,
    source_sessions: [...sessions],
    source_hosts: [...hosts],
    sensitivity: cur.sensitivity, // sensitivity is sticky once set
  });
  merged.source_ordinals = [...ordinals];
  // S2 — the precision verdict follows the most-recent stamp: a re-stamped
  // incoming (precision_eligible present) wins; otherwise the current verdict is
  // preserved (corroboration alone never UN-stamps a previously-cleared atom, and
  // never silently promotes one — fail-closed default false).
  merged.precision_eligible = Object.prototype.hasOwnProperty.call(incoming, 'precision_eligible')
    ? incoming.precision_eligible === true
    : cur.precision_eligible === true;
  if (Array.isArray(cur.history)) merged.history = cur.history.slice(-MAX_INFERENCE_HISTORY);
  // (1)+(2) recompute the admission flag: distinct + non-adjacent + not-stale.
  merged.confirmed = confirmationState(merged, { now }) === 'confirmed';
  list[idx] = merged;
}

/** Accumulate expertise counts and recompute the Wilson lower bound. */
function mergeExpertise(map, expertiseDelta) {
  const out = clone(map || {});
  for (const [domain, obs] of Object.entries(expertiseDelta || {})) {
    if (!obs || typeof obs !== 'object') continue;
    const cur = out[domain] || { accepts: 0, n: 0, wilsonLB: 0 };
    const accepts = (cur.accepts || 0) + (Number(obs.accepts) || 0);
    const n = (cur.n || 0) + (Number(obs.n) || 0);
    out[domain] = { accepts, n, wilsonLB: wilsonLowerBound(accepts, n) };
  }
  return out;
}

/**
 * applyDelta(profile, delta) -> NEW profile. Pure: never mutates `profile`.
 *
 * ProfileDelta = {
 *   style?:      { axis: { sample:0..1, weight?:number } },
 *   inferences?: Inference[],
 *   expertise?:  { domain: { accepts:number, n:number } },
 *   overlays?:   { key: { style?: {...} } },
 *   provenance?: { ...scalars to merge },
 * }
 */
export function applyDelta(profile, delta = {}, opts = {}) {
  const next = clone(profile || makeProfile());
  if (!next.global) next.global = { style: {}, dialectic: [] };
  if (!next.global.style) next.global.style = {};
  if (!Array.isArray(next.global.dialectic)) next.global.dialectic = [];
  if (!next.overlays) next.overlays = {};
  if (!next.expertise) next.expertise = {};
  if (!next.provenance) next.provenance = {};

  // A single `now` for the whole fold so the S4 admission gate's half-life /
  // confirmation flag is evaluated consistently (overridable for tests). NOT
  // persisted into any content field — provenance.updated stays content-derived
  // (commutative MAX, below), so applyDelta remains deterministic on its inputs.
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();

  if (delta.style) {
    next.global.style = mergeStyle(next.global.style, delta.style);
  }

  if (Array.isArray(delta.inferences)) {
    for (const inc of delta.inferences) {
      if (!inc || typeof inc !== 'object') continue;
      mergeInference(next.global.dialectic, inc, now);
    }
  }

  if (delta.expertise) {
    next.expertise = mergeExpertise(next.expertise, delta.expertise);
  }

  if (delta.overlays) {
    for (const [key, ov] of Object.entries(delta.overlays)) {
      if (!ov || typeof ov !== 'object') continue;
      const cur = next.overlays[key] || { style: {} };
      const merged = { ...cur };
      if (ov.style) merged.style = mergeStyle(cur.style || {}, ov.style);
      if (Array.isArray(ov.inferences)) {
        if (!Array.isArray(merged.dialectic)) merged.dialectic = [];
        for (const inc of ov.inferences) mergeInference(merged.dialectic, inc, now);
      }
      next.overlays[key] = merged;
    }
  }

  // Capture the prior `updated` BEFORE folding the delta's provenance scalars,
  // so the delta cannot clobber the existing recency we are about to MAX over.
  const priorUpdated = next.provenance.updated;
  if (delta.provenance && typeof delta.provenance === 'object') {
    next.provenance = { ...next.provenance, ...delta.provenance };
  }
  // `provenance.updated` must be COMMUTATIVE on disjoint merges: two independent
  // deltas folded in either order must yield the same value (N processes
  // interleave arbitrarily). A wall-clock `new Date()` stamp breaks that — two
  // orderings stamp different instants. Instead derive `updated` from the
  // CONTENT: the MAX (most-recent) of the existing value, the delta's
  // provenance.updated, and the incoming inferences' last_confirmed (the
  // natural recency signal). MAX is order-independent, so commutativity holds,
  // and `updated` never moves backward (monotonic).
  const recencyCandidates = [
    priorUpdated,
    delta.provenance && delta.provenance.updated,
  ];
  if (Array.isArray(delta.inferences)) {
    for (const inc of delta.inferences) {
      if (inc && typeof inc === 'object') recencyCandidates.push(inc.last_confirmed);
    }
  }
  if (delta.overlays) {
    for (const ov of Object.values(delta.overlays)) {
      if (ov && Array.isArray(ov.inferences)) {
        for (const inc of ov.inferences) {
          if (inc && typeof inc === 'object') recencyCandidates.push(inc.last_confirmed);
        }
      }
    }
  }
  let maxTs = -Infinity;
  let maxIso = next.provenance.updated;
  for (const cand of recencyCandidates) {
    const t = Date.parse(cand);
    if (Number.isFinite(t) && t > maxTs) {
      maxTs = t;
      maxIso = new Date(t).toISOString();
    }
  }
  next.provenance.updated = maxIso;

  return next;
}

// ---------------------------------------------------------------------------
// P0.6 — Bounded store + eviction + decay-to-archive.
//
// The global profile must not grow without bound as N sessions accumulate.
// Hard caps on dialectic inference + per-overlay inference counts; eviction
// drops the LOWEST-confidence / OLDEST entries; decay reduces confidence of
// stale low-evidence inferences and ARCHIVES them (never hard-delete — the
// archive is forensic + recoverable, design-v2 §4 "decay-to-archive (not just
// decay)").
// ---------------------------------------------------------------------------

export const DEFAULT_BOUNDS = Object.freeze({
  maxDialectic: 200,        // global trait inferences cap
  maxOverlayInferences: 100, // per-overlay inference cap
  maxExpertiseDomains: 200,
  // decay: an inference not confirmed within this window AND below the evidence
  // floor decays; once its confidence falls under archiveBelow it is archived.
  staleMs: 1000 * 60 * 60 * 24 * 90, // 90 days
  decayEvidenceFloor: 3,             // < this many confirmations = decay-eligible
  decayFactor: 0.5,                  // confidence multiplier on decay
  archiveBelow: 0.1,                 // archive once confidence drops under this
});

function archiveInferences(entries) {
  if (!entries || entries.length === 0) return;
  try {
    const dir = archiveDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Snapshot the current profile alongside the archived entries for forensics,
    // then append a JSONL record. Best-effort — archiving must never break a
    // merge. We append rather than rewrite so concurrent (lock-held) merges
    // accrete history.
    const rec = { ts: new Date().toISOString(), archived: entries };
    const line = `${JSON.stringify(rec)}\n`;
    const file = join(dir, 'archived-inferences.jsonl');
    // appendFileSync is fine here — merges run inside the global lock, so the
    // JSONL accretes history without interleaving.
    appendFileSync(file, line, 'utf8');
  } catch {
    // forensic-only; swallow.
  }
}

/** Sort key for eviction: lowest confidence first, then oldest confirmation. */
function evictionRank(a, b) {
  const ca = Number(a.confidence) || 0;
  const cb = Number(b.confidence) || 0;
  if (ca !== cb) return ca - cb;
  const ta = Date.parse(a.last_confirmed) || 0;
  const tb = Date.parse(b.last_confirmed) || 0;
  return ta - tb;
}

/**
 * decayAndArchive(list, bounds, now) -> { kept, archived }.
 * Stale, low-evidence inferences have their confidence reduced; any that fall
 * under archiveBelow are pulled out (archived, not hard-deleted).
 */
function decayAndArchive(list, bounds, now) {
  const kept = [];
  const archived = [];
  for (const inf of list) {
    // `last_confirmed` defaults to epoch (Date(0)) — a deliberate "never
    // confirmed" sentinel from makeInference. A never-confirmed inference is
    // brand-new (e.g. a freshly-derived P2 trait), NOT ~56-years-stale, so it
    // must not be treated as stale. Only inferences with a real confirmation
    // timestamp (ts > 0) can age into staleness.
    const ts = Date.parse(inf.last_confirmed) || 0;
    const isStale = ts > 0 && (now - ts) > bounds.staleMs;
    const lowEvidence = (inf.evidence_count || 0) < bounds.decayEvidenceFloor;
    let decayed = inf;
    if (isStale && lowEvidence) {
      // S4 lever (2): a stale low-evidence preference decays AND drops back to
      // UNCONFIRMED — a stale "you" must re-earn its standing before a brief
      // surfaces it again. (A high-evidence inference is exempt: it cleared the
      // corroboration bar and decayEvidenceFloor keeps it out of this branch.)
      decayed = {
        ...inf,
        confidence: clamp01((Number(inf.confidence) || 0) * bounds.decayFactor),
        confirmed: false,
      };
    }
    // Archive ONLY when genuinely stale (mirrors the decay gate). Without the
    // staleness requirement, a fresh low-confidence inference is silently
    // archived on its first enforceBounds — data loss for derived traits.
    if (isStale && (Number(decayed.confidence) || 0) < bounds.archiveBelow && lowEvidence) {
      archived.push(decayed);
    } else {
      kept.push(decayed);
    }
  }
  return { kept, archived };
}

/**
 * enforceBounds(profile, bounds) -> NEW profile with caps applied. Decays +
 * archives stale low-evidence inferences first, then evicts the lowest-ranked
 * entries if still over cap. Archived entries are written to the archive dir.
 * Pure w.r.t. its input (returns a clone); the archive write is a side effect.
 */
export function enforceBounds(profile, bounds = DEFAULT_BOUNDS) {
  const b = { ...DEFAULT_BOUNDS, ...bounds };
  const next = clone(profile || makeProfile());
  const now = Date.now();
  const allArchived = [];

  // Global dialectic: decay-to-archive, then cap by eviction.
  if (Array.isArray(next.global?.dialectic)) {
    const { kept, archived } = decayAndArchive(next.global.dialectic, b, now);
    allArchived.push(...archived);
    let keep = kept;
    if (keep.length > b.maxDialectic) {
      const ranked = [...keep].sort(evictionRank);
      const evicted = ranked.slice(0, keep.length - b.maxDialectic);
      allArchived.push(...evicted);
      const evictedIds = new Set(evicted.map((x) => x.id));
      keep = keep.filter((x) => !evictedIds.has(x.id));
    }
    next.global.dialectic = keep;
  }

  // Per-overlay inference caps (decay + evict, same policy).
  for (const key of Object.keys(next.overlays || {})) {
    const ov = next.overlays[key];
    if (Array.isArray(ov?.dialectic)) {
      const { kept, archived } = decayAndArchive(ov.dialectic, b, now);
      allArchived.push(...archived);
      let keep = kept;
      if (keep.length > b.maxOverlayInferences) {
        const ranked = [...keep].sort(evictionRank);
        const evicted = ranked.slice(0, keep.length - b.maxOverlayInferences);
        allArchived.push(...evicted);
        const evictedIds = new Set(evicted.map((x) => x.id));
        keep = keep.filter((x) => !evictedIds.has(x.id));
      }
      ov.dialectic = keep;
    }
  }

  // Expertise: cap domains by lowest Wilson LB (oldest signal first via n).
  const domains = Object.keys(next.expertise || {});
  if (domains.length > b.maxExpertiseDomains) {
    const ranked = domains
      .map((d) => ({ d, lb: Number(next.expertise[d].wilsonLB) || 0, n: Number(next.expertise[d].n) || 0 }))
      .sort((x, y) => (x.lb - y.lb) || (x.n - y.n));
    const drop = ranked.slice(0, domains.length - b.maxExpertiseDomains);
    for (const { d } of drop) delete next.expertise[d];
  }

  if (allArchived.length) archiveInferences(allArchived);
  return next;
}

/**
 * mergeAndWrite(delta, opts?) — read → merge → bound → write, INSIDE the global
 * profile lock. The backup is taken by writeProfile (which copies the prior good
 * content before overwrite) — and because the whole read-merge-write is under
 * the lock, two converging processes serialize and neither update is lost.
 *
 * @param {object} delta   a ProfileDelta
 * @param {object} [opts]  { lockPath, bounds } — lockPath for test isolation
 * @returns {Promise<{ok:boolean, code?:string, message?:string}>}
 */
export function mergeAndWrite(delta, opts = {}) {
  const { lockPath, bounds = DEFAULT_BOUNDS, ...lockOpts } = opts;
  return withProfileLock(async () => {
    const r = readProfile();
    if (!r.ok) {
      // Corrupt + unrecoverable: refuse rather than clobber. Caller surfaces.
      return { ok: false, code: r.code || 'EREAD', message: r.message };
    }
    let merged = applyDelta(r.profile, delta);
    merged = enforceBounds(merged, bounds);
    const w = writeProfile(merged);
    return w;
  }, { lockPath, ...lockOpts });
}
