/**
 * profile/eval/run-real-corpus.mjs — drive Gate C + Gate B against the user's
 * REAL Claude Code corpus with a CLOUD frontier model (Anthropic) as the
 * agent-under-test. Produces an HONEST results blob (JSON) written to the local
 * gitignored scratch dir; the report doc is generated from it separately.
 *
 * ── PRIVACY (enforced, not asserted) ────────────────────────────────────────
 *  - The corpus builder already reduces transcripts to counts; the only place
 *    raw-ish text survives is feedback `context` snippets, which live ONLY in
 *    the local scratch artifacts and are NEVER passed to the cloud transport.
 *  - The cloud agent receives ONLY: (a) a system brief that is either '' or the
 *    STYLE-ONLY brief (four axis descriptors — NO user text), or an authored
 *    oracle style brief; and (b) an authored generic prompt. A guard asserts the
 *    injected system/prompt strings are drawn from that closed set before any
 *    network call — if anything else appears the run ABORTS.
 *  - The full preference-tier brief (shareSensitive) is DELIBERATELY NOT sent:
 *    on this corpus its "Observed preference" lines are sentence fragments of the
 *    user's real prose (a finding in itself), so transmitting it would violate
 *    the raw-text constraint. Gate B's heuristic arm therefore uses the
 *    privacy-safe style-only brief — which is also the genuinely portable signal.
 *
 * ── BOUNDED SPEND ───────────────────────────────────────────────────────────
 *  Total cloud calls = nProbes * (#agent arms) + (nProbes judge calls). With
 *  nProbes=30, 3 agent arms (baseline/heuristic/oracle) + 1 judge pass =>
 *  30*3 + 30 = 120 calls, maxTokens 320 each. A hard call-counter aborts the run
 *  if it would exceed `maxCalls` (default 200).
 *
 * Node built-ins only (global fetch). No new deps.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderBrief } from '../render-brief.js';
import { makeProfile } from '../schema.js';
import { deriveProfileFromSessions } from './gate-c-capture.mjs';
import { runArm, objectiveAdherence } from './gate-b-behavior.mjs';
import {
  objectiveStyle, cohenKappa,
  bootstrapCI, mcnemar, expectedCalibrationError,
} from './harness.mjs';
import { buildCorpus } from './corpus-from-transcripts.mjs';
import { buildRealEval } from './build-real-probes.mjs';

const ANTHROPIC_MODEL = process.env.IJFW_EVAL_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Build an Anthropic agent transport with a hard call budget + a privacy guard.
 * The guard records every (system, prompt) pair and verifies system ∈ allowed
 * brief set and prompt ∈ allowed prompt set BEFORE the network call.
 */
function makeAnthropicAgent({ apiKey, model, allowedSystems, allowedPrompts, budget }) {
  const allowedSys = new Set(allowedSystems);
  const allowedPr = new Set(allowedPrompts);
  const MAX_TOKENS = 1024; // eval-fixed budget; runArm's 256 is intentionally overridden
  return async ({ prompt, system }) => {
    const sys = String(system || '');
    const pr = String(prompt || '');
    // PRIVACY GUARD — only the closed set of authored prompts + derived
    // style/oracle briefs may ever reach the network.
    if (!allowedPr.has(pr)) throw new Error('PRIVACY GUARD: prompt not in authored set — aborting');
    if (!allowedSys.has(sys)) throw new Error('PRIVACY GUARD: system brief not in allowed set — aborting');
    if (budget.calls >= budget.max) throw new Error(`BUDGET: exceeded ${budget.max} cloud calls`);
    budget.calls += 1;
    const body = {
      model,
      // 1024 tokens so the LENGTH signal can vary between arms: at the runArm
      // default (256) both arms clip at the ceiling and terseness is pinned,
      // masking the effect (verified live). 1024 lets the expansive-brief arm
      // run longer than baseline without either hitting the cap on most probes.
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: pr }],
    };
    if (sys) body.system = sys;
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Anthropic HTTP ${res.status}: ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text, usage: j.usage || null };
  };
}

/**
 * Run all judge pairs through Anthropic (async), returning a 0/1 preferA vector.
 * Replicates biasControlledJudge's position-randomization + length-control with
 * an async (network) judge — the harness's sync wrapper cannot await a fetch.
 */
