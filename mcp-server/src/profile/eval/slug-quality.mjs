/**
 * profile/eval/slug-quality.mjs — SLICE S2: slug-quality PRECISION gate.
 *
 * THE DECISION THIS MODULE OWNS: may a learned preference slug EVER auto-inject?
 *
 * The personalization layer is an EVIDENCE-ADMISSION system — nothing becomes
 * "you" without a citation. A derived preference slug is only allowed to
 * auto-act (inject silently, high bar) when the SURFACED slug set is precise
 * enough that we trust it not to put words in the user's mouth. The founder's
 * call is PRECISION >= 0.8 to auto-act; below it we show-and-confirm.
 *
 * This module turns that policy into a measurable, pre-registered gate:
 *
 *   1. LABEL each surfaced slug, three-way, against a HELD-OUT TEST window:
 *        - 'correct-actionable-preference' : the slug semantically matches a
 *          preference the user expressed in the TEST window (an actionable "you").
 *        - 'real-but-not-a-preference'     : the slug matches something the user
 *          really said in the TEST window, but it is NOT a preference (grounded,
 *          but not actionable as a profile directive).
 *        - 'wrong'                         : the slug matches NOTHING in the TEST
 *          window — fabricated / noise / hallucinated. Cannot inject, ever.
 *
 *   2. SCORE precision = #correct / #surfaced. Recall is reported HONESTLY
 *      (high-precision / low-recall is a feature here, not a bug — a cite-or-drop
 *      gate would rather drop a real preference than inject a wrong one).
 *
 *   3. GATE: eligible-to-inject ONLY when precision >= the pre-registered bar
 *      (0.8). The bar is frozen + tamper-evident via the SAME prereg rig Gate B
 *      uses (buildPreReg / hashPreReg), so the 0.8 cannot be quietly loosened to
 *      pass — re-registering after an edit changes the runId hash.
 *
 * CIRCULARITY GUARD (the ea15479 void): the gold here is the HELD-OUT TEST
 * window's preferences — NEVER the train target a brief injects. Scoring a slug
 * against the very phrase the system was handed to inject is teaching-to-the-test
 * and was voided once already. We assert the test ids are disjoint from any
 * provided train ids before scoring; a leaky corpus throws.
 *
 * REUSE, do NOT re-derive:
 *   - semanticPrecisionRecall  (gate-c-capture.mjs)  — lexical-semantic matcher
 *   - precisionRecall          (harness.mjs)         — exact-slug floor + vectors
 *   - bootstrapCI              (harness.mjs re-export)— CI on the per-unit vectors
 *   - buildPreReg / hashPreReg (prereg.mjs)          — tamper-evident bar freeze
 *   - wrongTargetControl shape (wrong-target-control.mjs) — negative-control idiom
 *
 * Zero deps. ESM. No serving/capture code is touched — this is eval-only infra
 * the runtime CALLS (eligibleSlugsForInjection) but does not live inside.
 *
 * Cites (methodology): LaMP time-based split [2304.11406] (held-out TEST) ·
 * pre-registration tamper-evidence (prereg.mjs, Gate B v2 T6).
 */

import crypto from 'node:crypto';
import { semanticPrecisionRecall } from './gate-c-capture.mjs';
import { bootstrapCI } from './harness.mjs';
import { buildPreReg, hashPreReg } from './prereg.mjs';

/** The founder's call: precision required to AUTO-act (inject silently). */
export const SLUG_PRECISION_BAR = 0.8;
/** Default lexical-semantic match threshold (reused matcher's documented default). */
export const SLUG_SEMANTIC_THRESHOLD = 0.5;

/** The three quality labels a surfaced slug can receive. */
export const SLUG_LABELS = Object.freeze({
  CORRECT: 'correct-actionable-preference',
  REAL_NOT_PREF: 'real-but-not-a-preference',
  WRONG: 'wrong',
});

/**
 * Normalize a phrase to the SAME subject slug space the heuristic derive uses
 * (phraseToSubject) so a TEST-window gold phrase compares apples-to-apples with a
 * surfaced slug. Identical 5-line rule, re-stated here (derive does not export it)
 * — matches gate-c-capture.toSubject so the two evals are on one scale.
 */
