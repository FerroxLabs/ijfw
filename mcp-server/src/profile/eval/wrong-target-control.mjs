// wrong-target-control.mjs — Gate B v2, Task T5. THE discriminator.
//
// For each subject P and arm, the margin is:
//     m_P = distance(output, NEAREST same-register foreigner) − distance(output, OWN test)
// m_P > 0 means the styled output landed closer to P's OWN held-out fingerprint than to
// the CLOSEST same-register stranger. A generic register-obeyer is ~equidistant from all
// same-register targets ⇒ m≈0 ⇒ NULL. Only idiosyncratic voice capture wins.
//
// Audit must-fixes baked in:
//   * Foreign pool restricted to the SAME register band (δ=0.15), by the register metric
//     only — a register-obeyer cannot false-PASS.
//   * NEAREST foreigner, never a centroid/mean of foreigners (centroid regresses to the
//     population center and manufactures a positive margin).
//   * Undecidable subjects (no same-register foreigner) are EXCLUDED — never fall back to
//     a register-diverse pool.
//   * Bootstrap resamples SUBJECTS (the margins array is length = nDecidableSubjects).
//   * One-sided 99% lower bound = bootstrapCI(margins, {alpha:0.02}).lo.
//   * Measured-scale floor (minMeanMargin) must bite: significant-but-trivial ⇒ NULL.
//   * McNemar vs baseline reads .pValue and applies perTestAlpha locally (ignores the
//     helper's hardcoded .significant=0.05).

import { fullStyleDistance, styleDistance } from './stylometry.js';
import { bootstrapCI, mcnemar } from '../../memory/bench-metrics.js';

export const CONTROL_DEFAULTS = Object.freeze({
  registerDelta: 0.15,
  alpha: 0.02,          // two-sided helper @0.02 → one-sided 99% lower bound
  minMeanMargin: 0.01,  // TEST-ONLY default; the real run derives floorK*(between-within) (prereg.deriveMinMeanMargin)
  minDz: 0.5,           // minimum standardized effect size (mean/sd) — kills "few subjects carry it"
  perTestAlpha: 0.01,   // Bonferroni-adjusted at T7; default single-test 0.01
  bootstrapIters: 2000,
  seed: 42,
});

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }
function stdev(xs) {
  if (xs.length < 2) return NaN;
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
}

// Same-register foreigners of P: other personas whose TEST register vector is within δ of
// P's. Register-only — independent of the authorship distance under test.
export function sameRegisterForeigners(p, personas, delta) {
  const pReg = p.fingerprint.register;
  return personas.filter((q) => q.id !== p.id && styleDistance(pReg, q.fingerprint.register) <= delta);
}

// Margin of one arm output for subject P against the NEAREST same-register foreigner.
export function subjectMargin(armVector, p, foreigners) {
  const dOwn = fullStyleDistance(armVector, p.fingerprint);
  let dNearestForeign = Infinity;
  for (const q of foreigners) {
    const d = fullStyleDistance(armVector, q.fingerprint);
    if (d < dNearestForeign) dNearestForeign = d;
  }
  return { dOwn, dNearestForeign, margin: dNearestForeign - dOwn };
}

// Significance at a given alpha, reading the raw p-value (NOT mcnemar's hardcoded .significant).
export function significantAt(pValue, alpha) { return Number.isFinite(pValue) && pValue < alpha; }

function fmt4(x) { return Number.isFinite(x) ? x.toFixed(4) : 'NaN'; }

// Pure arm-level control verdict. PASS requires ALL of (spec §4.4 + §4.7):
//   1. one-sided 99% CI lower bound > 0          (the effect is real)
//   2. meanMargin >= measured-scale floor        (the effect is non-trivial in instrument units)
//   3. majority of subjects positive (>50%)      (NOT a few subjects carrying it)
//   4. standardized effect dz = mean/sd >= minDz  (the effect is large relative to spread)
//   5. sign-test pValue < perTestAlpha            (the majority is statistically significant)
// A heavy-tailed margin that clears 1+2 but fails 3/4/5 is a NULL, not a PASS.
export function controlVerdict(armStats, cfg) {
  const reasons = [];
  const {
    ciLower, meanMargin, sd, pctPositive, signPValue,
  } = armStats;
  const minDz = cfg.minDz ?? 0.5;
  const dz = (Number.isFinite(sd) && sd > 0)
    ? meanMargin / sd
    : (meanMargin > 0 ? Infinity : 0); // sd≈0 with positive mean = perfectly consistent effect

  if (!(Number.isFinite(ciLower) && ciLower > 0)) reasons.push(`CI-lower ${fmt4(ciLower)} not > 0`);
  if (!(Number.isFinite(meanMargin) && meanMargin >= cfg.minMeanMargin)) reasons.push(`meanMargin ${fmt4(meanMargin)} < floor ${cfg.minMeanMargin}`);
  if (!(Number.isFinite(pctPositive) && pctPositive > 0.5)) reasons.push(`pctPositive ${fmt4(pctPositive)} <= 0.5 (minority of subjects)`);
  if (!(dz >= minDz)) reasons.push(`dz ${Number.isFinite(dz) ? dz.toFixed(3) : dz} < ${minDz}`);
  if (!(Number.isFinite(signPValue) && signPValue < cfg.perTestAlpha)) reasons.push(`sign-test p ${fmt4(signPValue)} >= perTestAlpha ${cfg.perTestAlpha}`);

  return { passes: reasons.length === 0, reasons, dz };
}

