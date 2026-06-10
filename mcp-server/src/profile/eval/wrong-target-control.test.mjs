// Gate B v2 — Task T5: wrong-target control. The discriminator's guards: same-register
// foreign pool, undecidable exclusion, NEAREST (not centroid) margin, subject-level
// bootstrap, measured-scale floor, McNemar by p-value. Positive control (own output)
// PASSES; generic output NULLs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrongTargetControl, sameRegisterForeigners, subjectMargin, controlVerdict, significantAt,
} from './wrong-target-control.mjs';
import { mcnemar } from '../../memory/bench-metrics.js';
import { generatePersonaText } from './synthetic-personas.js';
import { fullStyleVector } from './stylometry.js';

function persona(id, text) { return { id, fingerprint: fullStyleVector(text) }; }
// formal personas (archetype 0) — same register, different authors. n=10 so the sign test
// can clear perTestAlpha=0.01 when every subject is positive (the positive control).
const FORMAL = Array.from({ length: 10 }, (_, i) => persona(`f${i}`, generatePersonaText(0, 17 * (i + 1), 16)));
// Unambiguously different register: emoji + contractions + exclamations + casual (several
// axes differ from formal, clearing the 0.15 band).
const CASUAL = persona('c0', "omg yes!! 🚀 lol i love it, it's so cool 😄 you're gonna wanna try it, honestly it's the best, i can't even, no cap!! 💯");

function fakeHarness(arms, personas, vectorFor) {
  const results = {};
  for (const p of personas) {
    results[p.id] = {};
    for (const arm of arms) results[p.id][arm] = { vector: vectorFor(p, arm) };
  }
  return { arms, personaIds: personas.map((p) => p.id), results };
}

test('foreign pool is restricted to the SAME register band (δ=0.15)', () => {
  const pool = [...FORMAL, CASUAL];
  const f = sameRegisterForeigners(FORMAL[0], pool, 0.15).map((q) => q.id);
  assert.ok(f.includes('f1'), 'a same-register formal peer is in the pool');
  assert.ok(!f.includes('c0'), 'the different-register casual author is excluded');
});

test('undecidable subjects (no same-register foreigner) are EXCLUDED, no diverse fallback', () => {
  const personas = [FORMAL[0], CASUAL]; // each other is a different register
  const h = fakeHarness(['baseline'], personas, (p) => p.fingerprint);
  const r = wrongTargetControl(h, personas);
  assert.equal(r.nDecidable, 0);
  assert.equal(r.nUndecidable, 2);
  assert.deepEqual(r.decidableIds, []);
});

test('margin uses NEAREST foreigner, not a centroid', () => {
  const p = FORMAL[0];
  const foreigners = [FORMAL[1], FORMAL[2], FORMAL[3]];
  // output IS a foreigner (f1) → nearest distance is 0 → margin must be negative
  const sm = subjectMargin(FORMAL[1].fingerprint, p, foreigners);
  assert.equal(sm.dNearestForeign, 0, 'nearest foreigner distance is 0 (output == f1)');
  assert.ok(sm.margin < 0, 'matching a stranger yields a NEGATIVE margin (centroid would hide this)');
  // output IS own → margin positive
  const smOwn = subjectMargin(p.fingerprint, p, foreigners);
  assert.ok(smOwn.margin > 0, 'matching OWN yields a positive margin');
});

test('POSITIVE control: own-output arm PASSES (margins positive, CI-lower>0, floor cleared)', () => {
  const h = fakeHarness(['baseline'], FORMAL, (p) => p.fingerprint); // output == own
  const r = wrongTargetControl(h, FORMAL);
  assert.equal(r.nDecidable, 10);
  assert.equal(r.perArm.baseline.margins.length, 10, 'bootstrap operates on SUBJECTS (=10), not probes');
  assert.equal(r.perArm.baseline.verdict.passes, true);
  assert.ok(r.perArm.baseline.ciLower > 0);
  assert.ok(r.perArm.baseline.pctPositive > 0.5 && r.perArm.baseline.signPValue < 0.01);
});

test('NEGATIVE control: generic constant output does NOT pass the control (≈NULL)', () => {
  const constVec = fullStyleVector(generatePersonaText(1, 999, 16)); // casual generic, matches no formal voice
  const h = fakeHarness(['derived'], FORMAL, () => constVec);
  const r = wrongTargetControl(h, FORMAL);
  assert.equal(r.perArm.derived.verdict.passes, false, 'generic output is not closer to OWN than to nearest stranger');
});

const FULL_PASS = {
  ciLower: 0.02, meanMargin: 0.05, sd: 0.05, pctPositive: 0.8, signPValue: 0.001,
};
const FULL_CFG = { minMeanMargin: 0.01, minDz: 0.5, perTestAlpha: 0.01 };

test('controlVerdict PASSES only when ALL legs hold (not vacuously false)', () => {
  assert.equal(controlVerdict(FULL_PASS, FULL_CFG).passes, true);
});

test('measured-scale floor BITES: significant-but-trivial ⇒ NULL', () => {
  assert.equal(controlVerdict({ ...FULL_PASS, meanMargin: 0.004 }, FULL_CFG).passes, false);
  assert.equal(controlVerdict({ ...FULL_PASS, ciLower: -0.01 }, FULL_CFG).passes, false);
});

test('NEW LEG — effect size dz: a few subjects carrying it (high sd) ⇒ NULL', () => {
  // mean clears floor and CI>0, but sd is huge ⇒ dz<0.5 ⇒ NULL (heavy-tail false-PASS killed)
  const g = controlVerdict({ ...FULL_PASS, sd: 0.5 }, FULL_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.reasons.some((r) => /dz/.test(r)));
});

test('NEW LEG — majority: <=50% of subjects positive ⇒ NULL', () => {
  const g = controlVerdict({ ...FULL_PASS, pctPositive: 0.5 }, FULL_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.reasons.some((r) => /pctPositive/.test(r)));
});

test('NEW LEG — sign-test: p >= perTestAlpha ⇒ NULL (even with mean+CI+majority)', () => {
  const g = controlVerdict({ ...FULL_PASS, signPValue: 0.03 }, FULL_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.reasons.some((r) => /sign-test/.test(r)));
});

test('McNemar reads p-value with perTestAlpha — ignores the helper hardcoded .significant(0.05)', () => {
  const baseline = new Array(20).fill(0);
  const arm = new Array(20).fill(0).map((_, i) => (i < 7 ? 1 : 0)); // 7 flips, 0 losses
  const m = mcnemar(baseline, arm);
  assert.ok(m.pValue > 0.01 && m.pValue < 0.05, `p=${m.pValue.toFixed(3)} lands between the alphas`);
  assert.equal(significantAt(m.pValue, 0.01), false, 'not significant at the strict Bonferroni alpha');
  assert.equal(significantAt(m.pValue, 0.05), true, 'would be "significant" at the lax 0.05 the helper hardcodes');
});

test('registerGap diagnostic is emitted for decidable arms', () => {
  const h = fakeHarness(['baseline'], FORMAL, (p) => p.fingerprint);
  const r = wrongTargetControl(h, FORMAL);
  assert.ok(Number.isFinite(r.perArm.baseline.registerGap));
  assert.ok(r.perArm.baseline.registerGap <= 0.15, 'nearest foreigner really is same-register');
});
