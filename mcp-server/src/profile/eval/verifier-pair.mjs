// verifier-pair.mjs — Gate B v3. Turn two authors' chunk-feature sets into ONE fixed
// pair-summary feature vector for the trained logistic verifier. ZERO deps.
//
// For an author pair (A,B) we compute, over all (or sampled) cross-author chunk pairs,
// the DISTRIBUTION of per-family Burrows-Delta distances (mean |z_a - z_b| over that
// family's dims — NOT a single channel cosine, which washes out the few idiosyncratic
// dims). We summarize each family's cross-pair distance distribution with
// mean/median/min/max + 10/25/75/90 percentiles + fraction-below-cutpoint, and add a
// within-author consistency term (how tight each author's own chunks cluster). These
// summaries are the verifier's input — the logreg learns the same/different boundary.

import { FAMILIES } from './verifier-features.mjs';

// mean |z_a - z_b| over a family's dimensions = Burrows-Delta-style distance for ONE
// chunk pair within ONE family.
function familyDelta(za, zb) {
  const n = za.length;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i += 1) s += Math.abs(za[i] - zb[i]);
  return s / n;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function summarize(dists, cutpoint) {
  if (!dists.length) return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const s = [...dists].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = percentile(s, 50);
  const belowCut = s.filter((d) => d <= cutpoint).length / s.length;
  return [
    mean, median, s[0], s[s.length - 1],
    percentile(s, 10), percentile(s, 25), percentile(s, 75), percentile(s, 90),
    belowCut,
  ];
}
const SUMMARY_LEN = 9; // mean,median,min,max,p10,p25,p75,p90,fracBelow

// within-author consistency: mean cross-chunk family delta among an author's OWN chunks
// (low = tight idiolect). Returns one scalar per family.
function withinConsistency(chunkFeats) {
  const out = {};
  for (const fam of FAMILIES) {
    const cs = chunkFeats.map((c) => c[fam]).filter((v) => v && v.length);
    if (cs.length < 2) { out[fam] = 0; continue; }
    let s = 0; let n = 0;
    const cap = 40; // bound the within-author pair count for speed
    for (let i = 0; i < cs.length && n < cap * cs.length; i += 1) {
      for (let j = i + 1; j < cs.length; j += 1) { s += familyDelta(cs[i], cs[j]); n += 1; }
    }
    out[fam] = n ? s / n : 0;
  }
  return out;
}

// Deterministic sampling of cross-author chunk pairs (seeded) so the pair vector is
// reproducible and bounded for large authors.
function sampleCrossPairs(nA, nB, cap, rng) {
  const total = nA * nB;
  if (total <= cap) {
    const out = [];
    for (let i = 0; i < nA; i += 1) for (let j = 0; j < nB; j += 1) out.push([i, j]);
    return out;
  }
  const seen = new Set();
  const out = [];
  while (out.length < cap) {
    const i = Math.floor(rng() * nA);
    const j = Math.floor(rng() * nB);
    const k = i * nB + j;
    if (seen.has(k)) continue;
    seen.add(k); out.push([i, j]);
  }
  return out;
}

// pairFeatures(featsA, featsB, cfg) -> Float64Array. featsA/featsB are arrays of
// chunkFeatures objects. The feature layout is fixed (same length every call).
export function pairFeatures(featsA, featsB, cfg = {}) {
  const cap = cfg.pairCap || 400;
  const rng = cfg.rng || Math.random;
  const cutByFam = cfg.cutpoints || {}; // per-family DEV-learned cutpoint
  const idxs = sampleCrossPairs(featsA.length, featsB.length, cap, rng);

  // collect cross-pair family-delta distributions
  const dists = {};
  for (const fam of FAMILIES) dists[fam] = [];
  for (const [i, j] of idxs) {
    const a = featsA[i]; const b = featsB[j];
    for (const fam of FAMILIES) {
      if (a[fam] && a[fam].length) dists[fam].push(familyDelta(a[fam], b[fam]));
    }
  }

  const consA = withinConsistency(featsA);
  const consB = withinConsistency(featsB);

  const vec = [];
  for (const fam of FAMILIES) {
    const cut = Number.isFinite(cutByFam[fam]) ? cutByFam[fam] : 2.0;
    vec.push(...summarize(dists[fam], cut));
    // consistency context: each author's own tightness + the ratio cross/within
    const cA = consA[fam]; const cB = consB[fam];
    const crossMean = dists[fam].length
      ? dists[fam].reduce((a, b) => a + b, 0) / dists[fam].length : 0;
    vec.push(cA, cB, (cA + cB) / 2);
    // separation ratio: cross distance vs the tighter within-author distance (a strong
    // same/diff signal — within-author cross-pair distance ~ cross distance for same).
    const denom = Math.max(1e-6, (cA + cB) / 2);
    vec.push(crossMean / denom);
  }
  return Float64Array.from(vec);
}

export const PAIR_FEATURE_LEN = FAMILIES.length * (SUMMARY_LEN + 4);

export const __test = { familyDelta, summarize, withinConsistency, sampleCrossPairs };
