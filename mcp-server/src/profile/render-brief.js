/**
 * profile/render-brief.js — Cross-system profile bus, PHASE P4 (P4.1).
 *
 * renderBrief() composes a SHORT, DESCRIPTIVE summary of the user-global
 * profile for passive injection into a host session (design-v2 §5 "serving").
 * It is the read side of the moat: it makes ZERO LLM calls and imports ONLY the
 * zero-LLM schema / heuristic / sensitivity modules — the P4.5 import-graph
 * guard statically proves it never reaches the LLM tier.
 *
 * COMPOSITION (design-v2 §4 layering):
 *   global ⊕ active-overlay   — the overlay (context.overlay key) OVERRIDES the
 *   global layer field-by-field. An overlay inference with the same id as a
 *   global one wins (more specific context); an overlay style axis overrides the
 *   global axis estimate.
 *
 * INCLUSION GATES (only "earned" signal is surfaced):
 *   - inferences: confidence > 0.6 AND evidence_count >= 3. Below either floor
 *     the signal is too thin to assert as an observed pattern.
 *   - style axes: only CONFIRMED axes (>= 5 sessions of evidence, via
 *     styleAxisConfirmed). An unconfirmed axis is omitted — never guessed.
 *
 * PHRASING — descriptive "observed patterns", NEVER imperative instructions.
 * The brief tells a host what HAS BEEN OBSERVED, not what it MUST do (design-v2
 * §5: the profile informs, it does not command — that keeps the host's own
 * judgement primary and the profile non-coercive).
 *
 * SENSITIVITY + REDACTION — every candidate field is sensitivity-gated
 * (low-only by default; med/high require the per-host opt-in) and run through
 * the redaction denylist + kill-switch BEFORE it is emitted (sensitivity.js).
 *
 * BUDGET — tokenBudget caps the output. We greedily emit highest-priority
 * fields first (style, then expertise, then inferences by confidence) and stop
 * once the budget would be exceeded — a partial brief beats a truncated one.
 *
 * COLD START — an empty/missing profile yields an EMPTY brief, never an error.
 *
 * Zero deps, Node built-ins only. NO LLM calls.
 */

import { STYLE_AXES } from './schema.js';
import { styleAxisConfirmed, expertiseBand } from './derive-heuristic.js';
import {
  fieldSensitivity,
  sensitivityAllowed,
  loadRedaction,
  killSwitchEngaged,
  isRedacted,
} from './sensitivity.js';
// S5 — the audit module owns the human-in-the-loop inject-eligibility gate
// (`injectEligibleIds` = approved-in-registry AND carries a citation locator).
// It imports ONLY lock/store/egress/schema (all zero-LLM), so pulling it here
// keeps the P4.5 moat intact: the serve read path still never reaches the LLM
// tier. The moat-guard import-graph test re-proves this on every run.
import { injectEligibleIds } from './audit.js';

/**
 * Inference inclusion floors (design-v2 §5; audit L2 reconciliation).
 *
 * L2: dialectic inferences are capped at confidence 0.5 (anti-poison — a derived
 * belief about the user must never assert as a hard fact). The OLD confidence
 * floor of 0.6 therefore made EVERY dialectic inference structurally unreachable
 * through the brief/get read path — the lever could fire but its output could
 * never surface. We LOWER the confidence floor to 0.45 so a corroborated
 * dialectic trait (conf 0.5) can surface, while keeping `evidence_count >= 3` as
 * the REAL corroboration barrier (it, not the confidence number, is what stops a
 * single-shot poison from leaking). A trait at/below the dialectic cap is phrased
 * as "tentative" so it reads as an observed-but-soft pattern, not a fact.
 */
export const BRIEF_MIN_CONFIDENCE = 0.45;
export const BRIEF_MIN_EVIDENCE = 3;

/**
 * Below this confidence an inference is phrased TENTATIVELY ("appears to") rather
 * than as a plain observed pattern. The dialectic cap is 0.5, so any dialectic
 * trait that surfaces lands in the tentative band by construction.
 */
export const BRIEF_TENTATIVE_BELOW = 0.55;

/** ~4 chars per token — the cheap, dependency-free budget estimator. */
const CHARS_PER_TOKEN = 4;

/** Default token budget when the caller doesn't cap it. */
export const DEFAULT_TOKEN_BUDGET = 400;

