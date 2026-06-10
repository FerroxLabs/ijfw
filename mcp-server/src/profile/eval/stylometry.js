// stylometry.js — a richer, judge-free style metric for the Gate B research
// program (docs/superpowers/plans/2026-06-08-gate-b-research-program.md, Phase 1.1).
//
// WHY: the old Gate B style metric was 3 shallow axes (length-as-terseness + a
// 12-word formality keyword count + an emoji bit). A skeptic correctly rejects
// "matched your length profile" as evidence of "writes in your voice", and a
// model trivially games it via maxTokens alone. This vector adds axes that move
// INDEPENDENTLY of length — lexical diversity, sentence-length variance,
// punctuation signature, hedging and contraction rates — so a real voice match
// must move several dimensions, not just shorten the output.
//
// Everything here is deterministic and dependency-free (no LLM, no network).
// All nine features are normalized to [0,1] so styleDistance is a well-behaved
// mean-absolute-difference in [0,1].

import {
  FUNCTION_WORDS, TRIGRAM_KEYS, PUNCT_KEYS,
  REF_MEAN_FUNC, REF_SD_FUNC, REF_MEAN_TRI, REF_SD_TRI, REF_MEAN_PUNCT, REF_SD_PUNCT,
} from './stylometry-reference.js';
import { relFreqFunc, relFreqTrigrams, relFreqPunct } from './stylometry-features.js';

const FORMAL_MARKERS = [
  'however', 'therefore', 'furthermore', 'moreover', 'nevertheless',
  'consequently', 'accordingly', 'thus', 'hence', 'whereas', 'regarding',
  'additionally', 'subsequently',
];
const HEDGES = [
  'maybe', 'perhaps', 'possibly', 'probably', 'might', 'could', 'i think',
  'i guess', 'sort of', 'kind of', 'somewhat', 'arguably', 'presumably',
  'it seems', 'roughly', 'approximately',
];
// Conservative emoji + pictograph ranges (no external dep).
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
const CONTRACTION_RE = /\b\w+'(?:s|t|re|ve|ll|d|m)\b/gi;

