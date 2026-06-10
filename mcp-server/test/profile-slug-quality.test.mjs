// SLICE S2 — slug-quality precision gate. Tests the decision that controls whether
// a learned preference slug may EVER auto-inject.
//
// The gate labels each SURFACED slug three-way against a HELD-OUT TEST window
// (never the injected train target — that circularity was the ea15479 void) and
// returns eligible-to-auto-inject ONLY when precision >= the pre-registered 0.8
// bar (the founder's call). Recall is reported honestly (low recall is fine).
//
// Proves:
//   - a fabricated/noise slug is labeled 'wrong';
//   - a real cited correction is labeled 'correct-actionable-preference';
//   - a grounded-but-not-a-preference slug is labeled 'real-but-not-a-preference';
//   - the gate clears ONLY at precision >= 0.8 (and not below);
//   - the 0.8 bar is pre-registered + tamper-evident (changing it changes the hash);
//   - the held-out leakage guard throws on a TEST id that also appears in TRAIN;
//   - a fabricated/foreign slug set does NOT clear the bar (precision-guard control).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLUG_LABELS,
  SLUG_PRECISION_BAR,
  buildSlugQualityPreReg,
  testWindowGold,
  labelSlugs,
  eligibleSlugsForInjection,
  negativeControlClears,
  polarityConflict,
} from '../src/profile/eval/slug-quality.mjs';
import { hashPreReg } from '../src/profile/eval/prereg.mjs';

// A HELD-OUT TEST-window corpus. `goldSubjects` = actionable preferences the user
// expressed in the TEST window; `nonPreferenceSubjects` = things the user really
// said but that are NOT preferences. DISJOINT ids from any train window.
function testCorpus() {
  return {
    trainIds: ['train-0', 'train-1'],
    testIds: ['test-0', 'test-1'],
    probes: [
      {
        session_id: 'test-0',
        goldSubjects: ['use tabs not spaces', 'prefer typescript over javascript'],
        nonPreferenceSubjects: ['deploying the staging cluster on friday afternoon'],
      },
      {
        session_id: 'test-1',
        goldSubjects: ['keep responses terse'],
        nonPreferenceSubjects: ['the build failed because of a flaky network test'],
      },
    ],
  };
}

test('labelSlugs: a fabricated/noise slug is labeled WRONG', () => {
  const corpus = testCorpus();
  // A slug grounded in NOTHING the user said in the TEST window.
  const { labels, counts } = labelSlugs(['xyzzy quux frobnicate the wizbang'], corpus);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].label, SLUG_LABELS.WRONG, 'noise slug -> wrong');
  assert.equal(labels[0].matchedPreference, null);
  assert.equal(labels[0].matchedNonPreference, null);
  assert.equal(counts.wrong, 1);
  assert.equal(counts.correct, 0);
});

test('labelSlugs: a real cited correction is labeled CORRECT-ACTIONABLE-PREFERENCE', () => {
  const corpus = testCorpus();
  // A paraphrase of a TEST-window preference ("use tabs not spaces").
  const { labels, counts } = labelSlugs(['indentation should use tabs not spaces'], corpus);
  assert.equal(labels[0].label, SLUG_LABELS.CORRECT, 'cited correction -> correct');
  assert.ok(labels[0].matchedPreference, 'records which TEST preference it matched');
  assert.equal(counts.correct, 1);
  assert.equal(counts.wrong, 0);
});

test('labelSlugs: a grounded non-preference is labeled REAL-BUT-NOT-A-PREFERENCE', () => {
  const corpus = testCorpus();
  // Matches a TEST-window non-preference utterance, not a preference.
  const { labels } = labelSlugs(['the staging cluster deploying on friday'], corpus);
  assert.equal(labels[0].label, SLUG_LABELS.REAL_NOT_PREF, 'real-but-not-pref');
  assert.equal(labels[0].matchedPreference, null);
  assert.ok(labels[0].matchedNonPreference, 'records the real utterance it matched');
});

