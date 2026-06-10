// verifier-features.mjs — Gate B v3 (trained pairwise verifier), chunk-level feature
// extraction. ZERO deps. Reuses the shipped func(180)/tri(250)/punct(24) extractors and
// adds TOPIC-ROBUST per-chunk features (word-shape/casing, char-affix n-grams,
// sentence/paragraph length distributions, whitespace/quote/emoji/typo habits) so the
// downstream verifier keys on individual VOICE, not subreddit topic vocabulary.
//
// Does NOT import or mutate the shipped stylometry.js scoring path. The frozen
// reference here is INJECTED (built from DEV held-out authors by the harness), never the
// shipped REF_MEAN/SD — calibration regen requirement (Task B).

import { relFreqFunc, relFreqTrigrams, relFreqPunct } from './stylometry-features.js';
import { FUNCTION_WORDS, TRIGRAM_KEYS, PUNCT_KEYS } from './stylometry-reference.js';

const Z_CAP = 8;

// ---- chunking --------------------------------------------------------------
// Split an author's docs into whitespace-token chunks of `size` tokens. Punctuation is
// kept attached (raw whitespace split) so punct/affix features survive. We chunk WITHIN
// each doc (no cross-doc bleed) then concatenate the chunk lists.
export function chunkDocs(docs, size) {
  const chunks = [];
  for (const doc of docs) {
    const toks = String(doc).split(/\s+/).filter(Boolean);
    if (toks.length < Math.floor(size * 0.6)) {
      // too short to be a clean chunk on its own; keep only if it is at least ~60% of a
      // chunk (avoids tiny noisy slices dominating the distribution).
      if (toks.length >= 120) chunks.push(toks.join(' '));
      continue;
    }
    for (let i = 0; i + size <= toks.length; i += size) {
      chunks.push(toks.slice(i, i + size).join(' '));
    }
    // tail: keep if it is at least 60% of a chunk so we don't waste long tails
    const rem = toks.length % size;
    if (rem >= Math.floor(size * 0.6)) {
      chunks.push(toks.slice(toks.length - rem).join(' '));
    }
  }
  return chunks;
}

