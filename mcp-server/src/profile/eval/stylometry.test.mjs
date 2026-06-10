// Gate B v2 — authorship-layer stylometry (Task T1). These tests enforce the
// properties the design audit made load-bearing: the metric is a sane distance, it
// carries INDIVIDUAL-voice signal that survives length (not just register), and the
// z-standardization is provably NOT recomputed from the scored text (the anti-circularity
// guard — both structural source-scan and behavioral independence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authorVector, fullStyleVector, fullStyleDistance, STYLO_WEIGHTS,
} from './stylometry.js';
import {
  FUNCTION_WORDS, TRIGRAM_KEYS, PUNCT_KEYS, REFERENCE_SOURCE,
  REF_MEAN_FUNC, REF_SD_FUNC,
} from './stylometry-reference.js';

// Same-author (formal/expository), two lengths.
const A_SHORT = 'The matter, however, is one which must be considered with the greatest of care; the consequences of a hasty decision are, as the records of the past have shown, considerable.';
const A_LONG = 'The matter, however, is one which must be considered with the greatest of care, for the consequences of a hasty decision are, as the records of the past have repeatedly shown, considerable. It is therefore the case that the wise observer, having weighed the whole of the evidence which is before him, will tend toward the conclusion that nothing of importance ought to be undertaken until the question itself has been examined with the patience that such a matter properly demands.';
// Different author (casual/personal), length-matched to A_SHORT.
const B_CASUAL = "yeah so i just think you're gonna really like it, it's kinda cool and you just click on the thing and then you're basically done, i mean it barely took me any time at all honestly.";

test('authorVector emits fixed-length func(180)/tri(250)/punct(24), deterministic', () => {
  const v = authorVector(A_SHORT);
  assert.equal(v.func.length, 180);
  assert.equal(v.tri.length, 250);
  assert.equal(v.punct.length, 24);
  for (const x of [...v.func, ...v.tri, ...v.punct]) assert.ok(Number.isFinite(x));
  // deterministic
  const v2 = authorVector(A_SHORT);
  assert.deepEqual(v2.func, v.func);
  assert.deepEqual(v2.tri, v.tri);
  assert.deepEqual(v2.punct, v.punct);
});

test('fullStyleDistance is a sane metric: [0,1], symmetric, d(x,x)=0', () => {
  assert.equal(fullStyleDistance(A_SHORT, A_SHORT), 0);
  const d = fullStyleDistance(A_SHORT, B_CASUAL);
  assert.ok(d >= 0 && d <= 1, `in [0,1], got ${d}`);
  const d2 = fullStyleDistance(B_CASUAL, A_SHORT);
  assert.ok(Math.abs(d - d2) < 1e-12, 'symmetric');
});

test('NOT-GAMEABLE-BY-LENGTH: same-author/diff-length is CLOSER than diff-author/same-length', () => {
  const sameAuthorDiffLength = fullStyleDistance(A_SHORT, A_LONG);
  const diffAuthorSameLength = fullStyleDistance(A_SHORT, B_CASUAL);
  assert.ok(
    diffAuthorSameLength > sameAuthorDiffLength,
    `expected diff-author (${diffAuthorSameLength.toFixed(4)}) > same-author-diff-length (${sameAuthorDiffLength.toFixed(4)})`,
  );
});

test('ANTI-RECOMPUTE (structural): standardization uses imported REF constants, not input stats', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('./stylometry.js', import.meta.url)), 'utf8');
  // imports the frozen reference module
  assert.ok(/from '\.\/stylometry-reference\.js'/.test(src), 'imports the frozen reference module');
  // REF constants are passed into the standardizer at the call site
  assert.ok(/zStandardize\(\s*relFreqFunc\([^)]*\),\s*REF_MEAN_FUNC,\s*REF_SD_FUNC\)/.test(src),
    'authorVector standardizes func against imported REF_MEAN_FUNC/REF_SD_FUNC');
  // the standardizer body must not recompute a mean/variance over the scored input
  const m = src.match(/function zStandardize[\s\S]*?\n}/);
  assert.ok(m, 'found zStandardize body');
  assert.ok(!/Math\.sqrt/.test(m[0]), 'standardizer does not compute a stdev (no Math.sqrt) over input');
  assert.ok(!/\.reduce\(/.test(m[0]), 'standardizer does not aggregate over the input vector');
});

test('ANTI-RECOMPUTE (behavioral): authorVector(A) is independent of other scored texts', () => {
  const before = authorVector(A_SHORT);
  // score a pile of unrelated texts — must not mutate any global standardization state
  for (let i = 0; i < 50; i += 1) {
    authorVector(`${B_CASUAL} ${i} ${A_LONG}`);
    fullStyleDistance(A_LONG, B_CASUAL);
  }
  const after = authorVector(A_SHORT);
  assert.deepEqual(after.func, before.func);
  assert.deepEqual(after.tri, before.tri);
  assert.deepEqual(after.punct, before.punct);
});

test('reference constants are frozen, aligned, and documented as persona-disjoint', () => {
  assert.equal(FUNCTION_WORDS.length, 180);
  assert.equal(TRIGRAM_KEYS.length, 250);
  assert.equal(PUNCT_KEYS.length, 24);
  assert.equal(REF_MEAN_FUNC.length, 180);
  assert.equal(REF_SD_FUNC.length, 180);
  assert.ok(REF_SD_FUNC.every((s) => s > 0), 'all SDs strictly positive (no divide-by-zero)');
  assert.match(REFERENCE_SOURCE, /disjoint/i);
});

test('STYLO_WEIGHTS is frozen and sums sensibly with func dominant', () => {
  assert.ok(Object.isFrozen(STYLO_WEIGHTS));
  assert.ok(STYLO_WEIGHTS.func >= STYLO_WEIGHTS.tri);
  assert.ok(STYLO_WEIGHTS.func > STYLO_WEIGHTS.register);
});

test('fullStyleVector is idempotent on an already-computed full vector', () => {
  const fv = fullStyleVector(A_SHORT);
  const again = fullStyleVector(fv);
  assert.equal(again, fv);
  assert.equal(fullStyleDistance(fv, fv), 0);
});