/**
 * VOICE FEW-SHOT BUDGET (V3). The `<ijfw-voice>` block few-shots the user's OWN
 * writing so a drafter can match their voice. It is bounded on BOTH axes so it
 * can never balloon a prompt: at most VOICE_MAX_SAMPLES samples AND at most
 * VOICE_MAX_CHARS of total sample text (the running sum of the rendered snippet
 * text). A sample that would push past either cap is dropped cleanly — a partial
 * block of whole samples beats a truncated mid-sentence one. A single sample
 * whose own text already exceeds the char budget is itself hard-truncated to the
 * remaining budget with an ellipsis so one giant snippet can't starve the block.
 */
export const VOICE_MAX_SAMPLES = 4;
export const VOICE_MAX_CHARS = 800;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

/** Human-readable phrase for a style axis estimate (descriptive, not imperative). */
function describeStyleAxis(axis, ema) {
  const v = Number(ema);
  // Three-band qualitative description per axis so the brief reads naturally
  // and never as a command ("the user TENDS toward", not "BE terse").
  const bands = {
    formality: ['casual', 'balanced', 'formal'],
    energy: ['measured', 'steady', 'high-energy'],
    terseness: ['expansive', 'moderate', 'terse'],
    emoji_use: ['rare', 'occasional', 'frequent'],
  };
  const labels = bands[axis] || ['low', 'moderate', 'high'];
  let band;
  if (v < 0.34) band = labels[0];
  else if (v < 0.67) band = labels[1];
  else band = labels[2];
  return band;
}

/**
 * DIRECTIVE phrasing of a style axis (opt-in `style:'directive'` mode only).
 *
 * Same DERIVED band (same gating, same confidence/evidence floors, same
 * sensitivity tier) — only the surface wording changes from an OBSERVATION
 * ("terseness: expansive") to ACTIONABLE GUIDANCE ("prefer expansive, detailed
 * responses"). This is the read-time hypothesis under test (Push v2): does
 * phrasing the SAME signal as guidance move a host's behaviour where the
 * descriptive default does not? It adds NO new derived content and NO new
 * imports — the moat (zero-LLM read path) is unchanged.
 */
function directiveStyleAxis(axis, ema) {
  const band = describeStyleAxis(axis, ema);
  // Map (axis, band) -> an imperative the host can act on. The mapping is a pure
  // lookup over the SAME three bands the descriptive path emits.
  const guidance = {
    formality: {
      casual: 'keep a casual, relaxed tone',
      balanced: 'keep a balanced, neutral tone',
      formal: 'prefer a formal, precise tone',
    },
    energy: {
      measured: 'keep a calm, measured delivery',
      steady: 'keep a steady delivery',
      'high-energy': 'match a high-energy, enthusiastic delivery',
    },
    terseness: {
      expansive: 'prefer expansive, detailed responses',
      moderate: 'aim for moderate-length responses',
      terse: 'prefer concise, terse responses',
    },
    emoji_use: {
      rare: 'avoid emoji',
      occasional: 'occasional emoji are welcome',
      frequent: 'emoji are welcome and expected',
    },
  };
  const byAxis = guidance[axis];
  return byAxis && byAxis[band] ? byAxis[band] : band;
}

/**
 * Merge global ⊕ overlay style maps (overlay axis overrides global axis).
 * Returns a plain { axis: {ema,alpha,beta,evidence_count} } map.
 */
function composeStyle(globalStyle = {}, overlayStyle = {}) {
  const out = {};
  for (const axis of STYLE_AXES) {
    const ov = overlayStyle && overlayStyle[axis];
    const gl = globalStyle && globalStyle[axis];
    out[axis] = ov || gl || null;
  }
  return out;
}

/**
 * Merge global ⊕ overlay dialectic lists by inference id (overlay wins on id
 * collision — more specific context overrides the global belief).
 */
function composeInferences(globalList = [], overlayList = []) {
  const byId = new Map();
  for (const inf of Array.isArray(globalList) ? globalList : []) {
    if (inf && inf.id) byId.set(inf.id, inf);
  }
  for (const inf of Array.isArray(overlayList) ? overlayList : []) {
    if (inf && inf.id) byId.set(inf.id, inf); // overlay overrides global
  }
  return [...byId.values()];
}

/**
 * Phrase a preference/trait inference as an observed pattern. Low-confidence
 * (dialectic-capped) items are phrased TENTATIVELY so they read as soft,
 * observed-but-unconfirmed patterns rather than asserted facts (audit L2).
 */
