// verifier-reference.mjs — Gate B v3, Task B (calibration regen). Build the per-family
// reference mean/SD from a set of TRAIN-author chunks (DEV, author-disjoint from the
// validation fold). Percentile SD floor; floored dims dropped from the scalar/affix
// families is NOT done (fixed-length vectors needed) — instead a robust SD floor keeps
// rare dims from blowing up to the z-cap. ZERO deps. Never reads sealed corpora.

import { relFreqFunc, relFreqTrigrams, relFreqPunct } from './stylometry-features.js';
import { FUNCTION_WORDS, TRIGRAM_KEYS, PUNCT_KEYS } from './stylometry-reference.js';
import { topicRobustScalars, affixCounts, relFreqAffix } from './verifier-features.mjs';

function meanSd(rows, floorPct) {
  const d = rows[0].length;
  const mean = Array.from({ length: d }, () => 0);
  const sd = Array.from({ length: d }, () => 0);
  for (const r of rows) for (let j = 0; j < d; j += 1) mean[j] += r[j];
  for (let j = 0; j < d; j += 1) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j += 1) sd[j] += (r[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j += 1) sd[j] = Math.sqrt(sd[j] / rows.length);
  // percentile SD floor: floor at the `floorPct` percentile of the POSITIVE sds, so rare
  // near-constant dims don't divide by ~0 (which sends them to the z-cap and dominates).
  const pos = sd.filter((x) => x > 0).sort((a, b) => a - b);
  const floor = pos.length ? pos[Math.floor((floorPct / 100) * (pos.length - 1))] : 1e-6;
  for (let j = 0; j < d; j += 1) if (!(sd[j] > floor)) sd[j] = floor;
  return { mean, sd };
}

// Pick the top-K most frequent affix keys across the train chunks (content-light:
// 3-char prefixes/suffixes). Deterministic by (count desc, key asc).
function pickAffixKeys(chunks, k) {
  const counts = Object.create(null);
  for (const c of chunks) {
    const { pre, suf } = affixCounts(c);
    for (const key in pre) counts[key] = (counts[key] || 0) + pre[key];
    for (const key in suf) counts[key] = (counts[key] || 0) + suf[key];
  }
  return Object.entries(counts)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([key]) => key);
}

// buildReference(trainChunks, opts) -> ref object consumed by chunkFeatures.
export function buildReference(trainChunks, opts = {}) {
  const floorPct = opts.floorPct ?? 10;
  const affixK = opts.affixK ?? 150;
  const affixKeys = pickAffixKeys(trainChunks, affixK);

  const funcRows = trainChunks.map((c) => relFreqFunc(c, FUNCTION_WORDS));
  const triRows = trainChunks.map((c) => relFreqTrigrams(c, TRIGRAM_KEYS));
  const punctRows = trainChunks.map((c) => relFreqPunct(c, PUNCT_KEYS));
  const scalarRows = trainChunks.map((c) => topicRobustScalars(c));
  const affixRows = trainChunks.map((c) => relFreqAffix(c, affixKeys));

  const f = meanSd(funcRows, floorPct);
  const t = meanSd(triRows, floorPct);
  const p = meanSd(punctRows, floorPct);
  const s = meanSd(scalarRows, floorPct);
  const a = meanSd(affixRows, floorPct);

  return {
    funcMean: f.mean, funcSd: f.sd,
    triMean: t.mean, triSd: t.sd,
    punctMean: p.mean, punctSd: p.sd,
    scalarMean: s.mean, scalarSd: s.sd,
    affixKeys, affixMean: a.mean, affixSd: a.sd,
    nTrainChunks: trainChunks.length,
  };
}
