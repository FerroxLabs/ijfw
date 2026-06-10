// real-personas.mjs — Gate B v2, Task T3 (real-author half). A "persona" is one real
// author split into DISJOINT train/test document slices. The brief is derived from TRAIN
// only; the held-out TEST fingerprint is the scoring target (kills the train/test
// circularity C1). Real authors carry the confirmatory headline (synthetic-personas.js
// may only downgrade).
//
// SELECTION-BIAS GUARD (audit must-fix): persona selection + ordering depend ONLY on the
// seed and author identity — NEVER on the mutual fullStyleDistance under test. Choosing
// "well-separated" authors by the scored metric would inflate every downstream result.

import { tokenizeWords } from './stylometry-features.js';
import { fullStyleVector } from './stylometry.js';

export const PERSONA_DEFAULTS = Object.freeze({
  minTrainTokens: 1200, minTestTokens: 600, seed: 1,
});

// FNV-1a string hash → uint32. Deterministic, content-independent ordering key.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenCount(text) { return tokenizeWords(text).length; }

// Split one author's docs into disjoint train/test slices. Allocates whole documents to
// TEST until the test-token floor is met, the remainder to TRAIN; both must clear their
// floors or it THROWS (abort — do not silently shrink a slice below power).
export function splitAuthorDocs(author, opts = {}) {
  const cfg = { ...PERSONA_DEFAULTS, ...opts };
  const docs = author.docs || [];
  if (docs.length < 2) throw new Error(`persona ${author.id}: needs >=2 documents for a disjoint split`);

  // deterministic doc order by seeded hash (never by content distance)
  const order = docs.map((_, i) => i).sort((a, b) => {
    const ha = fnv1a(`${cfg.seed}:${author.id}:${a}`);
    const hb = fnv1a(`${cfg.seed}:${author.id}:${b}`);
    return ha - hb || a - b;
  });

  const testIdx = [];
  let testTok = 0;
  for (const i of order) {
    if (testTok >= cfg.minTestTokens) break;
    testIdx.push(i);
    testTok += tokenCount(docs[i]);
  }
  const testSet = new Set(testIdx);
  const trainIdx = order.filter((i) => !testSet.has(i));
  const trainDocs = trainIdx.map((i) => docs[i]);
  const testDocs = testIdx.map((i) => docs[i]);
  const trainTok = trainDocs.reduce((s, d) => s + tokenCount(d), 0);

  if (testTok < cfg.minTestTokens) throw new Error(`persona ${author.id}: test slice ${testTok} < ${cfg.minTestTokens} tokens`);
  if (trainTok < cfg.minTrainTokens) throw new Error(`persona ${author.id}: train slice ${trainTok} < ${cfg.minTrainTokens} tokens`);
  // disjoint by construction (test/train index sets are complementary)
  return {
    trainDocs, testDocs, trainTokens: trainTok, testTokens: testTok,
  };
}

export function makePersona(author, opts = {}) {
  const split = splitAuthorDocs(author, opts);
  return {
    id: author.id,
    synthetic: false,
    headlineEligible: true,
    trainDocs: split.trainDocs,
    testDocs: split.testDocs,
    trainTokens: split.trainTokens,
    testTokens: split.testTokens,
    // held-out TEST fingerprint = the scoring target (NOT derived from train).
    fingerprint: fullStyleVector(split.testDocs.join('\n')),
  };
}

// loadRealPersonas(corpus, opts) → up to nAuthors personas. Authors are considered in
// seed+identity order; too-short authors are SKIPPED (not fatal in selection mode), but
// if fewer than nAuthors qualify it THROWS — abort-and-ingest-more, never evaluate the
// downstream gate on an underpowered set.
export function loadRealPersonas(corpus, opts = {}) {
  const cfg = { nAuthors: corpus.length, ...PERSONA_DEFAULTS, ...opts };
  const ordered = [...corpus].sort((a, b) => {
    const ha = fnv1a(`${cfg.seed}:${a.id}`);
    const hb = fnv1a(`${cfg.seed}:${b.id}`);
    return ha - hb || (a.id < b.id ? -1 : 1);
  });

  const personas = [];
  const skipped = [];
  for (const author of ordered) {
    if (personas.length >= cfg.nAuthors) break;
    try {
      personas.push(makePersona(author, cfg));
    } catch (e) {
      skipped.push(`${author.id}: ${e.message}`);
    }
  }
  if (personas.length < cfg.nAuthors) {
    throw new Error(`only ${personas.length} qualifying personas (< ${cfg.nAuthors}); ingest more authors. skipped: ${skipped.length}`);
  }
  return personas;
}

export const __test = { fnv1a, tokenCount };