test('labelSlugs: preference wins when a subject could match both sets', () => {
  // testWindowGold drops a subject from nonPref if it is also a preference, so the
  // label is unambiguous (preference is the stronger, actionable claim).
  const corpus = {
    testIds: ['t'],
    probes: [{
      session_id: 't',
      goldSubjects: ['use tabs not spaces'],
      nonPreferenceSubjects: ['use tabs not spaces'], // duplicated into nonpref on purpose
    }],
  };
  const gold = testWindowGold(corpus);
  assert.ok(gold.preferenceSubjects.includes('use tabs not spaces'));
  assert.ok(!gold.nonPreferenceSubjects.includes('use tabs not spaces'),
    'overlap is removed from the non-preference set');
  const { labels } = labelSlugs(['use tabs not spaces'], corpus);
  assert.equal(labels[0].label, SLUG_LABELS.CORRECT);
});

test('gate clears (eligible) ONLY at precision >= 0.8', () => {
  const corpus = testCorpus();

  // ALL-correct surfaced set: precision 1.0 -> clears.
  const allGood = eligibleSlugsForInjection(
    ['use tabs not spaces', 'prefer typescript over javascript', 'keep responses terse'],
    corpus,
  );
  assert.equal(allGood.cleared, true, 'precision 1.0 clears the 0.8 bar');
  assert.ok(allGood.precision.point >= 0.8);
  assert.equal(allGood.eligible.length, 3);
  assert.equal(allGood.ineligible.length, 0);

  // 4 correct + 1 wrong = precision 0.8 -> clears (>= is inclusive).
  const exactly08 = eligibleSlugsForInjection(
    [
      'use tabs not spaces',
      'prefer typescript over javascript',
      'keep responses terse',
      'indentation should use tabs not spaces', // semantic dup of pref #1, still correct
      'xyzzy quux frobnicate', // wrong
    ],
    corpus,
  );
  assert.ok(Math.abs(exactly08.precision.point - 0.8) < 1e-9, `precision is 0.8 (${exactly08.precision.point})`);
  assert.equal(exactly08.cleared, true, 'precision exactly 0.8 clears (>= bar)');

  // 1 correct + 1 wrong = precision 0.5 -> does NOT clear.
  const half = eligibleSlugsForInjection(
    ['use tabs not spaces', 'xyzzy quux frobnicate'],
    corpus,
  );
  assert.ok(Math.abs(half.precision.point - 0.5) < 1e-9);
  assert.equal(half.cleared, false, 'precision 0.5 is below the 0.8 bar -> blocked');
  // even when blocked, the correct subset is still surfaced for show-and-confirm.
  assert.deepEqual(half.eligible, ['use tabs not spaces']);
  assert.deepEqual(half.ineligible, ['xyzzy quux frobnicate']);
});

test('a real-but-not-a-preference slug counts AGAINST precision (not eligible)', () => {
  const corpus = testCorpus();
  // 1 correct + 1 real-but-not-pref = precision 0.5 -> blocked. A grounded
  // non-preference must NOT be auto-injected as a preference.
  const out = eligibleSlugsForInjection(
    ['use tabs not spaces', 'the staging cluster deploying on friday'],
    corpus,
  );
  assert.equal(out.counts.correct, 1);
  assert.equal(out.counts.realNotPref, 1);
  assert.ok(Math.abs(out.precision.point - 0.5) < 1e-9);
  assert.equal(out.cleared, false);
  assert.ok(!out.eligible.includes('the staging cluster deploying on friday'));
});

test('recall is reported honestly (high-precision / low-recall is fine)', () => {
  const corpus = testCorpus(); // 3 TEST preferences total
  // Surface ONE correct preference: precision 1.0 but recall 1/3.
  const out = eligibleSlugsForInjection(['use tabs not spaces'], corpus);
  assert.equal(out.precision.point, 1, 'precision is perfect');
  assert.equal(out.cleared, true, 'high-precision low-recall still clears the precision gate');
  assert.ok(out.recall.point < 0.4 && out.recall.point > 0,
    `recall is honestly low (${out.recall.point}) — only 1 of 3 TEST prefs recovered`);
  assert.equal(out.gold.nPreferences, 3);
});

test('empty surfaced set does NOT clear (no precision to speak of)', () => {
  const out = eligibleSlugsForInjection([], testCorpus());
  assert.equal(out.cleared, false);
  assert.equal(out.precision.point, 0);
  assert.equal(out.eligible.length, 0);
});

