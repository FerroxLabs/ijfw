// Gate B v2 — Task T6: pre-registration rig. Tamper-evidence (any frozen field changes the
// hash), freeze-once (no overwrite), seed-pure derivation, per-arm Bonferroni alpha, and a
// power simulation that responds to the true effect size.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreReg, hashPreReg, bonferroniAlpha, deriveSeeds, assertFrozen, simulatePower, deriveMinMeanMargin,
} from './prereg.mjs';

test('deriveMinMeanMargin = floorK*(between-within); throws on invalid instrument scale', () => {
  assert.ok(Math.abs(deriveMinMeanMargin({ betweenMean: 0.5, withinMean: 0.3 }, 0.25) - 0.05) < 1e-12);
  assert.throws(() => deriveMinMeanMargin({ betweenMean: 0.3, withinMean: 0.5 }, 0.25), /separation/);
  assert.throws(() => deriveMinMeanMargin({ betweenMean: 0.5, withinMean: 0.3 }, 0), /floorK/);
});

test('hashPreReg is stable and key-order independent', () => {
  const a = buildPreReg({ seed: 7 });
  const b = buildPreReg({ seed: 7 });
  assert.equal(a.hash, b.hash);
  assert.equal(a.runId, b.runId);
  // key-order independence: same fields, different insertion order ⇒ same hash
  const o1 = { ...a };
  const o2 = {};
  for (const k of Object.keys(o1).reverse()) o2[k] = o1[k];
  assert.equal(hashPreReg(o1), hashPreReg(o2));
});

test('TAMPER-EVIDENCE: changing any frozen field changes the hash', () => {
  const base = buildPreReg({});
  assert.notEqual(base.hash, buildPreReg({ leakFloor: 0.05 }).hash, 'leakFloor');
  assert.notEqual(base.hash, buildPreReg({ foreignAggregation: 'mean' }).hash, 'foreignAggregation');
  assert.notEqual(base.hash, buildPreReg({ familyAlpha: 0.02 }).hash, 'familyAlpha (⇒ perTestAlpha)');
  assert.notEqual(base.hash, buildPreReg({ registerDelta: 0.2 }).hash, 'registerDelta');
  assert.notEqual(base.hash, buildPreReg({ floorK: 0.4 }).hash, 'floorK (measured-scale floor multiplier)');
  // perTestAlpha itself is hashed: a manual override is caught
  assert.notEqual(hashPreReg(base), hashPreReg({ ...base, perTestAlpha: { derived: 0.001, fewShotOracle: 0.009 } }));
});

test('FREEZE-ONCE: assertFrozen refuses to overwrite an existing runId', () => {
  const registry = new Map();
  const pr = buildPreReg({ seed: 3 });
  assert.equal(assertFrozen(registry, pr), true);
  assert.throws(() => assertFrozen(registry, pr), /already frozen/);
});

test('seeds are a pure function of preReg.seed', () => {
  assert.deepEqual(deriveSeeds(5), deriveSeeds(5));
  assert.notDeepEqual(deriveSeeds(5), deriveSeeds(6));
  const pr = buildPreReg({ seed: 5 });
  assert.deepEqual(pr.seeds, deriveSeeds(5));
});

test('per-arm Bonferroni alpha (familyAlpha/k), not one reused alpha', () => {
  const a = bonferroniAlpha(0.01, ['derived', 'fewShotOracle']);
  assert.equal(a.derived, 0.005);
  assert.equal(a.fewShotOracle, 0.005);
  const pr = buildPreReg({});
  assert.equal(Object.keys(pr.perTestAlpha).length, 2, 'one alpha entry per verdict arm');
  assert.ok(pr.perTestAlpha.derived < pr.familyAlpha, 'per-test alpha is stricter than family alpha');
});

test('buildPreReg returns a frozen object with a runId', () => {
  const pr = buildPreReg({});
  assert.ok(Object.isFrozen(pr));
  assert.match(pr.runId, /^gateb-[0-9a-f]{12}$/);
});

test('simulatePower is in [0,1] and increases with the true effect', () => {
  const pr = buildPreReg({ minSubjects: 60 });
  const opts = { nSubjects: 60, sims: 120, bootIters: 200, spread: 0.05 };
  const lowEffect = simulatePower(pr, { ...opts, trueMeanMargin: 0.0 });
  const highEffect = simulatePower(pr, { ...opts, trueMeanMargin: 0.10 });
  for (const p of [lowEffect, highEffect]) assert.ok(p >= 0 && p <= 1);
  assert.ok(highEffect > lowEffect, `power rises with effect: ${highEffect} > ${lowEffect}`);
  // deterministic
  assert.equal(simulatePower(pr, { ...opts, trueMeanMargin: 0.10 }), highEffect);
});
