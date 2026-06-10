#!/usr/bin/env node
// build-stylo-reference.mjs — ONE-OFF generator for stylometry-reference.js.
//
// Produces the FROZEN reference statistics (REF_MEAN/REF_SD per feature) that
// z-standardize the authorship sub-vectors in stylometry.js::authorVector. The
// reference corpus is a NEUTRAL, hand-authored, public English baseline that is
// DISJOINT from every Gate-B persona author (no Reddit / Enron / IJFW-user text). It
// exists only to fix the standardization scale; the instrument-validation gate (T2)
// empirically verifies that the metric actually discriminates authors, so any
// reasonable disjoint reference suffices.
//
// For the confirmatory run the reference SHOULD be regenerated from a broad disjoint
// corpus:  node tools/build-stylo-reference.mjs --corpus path/to/reference.txt
// The committed default uses the embedded NEUTRAL_REFERENCE below.
//
// This lives under tools/ (OFF the eval scoring path) and is never imported at scoring
// time — only stylometry-reference.js (its committed output) is.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  relFreqFunc, relFreqTrigrams, relFreqPunct, trigramCounts, splitChunks,
} from '../src/profile/eval/stylometry-features.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'profile', 'eval', 'stylometry-reference.js');
const N_CHUNKS = 12;
const N_TRIGRAMS = 250;

// A closed-class function-word pool (articles, pronouns, prepositions, conjunctions,
// auxiliaries, modals, common adverbs/particles). Frozen to the first 180 — a standard
// stylometric feature set (cf. Mosteller & Wallace), NOT corpus-selected, so the choice
// of words carries no persona information.
const FUNCTION_WORD_POOL = [
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its',
  'our', 'their', 'some', 'any', 'no', 'every', 'each', 'either', 'neither', 'all', 'both',
  'few', 'many', 'much', 'more', 'most', 'several', 'such', 'what', 'which', 'whose',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'them', 'us', 'who', 'whom',
  'whoever', 'anyone', 'someone', 'everyone', 'nobody', 'anything', 'something',
  'everything', 'nothing', 'myself', 'yourself', 'himself', 'herself', 'itself',
  'ourselves', 'themselves', 'one', 'ones', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'by', 'from', 'up', 'about', 'into',
  'over', 'after', 'beneath', 'under', 'above', 'below', 'between', 'among', 'through',
  'during', 'before', 'behind', 'beyond', 'plus', 'except', 'around', 'near', 'since',
  'until', 'against', 'without', 'within', 'along', 'across', 'toward', 'upon', 'off',
  'out', 'down', 'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'whereas', 'unless', 'whether', 'if', 'then', 'than', 'as', 'is', 'am', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'ought', 'not',
  'very', 'too', 'also', 'just', 'only', 'even', 'still', 'again', 'ever', 'never',
  'always', 'often', 'sometimes', 'here', 'there', 'where', 'when', 'how', 'why', 'now',
  'once', 'quite', 'rather', 'almost', 'enough', 'indeed', 'however', 'therefore', 'thus',
  'hence', 'otherwise', 'instead', 'perhaps', 'maybe',
];
const FUNCTION_WORDS = [...new Set(FUNCTION_WORD_POOL)].slice(0, 180);

// Fixed punctuation n-gram key set (24) — single marks, dashes, brackets, multi-mark
// sequences, and a few spacing patterns. Fixed (not corpus-selected) so the key set
// carries no persona information; only the REF stats come from the corpus.
const PUNCT_KEYS = [
  '.', ',', ';', ':', '!', '?', '-', '—', '–', '(', ')', '[', ']', '"', "'",
  '...', '?!', '!?', '!!', '??', '--', ', ', '. ', '; ',
];

// Neutral, hand-authored public English baseline (disjoint from all personas).
const NEUTRAL_REFERENCE = `
The river moved slowly through the valley, and the morning light fell across the water in long pale bands. A traveler stopped at the edge of the bank to rest, setting down a heavy pack and looking out toward the distant hills. The air was cool, and somewhere beyond the trees a bird called twice and then fell silent. It is in such quiet places that a person can begin to notice the smaller things: the texture of the stones, the slow drift of a leaf, the way the current folds around a fallen branch.

Work of any kind requires patience, and the building of a single wall is no exception. First the ground must be cleared and leveled, then the foundation laid with care, stone by stone, each one chosen to fit against the last. If a single stone is set carelessly, the whole structure will lean, and later it must be taken apart and built again. Many people imagine that skill is a matter of speed, but in truth it is mostly a matter of attention, repeated over many days until the hands learn what the mind already knows.

When we consider how a city grows, we find that it rarely follows a single plan. Streets bend around older paths, markets gather where roads happen to cross, and houses rise wherever there is room. Over time the shape of the place reflects the thousands of small decisions made by the people who live there. No one designed it, yet it works; no one controls it, yet it endures. This is how most living systems behave, whether they are made of stone, of habit, or of language.

Consider, for a moment, the ordinary act of reading. The eye moves across a line, the mind assembles meaning, and somehow marks on a page become thoughts inside a skull. We do this so easily that we forget how strange it is. A child spends years learning the trick, and then carries it for a lifetime without a second thought. Language is perhaps the oldest tool we have, older than the wheel, older than fire used on purpose, and we still do not fully understand how it works.

There are questions that cannot be answered by measurement alone. How much is a quiet evening worth? What is the value of a long walk with no destination? These things resist the scale and the ledger, and yet they matter to us more than many things we can count. A wise person keeps room for both kinds of knowing: the kind that can be proven, and the kind that can only be felt and trusted. To insist on only one is to lose half of what it means to understand.

In the end, the simplest advice is often the hardest to follow. Pay attention. Do the work. Be patient with what grows slowly. Notice when something is wrong, and be honest about it, even when honesty is inconvenient. These rules are easy to state and difficult to keep, which is exactly why they are worth repeating. The world rewards those who can hold a clear idea steady while the noise rises around them, and it forgives, in time, those who are willing to begin again.
`;

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); }
function stdev(xs, mu) {
  if (xs.length < 2) return 0;
  const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}
