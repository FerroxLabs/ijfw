// IJFW v1.6.0 -- benchmark metrics. Pure functions, no I/O, no LLM.
import { mulberry32 } from './benchmark.js';
//
// Retrieval metrics (free -- no model calls):
//   recallAtK, precisionAtK, mrr, episodesPerQuery, latencyPercentile
// Answer metrics:
//   normalizeAnswer + answerExactMatch (free string match). LLM-judged
//   answer correctness is a separate paid path wired in P5, not here.
//
// All retrieval metrics operate on:
//   retrievedIds : string[]  -- ranked result ids (best first)
//   relevantIds  : string[]  -- gold evidence ids (the relevant set)
// expressed in the SAME id space (the loader's job to align granularity).

/** Recall@k = |relevant ∩ retrieved[0:k]| / |relevant|. */
export function recallAtK(retrievedIds, relevantIds, k) {
  if (!relevantIds || relevantIds.length === 0) return null; // undefined for no-evidence queries
  const top = new Set(retrievedIds.slice(0, k));
  let hit = 0;
  for (const r of relevantIds) if (top.has(r)) hit++;
  return hit / relevantIds.length;
}

/** Precision@k = |relevant ∩ retrieved[0:k]| / k. */
export function precisionAtK(retrievedIds, relevantIds, k) {
  if (k <= 0) return null;
  const rel = new Set(relevantIds || []);
  const top = retrievedIds.slice(0, k);
  if (top.length === 0) return 0;
  let hit = 0;
  for (const id of top) if (rel.has(id)) hit++;
  return hit / Math.min(k, top.length);
}

