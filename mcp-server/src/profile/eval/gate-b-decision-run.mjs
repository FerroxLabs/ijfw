// gate-b-decision-run.mjs — Gate B v2, Task T7. The Phase-2 decision runner and the
// honest decision gate the whole program exists to protect.
//
// Flow: validate instrument → (refuse to spend if it fails) → DESCRIPTIVE pilot →
// FRESH-seed confirmatory → decision gate. The verdict is computed from the CONFIRMATORY
// arm only; the pilot is descriptive and never feeds the statistic.
//
// Decision rules (hardened spec §6.3 + audit):
//   instrument invalid           → NULL  (same-register discrimination unproven; NO spend; ship portability)
//   baseline / register-echo PASS→ VOID  (a no-signal arm beat the control ⇒ rig contaminated)
//   real authors didn't carry it → NULL  (synthetic can NEVER license the claim)
//   derived arm PASSES           → PASS  (descriptor-only brief works — the product win)
//   only few-shot-oracle PASSES  → PASS_ORACLE → Phase 3 (descriptors plateau; exemplar lever)
//   even few-shot-oracle NULLS   → CUT   (the real ceiling can't capture voice ⇒ cut the claim)
//
// CUT is licensed ONLY by a few-shot-oracle NULL. A renderable-ceiling (derived) NULL alone
// never CUTs — it routes to Phase 3.

import { deriveMinMeanMargin } from './prereg.mjs';

export const VERDICTS = ['PASS', 'PASS_ORACLE', 'CUT', 'NULL', 'VOID'];

// realArmsCarried producer: the verdict may be licensed ONLY if enough REAL (headline-
// eligible, non-synthetic) personas were decidable. Synthetic personas can never license
// the claim. Derived from the persona stamps — never an injected literal in production.
export function deriveRealArmsCarried(personas, decidableIds, minSubjects) {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const realDecidable = decidableIds.filter((id) => {
    const p = byId.get(id);
    return p && p.headlineEligible === true && p.synthetic !== true;
  });
  return realDecidable.length >= minSubjects;
}

// Pure decision over the confirmatory booleans. No I/O, fully unit-tested.
export function decideGateB(input) {
  const {
    instrumentValid, baselinePasses, registerEchoPasses, derivedPasses, oraclePasses, realArmsCarried,
  } = input;

  if (!instrumentValid) {
    return {
      verdict: 'NULL', ship: 'portability',
      reason: 'instrument invalid: same-register discrimination not established; no cloud spend',
    };
  }
  // A safety rail must NEVER read as silent-false. If a producer didn't compute these,
  // refuse loudly rather than let a missing VOID/NULL rail wave a contaminated run through.
  if (typeof registerEchoPasses !== 'boolean' || typeof realArmsCarried !== 'boolean') {
    throw new Error('decideGateB: registerEchoPasses and realArmsCarried must be computed booleans — a dead safety rail must never read as silent-false');
  }
  if (baselinePasses || registerEchoPasses) {
    return {
      verdict: 'VOID',
      reason: 'a no-signal arm (baseline or register-only echo) passed the control — rig contaminated; re-examine before any claim',
    };
  }
  if (!realArmsCarried) {
    return {
      verdict: 'NULL', ship: 'portability',
      reason: 'real authors did not carry the verdict (synthetic personas cannot license "writes like you")',
    };
  }
  if (derivedPasses) {
    return {
      verdict: 'PASS', claim: 'writes in your voice (descriptor-only brief)',
      reason: 'derived style-axis-band brief passes the wrong-target control on real authors',
    };
  }
  if (oraclePasses) {
    return {
      verdict: 'PASS_ORACLE', next: 'phase-3-exemplar-lever',
      reason: 'few-shot-oracle passes but descriptors plateau; voice-match is achievable, derivation is the gap',
    };
  }
  return {
    verdict: 'CUT', ship: 'portability',
    reason: 'even the real-ceiling few-shot-oracle fails the wrong-target control — voice-match is not achievable; cut the claim honestly',
  };
}

