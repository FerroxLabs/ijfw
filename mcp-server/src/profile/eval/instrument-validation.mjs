// instrument-validation.mjs — Gate B v2, Task T2. THE HARD PREREQUISITE GATE.
//
// Before any cloud spend, prove the metric (T1 fullStyleDistance) actually discriminates
// INDIVIDUALS — not just registers. We compute same-author vs different-author distances
// over a labeled corpus and score the discriminator with AUC. The PRIMARY gate is the
// SAME-REGISTER AUC: can the metric tell apart two authors who write in the same register
// (the only thing that makes the wrong-target control meaningful). If the same-register
// discriminator is near chance, the whole behavioral question is unanswerable → report a
// NULL and CUT; do NOT loosen the thresholds to proceed.
//
// Anti-bias discipline (audit must-fix): authors and pairs are selected by IDENTITY and
// by REGISTER distance only — NEVER by the fullStyleDistance being scored. Selecting
// "well-separated" authors by the scored metric would inflate AUC. The same-register
// membership uses the 9-axis register metric (styleDistance), which is independent of the
// authorship sub-vectors under test.

import { fullStyleVector, fullStyleDistance, styleVector, styleDistance } from './stylometry.js';

export const DEFAULT_VALIDATION_CFG = Object.freeze({
  registerDelta: 0.15,        // same-register band on the 9-axis register metric
  aucFloor: 0.80,             // sanity floor on register-diverse AUC
  sameRegisterCILower: 0.75,  // PRIMARY gate: bootstrap lower bound on same-register AUC
  minSameRegister: 150,       // min same-register between-author pairs (else underpowered)
  bootstrapB: 1000,
  ciAlpha: 0.05,              // one-sided lower bound at this alpha
  seed: 1,
});

// ---- deterministic RNG (mulberry32) so bootstrap is reproducible ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mann-Whitney AUC with higher score = positive class, average-rank tie handling.
function aucHigherPos(posScores, negScores) {
  const nP = posScores.length;
  const nN = negScores.length;
  if (!nP || !nN) return NaN;
  const all = [];
  for (const s of posScores) all.push({ s, p: 1 });
  for (const s of negScores) all.push({ s, p: 0 });
  all.sort((a, b) => a.s - b.s);
  const N = all.length;
  let rankSumPos = 0;
  let i = 0;
  while (i < N) {
    let j = i;
    while (j < N && all[j].s === all[i].s) j += 1;
    const avgRank = (i + 1 + j) / 2; // ranks are 1-based; average over the tie block
    for (let k = i; k < j; k += 1) if (all[k].p === 1) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - (nP * (nP + 1)) / 2) / (nP * nN);
}

// Positive class = same-author pairs (should have LOW distance), so score = -distance
// (higher = more "same"). AUC = P(same-author pair ranks closer than diff-author pair).
function aucFromDistances(sameDists, diffDists) {
  return aucHigherPos(sameDists.map((d) => -d), diffDists.map((d) => -d));
}

// Equal Error Rate over the distance threshold sweep.
function equalErrorRate(sameDists, diffDists) {
  if (!sameDists.length || !diffDists.length) return NaN;
  const ts = [...new Set([...sameDists, ...diffDists])].sort((a, b) => a - b);
  let best = 1;
  for (const t of ts) {
    const fnr = sameDists.filter((d) => d > t).length / sameDists.length; // same called diff
    const fpr = diffDists.filter((d) => d <= t).length / diffDists.length; // diff called same
    best = Math.min(best, Math.max(fnr, fpr));
  }
  return best;
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

// Build flat sample list: one sample per document. Each carries authorId + precomputed
// register (9-axis) and full (authorship) vectors so pairwise distance is cheap.
//
// OPT-IN (Gate B v3 trained verifier): if `scorer` is supplied it carries a custom
// authorship representation + distance. `scorer.vectorize(text)` returns the opaque
// authorship object stored on `sample.full`; `scorer.distance(a.full, b.full)` returns a
// distance in [0,1] (higher = more different). The 9-axis REGISTER vector is ALWAYS the
// shipped styleVector — the same-register tag must stay independent of the authorship
// representation under test. When `scorer` is null, behavior is identical to before
// (fullStyleVector + fullStyleDistance).
function buildSamples(corpus, scorer = null) {
  const samples = [];
  for (const author of corpus) {
    const docs = author.docs || [];
    for (const text of docs) {
      samples.push({
        authorId: author.id,
        register: styleVector(text),
        full: scorer ? scorer.vectorize(text) : fullStyleVector(text),
      });
    }
  }
  return samples;
}

// Authorship distance: the injected scorer's distance, or the shipped composite.
function authDistance(aFull, bFull, scorer) {
  return scorer ? scorer.distance(aFull, bFull) : fullStyleDistance(aFull, bFull);
}

// Enumerate same-author and diff-author pair distances. Diff pairs are tagged with
// whether they are SAME-REGISTER (register distance <= delta) — that tag depends ONLY on
// the register metric, never on the authorship distance under test.
function enumeratePairs(samples, delta, scorer = null) {
  const same = [];
  const diff = [];
  const diffSameRegister = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const a = samples[i];
      const b = samples[j];
      const d = authDistance(a.full, b.full, scorer);
      if (a.authorId === b.authorId) {
        same.push(d);
      } else {
        diff.push(d);
        if (styleDistance(a.register, b.register) <= delta) diffSameRegister.push(d);
      }
    }
  }
  return { same, diff, diffSameRegister };
}