function describeInference(inf, style = 'descriptive') {
  const subject = String(inf.subject || '').trim();
  let detail = '';
  if (inf.value && typeof inf.value === 'object' && inf.value.phrase) {
    detail = String(inf.value.phrase).trim();
  } else if (inf.value != null && typeof inf.value !== 'object') {
    detail = String(inf.value).trim();
  }
  const what = detail || subject;
  if (!what) return null;
  const tentative = inf.kind === 'dialectic'
    || (Number(inf.confidence) || 0) < BRIEF_TENTATIVE_BELOW;
  if (style === 'directive') {
    // DIRECTIVE: phrase the SAME derived preference as actionable guidance.
    // Tentative (dialectic-capped) items soften to "where it fits" so a soft,
    // corroborated-but-not-certain belief never asserts as a hard command.
    return tentative
      ? `Where it fits, lean toward: ${what}`
      : `Honor this preference: ${what}`;
  }
  return tentative ? `Tentative pattern: ${what}` : `Observed preference: ${what}`;
}

/**
 * renderBrief(profile, opts) -> { text, fields }.
 *
 * @param {object} profile  a UserProfile (schema.makeProfile shape)
 * @param {object} [opts]
 *   @param {number}  [opts.tokenBudget]    cap on output tokens (default 400)
 *   @param {object}  [opts.context]        { overlay?:string } active overlay key
 *   @param {boolean} [opts.shareSensitive] include med/high fields (per-host opt-in)
 *   @param {object}  [opts.env]            env source (defaults to process.env)
 *   @param {string}  [opts.redactFile]     override redact.txt path (tests)
 *   @param {('descriptive'|'directive')} [opts.style]  phrasing mode (default
 *     'descriptive'). 'directive' phrases the SAME gated/derived content as
 *     actionable guidance ("prefer concise responses") instead of observation
 *     ("terseness: terse"). It is OPT-IN: the default stays descriptive (the
 *     deliberate anti-over-personalization choice). Same inclusion floors, same
 *     sensitivity gating, same redaction, same zero-LLM moat — only wording
 *     changes. (Push v2 hypothesis: directive phrasing of the derived profile
 *     moves host behaviour where descriptive does not.)
 *
 * @returns {{ text:string, fields:string[] }}
 *   `fields` is the list of EMITTED field ids (inference ids + style/expertise
 *   tags) — exactly what the egress ledger records as having left the machine.
 */