function toSubject(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// POLARITY GUARD — the precision-gate-specific hardening over the reused Gate C
// matcher. The lexical-semantic Jaccard match (semanticPrecisionRecall) is
// POLARITY-BLIND: "use tabs not spaces" and "use spaces not tabs" reduce to the
// SAME content tokens {tabs, spaces} and so match at Jaccard 1.0. For a CAPTURE-
// RECALL metric (Gate C) that is tolerable. For a PRECISION gate that decides
// silent AUTO-INJECTION it is not — labeling the user's OPPOSITE preference as
// "correct" is exactly the false-positive this gate exists to prevent (it would
// put the inverse of what the user wants into the profile). So before a semantic
// match is ALLOWED to count as a correct preference, we reject it when the two
// phrases share content tokens but disagree on NEGATION polarity.
//
// Signal (dependency-free, no antonym lexicon to maintain): for each content
// token shared by both phrases, record whether it sits BEFORE or AFTER the first
// negation marker ("not"/"never"/"no"/"avoid"/"instead of"/"rather than") in each
// phrase. If a shared token flips sides (before in one, after in the other), the
// two phrases assert OPPOSITE polarity over the same subject — a conflict. This
// catches the "X not Y" vs "Y not X" inversion without hardcoding domain antonyms.
// ---------------------------------------------------------------------------

const NEGATION_MARKERS = new Set(['not', 'never', 'no', 'avoid', "don't", 'dont', 'without', 'instead', 'rather']);

/** Side of the first negation marker each content token sits on: -1 before, 1 after. */
function negationSides(phrase) {
  const toks = toSubject(phrase).split(/\s+/).filter(Boolean);
  let negAt = -1;
  for (let i = 0; i < toks.length; i += 1) {
    if (NEGATION_MARKERS.has(toks[i])) { negAt = i; break; }
  }
  const sides = new Map();
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.length < 3 || STOPWORDS_LITE.has(t) || NEGATION_MARKERS.has(t)) continue;
    // No negation in the phrase -> neutral side 0 (cannot conflict on its own).
    sides.set(t, negAt === -1 ? 0 : (i < negAt ? -1 : 1));
  }
  return sides;
}

// Small content stoplist shared with the matcher's spirit (function words that
// would otherwise pollute the polarity comparison). Kept local + minimal.
const STOPWORDS_LITE = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'is',
  'are', 'be', 'i', 'you', 'user', 'prefer', 'prefers', 'preference', 'like',
  'likes', 'want', 'wants', 'use', 'uses', 'using', 'should', 'would', 'do',
  'does', 'my', 'me', 'it', 'this', 'that', 'when', 'always', 'over', 'than',
]);

/**
 * polarityConflict(a, b) -> boolean. True when a and b share at least one content
 * token that sits on OPPOSITE sides of a negation marker (one before, one after)
 * — i.e. they express opposite preferences over the same subject. Only fires when
 * AT LEAST ONE phrase actually contains a negation (a pure positive-vs-positive
 * pair never conflicts on this signal).
 */
export function polarityConflict(a, b) {
  const sa = negationSides(a);
  const sb = negationSides(b);
  for (const [tok, side] of sa) {
    if (!sb.has(tok)) continue;
    const other = sb.get(tok);
    // A flip from one side of a negation to the other = opposite polarity.
    if (side !== 0 && other !== 0 && side !== other) return true;
  }
  return false;
}

/**
 * A slug counts as a CORRECT match of a gold subject iff it lexical-semantically
 * matches (reused Gate C matcher) AND does NOT polarity-conflict with it. The
 * polarity guard is the precision-gate hardening; recall-side Gate C keeps its
 * polarity-blind matcher unchanged.
 */
function correctMatch(slug, goldSubject, threshold) {
  if (semanticPrecisionRecall([slug], [goldSubject], threshold).perPredCorrect[0] !== 1) return false;
  return !polarityConflict(slug, goldSubject);
}

/**
 * Build the PRE-REGISTERED gate config. The 0.8 bar (and the semantic threshold)
 * flow into the prereg hash via the rig's input spread, so any post-hoc edit to
 * the bar is tamper-evident: re-registering with a changed bar yields a different
 * runId hash. We do NOT relax the bar to pass — that was the explicit lesson.
 *
 * @param {object} [opts]
 *   @param {number} [opts.bar]               precision bar (default 0.8)
 *   @param {number} [opts.semanticThreshold] Jaccard threshold (default 0.5)
 *   @param {number} [opts.seed]              prereg seed (default 1)
 * @returns {object} frozen prereg with .slugPrecisionBar, .slugSemanticThreshold,
 *   .hash and .runId. hashPreReg over this object is stable + tamper-evident.
 */