async function runJudgePairs({ apiKey, model, styleDescription, pairs, budget, seed }) {
  // We replicate biasControlledJudge's position-randomization + length-control
  // but with an async judge call. Mirrors harness semantics exactly.
  const { mulberry32 } = await import('./harness.mjs');
  const rng = mulberry32(seed);
  const preferA = [];
  const details = [];
  for (const it of pairs) {
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
    const ctlA = cut(rawA);
    const ctlB = cut(rawB);
    const firstTxt = aFirst ? ctlA : ctlB;
    const secondTxt = aFirst ? ctlB : ctlA;
    if (budget.calls >= budget.max) throw new Error(`BUDGET: exceeded ${budget.max} cloud calls`);
    budget.calls += 1;
    const sys = `You are a STYLE judge. Decide which candidate better matches this writing style: ${styleDescription}. `
      + 'Answer with ONLY the single character "1" or "2". No other text.';
    const usr = `Candidate 1:\n${firstTxt}\n\n---\n\nCandidate 2:\n${secondTxt}\n\nWhich better matches the target style? Reply 1 or 2.`;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4, system: sys, messages: [{ role: 'user', content: usr }] }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
    const j = await res.json();
    const out = (j.content || []).map((c) => c.text || '').join('').trim();
    const choseSecond = out.startsWith('2') ? 1 : 0; // 0 = first, 1 = second
    const judgePrefersFirst = choseSecond === 0;
    const prefersA = aFirst ? judgePrefersFirst : !judgePrefersFirst;
    preferA.push(prefersA ? 1 : 0);
    details.push({ aFirst, out });
  }
  return { preferA, details };
}

/**
 * Continuous per-probe distance of an output to the user's style target, scoped
 * to the BRIEF-CONTROLLABLE dimensions (terseness, formality, emoji presence).
 * We deliberately do NOT use the harness styleDistance here because its codeBlock
 * presence bit penalizes outputs for a facet the style brief never conveys (see
 * build-real-probes styleTargetFromAxes). The thresholded harness
 * `objectiveAdherence` (which DOES include codeBlock) is still reported as the
 * conservative secondary view.
 */
function scopedDistance(out, target) {
  const g = objectiveStyle(out);
  let d = Math.abs((g.terseness || 0) - (target.terseness || 0));
  d += Math.abs((g.formalityMarkers || 0) - (target.formalityMarkers || 0));
  d += Math.abs((g.emojiPerChar > 0 ? 1 : 0) - (target.emojiPerChar > 0 ? 1 : 0)) * 0.5;
  return d;
}
function distVec(outputs, target) {
  return outputs.map((o) => scopedDistance(o, target));
}

/**
 * main — orchestrate the full real-corpus run.
 */
