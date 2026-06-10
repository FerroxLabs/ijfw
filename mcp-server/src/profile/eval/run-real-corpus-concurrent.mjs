/**
 * profile/eval/run-real-corpus-concurrent.mjs — CONCURRENT driver for the
 * real-corpus profile-bus eval (Gate C + Gate B) against the user's OWN Claude
 * Code transcripts with a CLOUD frontier model as the agent-under-test.
 *
 * WHY THIS EXISTS (vs run-real-corpus.mjs):
 *   The sibling sequential orchestrator (`run-real-corpus.mjs`) runs every arm and
 *   every judge pair as a serial `await` — ~150 blocking round-trips, which makes a
 *   fully-synchronous in-turn run impractically slow. This driver uses the same
 *   REAL scoring + REAL stats but dispatches the cloud calls in bounded
 *   `Promise.all` BATCHES (default 8) so the whole A/B finishes in minutes, in
 *   one turn, with no backgrounding.
 *
 *   PUSH V2: a FOURTH arm — the DIRECTIVE brief (renderBrief style:'directive') —
 *   sits alongside baseline / descriptive / oracle. The four pre-registered
 *   paired McNemar contrasts (descriptive-vs-baseline, directive-vs-baseline [the
 *   bar], directive-vs-descriptive, oracle-vs-baseline) are reported on both the
 *   thresholded adherence metric and the continuous style-distance metric. Gate C
 *   reports BOTH the exact-slug and the SEMANTIC (Jaccard) preference metric.
 *
 * NO NEW SCORING MATH. Every statistic comes from the REAL helpers:
 *   - derivation:   deriveProfileFromSessions (gate-c-capture.mjs) -> REAL derive/merge
 *   - brief:        renderBrief (render-brief.js)  -> the production serving string
 *   - adherence:    objectiveAdherence (gate-b-behavior.mjs)
 *   - stats:        mcnemar / bootstrapCI / cohenKappa / expectedCalibrationError /
 *                   objectiveStyle  (harness.mjs, re-exporting bench-metrics.js)
 *   - Gate C:       runGateC (gate-c-capture.mjs)
 *   - corpus+split: buildCorpus / buildRealEval
 * The ONLY thing this file owns is the concurrency loop + the same privacy guard
 * and call-budget that run-real-corpus.mjs uses.
 *
 * PRIVACY (guard-enforced, identical to the sequential driver):
 *   The cloud agent only ever receives (a) a system brief drawn from the CLOSED
 *   set { '' , style-only-brief , authored-oracle-brief } — NONE of which contains
 *   raw user prose — and (b) an authored generic prompt from GENERIC_PROMPTS. A
 *   guard asserts membership BEFORE every network call; anything else ABORTS the
 *   run. The full preference-tier brief (whose "Observed preference" lines are
 *   fragments of the user's real prose on this corpus) is DELIBERATELY NOT sent.
 *
 * BOUNDED SPEND: a hard call counter aborts if a call would exceed `maxCalls`.
 *
 * Node built-ins only (global fetch). No new deps. ESM.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderBrief } from '../render-brief.js';
import { makeProfile } from '../schema.js';
import { deriveProfileFromSessions, runGateC } from './gate-c-capture.mjs';
import { objectiveAdherence } from './gate-b-behavior.mjs';
import {
  objectiveStyle, cohenKappa, bootstrapCI, mcnemar,
  expectedCalibrationError, mulberry32,
} from './harness.mjs';
import { buildCorpus } from './corpus-from-transcripts.mjs';
import { buildRealEval } from './build-real-probes.mjs';

const ANTHROPIC_MODEL = process.env.IJFW_EVAL_MODEL || 'claude-opus-4-8';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const AGENT_MAX_TOKENS = 1024; // matches the sequential driver: lets length vary between arms

/** Run an array of async thunks in bounded-concurrency batches, preserving order. */
async function mapBatched(items, batchSize, fn) {
  const out = Array.from({ length: items.length });
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    // eslint-disable-next-line no-await-in-loop
    const res = await Promise.all(slice.map((it, j) => fn(it, i + j)));
    for (let j = 0; j < res.length; j++) out[i + j] = res[j];
  }
  return out;
}