// wrongTargetControl(harnessOut, personas, opts) → per-arm margin stats + verdicts.
export function wrongTargetControl(harnessOut, personas, opts = {}) {
  const cfg = { ...CONTROL_DEFAULTS, ...opts };
  const byId = new Map(personas.map((p) => [p.id, p]));

  // foreigners per persona (register-only); decidable = has >=1 same-register foreigner
  const foreignersById = {};
  for (const p of personas) foreignersById[p.id] = sameRegisterForeigners(p, personas, cfg.registerDelta);
  const decidableIds = personas.filter((p) => foreignersById[p.id].length > 0).map((p) => p.id);

  const perArm = {};
  for (const arm of harnessOut.arms) {
    const margins = [];
    const ownWin = [];
    const regGaps = [];
    for (const id of decidableIds) {
      const p = byId.get(id);
      const armVec = harnessOut.results[id][arm].vector;
      const sm = subjectMargin(armVec, p, foreignersById[id]);
      margins.push(sm.margin);
      ownWin.push(sm.margin > 0 ? 1 : 0);
      // diagnostic: register distance to the nearest same-register foreigner
      const nearest = foreignersById[id].reduce((best, q) => {
        const d = fullStyleDistance(armVec, q.fingerprint);
        return d < best.d ? { q, d } : best;
      }, { q: null, d: Infinity }).q;
      if (nearest) regGaps.push(styleDistance(p.fingerprint.register, nearest.fingerprint.register));
    }
    const ownLoss = margins.map((m) => (m < 0 ? 1 : 0));
    const ci = bootstrapCI(margins, { iters: cfg.bootstrapIters, alpha: cfg.alpha, seed: cfg.seed });
    // zeros-vs-wins sign test: b = #(margin>0), c = #(margin<0); two-sided p on |b−c|.
    const sign = mcnemar(ownLoss, ownWin);
    perArm[arm] = {
      arm,
      nDecidable: margins.length,
      margins,
      ownWin,
      meanMargin: mean(margins),
      sd: stdev(margins),
      pctPositive: mean(ownWin),
      signPValue: sign.pValue,
      signPositives: sign.b,
      signNegatives: sign.c,
      ciLower: ci.lo,
      ciPoint: ci.point,
      registerGap: mean(regGaps),
    };
  }

  // McNemar vs baseline for each verdict arm (own-match win indicator), pValue exposed.
  for (const arm of harnessOut.arms) {
    if (arm === 'baseline' || !perArm.baseline) continue;
    const m = mcnemar(perArm.baseline.ownWin, perArm[arm].ownWin);
    // mcnemar.pValue is TWO-SIDED (|b−c|), so the direction guard m.b > m.c is mandatory:
    // the arm must FLIP MORE subjects to own-match than baseline does, not merely differ.
    perArm[arm].vsBaseline = {
      b: m.b, c: m.c, pValue: m.pValue, beatsBaseline: significantAt(m.pValue, cfg.perTestAlpha) && m.b > m.c,
    };
  }

  // arm verdicts
  for (const arm of harnessOut.arms) perArm[arm].verdict = controlVerdict(perArm[arm], cfg);

  return {
    cfg,
    nSubjects: personas.length,
    nDecidable: decidableIds.length,
    nUndecidable: personas.length - decidableIds.length,
    decidableIds,
    perArm,
    // VOID rail input: PASS of a register-only-echo arm means the control is fooled by
    // register alone. undefined (no registerEcho arm present) ⇒ the decision layer THROWS
    // rather than silently treating the missing rail as false.
    registerEchoPasses: perArm.registerEcho ? perArm.registerEcho.verdict.passes : undefined,
  };
}

export const __test = { mean };
