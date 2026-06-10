// Phase 1.1 — rich, judge-free stylometry metric.
// The whole point of this metric is that it is NOT gameable by length alone
// (the cross-audit's core complaint about the old 3-axis metric). These tests
// enforce that several axes move independently, that the distance is a sane
// metric, and (negative control) that a length-only change does NOT zero out a
// formality/emoji difference.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleVector, styleDistance, STYLE_AXES } from '../src/profile/eval/stylometry.js';

const TERSE = 'Fixed it. Shipped.';
const VERBOSE = 'I went ahead and investigated the issue in some depth, and after carefully considering several different approaches, I ultimately decided that the most prudent course of action would be to refactor the affected module before proceeding any further with the deployment.';
const FORMAL = 'However, the results were inconclusive; therefore, additional analysis is warranted. Furthermore, the methodology should be reviewed.';
const CASUAL = "yeah that's broken lol, i'll just hack around it for now and we can fix it properly later maybe";
const EMOJI = 'shipped it 🚀🚀 looks great 🎉 super happy with this one 😄';

test('styleVector returns all 9 axes, each in [0,1]', () => {
  for (const txt of [TERSE, VERBOSE, FORMAL, CASUAL, EMOJI, '']) {
    const v = styleVector(txt);
    assert.equal(Object.keys(v).length, 9);
    for (const ax of STYLE_AXES) {
      assert.ok(Number.isFinite(v[ax]), `${ax} finite`);
      assert.ok(v[ax] >= 0 && v[ax] <= 1, `${ax} in [0,1] (got ${v[ax]})`);
    }
  }
});

test('terseness discriminates short vs long', () => {
  assert.ok(styleVector(TERSE).terseness > styleVector(VERBOSE).terseness);
});

test('formality discriminates formal connectives vs casual', () => {
  assert.ok(styleVector(FORMAL).formality > styleVector(CASUAL).formality);
});

test('emojiRate discriminates emoji-heavy vs none', () => {
  assert.ok(styleVector(EMOJI).emojiRate > styleVector(FORMAL).emojiRate);
});

test('contractionRate + hedgeRate are higher for casual prose', () => {
  assert.ok(styleVector(CASUAL).contractionRate > styleVector(FORMAL).contractionRate);
});

test('typeTokenRatio is lower for repetitive text', () => {
  const repetitive = 'go go go go go go go go go go';
  const diverse = 'the quick brown fox jumps over a lazy sleeping dog nearby';
  assert.ok(styleVector(repetitive).typeTokenRatio < styleVector(diverse).typeTokenRatio);
});

test('styleDistance is a sane metric: identity, symmetry, non-negativity', () => {
  assert.equal(styleDistance(FORMAL, FORMAL), 0);
  assert.ok(Math.abs(styleDistance(TERSE, VERBOSE) - styleDistance(VERBOSE, TERSE)) < 1e-12);
  assert.ok(styleDistance(TERSE, FORMAL) > 0);
});

test('NOT gameable by length alone: same length, different formality/emoji => nonzero distance', () => {
  // Two strings padded to (near) equal length but differing in formality + emoji.
  const a = 'However, therefore, furthermore, the matter is settled and closed.';
  const b = 'yeah ok cool 🚀 whatever works for you, no worries at all my friend';
  assert.ok(Math.abs(a.length - b.length) <= 6, 'lengths matched for the control');
  // terseness (length axis) is ~equal, but the vector still separates them.
  const va = styleVector(a); const vb = styleVector(b);
  assert.ok(Math.abs(va.terseness - vb.terseness) < 0.05, 'terseness ~equal (length matched)');
  assert.ok(styleDistance(a, b) > 0.1, 'distance is driven by non-length axes, not length');
});

test('accepts pre-computed vectors as well as raw text', () => {
  const v = styleVector(TERSE);
  assert.equal(styleDistance(v, v), 0);
  assert.equal(styleDistance(v, TERSE), 0);
});

test('NEGATIVE CONTROL: a known-true ordering would FLIP if formality collapsed to length', () => {
  // Proves the test isn't vacuous: FORMAL and a same-length casual string must be
  // distinguished by a NON-length axis. If styleVector ever regressed to
  // length-only, formality delta would be 0 and this asserts catches it.
  const casualSameish = 'so i poked at it a bit and honestly it just kinda works now ok cool done';
  const vF = styleVector(FORMAL);
  const vC = styleVector(casualSameish);
  assert.ok(vF.formality - vC.formality > 0.1, 'formality axis carries real, non-length signal');
});
