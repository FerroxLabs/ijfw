/**
 * profile/eval/gate-c-capture.mjs — Cross-system profile bus, PHASE P5 (Gate C).
 *
 * GATE C — CAPTURE, HELD-OUT. The honest answer to "does the profile capture the
 * user?" without the circular train==test leakage the slice-1 hook had. We:
 *   1. Derive a profile from TRAIN sessions ONLY (sessions 1..k), through the
 *      REAL pipeline: deriveProfile() -> applyDelta() -> a real UserProfile.
 *   2. Evaluate on a DISJOINT, surface-varied PROBE set (LaMP time-based split):
 *      probes live in a later time window with DIFFERENT session ids and
 *      paraphrased restatements of the same preferences — so recovering them
 *      tests GENERALIZATION, not memorization of exact train strings.
 *   3. Report inference PRECISION and RECALL, each with a bootstrap CI from the
 *      REAL lab-study helper, plus a NEGATIVE-CONTROL persona (the derived
 *      profile must NOT match an unrelated user's prefs — a precision guard).
 *
 * HELD-OUT ENFORCEMENT is not a comment — it is an ASSERTION. Before scoring we
 * verify train-session-ids ∩ probe-session-ids = ∅ (splitByTime.disjoint). If a
 * caller hands us a leaky split, runGateC throws rather than reporting an
 * inflated number. That is the whole point of Gate C vs the slice-1 hook.
 *
 * Zero deps. ESM. Wires the REAL derive/merge modules + REAL stats. No stubs.
 *
 * Cites: LaMP time-based split [2304.11406].
 */

import { deriveProfile } from '../derive.js';
import { applyDelta } from '../merge.js';
import { makeProfile } from '../schema.js';
import {
  splitByTime,
  precisionRecall,
  bootstrapCI,
  makeHeldOutFixture,
} from './harness.mjs';

/**
 * Normalize a phrase to the SAME subject slug the heuristic derive uses
 * (derive-heuristic.js phraseToSubject), so a probe's gold phrase compares
 * apples-to-apples with a derived inference's `subject`. Re-implemented here
 * (5 lines, identical rule) to keep this eval module from importing derive
 * internals — the derive does not export phraseToSubject.
 */
function toSubject(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Push v2 — SEMANTIC preference match (eval-metric fix).
 *
 * The exact-slug match (set equality on toSubject) reports recall = 0 on the real
 * corpus because the user restates the SAME preference cross-time with DIFFERENT
 * words, so the verbatim sentence-fragment slugs never coincide. That conflates
 * "captured-but-paraphrased" with "genuinely-not-captured". To separate them we
 * add a principled LEXICAL-SEMANTIC match: two subjects count as the same
 * preference if their CONTENT-WORD token sets overlap by Jaccard >= a documented
 * threshold (default 0.5). No embedder is used — bringing the memory-tier
 * embedder onto this path would also drag network/LLM modules across the profile
 * moat — so we use a deterministic, dependency-free lexical-semantic similarity
 * with a pre-registered threshold instead (the task's sanctioned fallback).
 *
 * STOPWORDS are stripped so function words ("the user prefers to") don't inflate
 * overlap; the match is on the substantive tokens that carry the preference.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'with', 'is',
  'are', 'be', 'i', 'you', 'user', 'prefer', 'prefers', 'preference', 'like',
  'likes', 'want', 'wants', 'use', 'uses', 'using', 'should', 'would', 'do',
  'does', 'my', 'me', 'it', 'this', 'that', 'when', 'always', 'not', 'no',
]);