export function renderBrief(profile, opts = {}) {
  const tokenBudget = Number.isFinite(opts.tokenBudget) && opts.tokenBudget > 0
    ? opts.tokenBudget
    : DEFAULT_TOKEN_BUDGET;
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const env = opts.env || process.env;
  // Phrasing mode. DEFAULT 'descriptive' — directive is strictly opt-in and only
  // changes surface wording, never which fields are gated in.
  const phrasing = opts.style === 'directive' ? 'directive' : 'descriptive';

  // Kill-switch + redaction are loaded ONCE up front; the kill-switch short
  // circuits the whole render so nothing can leak past it.
  const redaction = loadRedaction({ env, redactFile: opts.redactFile });
  if (killSwitchEngaged(redaction)) {
    return { text: '', fields: [] };
  }

  // Cold start: missing/empty profile -> empty brief, never an error.
  if (!profile || typeof profile !== 'object' || !profile.global) {
    return { text: '', fields: [] };
  }

  // Sensitivity gate inputs: the per-call/env opt-in PLUS the resolved host
  // (cross-checked against the share-hosts allowlist — audit MED-2) PLUS
  // forceLowOnly (passive read => low-only, audit MED-3). host/forceLowOnly are
  // threaded by serve.js; absent (direct callers) => default-deny on sensitive.
  const shareOpts = {
    env,
    shareSensitive: opts.shareSensitive,
    host: typeof opts.host === 'string' ? opts.host : (typeof context.host === 'string' ? context.host : undefined),
    forceLowOnly: opts.forceLowOnly === true,
    enforceHostAllowlist: opts.enforceHostAllowlist === true,
    shareHostsFile: opts.shareHostsFile,
  };
  const overlayKey = typeof context.overlay === 'string' ? context.overlay : null;
  const overlay = overlayKey && profile.overlays ? profile.overlays[overlayKey] : null;

  // Build a priority-ordered candidate list. Each candidate carries its emitted
  // field id, its rendered line, and its sensitivity — gating happens here so a
  // redacted/over-sensitive field never reaches the output OR the egress list.
  const candidates = [];

  // 1) STYLE (low-sensitivity, highest priority — the cheapest, most-shared
  //    signal). Only confirmed axes; overlay overrides global.
  const style = composeStyle(
    profile.global.style,
    overlay && overlay.style ? overlay.style : {},
  );
  for (const axis of STYLE_AXES) {
    const a = style[axis];
    if (!a || !styleAxisConfirmed(a)) continue; // omit unconfirmed axes
    const fieldId = `style:${axis}`;
    const sens = fieldSensitivity({ kind: 'style' });
    if (!sensitivityAllowed(sens, shareOpts)) continue;
    if (isRedacted(fieldId, redaction)) continue;
    candidates.push({
      fieldId,
      sens,
      priority: 0,
      line: phrasing === 'directive'
        ? `Communication style — ${directiveStyleAxis(axis, a.ema)}.`
        : `Communication style — ${axis.replace('_', ' ')}: ${describeStyleAxis(axis, a.ema)}.`,
    });
  }

  // 2) EXPERTISE (low-sensitivity). Only banded domains (N>=5 via expertiseBand).
  if (profile.expertise && typeof profile.expertise === 'object') {
    for (const [domain, rec] of Object.entries(profile.expertise)) {
      const band = expertiseBand(rec);
      if (band === 'unknown') continue; // too thin to name
      const fieldId = `expertise:${domain}`;
      const sens = fieldSensitivity({ kind: 'expertise' });
      if (!sensitivityAllowed(sens, shareOpts)) continue;
      if (isRedacted(fieldId, redaction)) continue;
      candidates.push({
        fieldId,
        sens,
        priority: 1,
        line: phrasing === 'directive'
          ? `Expertise — ${domain}: ${band}; you can assume this level and skip basics.`
          : `Observed expertise — ${domain}: ${band}.`,
      });
    }
  }

  // 3) INFERENCES (preferences/traits/dialectic). Sensitivity per the
  //    inference's own tag. Inclusion floor: confidence > 0.45 AND
  //    evidence_count >= 3 (audit L2: the 0.45 floor lets a corroborated
  //    dialectic trait — capped at conf 0.5 — surface; the evidence_count >= 3
  //    gate, not the confidence number, is the real corroboration barrier).
  //    Sorted by confidence desc so the strongest signal survives a tight budget.
  const inferences = composeInferences(
    profile.global.dialectic,
    overlay && overlay.dialectic ? overlay.dialectic : [],
  )
    .filter((inf) => inf
      && Number(inf.confidence) > BRIEF_MIN_CONFIDENCE
      && (Number(inf.evidence_count) || 0) >= BRIEF_MIN_EVIDENCE)
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));

  for (const inf of inferences) {
    const sens = fieldSensitivity({ kind: 'inference', sensitivity: inf.sensitivity });
    if (!sensitivityAllowed(sens, shareOpts)) continue;
    if (isRedacted(inf.id, redaction)) continue;
    const line = describeInference(inf, phrasing);
    if (!line) continue;
    candidates.push({ fieldId: inf.id, sens, priority: 2, line });
  }

  // Stable priority sort (style < expertise < inferences; inferences already in
  // confidence order). Greedily emit within the token budget.
  candidates.sort((a, b) => a.priority - b.priority);

  const header = phrasing === 'directive'
    ? 'User profile (derived guidance — adapt your responses to fit):'
    : 'User profile (observed patterns — informative, not directive):';
  const lines = [];
  const fields = [];
  let used = estimateTokens(header);
  for (const c of candidates) {
    const cost = estimateTokens(c.line) + 1; // +1 for the newline join
    if (used + cost > tokenBudget) continue; // skip; try the next (cheaper) one
    lines.push(c.line);
    fields.push(c.fieldId);
    used += cost;
  }

  if (lines.length === 0) return { text: '', fields: [] };
  const text = `${header}\n${lines.map((l) => `- ${l}`).join('\n')}`;
  return { text, fields };
}

