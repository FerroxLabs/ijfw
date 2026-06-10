// prereg.mjs — Gate B v2, Task T6. Pre-registration rig. Freezes the analysis plan BEFORE
// the confirmatory run so nothing can be tuned to pass after seeing results. The hash
// covers EVERY decision-bearing field (including leakFloor, perTestAlpha, foreignAggregation)
// so any post-hoc edit is tamper-evident. Split/persona/bootstrap seeds are a pure function
// of preReg.seed. Per-arm alpha is Bonferroni-split across the verdict-bearing arms.

import crypto from 'node:crypto';
import { bootstrapCI } from '../../memory/bench-metrics.js';

// Every field here is frozen and hashed. Editing any of them changes the runId hash.
export const PREREG_DEFAULTS = Object.freeze({
  primaryEndpoint: 'own-vs-nearest-same-register-foreigner-margin',
  corpus: 'reddit-single-subreddit',
  registerDelta: 0.15,
  familyAlpha: 0.01,        // family-wise; Bonferroni-split across verdictArms
  alpha: 0.02,              // bootstrap two-sided @0.02 ⇒ one-sided 99% lower bound
  floorK: 0.25,             // measured-scale floor MULTIPLIER: minMeanMargin = floorK*(betweenMean-withinMean)
  leakFloor: 0.02,
  foreignAggregation: 'nearest', // NEVER 'mean'/'centroid'
  nExemplars: 2,
  verdictArms: ['derived', 'fewShotOracle'],
  minSubjects: 60,
  minDetectableEffect: 0.02,
  seed: 1,
});

// perTestAlpha is derived but ALSO hashed, so a manual post-hoc override is tamper-evident.
const HASHED_FIELDS = [...Object.keys(PREREG_DEFAULTS), 'perTestAlpha'];

// Stable stringify: object keys sorted (key-order independent), array order preserved.
function stableStringify(o) {
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  if (o && typeof o === 'object') {
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(o);
}

export function hashPreReg(preReg) {
  const picked = {};
  for (const f of HASHED_FIELDS) picked[f] = preReg[f];
  return crypto.createHash('sha256').update(stableStringify(picked)).digest('hex');
}

// Bonferroni per-arm alpha — NOT one reused alpha. Returns { arm: familyAlpha/k }.
export function bonferroniAlpha(familyAlpha, verdictArms) {
  const k = verdictArms.length || 1;
  const per = familyAlpha / k;
  const out = {};
  for (const a of verdictArms) out[a] = per;
  return out;
}

// Measured-scale floor: the minimum mean margin that counts as a real effect, expressed
// in the instrument's OWN units = floorK * (betweenMean − withinMean) from validateInstrument.
// This REPLACES the blind absolute constant (the prior attempt's failure class). Frozen
// before any cloud spend (floorK is hashed; the derived value is recorded in the run).
export function deriveMinMeanMargin(validation, floorK) {
  const sep = validation.betweenMean - validation.withinMean;
  if (!(Number.isFinite(sep) && sep > 0)) {
    throw new Error(`cannot derive measured-scale floor: invalid instrument separation (between ${validation.betweenMean}, within ${validation.withinMean})`);
  }
  if (!(Number.isFinite(floorK) && floorK > 0)) throw new Error(`invalid floorK ${floorK}`);
  return floorK * sep;
}

// Seeds are a pure function of preReg.seed — same seed ⇒ same splits everywhere.
export function deriveSeeds(seed) {
  const h = (tag) => parseInt(crypto.createHash('sha256').update(`${seed}:${tag}`).digest('hex').slice(0, 8), 16) >>> 0;
  return { splitSeed: h('split'), personaSeed: h('persona'), bootstrapSeed: h('bootstrap') };
}

// buildPreReg(input) → frozen config + derived alpha/seeds + runId hash.
export function buildPreReg(input = {}) {
  const cfg = { ...PREREG_DEFAULTS, ...input };
  const perTestAlpha = bonferroniAlpha(cfg.familyAlpha, cfg.verdictArms);
  const seeds = deriveSeeds(cfg.seed);
  const base = { ...cfg, perTestAlpha, seeds };
  const hash = hashPreReg(base);
  return Object.freeze({ ...base, hash, runId: input.runId || `gateb-${hash.slice(0, 12)}` });
}

// assertFrozen(registry, preReg): a runId can be registered ONCE. Re-registering (a re-run
// after an edit) throws — the rig refuses to silently overwrite a frozen plan.
export function assertFrozen(registry, preReg) {
  if (registry.has(preReg.runId)) {
    throw new Error(`runId ${preReg.runId} already frozen (hash ${registry.get(preReg.runId).slice(0, 12)}); start a new run`);
  }
  registry.set(preReg.runId, preReg.hash);
  return true;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// simulatePower: Monte Carlo power under a RIGHT-SKEWED margin distribution (margins are
// not normal — a few subjects carry most of the signal). For each sim, draw nSubjects
// margins (mean = trueMeanMargin, right-skewed via exponential), then apply the EXACT
// decision rule (bootstrap one-sided lower bound > 0 AND mean >= minMeanMargin). Power =
// fraction of sims that PASS. Deterministic by seed.
export function simulatePower(preReg, {
  trueMeanMargin, spread = 0.05, nSubjects, sims = 300, bootIters = 300, minMeanMargin = 0,
} = {}) {
  const n = nSubjects || preReg.minSubjects;
  const rng = mulberry32(preReg.seeds.bootstrapSeed ^ 0x9e3779b9);
  let pass = 0;
  for (let s = 0; s < sims; s += 1) {
    const margins = Array.from({ length: n });
    for (let i = 0; i < n; i += 1) {
      // exponential(mean=spread) shifted so the overall mean is trueMeanMargin
      const exp = -Math.log(1 - rng()) * spread;
      margins[i] = trueMeanMargin - spread + exp;
    }
    const mean = margins.reduce((a, b) => a + b, 0) / n;
    // measured-scale floor is run-derived (deriveMinMeanMargin); the planner passes a
    // hypothesized value here. Defaults to 0 so the CI leg dominates the planning estimate.
    const ci = bootstrapCI(margins, { iters: bootIters, alpha: preReg.alpha, seed: (s * 2654435761) >>> 0 });
    if (ci.lo > 0 && mean >= minMeanMargin) pass += 1;
  }
  return pass / sims;
}

export const __test = { stableStringify, HASHED_FIELDS };