// Reduce a confirmatory control result (T5 output) + per-arm Bonferroni alpha into the
// booleans decideGateB consumes. An arm "passes" iff its control verdict passes AND it
// beats baseline at its Bonferroni-adjusted alpha.
export function confirmatoryBooleans(control, preReg, { realArmsCarried }) {
  const pa = control.perArm;
  // The register-echo VOID rail must have been MEASURED. undefined ⇒ no register-echo arm
  // was run ⇒ refuse, rather than silently treating it as false (the rail's dead-wiring bug).
  if (control.registerEchoPasses === undefined) {
    throw new Error('confirmatoryBooleans: control.registerEchoPasses is undefined — the register-echo arm was not run; the VOID rail is dead');
  }
  if (typeof realArmsCarried !== 'boolean') {
    throw new Error('confirmatoryBooleans: realArmsCarried must be a computed boolean (use deriveRealArmsCarried)');
  }
  const armPasses = (arm) => {
    const a = pa[arm];
    if (!a) return false;
    // beatsBaseline is already directioned (significant AND arm flips more than baseline).
    const beats = a.vsBaseline ? a.vsBaseline.beatsBaseline === true : true;
    return Boolean(a.verdict && a.verdict.passes && beats);
  };
  return {
    instrumentValid: true,
    baselinePasses: Boolean(pa.baseline && pa.baseline.verdict && pa.baseline.verdict.passes),
    registerEchoPasses: Boolean(control.registerEchoPasses),
    derivedPasses: armPasses('derived'),
    oraclePasses: armPasses('fewShotOracle'),
    realArmsCarried,
  };
}

// runGateBDecision(deps, preRegInput) — orchestrator. deps is injected so the runner is
// testable offline; the real deps wire validateInstrument + runHarness + wrongTargetControl
// + the cloud transport and reuse the existing allowedSys/allowedPr + budget guard.
//
// deps = {
//   buildPreReg(input)            -> preReg
//   validate(preReg)              -> { passes, ... }     (T2; no spend)
//   guard({phase})                -> asserts budget + allowedSys/allowedPr BEFORE every spend
//   measure({seed, phase, preReg})-> confirmatory shape  (runs harness+control for that seed)
// }
export async function runGateBDecision(deps, preRegInput = {}) {
  const preReg = deps.buildPreReg(preRegInput);
  const validation = await deps.validate(preReg);

  if (!validation.passes) {
    // REFUSE TO SPEND: no guard, no measure calls.
    return {
      runId: preReg.runId, preRegHash: preReg.hash, spent: false, validation,
      verdict: decideGateB({ instrumentValid: false }),
    };
  }

  // Derive the measured-scale floor from the validated instrument's own separation and
  // freeze it for this run (throws if the instrument has no valid scale). This REPLACES
  // the blind absolute constant — the prior attempt's failure class.
  const minMeanMargin = deriveMinMeanMargin(validation, preReg.floorK);

  const pilotSeed = preReg.seeds.personaSeed >>> 0;
  const confirmSeed = (preReg.seeds.personaSeed ^ 0x5bd1e995) >>> 0; // FRESH, distinct draw

  await deps.guard({ phase: 'pilot' });
  const pilot = await deps.measure({
    seed: pilotSeed, phase: 'pilot', preReg, minMeanMargin,
  }); // DESCRIPTIVE only

  await deps.guard({ phase: 'confirmatory' });
  const confirmatory = await deps.measure({
    seed: confirmSeed, phase: 'confirmatory', preReg, minMeanMargin,
  });

  const verdict = decideGateB({
    instrumentValid: true,
    baselinePasses: confirmatory.baselinePasses,
    registerEchoPasses: confirmatory.registerEchoPasses,
    derivedPasses: confirmatory.derivedPasses,
    oraclePasses: confirmatory.oraclePasses,
    realArmsCarried: confirmatory.realArmsCarried,
  });

  return {
    runId: preReg.runId,
    preRegHash: preReg.hash,
    spent: true,
    validation,
    seeds: { pilotSeed, confirmSeed },
    pilot, // descriptive — NOT an input to `verdict`
    confirmatory,
    verdict,
  };
}