export function buildSlugQualityPreReg(opts = {}) {
  const bar = Number.isFinite(opts.bar) ? opts.bar : SLUG_PRECISION_BAR;
  const semanticThreshold = Number.isFinite(opts.semanticThreshold)
    ? opts.semanticThreshold : SLUG_SEMANTIC_THRESHOLD;
  const seed = Number.isFinite(opts.seed) ? opts.seed : 1;

  // Reuse the Gate B rig for the base prereg (seeds + Bonferroni + base hash).
  const base = buildPreReg({
    primaryEndpoint: 'slug-quality-precision-gate',
    slugPrecisionBar: bar,
    slugSemanticThreshold: semanticThreshold,
    seed,
    runId: opts.runId,
  });

  // buildPreReg only hashes its FIXED field list, so `slugPrecisionBar` /
  // `slugSemanticThreshold` are present on the object but do NOT yet affect
  // base.hash — a silent loosening of the bar would slip through. We make the bar
  // GENUINELY tamper-evident with a COMPOSITE hash over (base prereg hash + the
  // slug-specific knobs). Editing the bar now changes the composite hash and the
  // runId, exactly as the founder's-call requires (the 0.8 cannot be quietly
  // moved to pass). hashPreReg is still reused for the base leg.
  const baseHash = hashPreReg(base);
  const composite = crypto.createHash('sha256')
    .update(`${baseHash}|slugPrecisionBar:${bar}|slugSemanticThreshold:${semanticThreshold}`)
    .digest('hex');

  return Object.freeze({
    ...base,
    slugPrecisionBar: bar,
    slugSemanticThreshold: semanticThreshold,
    baseHash,
    hash: composite,
    runId: opts.runId || `slugq-${composite.slice(0, 12)}`,
  });
}

/**
 * Assemble the HELD-OUT TEST gold from a corpus's probe/test window. Returns two
 * disjoint slug sets in the same normalized space:
 *   - preferenceSubjects     : actionable preferences the user expressed (gold +).
 *   - nonPreferenceSubjects  : things the user really said that are NOT
 *     preferences (real-but-not-a-preference targets).
 *
 * Accepts the makeHeldOutFixture corpus shape (probes[].goldSubjects /
 * probes[].nonPreferenceSubjects) OR an explicit { testPreferences,
 * testNonPreferences } pair. The TEST window — never the train target — is the
 * scoring source (anti-circularity).
 */
export function testWindowGold(corpus = {}) {
  const pref = new Set();
  const nonPref = new Set();

  if (Array.isArray(corpus.testPreferences)) {
    for (const p of corpus.testPreferences) pref.add(toSubject(p));
  }
  if (Array.isArray(corpus.testNonPreferences)) {
    for (const p of corpus.testNonPreferences) nonPref.add(toSubject(p));
  }
  const probes = Array.isArray(corpus.probes) ? corpus.probes
    : (Array.isArray(corpus.test) ? corpus.test : []);
  for (const probe of probes) {
    for (const g of (probe.goldSubjects || [])) pref.add(toSubject(g));
    for (const g of (probe.nonPreferenceSubjects || probe.nonPrefSubjects || [])) {
      nonPref.add(toSubject(g));
    }
  }
  // A subject can't be both a preference and a non-preference. Preference wins
  // (it is the stronger, actionable claim); drop the overlap from nonPref so the
  // labels are mutually exclusive.
  for (const s of pref) nonPref.delete(s);
  return { preferenceSubjects: [...pref], nonPreferenceSubjects: [...nonPref] };
}

/**
 * labelSlugs(slugs, corpus, opts) -> per-slug quality labels + counts.
 *
 * Each surfaced slug is labeled three-way against the HELD-OUT TEST window:
 *   - matches a TEST preference (semantic)            -> 'correct-actionable-preference'
 *   - else matches a TEST non-preference utterance    -> 'real-but-not-a-preference'
 *   - else                                            -> 'wrong'
 *
 * Matching reuses the SAME lexical-semantic matcher Gate C uses
 * (semanticPrecisionRecall), so "captured-but-paraphrased" counts and a verbatim
 * coincidence is not required. The preference set is checked FIRST so a slug that
 * is genuinely a preference is never mislabeled as merely-real.
 *
 * @param {string[]} slugs   the SURFACED slugs (already at the brief floor)
 * @param {object}   corpus  carries the TEST window (see testWindowGold)
 * @param {object}   [opts]  @param {number} [opts.semanticThreshold]
 *   @param {string[]} [opts.trainIds] / @param {string[]} [opts.testIds] for the
 *     held-out disjointness assertion (throws on leakage).
 * @returns {{ labels: Array<{slug,label,matchedPreference,matchedNonPreference}>,
 *   counts: {correct,realNotPref,wrong,total} }}
 */
