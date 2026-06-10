// verifier-scorer.mjs — Gate B v3. Adapts the trained chunk-pair logistic verifier to
// the `scorer` interface validateInstrument expects: { vectorize, distance }.
//
// UNIT OF PAIRING = one CHUNK per "doc". vectorize(text) -> per-family z-vectors for that
// chunk (against the DEV-derived reference). distance(a,b) -> 1 - P(same-author) from the
// trained logreg over the single chunk-pair summary. Training (in the harness) uses the
// IDENTICAL single-pair summary representation, so train and score are consistent.

import { chunkFeatures } from './verifier-features.mjs';
import { pairFeatures } from './verifier-pair.mjs';
import { applyStandardizer, predictProba } from './verifier-logreg.mjs';

// Build a single chunk-pair summary vector (two singleton chunk sets). cutpoints kept
// fixed across train/score (DEV-learned, passed in).
export function chunkPairFeatures(featA, featB, cfg) {
  return pairFeatures([featA], [featB], cfg);
}

// makeScorer(ref, model, standardizer, cfg) -> { vectorize, distance }.
export function makeScorer(ref, model, standardizer, cfg = {}) {
  return {
    vectorize(text) { return chunkFeatures(text, ref); },
    distance(a, b) {
      const pf = chunkPairFeatures(a, b, cfg);
      const std = applyStandardizer(pf, standardizer);
      const p = predictProba(std, model); // P(same-author)
      return 1 - p; // distance: higher = more different (validateInstrument convention)
    },
  };
}