const SD_FLOOR = 1e-4; // relative-frequency units; prevents divide-by-near-zero blowups

function statsAcrossChunks(perChunkVectors) {
  const dim = perChunkVectors[0].length;
  const refMean = new Array(dim);
  const refSd = new Array(dim);
  for (let j = 0; j < dim; j += 1) {
    const col = perChunkVectors.map((v) => v[j]);
    const mu = mean(col);
    refMean[j] = mu;
    refSd[j] = Math.max(stdev(col, mu), SD_FLOOR);
  }
  return { refMean, refSd };
}

function round6(x) { return Number.parseFloat(x.toPrecision(6)); }

function build(corpus) {
  const chunks = splitChunks(corpus, N_CHUNKS);
  if (chunks.length < 4) throw new Error(`reference corpus too small: ${chunks.length} chunks`);

  // Trigram keys = top-N by total count across the whole corpus.
  const counts = trigramCounts(corpus);
  const trigramKeys = Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1))
    .slice(0, N_TRIGRAMS);
  if (trigramKeys.length < N_TRIGRAMS) {
    throw new Error(`reference corpus yielded only ${trigramKeys.length} distinct trigrams (<${N_TRIGRAMS})`);
  }

  const funcVecs = chunks.map((c) => relFreqFunc(c, FUNCTION_WORDS));
  const triVecs = chunks.map((c) => relFreqTrigrams(c, trigramKeys));
  const punctVecs = chunks.map((c) => relFreqPunct(c, PUNCT_KEYS));

  const func = statsAcrossChunks(funcVecs);
  const tri = statsAcrossChunks(triVecs);
  const punct = statsAcrossChunks(punctVecs);

  return { trigramKeys, func, tri, punct };
}

function emit({ trigramKeys, func, tri, punct }, source) {
  const arr = (xs) => `[${xs.map(round6).join(',')}]`;
  const strArr = (xs) => JSON.stringify(xs);
  return `// AUTO-GENERATED by tools/build-stylo-reference.mjs — DO NOT EDIT BY HAND.
// Frozen reference statistics that z-standardize the authorship sub-vectors. Derived
// from a NEUTRAL hand-authored public English baseline, DISJOINT from every Gate-B
// persona author. Never recomputed from scored text. Regenerate for the confirmatory
// run:  node tools/build-stylo-reference.mjs --corpus <broad-disjoint-corpus>
/* eslint-disable */
export const REFERENCE_SOURCE = ${JSON.stringify(source)};
export const FUNCTION_WORDS = ${strArr(FUNCTION_WORDS)};
export const PUNCT_KEYS = ${strArr(PUNCT_KEYS)};
export const TRIGRAM_KEYS = ${strArr(trigramKeys)};
export const REF_MEAN_FUNC = ${arr(func.refMean)};
export const REF_SD_FUNC = ${arr(func.refSd)};
export const REF_MEAN_TRI = ${arr(tri.refMean)};
export const REF_SD_TRI = ${arr(tri.refSd)};
export const REF_MEAN_PUNCT = ${arr(punct.refMean)};
export const REF_SD_PUNCT = ${arr(punct.refSd)};
`;
}

function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--corpus');
  let corpus = NEUTRAL_REFERENCE;
  let source = 'neutral-handauthored-baseline-v1 (disjoint from all personas)';
  if (ci !== -1 && argv[ci + 1]) {
    corpus = fs.readFileSync(argv[ci + 1], 'utf8');
    source = `external:${path.basename(argv[ci + 1])} (operator-asserted disjoint from all personas)`;
  }
  const built = build(corpus);
  fs.writeFileSync(OUT, emit(built, source));
  process.stdout.write(`wrote ${OUT}\n  func=${FUNCTION_WORDS.length} tri=${built.trigramKeys.length} punct=${PUNCT_KEYS.length}\n`);
}

main();