export function labelSlugs(slugs = [], corpus = {}, opts = {}) {
  // HELD-OUT ENFORCEMENT (assertion, not comment): if the caller declares both
  // train and test ids, no id may appear on both sides. A leaky split means the
  // gold may include the very target a brief injected — the ea15479 void. Refuse.
  const trainIds = Array.isArray(opts.trainIds) ? opts.trainIds : (corpus.trainIds || []);
  const testIds = Array.isArray(opts.testIds) ? opts.testIds : (corpus.testIds || []);
  if (trainIds.length && testIds.length) {
    const train = new Set(trainIds.map(String));
    for (const id of testIds) {
      if (train.has(String(id))) {
        throw new Error(
          'slug-quality held-out violation: a TEST id also appears in TRAIN '
          + '(the gold would include the injected train target — the ea15479 circularity). '
          + 'Refusing to label slugs against a leaky split.',
        );
      }
    }
  }

  const threshold = Number.isFinite(opts.semanticThreshold)
    ? opts.semanticThreshold : SLUG_SEMANTIC_THRESHOLD;
  const { preferenceSubjects, nonPreferenceSubjects } = testWindowGold(corpus);

  const labels = [];
  let correct = 0; let realNotPref = 0; let wrong = 0;
  for (const raw of slugs) {
    const slug = toSubject(raw);
    // Preference FIRST (the stronger, actionable claim). A correct match must be
    // semantic AND polarity-agreeing — the OPPOSITE preference is NOT correct.
    const matchedPref = firstMatch(slug, preferenceSubjects, threshold);
    if (matchedPref) {
      correct += 1;
      labels.push({
        slug, raw, label: SLUG_LABELS.CORRECT,
        matchedPreference: matchedPref,
        matchedNonPreference: null,
      });
      continue;
    }
    const matchedNonPref = firstMatch(slug, nonPreferenceSubjects, threshold);
    if (matchedNonPref) {
      realNotPref += 1;
      labels.push({
        slug, raw, label: SLUG_LABELS.REAL_NOT_PREF,
        matchedPreference: null,
        matchedNonPreference: matchedNonPref,
      });
      continue;
    }
    wrong += 1;
    labels.push({
      slug, raw, label: SLUG_LABELS.WRONG, matchedPreference: null, matchedNonPreference: null,
    });
  }

  return {
    labels,
    counts: { correct, realNotPref, wrong, total: slugs.length },
  };
}

/**
 * First TEST-window gold subject a slug CORRECTLY matches (semantic AND
 * polarity-agreeing), for provenance. The OPPOSITE preference is NOT a match.
 */
function firstMatch(slug, goldSubjects, threshold) {
  for (const g of goldSubjects) {
    if (correctMatch(slug, g, threshold)) return g;
  }
  return null;
}

/**
 * eligibleSlugsForInjection(slugs, corpus, opts) -> the RUNTIME gate.
 *
 * Given the current derived/surfaced slugs, decide which (if any) may auto-inject.
 * The gate is precision-over-the-surfaced-set: a single 'wrong' slug among few can
 * sink precision below 0.8 and block auto-injection — that is the intended
 * safe-by-design behavior (cite-or-drop, high bar to auto-act). We return BOTH the
 * set-level verdict (`cleared`) AND the per-slug labels, so a caller may choose to
 * inject only the 'correct' subset, or fall back to show-and-confirm below the bar.
 *
 * PRECISION counts only 'correct-actionable-preference' as a true positive.
 * 'real-but-not-a-preference' is NOT a preference and so is a precision MISS (it
 * would put a non-preference into the profile) — counted against precision, never
 * eligible to inject. 'wrong' is likewise a miss.
 *
 * RECALL is reported honestly against the TEST preference gold (how many of the
 * user's actual TEST-window preferences the surfaced set recovered). Low recall is
 * acceptable; the gate optimizes precision.
 *
 * @param {string[]} slugs   current derived/surfaced slugs
 * @param {object}   corpus  HELD-OUT TEST window (see testWindowGold)
 * @param {object}   [opts]
 *   @param {number} [opts.bar]               precision bar (default 0.8, pre-registered)
 *   @param {number} [opts.semanticThreshold] Jaccard threshold (default 0.5)
 *   @param {number} [opts.bootstrapSeed]     CI seed (default 42)
 *   @param {string[]} [opts.trainIds] / [opts.testIds]  held-out leakage check
 * @returns {{
 *   bar, preReg:{hash,runId,slugPrecisionBar},
 *   cleared:boolean,
 *   precision:{point,lo,hi}, recall:{point,lo,hi},
 *   eligible:string[], ineligible:string[],
 *   labels:Array, counts:{correct,realNotPref,wrong,total},
 *   gold:{nPreferences,nNonPreferences}
 * }}
 */