/** Mean Reciprocal Rank: 1/(rank of first relevant), else 0. */
export function reciprocalRank(retrievedIds, relevantIds) {
  const rel = new Set(relevantIds || []);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (rel.has(retrievedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Mean over a list of per-query numbers, skipping null (undefined) entries. */
export function mean(values) {
  const xs = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Percentile (linear interpolation). p in [0,100]. */
export function percentile(values, p) {
  const xs = values.filter((v) => typeof v === 'number' && !Number.isNaN(v)).slice().sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

/** Normalize an answer string for exact-match comparison (SQuAD-style). */
export function normalizeAnswer(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * G1b L4-HIGH-1: is this ground-truth entry an ABSTENTION (no-answer / trap) gold?
 *
 * Both confirmatory loaders (longmemeval.js `_abs`, convomem.js abstention_evidence)
 * stamp `ground_truth[qid].is_abstention = true` and KEEP the dataset's own
 * natural-language no-answer gold. This canonical flag — NOT the gold's surface
 * form — is what routes scoring to the single abstention rubric, so a correct
 * abstention scores the same on BOTH datasets and a confident hallucination is
 * wrong on BOTH. Pure; exported for unit tests.
 *
 * @param {object|null|undefined} gt  a ground_truth entry
 * @returns {boolean}
 */
export function isAbstentionGold(gt) {
  return !!(gt && gt.is_abstention === true);
}

// Lexical cues that a prediction CORRECTLY abstained / declined (no confident
// claim). Deliberately rubric-only (no LLM) so the abstention verdict is the
// SAME function regardless of dataset, judge mode, or gold surface form.
const ABSTENTION_CUES = [
  /\bi (?:do not|don't|dont) (?:know|have)\b/,
  /\b(?:no|not any|don't have|do not have|lack) (?:information|info|record|data|details?)\b/,
  /\bno (?:information|mention|record|reference)\b/,
  /\bnot (?:mentioned|stated|specified|provided|available|found|present|discussed)\b/,
  /\b(?:cannot|can't|cant|could not|couldn't|unable to) (?:find|determine|tell|answer|say|locate)\b/,
  /\bisn't (?:any )?(?:information|mention|record)\b/,
  /\bthere (?:is|isn't|is no|isn't any|was no) (?:no )?(?:information|mention|record|reference|data)\b/,
  /\bnot enough (?:information|context|detail)\b/,
];

// G1b cross-C LOW-1: bare cue TOKENS ("unknown", "unclear", "n/a") are genuine
// abstentions ONLY when they are essentially the WHOLE answer — a short decline.
// As a SUBSTRING of a longer confident response ("...the status is unknown to
// the team but the project shipped", "Unknown Pleasures") they are a
// hallucination on the trap, NOT a decline, and must score 0. These are matched
// against the whole normalized answer (anchored), separate from the phrase cues
// above which may legitimately appear inside a sentence. Symmetric across
// subjects (the metric is subject-agnostic).
const BARE_TOKEN_ABSTENTIONS = [
  /^unknown$/,
  /^unclear$/,
  /^n\/a$/,
  /^na$/,
];

/**
 * G1b L4-HIGH-1: score one ABSTENTION question under ONE rubric.
 *
 * Returns 1 when the prediction correctly abstains / declines (it does not assert
 * a specific fact), 0 when it makes a confident factual claim (a hallucination on
 * an unanswerable trap). Independent of the gold's surface form — the gold is a
 * natural-language no-answer sentence on LongMemEval and ConvoMem alike; the
 * ABILITY graded is "did the system refuse to invent an answer". Pure.
 *
 * @param {string} predicted
 * @returns {1|0}
 */
export function scoreAbstentionMatch(predicted) {
  const t = String(predicted ?? '').toLowerCase().trim();
  if (t === '') return 0; // an empty answer is not a stated abstention (caller may skip earlier)
  // Phrase-level cues may appear inside a sentence (a genuine NL decline).
  for (const re of ABSTENTION_CUES) {
    if (re.test(t)) return 1;
  }
  // Bare cue tokens count ONLY when they are essentially the whole answer (a
  // short decline) — strip surrounding punctuation/whitespace first so
  // "Unknown.", "n/a!", " unclear " still match, but a confident sentence that
  // merely CONTAINS the token does not.
  const bare = t.replace(/^[\s"'.,!?-]+|[\s"'.,!?-]+$/g, '');
  for (const re of BARE_TOKEN_ABSTENTIONS) {
    if (re.test(bare)) return 1;
  }
  return 0;
}

/** Free answer-correctness signal: normalized exact / containment match. */
export function answerExactMatch(predicted, gold) {
  const p = normalizeAnswer(predicted);
  const g = normalizeAnswer(gold);
  if (!g) return null;
  if (p === g) return 1;
  // containment either direction handles "yes" vs "yes, both American" cases
  if (p && (p.includes(g) || g.includes(p))) return 1;
  return 0;
}

/**
 * Aggregate per-query retrieval records into the metrics block for one
 * (adapter, dataset) cell.
 * @param {Array<{retrievedIds, relevantIds, latency_ms, tokens_in, tokens_out, cost_usd, n_retrieved, answerMatch}>} per
 */
export function aggregate(per) {
  const r1 = per.map((q) => recallAtK(q.retrievedIds, q.relevantIds, 1));
  const r5 = per.map((q) => recallAtK(q.retrievedIds, q.relevantIds, 5));
  const r10 = per.map((q) => recallAtK(q.retrievedIds, q.relevantIds, 10));
  const p5 = per.map((q) => precisionAtK(q.retrievedIds, q.relevantIds, 5));
  const rr = per.map((q) => reciprocalRank(q.retrievedIds, q.relevantIds));
  const lat = per.map((q) => q.latency_ms).filter((x) => typeof x === 'number');
  const ans = per.map((q) => q.answerMatch).filter((x) => x !== null && x !== undefined);

  return {
    n_queries: per.length,
    recall_at_1: round(mean(r1)),
    recall_at_5: round(mean(r5)),
    recall_at_10: round(mean(r10)),
    precision_at_5: round(mean(p5)),
    mrr: round(mean(rr)),
    episodes_per_query_mean: round(mean(per.map((q) => q.n_retrieved))),
    latency_p50_ms: round(percentile(lat, 50)),
    latency_p95_ms: round(percentile(lat, 95)),
    tokens_per_query_mean: round(mean(per.map((q) => (q.tokens_in || 0) + (q.tokens_out || 0)))),
    cost_per_query_usd: round6(mean(per.map((q) => q.cost_usd || 0))),
    answer_match_mean: ans.length ? round(mean(ans)) : null,
    hops_mean: round(mean(per.map((q) => q.hops))),
  };
}

/**
 * Aggregate per-query records bucketed by a dimension key (e.g. question type).
 * Returns { [dimensionValue]: aggregateBlock }. This is the diagnostic view —
 * global aggregates hide WHERE a system fails; per-dimension exposes it.
 * @param {Array} per   per-query records, each carrying a `dim` field
 */
export function aggregateByDimension(per) {
  const buckets = new Map();
  for (const q of per) {
    const key = q.dim ?? 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(q);
  }
  const out = {};
  for (const [key, rows] of buckets) out[key] = aggregate(rows);
  return out;
}

function round(x) { return x === null || x === undefined ? null : Math.round(x * 10000) / 10000; }
function round6(x) { return x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6; }

/**
 * Bootstrap confidence interval for the mean of per-query numeric scores.
 *
 * @param {number[]} perQuery - per-query numeric scores (e.g. 0/1 per query)
 * @param {{ iters?: number, alpha?: number, seed?: number }} opts
 * @returns {{ point: number, lo: number, hi: number }}
 *   point = mean(perQuery), lo/hi are the alpha/2 and 1-alpha/2 percentiles
 *   of the bootstrap distribution. Deterministic for a given seed.
 */
export function bootstrapCI(perQuery, { iters = 1000, alpha = 0.05, seed = 42 } = {}) {
  const n = perQuery.length;
  const point = n > 0 ? perQuery.reduce((a, b) => a + b, 0) / n : 0;
  if (n === 0) return { point, lo: 0, hi: 0 };

  const rng = mulberry32(seed);
  const boots = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) {
      s += perQuery[Math.floor(rng() * n)];
    }
    boots[i] = s / n;
  }
  boots.sort((a, b) => a - b);

  const loIdx = Math.floor((alpha / 2) * iters);
  const hiIdx = Math.floor((1 - alpha / 2) * iters);
  return {
    point,
    lo: boots[loIdx],
    hi: boots[Math.min(hiIdx, iters - 1)],
  };
}

/**
 * Paired McNemar test for two binary result arrays (same length, 0/1 per query).
 *
 * Uses continuity-corrected McNemar χ² statistic.
 * pValue is derived from the χ²(1) survival function via an erfc approximation.
 *
 * @param {number[]} before - binary array (0/1 per query)
 * @param {number[]} after  - binary array (0/1 per query)
 * @returns {{ b: number, c: number, statistic: number, pValue: number, significant: boolean }}
 *   b = count(before=0, after=1)  (after wins)
 *   c = count(before=1, after=0)  (before wins)
 */
export function mcnemar(before, after) {
  let b = 0; // before=0, after=1
  let c = 0; // before=1, after=0
  for (let i = 0; i < before.length; i++) {
    if (before[i] === 0 && after[i] === 1) b++;
    else if (before[i] === 1 && after[i] === 0) c++;
  }

  const bc = b + c;
  if (bc === 0) return { b, c, statistic: 0, pValue: 1, significant: false };

  // Continuity-corrected McNemar χ² = (|b-c| - 1)² / (b+c)
  const diff = Math.abs(b - c) - 1;
  const statistic = (diff * diff) / bc;

  // χ²(1) survival function: P(χ² > x) = erfc(sqrt(x/2))
  // Using erfc approximation (Abramowitz & Stegun 7.1.26)
  const pValue = erfcApprox(Math.sqrt(statistic / 2));

  return { b, c, statistic, pValue, significant: pValue < 0.05 };
}

/**
 * Complementary error function approximation for χ²(1) p-value computation.
 * Abramowitz & Stegun 7.1.26 rational approximation (max |err| < 1.5e-7).
 */
function erfcApprox(x) {
  if (x < 0) return 2 - erfcApprox(-x);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}