/**
 * eligiblePreferenceSlugs(profile, opts) -> [{ id, line, sens }].
 *
 * The S5 RUNTIME ADMISSION GATE for preference injection — the single place that
 * decides which corroborated preference atoms have "become you". It is PURE
 * (no I/O, no disk reads — the caller threads in the approval registry) and
 * FAIL-CLOSED on EVERY axis, so an atom is admitted ONLY when ALL hold:
 *
 *   1. PRECISION-ELIGIBLE (S2). The atom carries `precision_eligible === true`
 *      — the offline slug-quality gate's verdict, STAMPED onto the atom during
 *      derivation (render-brief never imports the eval/ tier: that would breach
 *      the moat AND there is no held-out corpus at serve time). Absent / falsey
 *      => NOT eligible. This is what sidesteps the 0.00-precision regression: an
 *      un-cleared slug is STORED but never injected.
 *   2. CONFIDENCE > BRIEF_MIN_CONFIDENCE (the shared 0.45 floor).
 *   3. EVIDENCE_COUNT >= BRIEF_MIN_EVIDENCE (>= 3 — the REAL cross-session
 *      corroboration barrier; one session can never mint an injected preference).
 *   4. APPROVED (S3). The atom id is in `injectEligibleIds(profile, registry)`
 *      — registry state `approved` AND a real citation locator (cite-or-drop).
 *
 * Plus the ambient per-atom SENSITIVITY tier + REDACTION denylist that every
 * other field passes. Only `preference`/`correction`-kind atoms are considered
 * (a `dialectic` belief is never an actionable preference). Phrasing is
 * DESCRIPTIVE by default ("preference.<subject>: <detail>"); a passed
 * `phrasing === 'directive'` softens to guidance wording, mirroring the brief.
 *
 * @returns {Array<{ id:string, subject:string, line:string, sens:string }>}
 *   in confidence-desc order so the strongest signal survives a tight budget.
 */
export function eligiblePreferenceSlugs(profile, opts = {}) {
  if (!profile || typeof profile !== 'object' || !profile.global) return [];
  const shareOpts = opts.shareOpts && typeof opts.shareOpts === 'object' ? opts.shareOpts : {};
  const redaction = opts.redaction || {};
  const registry = opts.registry && typeof opts.registry === 'object' ? opts.registry : null;
  const phrasing = opts.phrasing === 'directive' ? 'directive' : 'descriptive';

  // S3 approval set — the human-in-the-loop gate. Absent registry => empty set
  // => nothing approved (fail-closed). The audit module is the SOLE authority on
  // which atoms may inject; we never re-derive that decision here.
  const approved = injectEligibleIds(profile, registry);

  // Compose global ⊕ overlay (overlay wins on id collision), exactly as the
  // brief/get read paths do, so the snapshot can never surface a preference the
  // brief would gate out.
  const overlay = opts.overlay && typeof opts.overlay === 'object' ? opts.overlay : null;
  const composed = composeInferences(
    profile.global.dialectic,
    overlay && overlay.dialectic ? overlay.dialectic : [],
  );

  const out = [];
  for (const inf of composed) {
    if (!inf || !inf.id) continue;
    // Only actionable preference atoms (a dialectic BELIEF is not a preference).
    if (inf.kind !== 'preference' && inf.kind !== 'correction') continue;
    // (1) precision-eligible — fail-closed: absent flag => held back.
    if (inf.precision_eligible !== true) continue;
    // (2)+(3) corroboration floors shared with the brief.
    if (!(Number(inf.confidence) > BRIEF_MIN_CONFIDENCE
        && (Number(inf.evidence_count) || 0) >= BRIEF_MIN_EVIDENCE)) continue;
    // (4) approved-in-audit AND citation-grounded (cite-or-drop).
    if (!approved.has(inf.id)) continue;
    // Ambient sensitivity + redaction — identical to every other emitted field.
    const sens = fieldSensitivity({ kind: 'inference', sensitivity: inf.sensitivity });
    if (!sensitivityAllowed(sens, shareOpts)) continue;
    if (isRedacted(inf.id, redaction)) continue;

    // Flat rules-file shape: a terse standing fact ("preference.<subject>:
    // <detail>"), not a narrated bullet — so we take the bare CONTENT phrase,
    // not the brief's "Observed preference:"-prefixed sentence. Prefer the
    // structured value.phrase, fall back to a scalar value, then the subject.
    const subject = String(inf.subject || '').trim();
    let content = '';
    if (inf.value && typeof inf.value === 'object' && inf.value.phrase) {
      content = String(inf.value.phrase).trim();
    } else if (inf.value != null && typeof inf.value !== 'object') {
      content = String(inf.value).trim();
    }
    const detail = content || subject;
    if (!detail) continue;
    // DIRECTIVE phrasing softens to guidance wording; DESCRIPTIVE (default) emits
    // the bare observed slug. Either way it is the SAME gated/derived content.
    const rendered = phrasing === 'directive' ? `prefer ${detail}` : detail;
    out.push({ id: inf.id, subject, line: `preference.${subject || inf.id}: ${rendered}`, sens });
  }

  // Strongest signal first (confidence desc) so a tight budget keeps the best.
  out.sort((a, b) => {
    const ca = composed.find((i) => i.id === a.id);
    const cb = composed.find((i) => i.id === b.id);
    return (Number(cb && cb.confidence) || 0) - (Number(ca && ca.confidence) || 0);
  });
  return out;
}