/** Content-word token SET for a (already-slugged) subject, stopwords removed. */
function contentTokens(subject) {
  const out = new Set();
  for (const t of String(subject || '').split(/\s+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Jaccard similarity between two content-token sets (0 when either is empty). */
function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter += 1;
  return inter / (aSet.size + bSet.size - inter);
}

/**
 * SEMANTIC precision/recall over predicted vs gold subjects, in the SAME shape
 * the REAL precisionRecall helper returns (so the existing bootstrapCI consumes
 * it unchanged). A predicted subject is "correct" iff it lexical-semantically
 * matches ANY gold subject at Jaccard >= threshold; a gold subject is
 * "recovered" iff ANY predicted subject matches it. Bipartite OR-matching (not a
 * 1:1 assignment) — appropriate for a recovery task where one expressed
 * preference may be derived as several near-duplicate slugs.
 */
export function semanticPrecisionRecall(predicted = [], gold = [], threshold = 0.5) {
  const predTok = (predicted || []).map((p) => ({ raw: String(p), tok: contentTokens(p) }));
  const goldTok = (gold || []).map((g) => ({ raw: String(g), tok: contentTokens(g) }));
  const perPredCorrect = predTok.map((p) => (
    goldTok.some((g) => jaccard(p.tok, g.tok) >= threshold) ? 1 : 0
  ));
  const perGoldHit = goldTok.map((g) => (
    predTok.some((p) => jaccard(p.tok, g.tok) >= threshold) ? 1 : 0
  ));
  const tp = perPredCorrect.reduce((a, b) => a + b, 0);
  const fp = perPredCorrect.length - tp;
  const recovered = perGoldHit.reduce((a, b) => a + b, 0);
  const fn = perGoldHit.length - recovered;
  const precision = predTok.length ? tp / predTok.length : 0;
  const recall = goldTok.length ? recovered / goldTok.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, tp, fp, fn, perGoldHit, perPredCorrect, threshold };
}

/**
 * Derive a REAL profile from a list of train sessions. Each session is run
 * through deriveProfile() (heuristic floor + optional injected dialectic) and the
 * resulting delta is folded with the REAL applyDelta() CRDT merge — exactly the
 * SessionEnd path, just driven by the eval instead of the dream runner.
 *
 * @param {Array} sessions  train sessions ({ metadata, feedback, outcomes, session_id, host })
 * @param {object} [opts]   @param {Function} [opts._localTransport] dialectic arm (ablation)
 *                          @param {object} [opts.env]
 * @returns {Promise<object>} a UserProfile (schema shape)
 */
export async function deriveProfileFromSessions(sessions = [], opts = {}) {
  let profile = makeProfile();
  for (const s of sessions) {
    const signals = {
      metadata: s.metadata,
      feedback: s.feedback,
      outcomes: s.outcomes,
      sessionId: s.session_id ?? s.sessionId,
      host: s.host,
      // dialectic corroborates over the per-session style array when present:
      style: s.style,
    };
    // REAL derivation (heuristic always; dialectic only if a transport is
    // injected — that is the heuristic-vs-dialectic ablation lever).
    // eslint-disable-next-line no-await-in-loop
    const delta = await deriveProfile(signals, {
      env: opts.env,
      _localTransport: opts._localTransport,
    });
    profile = applyDelta(profile, delta); // REAL CRDT merge
  }
  return profile;
}

/**
 * Collect the preference subjects a profile ASSERTS — the predicted set Gate C
 * scores against the held-out gold. We read the REAL profile's global dialectic
 * (where derived preference inferences live) and keep the EARNED ones: a
 * subject the profile is confident enough about to surface. We use the brief's
 * own inclusion floor (confidence > 0.6 AND evidence_count >= 3) so Gate C scores
 * the SAME signal a host would actually receive — not raw, un-surfaced atoms.
 */
export function assertedSubjects(profile, opts = {}) {
  const minConf = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.6;
  const minEv = Number.isFinite(opts.minEvidence) ? opts.minEvidence : 3;
  const dialectic = profile && profile.global && Array.isArray(profile.global.dialectic)
    ? profile.global.dialectic : [];
  const out = new Set();
  for (const inf of dialectic) {
    if (!inf || inf.kind !== 'preference') continue;
    if (Number(inf.confidence) > minConf && (Number(inf.evidence_count) || 0) >= minEv) {
      out.add(toSubject(inf.subject));
    }
  }
  return [...out];
}

/**
 * runGateC(corpus, opts) -> Gate C report.
 *
 * @param {object} [corpus]  { sessions, probes, negativeControl } — defaults to
 *   the built-in synthetic-but-held-out fixture. A REAL session corpus drops in
 *   here unchanged (same shape).
 * @param {object} [opts]
 *   @param {string|number} [opts.cutoff]        time-split boundary (else fraction)
 *   @param {number}        [opts.trainFraction] default 0.6
 *   @param {Function}      [opts._localTransport] dialectic arm (ablation)
 *   @param {object}        [opts.env]
 *   @param {number}        [opts.bootstrapSeed] default 42 (reproducible CIs)
 *
 * @returns {Promise<{
 *   heldOut: { disjoint, trainIds, probeIds },
 *   precision: { point, lo, hi }, recall: { point, lo, hi },
 *   f1, predicted, gold, negativeControl: { precision, matched },
 *   nTrain, nProbe }>}
 *
 * THROWS if the split is not disjoint (leaky held-out = invalid Gate C).
 */
export async function runGateC(corpus, opts = {}) {
  const data = corpus || makeHeldOutFixture();
  const allSessions = Array.isArray(data.sessions) ? data.sessions : [];
  const explicitProbes = Array.isArray(data.probes) ? data.probes : [];

  // TWO held-out modes, both LaMP time-based and both leakage-asserted:
  //   (a) EXPLICIT probe set: `corpus.probes` is a separate, later-time-window
  //       set with disjoint ids. TRAIN = all `sessions`; PROBE = `probes`.
  //   (b) NO explicit probes: split `sessions` chronologically by time/fraction
  //       (sessions 1..k train, the rest probe).
  let trainSessions; let probeSessions; let trainIds; let probeIds;
  if (explicitProbes.length > 0) {
    trainSessions = allSessions;
    probeSessions = explicitProbes;
    trainIds = new Set(allSessions.map((s) => String(s.session_id ?? s.sessionId ?? '')).filter(Boolean));
    probeIds = new Set(explicitProbes.map((p) => String(p.session_id ?? p.sessionId ?? '')).filter(Boolean));
  } else {
    const split = splitByTime(allSessions, {
      cutoff: opts.cutoff,
      trainFraction: opts.trainFraction,
    });
    trainSessions = split.train;
    probeSessions = split.probe;
    trainIds = split.trainIds;
    probeIds = split.probeIds;
  }

  // HELD-OUT ENFORCEMENT (assertion, not comment): no probe id may appear in the
  // train id set. A leaky split is a circular eval — refuse it.
  let disjoint = true;
  for (const id of probeIds) {
    if (trainIds.has(id)) { disjoint = false; break; }
  }
  if (!disjoint) {
    throw new Error(
      'Gate C held-out violation: a probe session id also appears in the train set '
      + '(train/test leakage). Refusing to report a circular capture score.',
    );
  }

  // DERIVE from train sessions ONLY (the held-out probe sessions never touch
  // derivation). REAL pipeline.
  const profile = await deriveProfileFromSessions(trainSessions, {
    env: opts.env,
    _localTransport: opts._localTransport,
  });

  // PREDICTED = what the profile asserts (earned, surfaced subjects).
  const predicted = assertedSubjects(profile);

  // GOLD = the union of the probe set's surface-varied gold subjects, normalized
  // to the same slug space. These are paraphrases the profile must GENERALIZE to.
  const goldSet = new Set();
  for (const p of probeSessions) {
    for (const g of (p.goldSubjects || [])) goldSet.add(toSubject(g));
  }
  const gold = [...goldSet];

  const pr = precisionRecall(predicted, gold);

  // Bootstrap CIs on precision AND recall using the REAL helper. The per-unit
  // 0/1 vectors precisionRecall already produced are the bootstrap inputs.
  const seed = Number.isFinite(opts.bootstrapSeed) ? opts.bootstrapSeed : 42;
  const precision = bootstrapCI(pr.perPredCorrect, { seed });
  const recall = bootstrapCI(pr.perGoldHit, { seed: seed + 1 });

  // Push v2 — SEMANTIC metric alongside the exact one. The exact slug match is
  // kept (it is the honest "do the verbatim slugs coincide" floor); the semantic
  // match (Jaccard >= threshold on content tokens) tests whether the SAME
  // preference was captured-but-paraphrased. Same bootstrapCI helper, same
  // per-unit vectors -> CIs are comparable across the two metrics.
  const semThreshold = Number.isFinite(opts.semanticThreshold) ? opts.semanticThreshold : 0.5;
  const semPr = semanticPrecisionRecall(predicted, gold, semThreshold);
  const semantic = {
    threshold: semThreshold,
    precision: bootstrapCI(semPr.perPredCorrect, { seed: seed + 2 }),
    recall: bootstrapCI(semPr.perGoldHit, { seed: seed + 3 }),
    f1: semPr.f1,
    counts: { tp: semPr.tp, fp: semPr.fp, fn: semPr.fn },
  };

  // NEGATIVE CONTROL — the derived (Ada) profile must NOT match Bo's prefs. We
  // score precision of the SAME predicted set against the negative persona's
  // gold; a low match here is the precision guard (it confirms we're not just
  // emitting universal prefs that match anyone).
  let negativeControl = { precision: 0, matched: [], semanticPrecision: 0, semanticMatched: [] };
  if (data.negativeControl && Array.isArray(data.negativeControl.goldSubjects)) {
    const ncGoldSlugs = data.negativeControl.goldSubjects.map(toSubject);
    const ncGold = new Set(ncGoldSlugs);
    const matched = predicted.filter((p) => ncGold.has(p));
    // SEMANTIC negative control: the SAME Jaccard matcher applied to the inverted
    // persona's gold. A near-zero here is the proof the semantic metric is not
    // trivially-always-positive — it must NOT light up on an unrelated user.
    const ncSem = semanticPrecisionRecall(predicted, ncGoldSlugs, semThreshold);
    negativeControl = {
      precision: predicted.length ? matched.length / predicted.length : 0,
      matched,
      semanticPrecision: ncSem.precision,
      semanticMatched: predicted.filter((p, i) => ncSem.perPredCorrect[i] === 1),
    };
  }

  return {
    heldOut: {
      disjoint: true,
      trainIds: [...trainIds],
      probeIds: [...probeIds],
    },
    precision,
    recall,
    f1: pr.f1,
    semantic,
    predicted,
    gold,
    counts: { tp: pr.tp, fp: pr.fp, fn: pr.fn },
    negativeControl,
    nTrain: trainSessions.length,
    nProbe: probeIds.size,
  };
}

export default {
  runGateC, deriveProfileFromSessions, assertedSubjects, semanticPrecisionRecall,
};