export async function runRealCorpus(opts = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { status: 'BLOCKED', reason: 'ANTHROPIC_API_KEY not set in env' };

  const scratch = opts.scratch || join(process.cwd(), '.ijfw', 'profile-eval-scratch');
  mkdirSync(scratch, { recursive: true });

  const nProbes = Number.isFinite(opts.nProbes) ? opts.nProbes : 30;
  const budget = { calls: 0, max: Number.isFinite(opts.maxCalls) ? opts.maxCalls : 200 };
  const seed = 7;

  // 1) REAL corpus.
  const corpus = buildCorpus({ minMessages: opts.minMessages ?? 8, cap: opts.cap ?? 400 });
  if (!corpus.sessions.length) return { status: 'BLOCKED', reason: `empty corpus: ${JSON.stringify(corpus.stats)}` };

  // Persist corpus stats + (LOCAL ONLY) the feedback artifacts for audit.
  writeFileSync(join(scratch, 'corpus-stats.json'), JSON.stringify(corpus.stats, null, 2));

  // 2) Split + probes.
  const ev = await buildRealEval(corpus, { trainFraction: opts.trainFraction ?? 0.6, nProbes });
  writeFileSync(join(scratch, 'split.json'), JSON.stringify(ev.split, null, 2));

  // 3) GATE C — capture, held-out (OFFLINE, no cloud). Explicit-probe mode:
  //    train = ev.train, probe = ev.probes (carry the held-out TEST gold).
  const cCorpus = { sessions: ev.train, probes: ev.probes, negativeControl: ev.negativeControl };
  const { runGateC } = await import('./gate-c-capture.mjs');
  const gateC = await runGateC(cCorpus, { bootstrapSeed: 42 });

  // 3b) STYLE-axis capture (the portable signal): TRAIN-derived vs TEST-derived
  //     EMA per axis + |diff|. This is the honest "does it capture you" leg that
  //     actually generalizes (the preference slug leg does not).
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
      confirmed_both: (a && b && a.evidence_count >= 5 && b.evidence_count >= 5),
    };
  }

  // 4) GATE B — behavior A/B with the CLOUD agent. Privacy-safe arms only.
  const renderOpts = { env: process.env };
  // heuristic STYLE-ONLY brief = default render (no opt-in => low-tier style axes
  // only, NO preference fragments). This is what is privacy-safe to transmit.
  const styleBrief = renderBrief(trainProfile, renderOpts).text; // style axes only
  const baselineBrief = renderBrief(makeProfile(), renderOpts).text; // ''
  // ORACLE — an authored, transcript-free ceiling describing the user's real
  // fingerprint in plain words (best-case explicit style signal).
  const st = ev.split.styleTarget;
  const terseWord = st.terseness < 0.34 ? 'expansive and detailed' : st.terseness < 0.67 ? 'moderate length' : 'terse';
  const emojiWord = st.emojiPerChar > 0 ? 'occasional emoji are welcome' : 'no emoji';
  const formalWord = st.formalityMarkers < 0.34 ? 'casual' : st.formalityMarkers < 0.67 ? 'balanced/neutral' : 'formal';
  const oracleBrief = `User writing-style profile (observed): responses should be ${terseWord}; tone ${formalWord}; ${emojiWord}.`;

  const allowedSystems = [baselineBrief, styleBrief, oracleBrief];
  const allowedPrompts = ev.probes.map((p) => p.prompt);
  const agent = makeAnthropicAgent({ apiKey, model: ANTHROPIC_MODEL, allowedSystems, allowedPrompts, budget });

  // Run the three arms through the REAL runArm (REAL objectiveAdherence scoring).
  const baseline = await runArm(agent, baselineBrief, ev.probes);
  const heuristic = await runArm(agent, styleBrief, ev.probes);
  const oracle = await runArm(agent, oracleBrief, ev.probes);

  // Primary headline: paired McNemar on objectiveAdherence (heuristic vs baseline).
  const headline = mcnemar(baseline.adherence, heuristic.adherence);
  const oracleVsBaseline = mcnemar(baseline.adherence, oracle.adherence);

  // Per-arm adherence rate + bootstrap CI (REAL helper).
  const arms = {
    baseline: { adherence: baseline.adherence, ci: bootstrapCI(baseline.adherence, { seed }) },
    heuristic: { adherence: heuristic.adherence, ci: bootstrapCI(heuristic.adherence, { seed: seed + 1 }) },
    oracle: { adherence: oracle.adherence, ci: bootstrapCI(oracle.adherence, { seed: seed + 2 }) },
  };

  // Secondary continuous: per-probe style-distance to the user's target. A
  // closer-than-baseline 0/1 vector feeds a second paired McNemar (more
  // sensitive than the thresholded adherence on a homogeneous corpus).
  const target = ev.split.styleTarget;
  const dBase = distVec(baseline.outputs, target);
  const dHeur = distVec(heuristic.outputs, target);
  const dOracle = distVec(oracle.outputs, target);
  const heurCloser = dBase.map((d, i) => (dHeur[i] < d ? 1 : 0));
  const baseCloserThanHeur = dBase.map((d, i) => (d < dHeur[i] ? 1 : 0));
  const distanceMcnemar = mcnemar(baseCloserThanHeur, heurCloser); // before=base-wins, after=heur-wins
  const meanDist = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);

  // ECE on confidence — the profile's style axes carry a confidence proxy via
  // Beta mass. We compute a calibration over per-probe (confidence, correct)
  // where confidence = the brief's asserted style strength and correct = the
  // heuristic-arm adherence. This makes the confidence number honest.
  const styleConfidence = (() => {
    // average confirmed-axis "strength" = mean |ema-0.5|*2 over confirmed axes
    let sum = 0; let n = 0;
    for (const ax of ['formality', 'energy', 'terseness', 'emoji_use']) {
      const a = trainProfile.global.style[ax];
      if (a && a.evidence_count >= 5) { sum += Math.min(1, Math.abs(a.ema - 0.5) * 2); n += 1; }
    }
    return n ? sum / n : 0.5;
  })();
  const ecePairs = heuristic.adherence.map((y) => ({ confidence: styleConfidence, correct: y }));
  const ece = expectedCalibrationError(ecePairs, { nBins: 10 });

  // 5) BIAS-CONTROLLED JUDGE (secondary rater) + κ vs objective. Anthropic judge.
  let judge = null;
  try {
    const styleDescription = `${terseWord}; tone ${formalWord}; ${emojiWord}`;
    const pairs = ev.probes.map((_, i) => ({ a: heuristic.outputs[i], b: baseline.outputs[i] }));
    const { preferA, details } = await runJudgePairs({
      apiKey, model: ANTHROPIC_MODEL, styleDescription, pairs, budget, seed,
    });
    const objectivePrefersA = ev.probes.map((_, i) => (
      heuristic.adherence[i] === 1 && baseline.adherence[i] === 0 ? 1 : 0
    ));
    judge = {
      preferA,
      objectivePrefersA,
      judgePreferAHeuristicRate: preferA.reduce((a, b) => a + b, 0) / (preferA.length || 1),
      kappa: cohenKappa(preferA, objectivePrefersA),
      sampleDetails: details.slice(0, 3).map((d) => ({ aFirst: d.aFirst, out: d.out })),
    };
  } catch (e) {
    judge = { error: String(e.message || e) };
  }

  const result = {
    status: 'DONE',
    model: ANTHROPIC_MODEL,
    cloudCalls: budget.calls,
    corpusStats: corpus.stats,
    split: ev.split,
    gateC: {
      precision: gateC.precision,
      recall: gateC.recall,
      f1: gateC.f1,
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
      arms: {
        baseline: { rate: arms.baseline.ci.point, ci: arms.baseline.ci, adherence: arms.baseline.adherence },
        heuristic_styleonly: { rate: arms.heuristic.ci.point, ci: arms.heuristic.ci, adherence: arms.heuristic.adherence },
        oracle_styleceiling: { rate: arms.oracle.ci.point, ci: arms.oracle.ci, adherence: arms.oracle.adherence },
      },
      headline_mcnemar: headline,
      oracle_vs_baseline_mcnemar: oracleVsBaseline,
      distance: {
        mean_baseline: meanDist(dBase),
        mean_heuristic: meanDist(dHeur),
        mean_oracle: meanDist(dOracle),
        heuristic_closer_count: heurCloser.reduce((a, b) => a + b, 0),
        baseline_closer_count: baseCloserThanHeur.reduce((a, b) => a + b, 0),
        mcnemar: distanceMcnemar,
      },
      ece: { ece: ece.ece, styleConfidence },
      judge,
    },
    privacy: {
      transcripts_sent_to_cloud: false,
      preference_brief_transmitted: false,
      allowed_systems_count: allowedSystems.length,
      note: 'Only style-only/oracle briefs (no user text) + authored prompts reached the cloud; guard-enforced.',
    },
    timestamp: new Date().toISOString(),
  };

  writeFileSync(join(scratch, 'results.json'), JSON.stringify(result, null, 2));
  return result;
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  runRealCorpus({
    nProbes: Number(process.env.IJFW_EVAL_NPROBES) || 30,
    maxCalls: Number(process.env.IJFW_EVAL_MAXCALLS) || 200,
  }).then((r) => {
    // print a compact summary (no raw text)
    const { status, model, cloudCalls } = r;
    console.log(JSON.stringify({ status, model, cloudCalls, reason: r.reason || null }, null, 2));
    if (r.status !== 'DONE') process.exit(1);
  }).catch((e) => { console.error('RUN ERROR:', e.message); process.exit(1); });
}

export default { runRealCorpus };