// ---- topic-robust scalar features (each is a function-word/shape RATE, topic-agnostic) -
function topicRobustScalars(text) {
  const s = String(text);
  const chars = s.length || 1;
  // word tokens (case-preserving for shape features)
  const rawToks = s.split(/\s+/).filter(Boolean);
  const alphaToks = (s.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []);
  const nW = alphaToks.length || 1;

  // casing / word-shape
  let allCaps = 0; let titleCase = 0; let allLower = 0; let hasDigitTok = 0;
  for (const t of rawToks) {
    if (/^[A-Z0-9]{2,}$/.test(t) && /[A-Z]/.test(t)) allCaps += 1;
    else if (/^[A-Z][a-z]+$/.test(t)) titleCase += 1;
    else if (/^[a-z]+$/.test(t)) allLower += 1;
    if (/\d/.test(t)) hasDigitTok += 1;
  }
  const nTok = rawToks.length || 1;

  // sentences + paragraphs
  const sents = s.split(/[.!?]+(?:\s|$)/).map((x) => x.trim()).filter(Boolean);
  const sentLens = sents.map((x) => (x.match(/[A-Za-z']+/g) || []).length).filter((n) => n > 0);
  const meanSent = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  let sdSent = 0;
  if (sentLens.length > 1 && meanSent > 0) {
    sdSent = Math.sqrt(sentLens.reduce((a, b) => a + (b - meanSent) ** 2, 0) / sentLens.length);
  }
  const paras = s.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const paraLens = paras.map((p) => (p.match(/[A-Za-z']+/g) || []).length);
  const meanPara = paraLens.length ? paraLens.reduce((a, b) => a + b, 0) / paraLens.length : 0;

  // whitespace / quote / emoji / typo habits
  const doubleSpace = (s.match(/ {2,}/g) || []).length;
  const newlineRate = (s.match(/\n/g) || []).length / chars;
  const straightQuote = (s.match(/"/g) || []).length;
  const curlyQuote = (s.match(/[“”‘’]/g) || []).length;
  const apostrophe = (s.match(/'/g) || []).length;
  // oxlint-disable-next-line no-misleading-character-class -- intentional emoji + variation-selector (U+FE0F) class; match semantics must not change.
  const emoji = (s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu) || []).length;
  // "typo"-ish signals: repeated-letter runs (sooo), lone i, multi-punct
  const repeatRun = (s.match(/([a-zA-Z])\1\1+/g) || []).length;
  const loneI = (s.match(/\bi\b/g) || []).length;       // lowercase pronoun i
  const multiPunct = (s.match(/[!?]{2,}/g) || []).length;
  const ellipsis = (s.match(/\.{2,}/g) || []).length;
  const parenRate = (s.match(/[()]/g) || []).length / chars;
  const dashRate = (s.match(/[-—–]/g) || []).length / chars;
  const digitRate = (s.match(/\d/g) || []).length / chars;
  // mean word length (chars per alpha token) — idiolect signal, topic-light
  const meanWordLen = alphaToks.reduce((a, t) => a + t.length, 0) / nW;
  const ttr = nW ? new Set(alphaToks.map((t) => t.toLowerCase())).size / nW : 0;

  const sat = (x, k) => (x > 0 ? x / (x + k) : 0);
  return [
    allCaps / nTok,
    titleCase / nTok,
    allLower / nTok,
    hasDigitTok / nTok,
    sat(meanSent, 22),
    meanSent > 0 ? sdSent / meanSent : 0,
    sat(meanPara, 60),
    sat(doubleSpace / nTok, 0.05),
    sat(newlineRate, 0.02),
    sat(straightQuote / chars, 0.01),
    sat(curlyQuote / chars, 0.01),
    sat(apostrophe / chars, 0.02),
    sat(emoji / chars, 0.005),
    sat(repeatRun / nTok, 0.01),
    sat(loneI / nW, 0.02),
    sat(multiPunct / chars, 0.005),
    sat(ellipsis / chars, 0.005),
    sat(parenRate, 0.02),
    sat(dashRate, 0.02),
    sat(digitRate, 0.05),
    sat(meanWordLen, 5),
    ttr,
  ];
}
export const N_SCALAR = 22;

// ---- char-affix n-grams (prefix/suffix 3-grams) — topic-robust morphology -----------
// We fix a key list per fold (the harness passes them in). Returns rel-freq over keys.
export function affixCounts(text) {
  const toks = (String(text).toLowerCase().match(/[a-z']{2,}/g) || []);
  const pre = Object.create(null);
  const suf = Object.create(null);
  for (const t of toks) {
    if (t.length >= 4) {
      const p = 'P' + t.slice(0, 3);
      const s = 'S' + t.slice(-3);
      pre[p] = (pre[p] || 0) + 1;
      suf[s] = (suf[s] || 0) + 1;
    }
  }
  return { pre, suf, nTok: toks.length || 1 };
}
export function relFreqAffix(text, keys) {
  const { pre, suf, nTok } = affixCounts(text);
  return keys.map((k) => ((k[0] === 'P' ? pre[k] : suf[k]) || 0) / nTok);
}

// ---- z-standardize against an INJECTED reference (DEV-derived) ----------------------
function zStd(raw, mean, sd) {
  const out = Array.from({ length: raw.length });
  for (let i = 0; i < raw.length; i += 1) {
    let z = (raw[i] - mean[i]) / (sd[i] || 1e-6);
    if (z > Z_CAP) z = Z_CAP; else if (z < -Z_CAP) z = -Z_CAP;
    out[i] = z;
  }
  return out;
}

// Per-chunk full feature object. `ref` = { funcMean, funcSd, triMean, triSd, punctMean,
// punctSd, scalarMean, scalarSd, affixKeys, affixMean, affixSd } built by the harness
// from DEV held-out authors. Families are kept SEPARATE so the pair stage can compute a
// per-family Burrows-Delta.
export function chunkFeatures(text, ref) {
  const func = zStd(relFreqFunc(text, FUNCTION_WORDS), ref.funcMean, ref.funcSd);
  const tri = zStd(relFreqTrigrams(text, TRIGRAM_KEYS), ref.triMean, ref.triSd);
  const punct = zStd(relFreqPunct(text, PUNCT_KEYS), ref.punctMean, ref.punctSd);
  const scalar = zStd(topicRobustScalars(text), ref.scalarMean, ref.scalarSd);
  const affix = ref.affixKeys && ref.affixKeys.length
    ? zStd(relFreqAffix(text, ref.affixKeys), ref.affixMean, ref.affixSd)
    : [];
  return { func, tri, punct, scalar, affix };
}

export const FAMILIES = ['func', 'tri', 'punct', 'scalar', 'affix'];

export { topicRobustScalars };
