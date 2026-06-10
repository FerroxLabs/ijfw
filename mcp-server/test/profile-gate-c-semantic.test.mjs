// Push v2 — SEMANTIC preference recall (Gate C eval-metric fix).
//
// CHANGE 2: the exact-slug match reports recall=0 on the real corpus because the
// user paraphrases the SAME preference cross-time. semanticPrecisionRecall adds a
// principled lexical-semantic match (Jaccard >= threshold over content tokens,
// stopwords removed) so "captured-but-paraphrased" is distinguished from
// "genuinely-not-captured". This suite proves:
//   - a paraphrase of the same preference MATCHES under the semantic metric where
//     it does NOT under exact;
//   - an unrelated preference does NOT match (the metric is not trivially
//     always-positive — the negative-control property);
//   - the threshold is honored (a weak overlap below threshold is a miss);
//   - the returned shape feeds bootstrapCI (perPredCorrect / perGoldHit vectors).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { semanticPrecisionRecall } from '../src/profile/eval/gate-c-capture.mjs';
import { precisionRecall } from '../src/profile/eval/harness.mjs';

test('semantic: paraphrase recovered where EXACT slug match misses', () => {
  // Same preference ("prefer tabs over spaces for indentation"), restated.
  const predicted = ['prefer tabs over spaces for indentation'];
  const gold = ['indentation should use tabs not spaces'];
  // Exact slug match: zero overlap of the verbatim slugs -> recall 0.
  const exact = precisionRecall(predicted, gold);
  assert.equal(exact.recall, 0, 'exact-slug recall is 0 on a paraphrase (the known gap)');
  // Semantic match: content tokens {tabs, spaces, indentation} overlap strongly.
  const sem = semanticPrecisionRecall(predicted, gold, 0.5);
  assert.equal(sem.recall, 1, 'semantic recall recovers the paraphrased preference');
  assert.equal(sem.precision, 1);
});

test('semantic: unrelated preference does NOT match (not trivially positive)', () => {
  const predicted = ['prefer tabs over spaces for indentation'];
  const gold = ['always respond with heavy emoji and casual tone'];
  const sem = semanticPrecisionRecall(predicted, gold, 0.5);
  assert.equal(sem.recall, 0, 'an unrelated preference must not match');
  assert.equal(sem.precision, 0);
});

test('semantic: threshold is honored — weak overlap below threshold is a miss', () => {
  // Share exactly one content token ("caching") out of many -> Jaccard < 0.5.
  const predicted = ['prefer aggressive caching of static assets at the edge'];
  const gold = ['caching database query results in redis is acceptable'];
  const hi = semanticPrecisionRecall(predicted, gold, 0.5);
  assert.equal(hi.recall, 0, 'single shared token is below the 0.5 threshold -> miss');
  // A permissive threshold lets the single-token overlap through (shows the knob works).
  const lo = semanticPrecisionRecall(predicted, gold, 0.05);
  assert.equal(lo.recall, 1, 'a low threshold admits the weak overlap (threshold is real)');
});

test('semantic: stopwords do not inflate overlap', () => {
  // Both restate the SAME pref with lots of shared function words but DIFFERENT
  // content. Stopword stripping must keep them apart on substance.
  const predicted = ['the user prefers to use verbose logging everywhere'];
  const gold = ['the user prefers to use terse minimal output always'];
  const sem = semanticPrecisionRecall(predicted, gold, 0.5);
  assert.equal(sem.recall, 0, 'shared stopwords must not create a false match');
});

test('semantic: returns bootstrap-ready 0/1 vectors', () => {
  const predicted = ['prefer tabs over spaces', 'likes typescript strict mode'];
  const gold = ['use tabs not spaces for code', 'no preference here at all xyz'];
  const sem = semanticPrecisionRecall(predicted, gold, 0.5);
  assert.equal(sem.perPredCorrect.length, predicted.length);
  assert.equal(sem.perGoldHit.length, gold.length);
  for (const v of [...sem.perPredCorrect, ...sem.perGoldHit]) {
    assert.ok(v === 0 || v === 1, 'vectors are strictly 0/1');
  }
  // tabs paraphrase matches gold[0]; typescript pred + gold[1] do not match.
  assert.equal(sem.perPredCorrect[0], 1);
  assert.equal(sem.perGoldHit[0], 1);
  assert.equal(sem.tp + sem.fp, predicted.length);
});

test('semantic: empty predicted/gold are safe (0, not NaN)', () => {
  const a = semanticPrecisionRecall([], ['anything here'], 0.5);
  assert.equal(a.precision, 0);
  assert.equal(a.recall, 0);
  const b = semanticPrecisionRecall(['something'], [], 0.5);
  assert.equal(b.precision, 0);
  assert.equal(b.recall, 0);
});