export function eligibleSlugsForInjection(slugs = [], corpus = {}, opts = {}) {
  const preReg = buildSlugQualityPreReg({
    bar: opts.bar,
    semanticThreshold: opts.semanticThreshold,
    seed: opts.seed,
    runId: opts.runId,
  });
  const bar = preReg.slugPrecisionBar;
  const threshold = preReg.slugSemanticThreshold;
  const seed = Number.isFinite(opts.bootstrapSeed) ? opts.bootstrapSeed : 42;

  const { labels, counts } = labelSlugs(slugs, corpus, {
    semanticThreshold: threshold,
    trainIds: opts.trainIds,
    testIds: opts.testIds,
  });

  // PRECISION per-unit vector: 1 iff the slug is a correct actionable preference.
  // (real-but-not-a-preference and wrong both count as 0 — a non-preference in the
  // profile is exactly the harm the gate exists to prevent.)
  const perPredCorrect = labels.map((l) => (l.label === SLUG_LABELS.CORRECT ? 1 : 0));
  const precision = bootstrapCI(perPredCorrect, { seed });
  // point precision is the honest fraction; bootstrapCI.point equals it.
  const precisionPoint = counts.total > 0 ? counts.correct / counts.total : 0;

  // RECALL against the TEST preference gold. A gold preference is "recovered"
  // only if SOME surfaced slug CORRECTLY matches it (semantic AND polarity-
  // agreeing) — the opposite preference does not count as recovery. perGoldHit is
  // a 0/1 vector over the gold prefs (feeds the same CI helper). Reported honestly
  // (the gate optimizes precision; low recall is acceptable).
  const { preferenceSubjects } = testWindowGold(corpus);
  const slugSubjects = slugs.map(toSubject);
  const perGoldHit = preferenceSubjects.map(
    (g) => (slugSubjects.some((s) => correctMatch(s, g, threshold)) ? 1 : 0),
  );
  const recall = bootstrapCI(perGoldHit, { seed: seed + 1 });

  // SET-LEVEL verdict: clear the bar (>=, not >) to auto-inject. Use the honest
  // point precision for the decision (the CI is reported alongside, not the gate).
  const cleared = counts.total > 0 && precisionPoint >= bar;

  // The per-slug eligible subset: the 'correct' slugs are the ones that COULD
  // inject. We surface them regardless of the set verdict so a caller may inject
  // the precise subset even when the whole set doesn't clear — but `cleared`
  // remains the auto-act gate.
  const eligible = labels.filter((l) => l.label === SLUG_LABELS.CORRECT).map((l) => l.raw);
  const ineligible = labels.filter((l) => l.label !== SLUG_LABELS.CORRECT).map((l) => l.raw);

  return {
    bar,
    preReg: { hash: preReg.hash, runId: preReg.runId, slugPrecisionBar: bar },
    cleared,
    precision: { point: precisionPoint, lo: precision.lo, hi: precision.hi },
    recall: { point: recall.point, lo: recall.lo, hi: recall.hi },
    eligible,
    ineligible,
    labels,
    counts,
    gold: {
      nPreferences: preferenceSubjects.length,
      nNonPreferences: testWindowGold(corpus).nonPreferenceSubjects.length,
    },
  };
}

/**
 * negativeControlClears(slugs, invertedCorpus, opts) -> boolean.
 *
 * The precision-guard control, in the wrong-target-control idiom: slugs scored
 * against an UNRELATED user's TEST window must NOT clear the bar. A gate that
 * lights up on someone else's preferences is matching universals, not the user —
 * a false PASS. Tests assert this returns false for a fabricated/foreign set.
 */
export function negativeControlClears(slugs = [], invertedCorpus = {}, opts = {}) {
  return eligibleSlugsForInjection(slugs, invertedCorpus, opts).cleared;
}

export default {
  SLUG_PRECISION_BAR,
  SLUG_SEMANTIC_THRESHOLD,
  SLUG_LABELS,
  buildSlugQualityPreReg,
  testWindowGold,
  labelSlugs,
  eligibleSlugsForInjection,
  negativeControlClears,
  hashPreReg,
};