// Author-level (cluster) bootstrap on the same-register AUC. Resamples AUTHORS with
// replacement; same-author distances come from each resampled author's own docs, and the
// same-register NEG pairs are drawn across DISTINCT resampled authors (a real author is
// never compared to a duplicate of themselves — that would inject distance~0 foreigners).
function bootstrapSameRegisterAucLower(corpus, delta, B, alpha, seed, scorer = null) {
  const rng = mulberry32(seed);
  const ids = corpus.map((a) => a.id);
  const byId = new Map(corpus.map((a) => [a.id, a]));
  const reps = [];
  for (let b = 0; b < B; b += 1) {
    const pick = [];
    for (let k = 0; k < ids.length; k += 1) pick.push(ids[Math.floor(rng() * ids.length)]);
    const distinct = [...new Set(pick)];
    if (distinct.length < 2) continue;
    // same-author distances: each occurrence contributes its within-author doc pairs
    const sameD = [];
    for (const id of pick) {
      const s = buildSamples([byId.get(id)], scorer);
      for (let i = 0; i < s.length; i += 1) {
        for (let j = i + 1; j < s.length; j += 1) sameD.push(authDistance(s[i].full, s[j].full, scorer));
      }
    }
    // same-register diff distances: across DISTINCT authors only
    const distinctSamples = buildSamples(distinct.map((id) => byId.get(id)), scorer);
    const negSR = [];
    for (let i = 0; i < distinctSamples.length; i += 1) {
      for (let j = i + 1; j < distinctSamples.length; j += 1) {
        const a = distinctSamples[i];
        const c = distinctSamples[j];
        if (a.authorId !== c.authorId && styleDistance(a.register, c.register) <= delta) {
          negSR.push(authDistance(a.full, c.full, scorer));
        }
      }
    }
    if (sameD.length && negSR.length) reps.push(aucFromDistances(sameD, negSR));
  }
  if (!reps.length) return { lower: NaN, reps: 0 };
  reps.sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(alpha * reps.length) - 1);
  return { lower: reps[idx], reps: reps.length };
}

function fmt(x) { return Number.isFinite(x) ? x.toFixed(3) : 'NaN'; }

// Pure gate decision over the computed metrics. Extracted so the threshold logic is
// unit-testable independent of any fixture's AUC. NEVER loosens: every threshold is a
// hard floor; a failed check is named for honest reporting at the decision gate.
export function gateDecision(m, cfg) {
  const checks = [];
  if (!(Number.isFinite(m.auc) && m.auc >= cfg.aucFloor)) {
    checks.push(`diverse AUC ${fmt(m.auc)} < ${cfg.aucFloor}`);
  }
  if (!(Number.isFinite(m.sameRegisterAucCILower) && m.sameRegisterAucCILower >= cfg.sameRegisterCILower)) {
    checks.push(`same-register AUC CI-lower ${fmt(m.sameRegisterAucCILower)} < ${cfg.sameRegisterCILower}`);
  }
  if (!(m.nSameRegister >= cfg.minSameRegister)) {
    checks.push(`nSameRegister ${m.nSameRegister} < ${cfg.minSameRegister}`);
  }
  if (!(Number.isFinite(m.withinMean) && Number.isFinite(m.betweenMean) && m.betweenMean > m.withinMean)) {
    checks.push('betweenMean not > withinMean');
  }
  return { passes: checks.length === 0, failedChecks: checks };
}

// validateInstrument(corpus, preReg) → structured validation result + pass/fail gate.
// corpus: [{ id, docs: [text, ...] }, ...]. preReg.validation overrides DEFAULT_VALIDATION_CFG.
export function validateInstrument(corpus, preReg = {}) {
  const cfg = { ...DEFAULT_VALIDATION_CFG, ...preReg.validation };
  // OPT-IN scorer (Gate B v3 trained verifier). preReg.scorer = { vectorize, distance }.
  // vectorize(text) -> opaque authorship object; distance(aFull, bFull) -> [0,1]. The
  // corpus "docs" are the unit of pairing (for the verifier these are author CHUNKS, and
  // distance is the trained-model same/diff distance for that chunk pair). When absent,
  // behavior is byte-identical to the shipped frozen-composite path.
  const scorer = preReg.scorer || null;
  const samples = buildSamples(corpus, scorer);
  const { same, diff, diffSameRegister } = enumeratePairs(samples, cfg.registerDelta, scorer);

  const withinMean = mean(same);
  const betweenMean = mean(diff);
  const auc = aucFromDistances(same, diff);
  const eer = equalErrorRate(same, diff);
  const nSameRegister = diffSameRegister.length;
  const sameRegisterAuc = nSameRegister ? aucFromDistances(same, diffSameRegister) : NaN;

  const boot = nSameRegister
    ? bootstrapSameRegisterAucLower(corpus, cfg.registerDelta, cfg.bootstrapB, cfg.ciAlpha, cfg.seed, scorer)
    : { lower: NaN, reps: 0 };

  const metrics = {
    auc, sameRegisterAucCILower: boot.lower, nSameRegister, withinMean, betweenMean,
  };
  const { passes, failedChecks } = gateDecision(metrics, cfg);

  return {
    auc,
    eer,
    sameRegisterAuc,
    sameRegisterAucCILower: boot.lower,
    bootstrapReps: boot.reps,
    withinMean,
    betweenMean,
    nWithin: same.length,
    nBetween: diff.length,
    nSameRegister,
    cfg,
    passes,
    failedChecks,
  };
}

export const __test = {
  aucHigherPos, aucFromDistances, equalErrorRate, enumeratePairs, buildSamples, gateDecision,
};