/** One Anthropic chat call. Returns the joined text. Budget + privacy enforced by caller. */
async function anthropicCall({ apiKey, model, system, prompt, maxTokens }) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (system) body.system = system;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Anthropic HTTP ${res.status}: ${t.slice(0, 160)}`);
  }
  const j = await res.json();
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

/**
 * Run ONE arm CONCURRENTLY over the probe set. The brief is the SYSTEM context —
 * exactly how a host passively injects the profile. Returns { outputs, adherence }
 * in probe order. Privacy guard + budget checked before each call.
 */
async function runArmConcurrent({
  apiKey, model, brief, probes, allowedSys, allowedPr, budget, batchSize,
}) {
  const sys = String(brief || '');
  if (!allowedSys.has(sys)) throw new Error('PRIVACY GUARD: system brief not in allowed set — aborting');
  const outputs = await mapBatched(probes, batchSize, async (probe) => {
    const pr = String(probe.prompt || '');
    if (!allowedPr.has(pr)) throw new Error('PRIVACY GUARD: prompt not in authored set — aborting');
    if (budget.calls >= budget.max) throw new Error(`BUDGET: exceeded ${budget.max} cloud calls`);
    budget.calls += 1;
    return anthropicCall({ apiKey, model, system: sys, prompt: pr, maxTokens: AGENT_MAX_TOKENS });
  });
  const adherence = outputs.map((text, i) => objectiveAdherence(text, probes[i]));
  return { outputs, adherence };
}

/**
 * Bias-controlled pairwise judge, CONCURRENT. Replicates biasControlledJudge's
 * position-randomization + length-control with an async (network) judge, batched.
 * Returns the 0/1 preferA vector (position flip undone).
 */
async function runJudgeConcurrent({
  apiKey, model, styleDescription, pairs, budget, batchSize, seed,
}) {
  const rng = mulberry32(seed);
  // pre-roll the coin per pair so order-of-resolution can't change randomization
  const plans = pairs.map((it) => {
    const aFirst = rng() < 0.5;
    const rawA = String(it.a || '');
    const rawB = String(it.b || '');
    const target = Math.min(rawA.length, rawB.length) || Math.max(rawA.length, rawB.length);
    const cut = (s) => {
      if (s.length <= target) return s;
      const c = s.slice(0, target);
      const sp = c.lastIndexOf(' ');
      return sp > target * 0.6 ? c.slice(0, sp) : c;
    };
    return { aFirst, first: aFirst ? cut(rawA) : cut(rawB), second: aFirst ? cut(rawB) : cut(rawA) };
  });
  const results = await mapBatched(plans, batchSize, async (p) => {
    if (budget.calls >= budget.max) throw new Error(`BUDGET: exceeded ${budget.max} cloud calls`);
    budget.calls += 1;
    const sys = `You are a STYLE judge. Decide which candidate better matches this writing style: ${styleDescription}. `
      + 'Answer with ONLY the single character "1" or "2". No other text.';
    const usr = `Candidate 1:\n${p.first}\n\n---\n\nCandidate 2:\n${p.second}\n\nWhich better matches the target style? Reply 1 or 2.`;
    const out = await anthropicCall({ apiKey, model, system: sys, prompt: usr, maxTokens: 4 });
    return out.trim();
  });
  const preferA = [];
  const details = [];
  for (let i = 0; i < plans.length; i++) {
    const out = results[i];
    const choseSecond = out.startsWith('2') ? 1 : 0;
    const judgePrefersFirst = choseSecond === 0;
    const prefersA = plans[i].aFirst ? judgePrefersFirst : !judgePrefersFirst;
    preferA.push(prefersA ? 1 : 0);
    details.push({ aFirst: plans[i].aFirst, out });
  }
  return { preferA, details };
}

/** Scoped per-probe distance (brief-controllable dims only) — mirrors the sequential driver. */
function scopedDistance(out, target) {
  const g = objectiveStyle(out);
  let d = Math.abs((g.terseness || 0) - (target.terseness || 0));
  d += Math.abs((g.formalityMarkers || 0) - (target.formalityMarkers || 0));
  d += Math.abs((g.emojiPerChar > 0 ? 1 : 0) - (target.emojiPerChar > 0 ? 1 : 0)) * 0.5;
  return d;
}

export async function runRealCorpusConcurrent(opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { status: 'BLOCKED', reason: 'ANTHROPIC_API_KEY not set in env' };

  const scratch = opts.scratch || join(process.cwd(), '.ijfw', 'profile-eval-scratch');
  mkdirSync(scratch, { recursive: true });

  const nProbes = Number.isFinite(opts.nProbes) ? opts.nProbes : 24;
  const batchSize = Number.isFinite(opts.batchSize) ? opts.batchSize : 8;
  const budget = { calls: 0, max: Number.isFinite(opts.maxCalls) ? opts.maxCalls : 150 };
  const seed = 7;
  const model = opts.model || ANTHROPIC_MODEL;
  // Push v2: a 4th arm (directive brief). The judge is a SECONDARY reliability
  // rater (κ only), so it runs on a bounded subsample to keep total cloud spend
  // under the pre-registered cap. judgeSampleN pairs are judged.
  const judgeSampleN = Number.isFinite(opts.judgeSampleN) ? opts.judgeSampleN : 30;

  // 1) REAL corpus (bounded). Deterministic stratified round-robin (no RNG): the
  //    "seed" is the sorted-dir + chronological ordering, fully reproducible.
  const corpus = buildCorpus({ minMessages: opts.minMessages ?? 8, cap: opts.cap ?? 200 });
  if (!corpus.sessions.length) return { status: 'BLOCKED', reason: `empty corpus: ${JSON.stringify(corpus.stats)}` };
  writeFileSync(join(scratch, 'corpus-stats.json'), JSON.stringify(corpus.stats, null, 2));

  // 2) Time-based split + probes (REAL).
  const ev = await buildRealEval(corpus, { trainFraction: opts.trainFraction ?? 0.6, nProbes });
  writeFileSync(join(scratch, 'split.json'), JSON.stringify(ev.split, null, 2));

  // 3) GATE C — held-out capture (OFFLINE, no cloud).
  const cCorpus = { sessions: ev.train, probes: ev.probes, negativeControl: ev.negativeControl };
  const gateC = await runGateC(cCorpus, { bootstrapSeed: 42 });

  // 3b) STYLE-axis capture: TRAIN-derived vs TEST-derived EMA per axis (+|diff|).
  const trainProfile = await deriveProfileFromSessions(ev.train, {});
  const testProfile = await deriveProfileFromSessions(ev.test, {});
  const styleCapture = {};
  for (const ax of ['formality', 'energy', 'terseness', 'emoji_use']) {
    const a = trainProfile.global.style[ax];
    const b = testProfile.global.style[ax];
    styleCapture[ax] = {
      train_ema: a ? a.ema : null,
      test_ema: b ? b.ema : null,
      abs_diff: (a && b) ? Math.abs(a.ema - b.ema) : null,
      train_evidence: a ? a.evidence_count : 0,
      test_evidence: b ? b.evidence_count : 0,
      confirmed_both: Boolean(a && b && a.evidence_count >= 5 && b.evidence_count >= 5),
    };
  }

  // 4) GATE B — behavior A/B (CLOUD), privacy-safe arms only.
  const renderOpts = { env: process.env };
  const styleBrief = renderBrief(trainProfile, renderOpts).text;       // descriptive style axes (no prose)
  // Push v2 CHANGE 1: the DIRECTIVE arm — the SAME derived/gated style content,
  // phrased as actionable guidance. Opt-in mode; default stays descriptive.
  const directiveBrief = renderBrief(trainProfile, { ...renderOpts, style: 'directive' }).text;
  const baselineBrief = renderBrief(makeProfile(), renderOpts).text;   // '' by construction
  const st = ev.split.styleTarget;
  const terseWord = st.terseness < 0.34 ? 'expansive and detailed' : st.terseness < 0.67 ? 'moderate length' : 'terse';
  const emojiWord = st.emojiPerChar > 0 ? 'occasional emoji are welcome' : 'no emoji';
  const formalWord = st.formalityMarkers < 0.34 ? 'casual' : st.formalityMarkers < 0.67 ? 'balanced/neutral' : 'formal';
  const oracleBrief = `User writing-style profile (observed): responses should be ${terseWord}; tone ${formalWord}; ${emojiWord}.`;

  // PRIVACY GUARD allow-set: every system string a cloud call may carry. The
  // directive brief, like the descriptive one, is style-axis-only (no user
  // prose) — confirm it is non-empty and prose-free before admitting it.
  const allowedSys = new Set([baselineBrief, styleBrief, directiveBrief, oracleBrief]);
  const allowedPr = new Set(ev.probes.map((p) => p.prompt));

  const armArgs = { apiKey, model, probes: ev.probes, allowedSys, allowedPr, budget, batchSize };
  const baseline = await runArmConcurrent({ ...armArgs, brief: baselineBrief });
  const heuristic = await runArmConcurrent({ ...armArgs, brief: styleBrief });      // descriptive
  const directive = await runArmConcurrent({ ...armArgs, brief: directiveBrief });  // directive
  const oracle = await runArmConcurrent({ ...armArgs, brief: oracleBrief });

  // Four pre-registered paired McNemar contrasts on objectiveAdherence:
  //   (1) descriptive vs baseline   — replicates the prior headline
  //   (2) directive   vs baseline   — THE PUSH-V2 BAR
  //   (3) directive   vs descriptive— does directive phrasing beat descriptive?
  //   (4) oracle      vs baseline   — the explicit-signal ceiling
  const descriptiveVsBaseline = mcnemar(baseline.adherence, heuristic.adherence);
  const directiveVsBaseline = mcnemar(baseline.adherence, directive.adherence);
  const directiveVsDescriptive = mcnemar(heuristic.adherence, directive.adherence);
  const oracleVsBaseline = mcnemar(baseline.adherence, oracle.adherence);
  const headline = directiveVsBaseline; // the bar this push must clear

  const arms = {
    baseline: bootstrapCI(baseline.adherence, { seed }),
    heuristic: bootstrapCI(heuristic.adherence, { seed: seed + 1 }),
    directive: bootstrapCI(directive.adherence, { seed: seed + 4 }),
    oracle: bootstrapCI(oracle.adherence, { seed: seed + 2 }),
  };

  // Secondary continuous: per-probe style-distance to the user's target -> paired McNemar.
  const target = ev.split.styleTarget;
  const dBase = baseline.outputs.map((o) => scopedDistance(o, target));
  const dHeur = heuristic.outputs.map((o) => scopedDistance(o, target));
  const dDir = directive.outputs.map((o) => scopedDistance(o, target));
  const dOracle = oracle.outputs.map((o) => scopedDistance(o, target));
  const meanDist = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
  // closer-than-baseline 0/1 vectors per arm, fed to paired McNemar.
  const heurCloser = dBase.map((d, i) => (dHeur[i] < d ? 1 : 0));
  const baseCloserH = dBase.map((d, i) => (d < dHeur[i] ? 1 : 0));
  const dirCloser = dBase.map((d, i) => (dDir[i] < d ? 1 : 0));
  const baseCloserD = dBase.map((d, i) => (d < dDir[i] ? 1 : 0));
  // directive-closer-than-descriptive
  const dirCloserThanHeur = dHeur.map((d, i) => (dDir[i] < d ? 1 : 0));
  const heurCloserThanDir = dHeur.map((d, i) => (d < dDir[i] ? 1 : 0));
  const distanceMcnemarHeur = mcnemar(baseCloserH, heurCloser);
  const distanceMcnemarDir = mcnemar(baseCloserD, dirCloser);
  const distanceMcnemarDirVsHeur = mcnemar(heurCloserThanDir, dirCloserThanHeur);

  // ECE on confidence (style strength of confirmed axes vs heuristic-arm adherence).
  const styleConfidence = (() => {
    let sum = 0; let n = 0;
    for (const ax of ['formality', 'energy', 'terseness', 'emoji_use']) {
      const a = trainProfile.global.style[ax];
      if (a && a.evidence_count >= 5) { sum += Math.min(1, Math.abs(a.ema - 0.5) * 2); n += 1; }
    }
    return n ? sum / n : 0.5;
  })();
  // ECE on the DIRECTIVE arm (the bar) — asserted style confidence vs directive-arm hit-rate.
  const ece = expectedCalibrationError(
    directive.adherence.map((y) => ({ confidence: styleConfidence, correct: y })),
    { nBins: 10 },
  );
  const eceDescriptive = expectedCalibrationError(
    heuristic.adherence.map((y) => ({ confidence: styleConfidence, correct: y })),
    { nBins: 10 },
  );

  // 5) BIAS-CONTROLLED JUDGE (secondary rater) + κ vs objective (CONCURRENT).
  //    Judges the DIRECTIVE arm (the bar) vs baseline, on a bounded SUBSAMPLE of
  //    pairs (κ only needs a sample; this keeps total cloud spend under the
  //    pre-registered cap). Deterministic first-judgeSampleN probes.
  let judge = null;
  try {
    const styleDescription = `${terseWord}; tone ${formalWord}; ${emojiWord}`;
    const nJudge = Math.min(judgeSampleN, ev.probes.length);
    const idx = Array.from({ length: nJudge }, (_, i) => i);
    const pairs = idx.map((i) => ({ a: directive.outputs[i], b: baseline.outputs[i] }));
    const { preferA, details } = await runJudgeConcurrent({
      apiKey, model, styleDescription, pairs, budget, batchSize, seed,
    });
    const objectivePrefersA = idx.map((i) => (
      directive.adherence[i] === 1 && baseline.adherence[i] === 0 ? 1 : 0
    ));
    judge = {
      arm: 'directive_vs_baseline',
      nJudged: nJudge,
      judgePreferADirectiveRate: preferA.reduce((a, b) => a + b, 0) / (preferA.length || 1),
      kappa: cohenKappa(preferA, objectivePrefersA),
      preferA,
      objectivePrefersA,
      sampleDetails: details.slice(0, 3),
    };
  } catch (e) {
    judge = { error: String(e.message || e) };
  }

  const result = {
    status: 'DONE',
    model,
    concurrency: batchSize,
    cloudCalls: budget.calls,
    budgetMax: budget.max,
    corpusStats: corpus.stats,
    split: ev.split,
    gateC: {
      // exact-slug metric (the honest floor — kept for continuity with prior run)
      precision: gateC.precision,
      recall: gateC.recall,
      f1: gateC.f1,
      // Push v2 CHANGE 2: SEMANTIC metric (Jaccard >= threshold on content tokens)
      semantic: gateC.semantic,
      predicted: gateC.predicted,
      goldCount: gateC.gold.length,
      counts: gateC.counts,
      negativeControl: gateC.negativeControl,
      nTrain: gateC.nTrain,
      nProbe: gateC.nProbe,
      heldOutDisjoint: gateC.heldOut.disjoint,
    },
    styleCapture,
    gateB: {
      nProbes: ev.probes.length,
      arms: {
        baseline: { rate: arms.baseline.point, ci: arms.baseline, adherence: baseline.adherence },
        descriptive_styleonly: { rate: arms.heuristic.point, ci: arms.heuristic, adherence: heuristic.adherence },
        directive_styleonly: { rate: arms.directive.point, ci: arms.directive, adherence: directive.adherence },
        oracle_styleceiling: { rate: arms.oracle.point, ci: arms.oracle, adherence: oracle.adherence },
      },
      mcnemar: {
        descriptive_vs_baseline: descriptiveVsBaseline,
        directive_vs_baseline: directiveVsBaseline, // THE BAR
        directive_vs_descriptive: directiveVsDescriptive,
        oracle_vs_baseline: oracleVsBaseline,
      },
      headline_mcnemar: headline, // == directive_vs_baseline
      distance: {
        mean_baseline: meanDist(dBase),
        mean_descriptive: meanDist(dHeur),
        mean_directive: meanDist(dDir),
        mean_oracle: meanDist(dOracle),
        descriptive_closer_count: heurCloser.reduce((a, b) => a + b, 0),
        directive_closer_count: dirCloser.reduce((a, b) => a + b, 0),
        mcnemar_descriptive_vs_baseline: distanceMcnemarHeur,
        mcnemar_directive_vs_baseline: distanceMcnemarDir,
        mcnemar_directive_vs_descriptive: distanceMcnemarDirVsHeur,
      },
      ece: { directive: ece.ece, descriptive: eceDescriptive.ece, styleConfidence },
      judge,
    },
    privacy: {
      transcripts_sent_to_cloud: false,
      preference_brief_transmitted: false,
      allowed_systems_count: allowedSys.size,
      directive_brief_prose_free: !/Observed preference|Tentative pattern|Honor this preference|Where it fits/.test(directiveBrief),
      note: 'Only baseline/descriptive/directive style-only briefs + oracle (none containing user prose) + authored prompts reached the cloud; guard-enforced before every call.',
    },
    timestamp: new Date().toISOString(),
  };

  writeFileSync(join(scratch, 'results.json'), JSON.stringify(result, null, 2));
  return result;
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  runRealCorpusConcurrent({
    scratch: process.env.IJFW_EVAL_SCRATCH,
    nProbes: Number(process.env.IJFW_EVAL_NPROBES) || 80,
    maxCalls: Number(process.env.IJFW_EVAL_MAXCALLS) || 360,
    batchSize: Number(process.env.IJFW_EVAL_BATCH) || 8,
    cap: Number(process.env.IJFW_EVAL_CAP) || 200,
    judgeSampleN: Number(process.env.IJFW_EVAL_JUDGE_N) || 30,
  }).then((r) => {
    const { status, model, cloudCalls } = r;
    console.error(JSON.stringify({ status, model, cloudCalls, reason: r.reason || null }));
    if (r.status !== 'DONE') process.exit(1);
  }).catch((e) => { console.error('RUN ERROR:', e.message); process.exit(1); });
}

export default { runRealCorpusConcurrent };