test('PRE-REGISTRATION: the 0.8 bar is frozen and tamper-evident', () => {
  const base = buildSlugQualityPreReg();
  assert.equal(base.slugPrecisionBar, SLUG_PRECISION_BAR, 'default bar is the founder 0.8');
  assert.equal(base.slugPrecisionBar, 0.8);
  // Stable: same inputs -> same hash + runId.
  assert.equal(base.hash, buildSlugQualityPreReg().hash);
  // Tamper-evident: loosening the bar to 0.7 changes the hash (cannot pass quietly).
  const loosened = buildSlugQualityPreReg({ bar: 0.7 });
  assert.notEqual(base.hash, loosened.hash, 'changing the bar changes the pre-reg hash');
  assert.notEqual(base.runId, loosened.runId, 'a loosened bar also changes the runId');
  // Changing the semantic threshold is likewise tamper-evident.
  assert.notEqual(base.hash, buildSlugQualityPreReg({ semanticThreshold: 0.4 }).hash);
  // The composite hash is built ON TOP of the reused prereg base hash (the base
  // leg comes from hashPreReg, the bar is folded in on top).
  assert.equal(base.baseHash, hashPreReg(base), 'base leg reuses the prereg rig hash');
  assert.notEqual(base.hash, base.baseHash, 'the bar is folded in beyond the base prereg hash');
  // The runtime gate surfaces the pre-reg hash so a run is bound to a frozen bar.
  const gate = eligibleSlugsForInjection(['use tabs not spaces'], testCorpus());
  assert.equal(gate.preReg.slugPrecisionBar, 0.8);
  assert.equal(gate.preReg.hash, base.hash, 'gate is bound to the frozen 0.8 pre-reg');
});

test('HELD-OUT GUARD: a TEST id that also appears in TRAIN throws (anti-circularity)', () => {
  const leaky = {
    trainIds: ['shared-id', 'train-1'],
    testIds: ['shared-id'], // same id on both sides = the ea15479 leak
    probes: [{ session_id: 'shared-id', goldSubjects: ['use tabs not spaces'] }],
  };
  assert.throws(
    () => labelSlugs(['use tabs not spaces'], leaky),
    /held-out violation/,
    'a leaky train/test split is refused, not scored',
  );
  assert.throws(
    () => eligibleSlugsForInjection(['use tabs not spaces'], leaky),
    /held-out violation/,
  );
});

test('POLARITY GUARD: the OPPOSITE preference is NOT labeled correct', () => {
  // "use spaces not tabs" shares content tokens {tabs, spaces} with the gold
  // "use tabs not spaces" (Jaccard 1.0 under the polarity-blind matcher) but
  // asserts the OPPOSITE. A precision gate must NOT call it a correct preference.
  assert.equal(polarityConflict('use spaces not tabs', 'use tabs not spaces'), true);
  // A true paraphrase (same polarity) does NOT conflict.
  assert.equal(polarityConflict('indentation should use tabs not spaces', 'use tabs not spaces'), false);
  const corpus = testCorpus();
  const { labels } = labelSlugs(['use spaces not tabs'], corpus);
  assert.equal(labels[0].label, SLUG_LABELS.WRONG,
    'the inverse preference is wrong (would inject the opposite of what the user wants)');
  // And so it cannot clear the gate on its own.
  assert.equal(eligibleSlugsForInjection(['use spaces not tabs'], corpus).cleared, false);
});

test('NEGATIVE CONTROL: a foreign/fabricated slug set does NOT clear the bar', () => {
  const corpus = testCorpus();
  // Slugs that belong to an UNRELATED persona (spaces / JS / verbose) — must not
  // light up on Ada's TEST window. A gate that PASSED here would be matching
  // universals, not the user.
  const foreign = ['use spaces not tabs', 'prefer plain javascript', 'write detailed verbose explanations'];
  const out = eligibleSlugsForInjection(foreign, corpus);
  assert.equal(out.cleared, false, 'foreign prefs do not clear the bar');
  assert.equal(out.counts.correct, 0, 'no foreign slug is labeled a correct preference');
  // The dedicated control helper agrees.
  assert.equal(negativeControlClears(foreign, corpus), false);
});

test('eligibleSlugsForInjection returns the full per-slug audit trail', () => {
  const out = eligibleSlugsForInjection(
    ['use tabs not spaces', 'xyzzy quux frobnicate'],
    testCorpus(),
  );
  assert.equal(out.labels.length, 2);
  assert.equal(out.counts.total, 2);
  // labels carry slug + label + provenance for show-and-confirm UX.
  for (const l of out.labels) {
    assert.ok(typeof l.slug === 'string');
    assert.ok(Object.values(SLUG_LABELS).includes(l.label));
  }
});