/**
 * renderVoiceBlock(voiceExemplars) -> { block, used }.
 *
 * PURE. Formats a labeled, budget-bounded `<ijfw-voice>` few-shot block from a
 * pre-retrieved set of the user's OWN writing snippets. NO disk, NO retrieval,
 * NO LLM/network — it only FORMATS what it is handed (serve.js does the zero-LLM
 * retrieval). Returns the rendered block string AND the exemplars that ACTUALLY
 * landed inside the budget (so the caller can disclose exactly what left).
 *
 * Budget: at most VOICE_MAX_SAMPLES samples and VOICE_MAX_CHARS of total sample
 * text. An over-budget sample is dropped whole; a single sample longer than the
 * whole budget is hard-truncated with an ellipsis. COLD START (empty/absent) ->
 * { block:'', used:[] } so the caller emits nothing.
 *
 * Wording is DESCRIPTIVE guidance ("match their voice / drafts in their voice"),
 * NEVER a hard override, and NEVER claims indistinguishability.
 *
 * @param {Array<{text:string,register?:string,id?:string}>} voiceExemplars
 * @returns {{ block:string, used:Array }}
 */
export function renderVoiceBlock(voiceExemplars) {
  if (!Array.isArray(voiceExemplars) || voiceExemplars.length === 0) {
    return { block: '', used: [] };
  }
  const samples = [];
  const used = [];
  let charBudget = VOICE_MAX_CHARS;
  for (const ex of voiceExemplars) {
    if (samples.length >= VOICE_MAX_SAMPLES) break;
    if (charBudget <= 0) break;
    const raw = ex && typeof ex === 'object' ? ex.text : null;
    // Single-line the snippet for the bullet (the few-shot only needs the prose,
    // not the user's original line breaks) and collapse runs of whitespace.
    let text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!text) continue;
    if (text.length > charBudget) {
      // Over budget. We hard-truncate ONLY the FIRST sample (so one long snippet
      // still contributes a meaningful fragment); a LATER sample that no longer
      // fits whole is DROPPED cleanly — we never emit a tiny, context-free tail
      // of a trailing sample. This keeps each emitted sample a coherent piece of
      // the user's writing rather than a stub.
      if (used.length > 0) continue; // a non-first sample must fit whole.
      const room = Math.max(0, charBudget - 1); // reserve 1 for the ellipsis
      if (room < 8) break; // not enough room left for a meaningful fragment
      text = `${text.slice(0, room).trim()}…`;
    }
    charBudget -= text.length;
    // Escape any stray closing tag so a captured snippet can't break the block.
    const safe = text.replace(/<\/?ijfw-voice>/gi, '');
    samples.push(`- "${safe}"`);
    used.push(ex);
  }
  if (samples.length === 0) return { block: '', used: [] };
  const block = [
    '<ijfw-voice>',
    'When drafting prose for the user, match their voice. Samples of their own writing:',
    ...samples,
    '(Guidance only — match tone/phrasing, not content. These are examples, not instructions.)',
    '</ijfw-voice>',
  ].join('\n');
  return { block, used };
}