function saturate(x, scale) {
  if (!(x > 0) || !(scale > 0)) return 0;
  return x / (x + scale);
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function words(text) {
  return (String(text).toLowerCase().match(/[a-z0-9']+/gi) || []);
}
function sentences(text) {
  return String(text).split(/[.!?]+(?:\s|$)/).map((s) => s.trim()).filter(Boolean);
}
function countMatches(text, list) {
  const lc = String(text).toLowerCase();
  let n = 0;
  for (const term of list) {
    if (term.includes(' ')) {
      // phrase: count non-overlapping occurrences
      let idx = 0;
      while ((idx = lc.indexOf(term, idx)) !== -1) { n += 1; idx += term.length; }
    } else {
      const re = new RegExp(`\\b${term}\\b`, 'g');
      n += (lc.match(re) || []).length;
    }
  }
  return n;
}

// The nine-axis style vector. Each component is in [0,1].
export function styleVector(text) {
  const s = String(text || '');
  const w = words(s);
  const nW = w.length;
  const sents = sentences(s);
  const chars = s.length || 1;

  // 1. terseness — short output = terse. (Length-driven, kept for continuity.)
  const terseness = 1 - saturate(chars, 240);

  // 2. formality — formal connective density (per word), saturated.
  const formality = saturate(countMatches(s, FORMAL_MARKERS) / Math.max(nW, 1), 0.03);

  // 3. emojiRate — emoji per char, saturated.
  const emojiRate = saturate((s.match(EMOJI_RE) || []).length / chars, 0.02);

  // 4. typeTokenRatio — lexical diversity (unique/total). Already [0,1].
  const ttr = nW ? new Set(w).size / nW : 0;

  // 5. meanSentenceLen — words per sentence, saturated at ~22.
  const sentLens = sents.map((x) => words(x).length);
  const meanSent = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  const meanSentenceLen = saturate(meanSent, 22);

  // 6. sentenceLenVar — burstiness of sentence length (stdev/mean), saturated.
  let sentenceLenVar = 0;
  if (sentLens.length > 1 && meanSent > 0) {
    const variance = sentLens.reduce((a, b) => a + (b - meanSent) ** 2, 0) / sentLens.length;
    sentenceLenVar = saturate(Math.sqrt(variance) / meanSent, 0.6);
  }

  // 7. punctProfile — punctuation density (per char), saturated.
  const punct = (s.match(/[!?;:,—–\-()"]/g) || []).length;
  const punctProfile = saturate(punct / chars, 0.06);

  // 8. hedgeRate — hedging-marker density (per word), saturated.
  const hedgeRate = saturate(countMatches(s, HEDGES) / Math.max(nW, 1), 0.04);

  // 9. contractionRate — contractions per word, saturated.
  const contractionRate = saturate((s.match(CONTRACTION_RE) || []).length / Math.max(nW, 1), 0.05);

  return {
    terseness: clamp01(terseness),
    formality: clamp01(formality),
    emojiRate: clamp01(emojiRate),
    typeTokenRatio: clamp01(ttr),
    meanSentenceLen: clamp01(meanSentenceLen),
    sentenceLenVar: clamp01(sentenceLenVar),
    punctProfile: clamp01(punctProfile),
    hedgeRate: clamp01(hedgeRate),
    contractionRate: clamp01(contractionRate),
  };
}

export const STYLE_AXES = [
  'terseness', 'formality', 'emojiRate', 'typeTokenRatio', 'meanSentenceLen',
  'sentenceLenVar', 'punctProfile', 'hedgeRate', 'contractionRate',
];

// Mean absolute difference over the nine axes → [0,1]. Accepts either raw text
// or pre-computed vectors. Optional per-axis weights (default equal).
export function styleDistance(a, b, weights = null) {
  const va = (a && typeof a === 'object') ? a : styleVector(a);
  const vb = (b && typeof b === 'object') ? b : styleVector(b);
  let sum = 0;
  let wsum = 0;
  for (const ax of STYLE_AXES) {
    const wt = weights && Number.isFinite(weights[ax]) ? weights[ax] : 1;
    sum += wt * Math.abs((va[ax] ?? 0) - (vb[ax] ?? 0));
    wsum += wt;
  }
  return wsum ? sum / wsum : 0;
}

// ---------------------------------------------------------------------------
// AUTHORSHIP LAYER (Gate B v2) — function-word / char-trigram / punct-n-gram
// stylometry. The 9-axis styleVector above captures REGISTER (terse/formal/emoji);
// these sub-vectors capture INDIVIDUAL voice — the idiosyncratic markers that
// separate two same-register strangers. fullStyleDistance combines both.
// ---------------------------------------------------------------------------

// z-scores beyond this magnitude are clamped — guards against a function word that is
// rare-or-absent in the (small) reference corpus producing a blow-up component that
// would dominate the cosine direction.
const Z_CAP = 8;

// Standardize a raw relative-frequency vector against the FROZEN reference mean/sd.
// CRITICAL (anti-circularity): refMean/refSd are the imported constants from
// stylometry-reference.js — they are NEVER computed from `raw` (the scored text). The
// only operations on `raw` here are subtraction of a constant and division by a
// constant; no mean/variance is taken over the input. (Enforced by the anti-recompute
// guard test.)
function zStandardize(raw, refMean, refSd) {
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    let z = (raw[i] - refMean[i]) / refSd[i];
    if (z > Z_CAP) z = Z_CAP; else if (z < -Z_CAP) z = -Z_CAP;
    out[i] = z;
  }
  return out;
}

// authorVector(text) → { func[180], tri[250], punct[24] } z-standardized sub-vectors.
// Pure function of (text, frozen constants): independent of any other scored text.
export function authorVector(text) {
  return {
    func: zStandardize(relFreqFunc(text, FUNCTION_WORDS), REF_MEAN_FUNC, REF_SD_FUNC),
    tri: zStandardize(relFreqTrigrams(text, TRIGRAM_KEYS), REF_MEAN_TRI, REF_SD_TRI),
    punct: zStandardize(relFreqPunct(text, PUNCT_KEYS), REF_MEAN_PUNCT, REF_SD_PUNCT),
  };
}

// Frozen composite weights (spec §1.4). func-word distribution carries the most
// individual-voice signal, so it dominates; register is a minority contributor.
export const STYLO_WEIGHTS = Object.freeze({
  register: 0.20, func: 0.50, tri: 0.25, punct: 0.05,
});

// fullStyleVector(text) → { register (9-axis), func, tri, punct }. Accepts an already
// computed full vector (idempotent) so callers can precompute once and reuse.
export function fullStyleVector(text) {
  if (text && typeof text === 'object' && text.__full === true) return text;
  const av = authorVector(text);
  return { __full: true, register: styleVector(text), func: av.func, tri: av.tri, punct: av.punct };
}

// Cosine distance mapped to [0,1]: (1 - cos)/2. Zero-norm handling: both zero → 0
// (identical/empty), exactly one zero → 0.5 (maximally undecided).
function cosineDistance(u, v) {
  let dot = 0; let nu = 0; let nv = 0;
  for (let i = 0; i < u.length; i += 1) { dot += u[i] * v[i]; nu += u[i] * u[i]; nv += v[i] * v[i]; }
  if (nu === 0 && nv === 0) return 0;
  if (nu === 0 || nv === 0) return 0.5;
  let cos = dot / (Math.sqrt(nu) * Math.sqrt(nv));
  cos = cos > 1 ? 1 : cos < -1 ? -1 : cos;
  const d = (1 - cos) / 2;
  return d < 1e-12 ? 0 : d; // snap float dust so d(x,x) is exactly 0

}

// fullStyleDistance(a, b) → weighted authorship+register distance in [0,1]. Accepts
// raw text OR fullStyleVector objects for either argument.
export function fullStyleDistance(a, b, weights = STYLO_WEIGHTS) {
  const fa = fullStyleVector(a);
  const fb = fullStyleVector(b);
  const registerD = styleDistance(fa.register, fb.register);
  const funcD = cosineDistance(fa.func, fb.func);
  const triD = cosineDistance(fa.tri, fb.tri);
  const punctD = cosineDistance(fa.punct, fb.punct);
  const w = weights;
  const wsum = w.register + w.func + w.tri + w.punct;
  return wsum ? (w.register * registerD + w.func * funcD + w.tri * triD + w.punct * punctD) / wsum : 0;
}

export default {
  styleVector, styleDistance, STYLE_AXES,
  authorVector, fullStyleVector, fullStyleDistance, STYLO_WEIGHTS,
};
