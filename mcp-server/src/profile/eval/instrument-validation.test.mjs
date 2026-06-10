// Gate B v2 — Task T2: instrument-validation gate. Tests the GATE LOGIC and the
// anti-bias selection rule on small fixtures. (The real >=150-pair / CI>=0.75 thresholds
// are exercised at run time on the Reddit corpus, not here — here we prove the gate
// REFUSES to pass when underpowered or below threshold, and never self-loosens.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInstrument, __test } from './instrument-validation.mjs';

const {
  aucFromDistances, equalErrorRate, enumeratePairs, buildSamples, gateDecision,
} = __test;

const GATE_CFG = {
  aucFloor: 0.80, sameRegisterCILower: 0.75, minSameRegister: 150,
};
const PASSING = {
  auc: 0.88, sameRegisterAucCILower: 0.78, nSameRegister: 200, withinMean: 0.3, betweenMean: 0.5,
};

// Three stylistically distinct authors, 4 docs each.
const FORMAL = [
  'The proposal, however, must be examined with care, for the implications of the decision extend well beyond the present matter.',
  'It is therefore evident that the committee, which has reviewed the whole of the evidence, will arrive at the conclusion in due course.',
  'The argument rests upon the assumption that the conditions of the experiment were, in the main, properly controlled and recorded.',
  'One must consider, moreover, the degree to which the results of the study may be generalized beyond the original population.',
];
const CASUAL = [
  "yeah i just think you're gonna like this one, it's kinda fun and you don't really have to do much honestly.",
  'ok so i tried it and it is like, totally fine? you just click the thing and it kinda works, no big deal.',
  "i dunno, you could do it that way i guess, but honestly i'd just keep it simple, it is way easier that way.",
  "lol yeah that's basically what i did too, you just gotta be patient and it'll sort itself out eventually.",
];
const TERSE_TECH = [
  'Run the migration. Check the logs. If the index is missing, rebuild it and retry the job.',
  'Patch the handler. Add a guard for the null case. Ship it behind the flag, then enable ten percent.',
  'Cache is stale. Bump the version key. Invalidate on write. Measure the hit rate after deploy.',
  'Lock contention on the queue. Shard by tenant. Add backpressure. Alert if depth exceeds the threshold.',
];
const CORPUS3 = [
  { id: 'formal', docs: FORMAL },
  { id: 'casual', docs: CASUAL },
  { id: 'tech', docs: TERSE_TECH },
];

test('AUC helper: perfect separation = 1, reversed = 0, identical = 0.5', () => {
  assert.equal(aucFromDistances([0.1, 0.2], [0.8, 0.9]), 1);
  assert.equal(aucFromDistances([0.8, 0.9], [0.1, 0.2]), 0);
  assert.equal(aucFromDistances([0.5, 0.5], [0.5, 0.5]), 0.5);
});

test('EER is 0 for perfectly separated distance distributions', () => {
  assert.equal(equalErrorRate([0.1, 0.15, 0.2], [0.7, 0.8, 0.9]), 0);
});

test('betweenMean > withinMean on a 3-author x 4-doc fixture (metric discriminates)', () => {
  const r = validateInstrument(CORPUS3);
  assert.ok(r.betweenMean > r.withinMean, `between ${r.betweenMean.toFixed(3)} > within ${r.withinMean.toFixed(3)}`);
  assert.ok(r.auc > 0.5, `auc ${r.auc.toFixed(3)} above chance`);
});

test('same-register slice returns nSameRegister>0 + finite AUC + bootstrap CI', () => {
  // Two DIFFERENT formal authors (same register band, different func-word fingerprint).
  const P = [
    'The proposal, however, must be examined with the greatest care, for the consequences extend beyond the matter at hand.',
    'It is therefore the case that the observer, having weighed the evidence, will tend toward the cautious conclusion.',
  ];
  const Q = [
    'The findings are, consequently, of considerable importance; moreover, they bear directly upon the questions raised at the outset.',
    'Whereas the earlier account emphasized the structural causes, the present analysis attends, hence, to the procedural ones.',
  ];
  const corpus2 = [{ id: 'P', docs: P }, { id: 'Q', docs: Q }];
  const r = validateInstrument(corpus2, { validation: { bootstrapB: 300, minSameRegister: 1 } });
  assert.ok(r.nSameRegister > 0, `nSameRegister ${r.nSameRegister} > 0`);
  assert.ok(Number.isFinite(r.sameRegisterAuc), 'sameRegisterAuc finite');
  assert.ok(Number.isFinite(r.sameRegisterAucCILower), 'CI lower finite');
  assert.ok(r.bootstrapReps > 0, 'bootstrap produced replicates');
});

test('GATE refuses to pass when nSameRegister < 150 (underpowered), reported honestly', () => {
  const r = validateInstrument(CORPUS3); // tiny fixture, far below 150
  assert.equal(r.passes, false);
  assert.ok(r.failedChecks.some((c) => /nSameRegister/.test(c)), `failedChecks names the gap: ${r.failedChecks}`);
});

test('gateDecision PASSES only when ALL thresholds are met (not vacuously false)', () => {
  assert.equal(gateDecision(PASSING, GATE_CFG).passes, true);
});

test('gateDecision FAILS on diverse AUC below floor — threshold not loosened', () => {
  const g = gateDecision({ ...PASSING, auc: 0.79 }, GATE_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.failedChecks.some((c) => /diverse AUC/.test(c)), g.failedChecks.join('; '));
});

test('gateDecision FAILS on same-register CI-lower below floor — the PRIMARY gate', () => {
  const g = gateDecision({ ...PASSING, sameRegisterAucCILower: 0.74 }, GATE_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.failedChecks.some((c) => /same-register AUC CI-lower/.test(c)), g.failedChecks.join('; '));
});

test('gateDecision FAILS on NaN same-register CI-lower (no same-register pairs found)', () => {
  const g = gateDecision({ ...PASSING, sameRegisterAucCILower: NaN }, GATE_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.failedChecks.some((c) => /same-register AUC CI-lower/.test(c)));
});

test('gateDecision FAILS on underpowered nSameRegister (<150), never auto-loosened', () => {
  const g = gateDecision({ ...PASSING, nSameRegister: 149 }, GATE_CFG);
  assert.equal(g.passes, false);
  assert.ok(g.failedChecks.some((c) => /nSameRegister/.test(c)));
});

test('SELECTION-BIAS GUARD: same-register membership tracks REGISTER only, not authorship distance', () => {
  // X and Y: near-identical register (both terse imperative), different authorship content.
  const xText = 'Run it. Check it. Ship it.';
  const yText = 'Stop it. Fix it. Test it.';
  // Z: very different register (long formal).
  const zText = 'The committee, however, having deliberated at considerable length upon the whole of the available evidence, ultimately resolved to defer the decision until a later and more convenient occasion.';
  const samples = buildSamples([{ id: 'X', docs: [xText] }, { id: 'Y', docs: [yText] }, { id: 'Z', docs: [zText] }]);
  const { diffSameRegister, diff } = enumeratePairs(samples, 0.15);
  // X-Y (same register) is included; pairs involving Z (different register) are not all included.
  assert.ok(diffSameRegister.length >= 1, 'at least the same-register X-Y pair is included');
  assert.ok(diffSameRegister.length < diff.length, 'the register-distant pairs (with Z) are excluded');
});