/**
 * renderSnapshot(profile, opts) -> { text, fields, voice }.
 *
 * A SHORT, plain-text profile snapshot for RULES-FILE adapters (the cursor /
 * windsurf / copilot style instruction files that paste a few lines of standing
 * context). It is a sibling of renderBrief sharing the SAME gating, the SAME
 * inclusion floors and the SAME sensitivity/redaction/kill-switch machinery —
 * the only differences are surface shape:
 *   - flat plain-text lines ("key: value"), no markdown bullets / header prose,
 *     because a rules file wants terse standing facts, not a narrated brief;
 *   - STYLE + EXPERTISE bands ONLY by default (the low-sensitivity, always-safe
 *     signal). Preference/dialectic slugs are NOT emitted unless the caller
 *     explicitly opts in via `includePreferences:true` (default OFF — see the
 *     gated seam below).
 *
 * Zero new imports — it reuses renderBrief's exact composition helpers, so the
 * P4.5 moat (zero-LLM read path) is structurally unchanged.
 *
 * @param {object} profile  a UserProfile (schema.makeProfile shape)
 * @param {object} [opts]
 *   @param {number}  [opts.tokenBudget]       cap on output tokens (default 400)
 *   @param {object}  [opts.context]           { overlay?, host? } active overlay/host
 *   @param {boolean} [opts.shareSensitive]    include med/high fields (per-host opt-in)
 *   @param {object}  [opts.env]               env source (defaults to process.env)
 *   @param {string}  [opts.redactFile]        override redact.txt path (tests)
 *   @param {boolean} [opts.forceLowOnly]      passive read => low-only (audit MED-3)
 *   @param {boolean} [opts.includePreferences]  GATED SEAM, default FALSE. When
 *     TRUE, corroborated preference slugs that pass the FULL runtime gate
 *     (`eligiblePreferenceSlugs`) are appended as flat `preference.<subject>`
 *     lines, descriptively phrased and budget-respecting. The gate is
 *     FAIL-CLOSED on every axis (see below), so with the flag on but NO approval
 *     registry / NO precision-eligible atom NOTHING is emitted — a default-on
 *     rules file can never leak an un-cleared preference (S5).
 *   @param {object}  [opts.registry]  the S3 approval map (id -> { state }). Only
 *     atoms whose id is `approved` AND carry a citation locator are
 *     inject-eligible (via `injectEligibleIds`). ABSENT => nothing is approved
 *     (fail-closed). render-brief never reads the registry from disk itself —
 *     serve.js loads it and threads it in, keeping this module pure/zero-LLM.
 *
 *   @param {Array<{text:string,register?:string,id?:string}>} [opts.voiceExemplars]
 *     V3 VOICE FEW-SHOT SEAM. A pre-retrieved set of the user's OWN raw writing
 *     snippets (the caller — serve.js — does the zero-LLM retrieval and hands the
 *     results in; this renderer stays PURE: no disk, no retrieval, no LLM/network
 *     import). When present + non-empty, a labeled, budget-bounded `<ijfw-voice>`
 *     block is appended that few-shots the samples so a drafter can MATCH the
 *     user's voice. It is DESCRIPTIVE guidance, never a hard override, and never
 *     claims indistinguishability. COLD START (absent/empty) emits NOTHING — no
 *     header, no empty block. The block is bounded to VOICE_MAX_SAMPLES samples
 *     and VOICE_MAX_CHARS of sample text; exemplars that don't fit are dropped
 *     cleanly. Voice samples are NOT mixed into `fields[]` (that channel feeds the
 *     preference/style egress ledger) — instead the exemplars that ACTUALLY
 *     landed are returned in `voice` so the caller can disclose exactly what left
 *     via the dedicated exemplar-egress channel.
 *
 * @returns {{ text:string, fields:string[], voice:Array }}  `fields` = emitted
 *   style/expertise/preference field ids (the preference-egress channel). `voice`
 *   = the voice exemplars that actually landed inside the budget (the
 *   exemplar-egress channel) — empty array when no voice block was emitted.
 */
