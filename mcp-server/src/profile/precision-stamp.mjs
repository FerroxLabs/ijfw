/**
 * profile/precision-stamp.mjs — SLICE S2 RUNTIME WIRE (the gate goes live).
 *
 * THE BUG THIS CLOSES: render-brief.js reads `inf.precision_eligible` (the S5
 * snapshot gate, render-brief.js:417) but NOTHING in src/ ever WROTE it, and the
 * slug-quality precision gate (eval/slug-quality.mjs `eligibleSlugsForInjection`)
 * had ZERO runtime callers. The 0.8 precision bar was DEAD CODE: every derived
 * preference slug shipped without the flag, so the snapshot path's
 * `if (inf.precision_eligible !== true) continue;` held EVERYTHING back —
 * fail-closed-but-dark. This module is the runtime caller that runs the gate and
 * STAMPS the verdict, so a cleared slug can finally inject and a noise slug never
 * can.
 *
 * WHY THIS LIVES OUTSIDE THE SERVE MOAT: the serve/read path (serve.js,
 * render-brief.js) must NEVER import eval/ or the LLM tier — the P4.5 moat-guard
 * test statically proves it. This module is called from the DREAM/DERIVE path
 * (dream/runner.mjs), which is already LLM-capable (it imports derive.js). So the
 * gate runs at DERIVE time, stamps a plain boolean onto the atom, and the
 * zero-LLM serve path only ever READS that boolean. The moat stays intact: no
 * serve module imports this file.
 *
 * THE ANTI-CIRCULARITY (the ea15479 lesson): the precision gate scores a surfaced
 * slug against a HELD-OUT gold of the user's REAL preferences — never the train
 * target a brief injected. At derive time on a user's machine there is no labeled
 * external gold, so we build the gold from the strongest GROUNDED evidence the
 * user produced THIS cycle: the EDIT-DELTA corrections. An edit-delta correction
 * carries a real cited diff span (the agent proposed X, the user committed Y —
 * the diff IS the citation). That is the cleanest "this is genuinely a preference
 * the user expressed" signal in the whole system. Feedback-only slugs (regex
 * triggers in a prompt) are CANDIDATES scored AGAINST that grounded gold:
 *   - a feedback slug that semantically matches a grounded edit correction is
 *     corroborated -> CORRECT -> precision_eligible.
 *   - a noise/meaningless feedback slug ("not to deal with this garbage") that
 *     matches NO grounded correction is WRONG -> NOT precision_eligible (closes
 *     the "meaningless-but-real slug mints" finding — it is stored but can never
 *     reach the brief).
 * This is non-circular by construction: feedback can NEVER bootstrap its own
 * eligibility; only diff-grounded evidence seeds the gold. No grounded gold ->
 * empty corpus -> NOTHING is precision-eligible (fail-closed).
 *
 * Zero deps. ESM. Pure (no I/O). Never throws — a stamp failure degrades to
 * "stamped false" (fail-closed), never a thrown derive cycle.
 */

import { labelSlugs, SLUG_LABELS, SLUG_SEMANTIC_THRESHOLD } from './eval/slug-quality.mjs';

/**
 * The same slug-normalization the heuristic derive + slug-quality gate use, so a
 * gold phrase and a surfaced subject compare on ONE scale. Re-stated (derive does
 * not export it). Pure.
 */
function toSubject(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Is this inference an actionable preference/correction (vs a dialectic belief)? */
function isActionablePreference(inf) {
  return inf && (inf.kind === 'preference' || inf.kind === 'correction');
}

/** True iff the atom is grounded in an actual edit-delta citation (the diff). */
function isEditGrounded(inf) {
  const v = inf && inf.value;
  return !!(v && typeof v === 'object' && v.cited && typeof v.cited === 'object'
    && (v.cited.committed_hash || v.cited.proposed_hash));
}

/**
 * The human-readable preference PHRASE an atom asserts (what a brief would
 * render): the value.phrase when present, else the subject. For an edit-grounded
 * correction the subject is `scopeKey::citedSlug` — we strip the scope prefix so
 * the gold/candidate compare on the CITED preference content, not the scope tag.
 */
function preferencePhrase(inf) {
  const v = inf && inf.value;
  if (v && typeof v === 'object' && typeof v.phrase === 'string' && v.phrase.trim()) {
    return v.phrase.trim();
  }
  const subject = String((inf && inf.subject) || '');
  const ci = subject.indexOf('::');
  return ci >= 0 ? subject.slice(ci + 2) : subject;
}

/**
 * stampPrecisionEligible(delta, opts) -> delta (same object, inferences mutated).
 *
 * For every actionable preference/correction inference in the delta, run the S2
 * slug-quality gate (labelSlugs) against a held-out gold built from THIS delta's
 * EDIT-DELTA-grounded corrections, and stamp `precision_eligible` = (the gate
 * labels the slug CORRECT). Dialectic beliefs and non-actionable atoms are left
 * untouched (no precision_eligible) — they are not preference slugs.
 *
 * FAIL-CLOSED everywhere:
 *   - no grounded gold this cycle -> corpus empty -> every slug labels WRONG ->
 *     precision_eligible = false on all of them.
 *   - any error in labeling -> precision_eligible = false (never thrown).
 *
 * @param {object} delta  a ProfileDelta ({ inferences?: Inference[] , ... })
 * @param {object} [opts]
 *   @param {number} [opts.semanticThreshold]  match threshold (default gate's 0.5)
 *   @param {Array<string>} [opts.goldPhrases] EXTRA grounded gold (e.g. confirmed
 *     edit-corrections already on the stored profile), unioned with this cycle's.
 * @returns {object} the same delta (inferences stamped in place + returned).
 */
export function stampPrecisionEligible(delta, opts = {}) {
  if (!delta || typeof delta !== 'object' || !Array.isArray(delta.inferences)) {
    return delta;
  }
  const threshold = Number.isFinite(opts.semanticThreshold)
    ? opts.semanticThreshold : SLUG_SEMANTIC_THRESHOLD;

  // GOLD = the user's GROUNDED preferences: every edit-delta-grounded correction
  // in this delta (the diff is the citation), PLUS any caller-supplied grounded
  // phrases (already-confirmed corrections on the stored profile). Feedback-only
  // atoms are NEVER gold — they cannot vouch for themselves.
  const goldSet = new Set();
  for (const inf of delta.inferences) {
    if (isActionablePreference(inf) && isEditGrounded(inf)) {
      const g = toSubject(preferencePhrase(inf));
      if (g) goldSet.add(g);
    }
  }
  for (const extra of (Array.isArray(opts.goldPhrases) ? opts.goldPhrases : [])) {
    const g = toSubject(extra);
    if (g) goldSet.add(g);
  }
  const corpus = { testPreferences: [...goldSet] };

  for (const inf of delta.inferences) {
    if (!isActionablePreference(inf)) continue; // dialectic/other -> not a pref slug
    let eligible = false;
    try {
      const slug = toSubject(preferencePhrase(inf));
      if (slug && goldSet.size > 0) {
        const { labels } = labelSlugs([slug], corpus, { semanticThreshold: threshold });
        eligible = labels.length === 1 && labels[0].label === SLUG_LABELS.CORRECT;
      }
    } catch {
      eligible = false; // fail-closed: an un-scorable slug never auto-injects
    }
    inf.precision_eligible = eligible;
  }
  return delta;
}

export default { stampPrecisionEligible };
