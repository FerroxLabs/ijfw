// Gate B v2 — Task T7: decision runner + gate. The honest verdict logic and the
// refuse-to-spend / fresh-seed / pilot-descriptive / guard-before-spend orchestration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideGateB, confirmatoryBooleans, runGateBDecision, deriveRealArmsCarried,
} from './gate-b-decision-run.mjs';
import { buildPreReg } from './prereg.mjs';

const VALID = { instrumentValid: true, baselinePasses: false, registerEchoPasses: false, realArmsCarried: true };

test('decideGateB: instrument invalid ⇒ NULL, no spend', () => {
  assert.equal(decideGateB({ instrumentValid: false }).verdict, 'NULL');
});

test('decideGateB: baseline or register-echo PASS ⇒ VOID (rig contaminated)', () => {
  assert.equal(decideGateB({ ...VALID, baselinePasses: true }).verdict, 'VOID');
  assert.equal(decideGateB({ ...VALID, registerEchoPasses: true }).verdict, 'VOID');
});

test('decideGateB: real authors did not carry it ⇒ NULL (synthetic cannot license)', () => {
  assert.equal(decideGateB({ ...VALID, realArmsCarried: false, derivedPasses: true, oraclePasses: true }).verdict, 'NULL');
});

test('decideGateB: derived passes ⇒ PASS (product win)', () => {
  assert.equal(decideGateB({ ...VALID, derivedPasses: true }).verdict, 'PASS');
});

test('decideGateB: only oracle passes ⇒ PASS_ORACLE → Phase 3 (NOT a cut)', () => {
  const v = decideGateB({ ...VALID, derivedPasses: false, oraclePasses: true });
  assert.equal(v.verdict, 'PASS_ORACLE');
  assert.equal(v.next, 'phase-3-exemplar-lever');
});

test('decideGateB: CUT licensed ONLY by few-shot-oracle NULL', () => {
  // oracle passes → never CUT
  assert.notEqual(decideGateB({ ...VALID, derivedPasses: false, oraclePasses: true }).verdict, 'CUT');
  // oracle nulls (and derived nulls) → CUT
  assert.equal(decideGateB({ ...VALID, derivedPasses: false, oraclePasses: false }).verdict, 'CUT');
});

test('confirmatoryBooleans: Bonferroni alpha BITES (arm must beat baseline at per-test alpha)', () => {
  const preReg = buildPreReg({}); // perTestAlpha derived=fewShotOracle=0.005
  const control = {
    registerEchoPasses: false,
    perArm: {
      baseline: { verdict: { passes: false } },
      derived: { verdict: { passes: true }, vsBaseline: { beatsBaseline: true } }, // directioned + significant
      fewShotOracle: { verdict: { passes: true }, vsBaseline: { beatsBaseline: false } }, // fails direction/alpha
    },
  };
  const b = confirmatoryBooleans(control, preReg, { realArmsCarried: true });
  assert.equal(b.derivedPasses, true);
  assert.equal(b.oraclePasses, false, 'beatsBaseline=false ⇒ does not pass');
});

test('confirmatoryBooleans THROWS if the register-echo VOID rail was not measured', () => {
  const preReg = buildPreReg({});
  const control = { perArm: { baseline: { verdict: { passes: false } } } }; // no registerEchoPasses
  assert.throws(() => confirmatoryBooleans(control, preReg, { realArmsCarried: true }), /register-echo/);
});

test('decideGateB THROWS if a safety rail is undefined (never silent-false)', () => {
  assert.throws(
    () => decideGateB({ instrumentValid: true, baselinePasses: false, derivedPasses: true }),
    /safety rail/,
  );
});

test('deriveRealArmsCarried: synthetic personas cannot license; needs enough real decidable', () => {
  const real = [{ id: 'r1', headlineEligible: true, synthetic: false }, { id: 'r2', headlineEligible: true, synthetic: false }];
  const synth = [{ id: 's1', headlineEligible: false, synthetic: true }, { id: 's2', headlineEligible: false, synthetic: true }];
  assert.equal(deriveRealArmsCarried(real, ['r1', 'r2'], 2), true);
  assert.equal(deriveRealArmsCarried(synth, ['s1', 's2'], 1), false, 'synthetic forced false');
  assert.equal(deriveRealArmsCarried(real, ['r1'], 2), false, 'not enough real decidable');
});

// ---- orchestrator with injected fakes ----
function makeDeps(overrides = {}) {
  const calls = { guard: 0, measure: 0, phases: [] };
  const defaultMeasure = {
    baselinePasses: false, registerEchoPasses: false, derivedPasses: true, oraclePasses: true, realArmsCarried: true,
  };
  return {
    calls,
    buildPreReg: (i) => buildPreReg(i),
    validate: async () => overrides.validation ?? { passes: true, betweenMean: 0.5, withinMean: 0.3 },
    guard: async () => { calls.guard += 1; },
    measure: async ({ seed, phase }) => {
      calls.measure += 1; calls.phases.push({ phase, seed });
      const m = overrides.measure ? overrides.measure(phase) : defaultMeasure;
      return { seed, phase, ...m };
    },
  };
}

test('REFUSES TO SPEND when validation fails (no guard, no measure)', async () => {
  const deps = makeDeps({ validation: { passes: false } });
  const r = await runGateBDecision(deps, {});
  assert.equal(r.spent, false);
  assert.equal(r.verdict.verdict, 'NULL');
  assert.equal(deps.calls.guard, 0);
  assert.equal(deps.calls.measure, 0);
});

test('guard is asserted BEFORE every spend phase (pilot + confirmatory)', async () => {
  const deps = makeDeps();
  await runGateBDecision(deps, {});
  assert.equal(deps.calls.guard, 2);
  assert.equal(deps.calls.measure, 2);
});

test('confirmatory uses a FRESH seed distinct from the pilot', async () => {
  const deps = makeDeps();
  const r = await runGateBDecision(deps, {});
  assert.notEqual(r.seeds.pilotSeed, r.seeds.confirmSeed);
  const phases = Object.fromEntries(deps.calls.phases.map((p) => [p.phase, p.seed]));
  assert.notEqual(phases.pilot, phases.confirmatory);
});

test('pilot is DESCRIPTIVE: the verdict comes from confirmatory, not pilot', async () => {
  // pilot says everything passes; confirmatory says everything nulls → verdict must be CUT
  const deps = makeDeps({
    measure: (phase) => (phase === 'pilot'
      ? { baselinePasses: false, registerEchoPasses: false, derivedPasses: true, oraclePasses: true, realArmsCarried: true }
      : { baselinePasses: false, registerEchoPasses: false, derivedPasses: false, oraclePasses: false, realArmsCarried: true }),
  });
  const r = await runGateBDecision(deps, {});
  assert.equal(r.verdict.verdict, 'CUT', 'confirmatory NULL drives the verdict, pilot PASS ignored');
});

test('real-arm NULL ⇒ mission NULL regardless of (synthetic) pilot optimism', async () => {
  const deps = makeDeps({
    measure: () => ({
      baselinePasses: false, registerEchoPasses: false, derivedPasses: true, oraclePasses: true, realArmsCarried: false,
    }),
  });
  const r = await runGateBDecision(deps, {});
  assert.equal(r.verdict.verdict, 'NULL');
});