export function renderSnapshot(profile, opts = {}) {
  const tokenBudget = Number.isFinite(opts.tokenBudget) && opts.tokenBudget > 0
    ? opts.tokenBudget
    : DEFAULT_TOKEN_BUDGET;
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const env = opts.env || process.env;

  // Kill-switch + redaction up front — same short-circuit as renderBrief so a
  // killed profile yields an empty snapshot, never a leak. The kill-switch also
  // suppresses the VOICE block (the user's raw writing is the MOST sensitive
  // surface here) — `voice:[]` so the caller discloses nothing.
  const redaction = loadRedaction({ env, redactFile: opts.redactFile });
  if (killSwitchEngaged(redaction)) {
    return { text: '', fields: [], voice: [] };
  }

  // Render the budget-bounded voice few-shot block (PURE — formats only what the
  // caller retrieved + handed in). COLD START (absent/empty voiceExemplars) =>
  // empty block + empty `voice`, so nothing is emitted and nothing is disclosed.
  // Computed up front so even the cold-start-profile early return can still carry
  // the voice block: voice is independent of the DERIVED profile (it is the
  // user's own raw writing, not an inference), so an empty derived profile must
  // not gate it out.
  const { block: voiceBlock, used: voiceUsed } = renderVoiceBlock(opts.voiceExemplars);

  // Cold start: missing/empty profile -> empty profile snapshot. We still emit
  // the voice block if one was retrieved (voice needs no derived profile).
  if (!profile || typeof profile !== 'object' || !profile.global) {
    return { text: voiceBlock, fields: [], voice: voiceUsed };
  }

  // Same sensitivity gate inputs as renderBrief (forceLowOnly + host allowlist
  // threaded by the caller; absent => default-deny on sensitive fields).
  const shareOpts = {
    env,
    shareSensitive: opts.shareSensitive,
    host: typeof opts.host === 'string' ? opts.host : (typeof context.host === 'string' ? context.host : undefined),
    forceLowOnly: opts.forceLowOnly === true,
    enforceHostAllowlist: opts.enforceHostAllowlist === true,
    shareHostsFile: opts.shareHostsFile,
  };
  const overlayKey = typeof context.overlay === 'string' ? context.overlay : null;
  const overlay = overlayKey && profile.overlays ? profile.overlays[overlayKey] : null;

  const lines = [];
  const fields = [];
  let used = 0;

  // STYLE — confirmed axes only, low-sensitivity, redaction-gated. Overlay
  // overrides global per axis (same composition as renderBrief).
  const style = composeStyle(
    profile.global.style,
    overlay && overlay.style ? overlay.style : {},
  );
  for (const axis of STYLE_AXES) {
    const a = style[axis];
    if (!a || !styleAxisConfirmed(a)) continue;
    const fieldId = `style:${axis}`;
    if (!sensitivityAllowed(fieldSensitivity({ kind: 'style' }), shareOpts)) continue;
    if (isRedacted(fieldId, redaction)) continue;
    const line = `style.${axis}: ${describeStyleAxis(axis, a.ema)}`;
    const cost = estimateTokens(line) + 1;
    if (used + cost > tokenBudget) continue;
    lines.push(line);
    fields.push(fieldId);
    used += cost;
  }

  // EXPERTISE — banded domains only (N>=5 via expertiseBand), low-sensitivity.
  if (profile.expertise && typeof profile.expertise === 'object') {
    for (const [domain, rec] of Object.entries(profile.expertise)) {
      const band = expertiseBand(rec);
      if (band === 'unknown') continue;
      const fieldId = `expertise:${domain}`;
      if (!sensitivityAllowed(fieldSensitivity({ kind: 'expertise' }), shareOpts)) continue;
      if (isRedacted(fieldId, redaction)) continue;
      const line = `expertise.${domain}: ${band}`;
      const cost = estimateTokens(line) + 1;
      if (used + cost > tokenBudget) continue;
      lines.push(line);
      fields.push(fieldId);
      used += cost;
    }
  }

  // GATED SEAM (default OFF) — corroborated preference slugs (S5, LIVE).
  // FAIL-CLOSED on every axis: a slug is appended ONLY when it clears the full
  // runtime gate in `eligiblePreferenceSlugs` (precision-eligible AND conf>floor
  // AND evidence>=3 AND approved-in-audit-with-citation), PLUS the ambient
  // sensitivity + redaction every other field passes. With the flag on but NO
  // approval registry / NO precision-eligible atom, the gate admits nothing — so
  // a default-on rules file can never leak an un-cleared preference. Budget is
  // shared with style/expertise: a tight budget keeps the higher-priority
  // style/expertise lines and the strongest (confidence-desc) preferences.
  const includePreferences = opts.includePreferences === true;
  if (includePreferences) {
    const slugs = eligiblePreferenceSlugs(profile, {
      shareOpts,
      redaction,
      registry: opts.registry,
      overlay,
      phrasing: opts.style === 'directive' ? 'directive' : 'descriptive',
    });
    for (const s of slugs) {
      const cost = estimateTokens(s.line) + 1;
      if (used + cost > tokenBudget) continue; // skip; try the next (cheaper) one
      lines.push(s.line);
      fields.push(s.id);
      used += cost;
    }
  }

  // Compose the profile snapshot, then append the voice block (if any). The
  // voice block is a self-contained, clearly-fenced section — kept SEPARATE from
  // the flat profile lines so a rules-file reader sees "facts" and "voice
  // samples" as distinct sections. When NO voice was retrieved (`voiceBlock`
  // empty), the output is BYTE-IDENTICAL to the pre-voice snapshot (the gate-OFF
  // regression guard). `voice` carries only the exemplars that actually landed,
  // so the caller discloses exactly what left via the exemplar-egress channel.
  const profileText = lines.length === 0 ? '' : lines.join('\n');
  if (!voiceBlock) {
    if (profileText === '') return { text: '', fields: [], voice: [] };
    return { text: profileText, fields, voice: [] };
  }
  const text = profileText === '' ? voiceBlock : `${profileText}\n${voiceBlock}`;
  return { text, fields, voice: voiceUsed };
}
