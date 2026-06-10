// gate-b-run.mjs — Gate B v2 PRODUCTION runner. The single executable that wires the
// already-built+green modules into one honest decision pipeline:
//
//   validateInstrument (HARD GATE, no spend on fail)
//     → buildPreReg + hashPreReg (frozen before any measure)
//       → runGateBDecision(deps): pilot (descriptive) + FRESH-seed confirmatory
//           measure(): runHarness (baseline/derived/fewShotOracle)
//                    + a spliced REGISTER-ECHO arm (the VOID rail's live input)
//                    + wrongTargetControl (the discriminator)
//                    + deriveRealArmsCarried (synthetic can never license the claim)
//           → confirmatoryBooleans → decideGateB → TRUE yes/no verdict
//
// HONESTY RAILS (enforced + unit-tested in gate-b-run.test.mjs):
//   * instrument gate BEFORE spend: validation fail ⇒ zero transport calls (runGateBDecision
//     refuses to spend).
//   * pre-reg frozen: hashPreReg once; assertFrozen guards re-registration.
//   * the register-echo arm is RUN + spliced, so control.registerEchoPasses is a measured
//     boolean (the rails in gate-b-decision-run throw on undefined — we feed them, not paper
//     over them).
//   * realArmsCarried via deriveRealArmsCarried on headlineEligible-only personas.
//   * NO metric/judge loosening, NO dropped cases, run-once. A NULL/CUT prints cleanly.
//   * fail-closed: missing key / corpus ⇒ BLOCKED/throw, never a silent empty pass.
//
// PRIVACY GUARD (preserved from run-real-corpus-concurrent.mjs): the cloud agent only ever
// receives style-axis-band briefs + OWN-train exemplars + authored probe prompts — NEVER a
// foreign author's prose and NEVER the user's held-out TEST text. Foreign authors enter the
// pipeline as numeric fullStyleVector fingerprints ONLY (they are never passed to runHarness).
// A closed allowed-set is asserted before every cloud call.

import {
  runHarness, buildBriefs, assertBriefNonLeaky, DEFAULT_PROBES,
} from './multi-subject-harness.mjs';
import { wrongTargetControl } from './wrong-target-control.mjs';
import { styleVector, fullStyleVector, fullStyleDistance } from './stylometry.js';
import { loadRealPersonas } from './real-personas.mjs';
import { validateInstrument } from './instrument-validation.mjs';
import {
  buildPreReg, assertFrozen,
} from './prereg.mjs';
import {
  runGateBDecision, confirmatoryBooleans, deriveRealArmsCarried,
} from './gate-b-decision-run.mjs';
import { ingestRedditCorpus } from './corpus-from-reddit.mjs';

export const ECHO_ARM = 'registerEcho';
const ANTHROPIC_MODEL = process.env.IJFW_EVAL_MODEL || 'claude-opus-4-8';

// ---- register-echo brief (the VOID rail's input) -------------------------------------
// A register-ONLY echo: describe the TRAIN register bands and explicitly instruct the agent
// to obey ONLY the register, imitating no specific person. If a register-obeyer PASSES the
// wrong-target control, the instrument is a register meter ⇒ VOID. The brief carries no
// exemplar prose, so it is non-leaky by construction (asserted like every non-baseline arm).
function describeBands(reg) {
  const band = (v, lo, hi, low, mid, high) => (v < lo ? low : v > hi ? high : mid);
  return [
    `length ${band(reg.terseness, 0.4, 0.6, 'expansive', 'moderate', 'very terse')}`,
    `tone ${band(reg.formality, 0.15, 0.4, 'casual', 'neutral', 'formal')}`,
    reg.emojiRate > 0.08 ? 'uses emoji' : 'no emoji',
  ].join('; ');
}
export function buildRegisterEchoBrief(persona) {
  const reg = styleVector(persona.trainDocs.join('\n'));
  return `REGISTER-ONLY control. Match ONLY these register bands — ${describeBands(reg)}. `
    + 'Do NOT imitate any specific person\'s voice or phrasing.';
}

// Run ONE arm for every persona and aggregate per-subject (mirrors runHarness aggregation):
// concat a subject's probe outputs → ONE authorship vector. Used for the spliced echo arm.
async function runEchoArm(personas, { transport, probes, briefFor }) {
  const out = {};
  for (const p of personas) {
    const brief = briefFor(p);
    assertBriefNonLeaky(brief, p, { leakFloor: 0 }); // echo carries no prose; floor 0 = verbatim-only check
    const outputs = [];
    for (const task of probes) {
      // eslint-disable-next-line no-await-in-loop
      outputs.push(String(await transport(`${brief}\n\nTask: ${task}`)));
    }
    out[p.id] = { vector: fullStyleVector(outputs.join('\n')), outputs };
  }
  return out;
}

// ---- makeMeasure: the injection seam runGateBDecision expects -------------------------
// deps.measure({ seed, phase, preReg, minMeanMargin }) → the EXACT confirmatory shape
// confirmatoryBooleans + decideGateB consume:
//   { instrumentValid, baselinePasses, registerEchoPasses, derivedPasses, oraclePasses,
//     realArmsCarried, control, harness } (control/harness attached for reporting).
//
// `personas` = REAL headline subjects (headlineEligible:true). `foreigners` = an ADDITIONAL
// same-register pool whose members serve as nearest-foreigner targets. They are also scored,
// but they are headlineEligible:false so deriveRealArmsCarried never counts them toward the
// verdict — they only thicken each subject's same-register foreigner candidate set.
//
// ARCHITECTURE NOTE (subject/foreigner conflation). wrongTargetControl draws each subject's
// foreigners from the SAME pool it scores (spec §4.1 headline design: the same-register peers
// ARE the foreigners). So the pool = personas ∪ foreigners, run through the harness arms as
// full subjects. PRIVACY (spec §2.4) is preserved: a persona's OWN train prose only ever
// appears in that SAME persona's own brief — a foreigner's prose is NEVER injected as another
// subject's TARGET (targets are always numeric held-out fingerprints). Foreigners are tagged
// headlineEligible:false on ingest so they cannot license the headline claim.
export function makeMeasure({
  transport, personas, foreigners = [], probes = DEFAULT_PROBES,
  minMeanMargin: defaultFloor, minRealSubjects, harnessCfg = {},
  registerDelta = 0.15,
}) {
  if (typeof transport !== 'function') throw new Error('makeMeasure requires a transport(prompt)=>text');
  if (!Array.isArray(personas) || !personas.length) throw new Error('makeMeasure requires real personas');

  // foreigner-pool members are scored subjects too, but NEVER headline-eligible.
  const foreignSubjects = foreigners.map((f) => ({ ...f, headlineEligible: false }));
  const pool = [...personas, ...foreignSubjects];

  return async function measure({
    seed, phase, preReg, minMeanMargin,
  }) {
    const floor = Number.isFinite(minMeanMargin) ? minMeanMargin
      : (Number.isFinite(defaultFloor) ? defaultFloor : 0.01);
    const cfg = { probes, ...harnessCfg };

    // 1) baseline / derived / fewShotOracle — every pool member (each is another's foreigner).
    const harness = await runHarness(pool, { transport, probes, cfg });

    // 2) REGISTER-ECHO arm (the VOID rail input) — run + splice into the harness output so
    //    wrongTargetControl populates registerEchoPasses (never left undefined → rails fire).
    const echo = await runEchoArm(pool, { transport, probes, briefFor: buildRegisterEchoBrief });
    const arms = [...harness.arms, ECHO_ARM];
    const results = {};
    for (const id of harness.personaIds) {
      results[id] = { ...harness.results[id], [ECHO_ARM]: echo[id] };
    }
    const splicedHarness = { personaIds: harness.personaIds, arms, results };

    // 3) the discriminator. perTestAlpha is the Bonferroni split derived in prereg.
    const perTestAlpha = preReg && preReg.perTestAlpha
      ? Math.min(...Object.values(preReg.perTestAlpha)) : 0.01;
    const control = wrongTargetControl(splicedHarness, pool, {
      registerDelta, minMeanMargin: floor, perTestAlpha,
    });

    // 4) realArmsCarried — synthetic personas + foreigner-pool members can NEVER license the
    //    claim (headlineEligible:false). Decidable HEADLINE subjects must reach the floor.
    const minReal = Number.isFinite(minRealSubjects) ? minRealSubjects
      : (preReg ? preReg.minSubjects : personas.length);
    const realArmsCarried = deriveRealArmsCarried(pool, control.decidableIds, minReal);

    // 5) reduce to the confirmatory booleans (throws if registerEchoPasses undefined — it isn't).
    const booleans = confirmatoryBooleans(control, preReg, { realArmsCarried });

    return {
      ...booleans, seed, phase, control, harness: splicedHarness, minMeanMargin: floor,
    };
  };
}

// ---- the full production runner -------------------------------------------------------
// runGateBProduction(opts) → { status, spent, verdict, preRegHash, validation, ... }.
// opts:
//   apiKey            — ANTHROPIC_API_KEY (BLOCKED if absent; never hardcoded)
//   corpus            — [{id,docs}] REAL subjects (or load via dumpPath below)
//   foreignersCorpus  — [{id,docs}] same-register foreigner pool (disjoint)
//   dumpPath          — alternative to corpus: a local reddit dump (ingestRedditCorpus)
//   transport         — async (prompt)=>text. PROD: a privacy-guarded anthropicCall wrapper
//                       (makeCloudTransport). TESTS: a deterministic fake.
//   validateOverride  — TEST-ONLY: inject a validation result (skips the real AUC sweep)
//   preRegInput       — buildPreReg overrides (seed, minSubjects, floorK, verdictArms, ...)
//   measureCfg        — { probes, minMeanMargin, minRealSubjects, harnessCfg, registerDelta }
export async function runGateBProduction(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { status: 'BLOCKED', reason: 'ANTHROPIC_API_KEY not set in env (fail-closed; no run, no spend)' };

  // 1) corpus — explicit arrays, or ingest a local dump (NO network).
  let corpus = opts.corpus;
  let foreignersCorpus = opts.foreignersCorpus;
  if ((!corpus || !foreignersCorpus) && opts.dumpPath) {
    const ing = ingestRedditCorpus(opts.dumpPath, opts.ingestCfg || {});
    corpus = corpus || ing.corpus;
    foreignersCorpus = foreignersCorpus || ing.foreigners;
  }
  if (!Array.isArray(corpus) || !corpus.length) {
    return { status: 'BLOCKED', reason: 'no subject corpus (pass corpus[] or dumpPath); fail-closed' };
  }
  if (!Array.isArray(foreignersCorpus) || !foreignersCorpus.length) {
    return { status: 'BLOCKED', reason: 'no same-register foreigner pool; fail-closed (the wrong-target control is unrunnable)' };
  }

  // 2) personas (real, headline-eligible) + foreigner fingerprints.
  const preRegInput = { corpus: 'reddit-single-subreddit', ...opts.preRegInput };
  const seedForPersonas = preRegInput.seed ?? 1;
  const nAuthors = preRegInput.minSubjects ?? Math.min(corpus.length, corpus.length);
  const personas = loadRealPersonas(corpus, {
    nAuthors: Math.min(nAuthors, corpus.length),
    seed: seedForPersonas,
    ...opts.personaCfg,
  });
  const foreigners = loadRealPersonas(foreignersCorpus, {
    nAuthors: foreignersCorpus.length,
    seed: seedForPersonas,
    ...opts.personaCfg,
  });

  // 3) build the deps for runGateBDecision. validate() is the HARD GATE: on fail,
  //    runGateBDecision returns spent:false with NO guard/measure call ⇒ zero transport calls.
  const validate = opts.validateOverride
    ? async (preReg) => opts.validateOverride(preReg)
    : async (preReg) => validateInstrument(corpus, preReg);

  // the privacy/budget guard wrapper. In production this also enforces the closed allowed-set
  // (built from the harness's own briefs) + a hard call budget. In tests the fake transport
  // is passed directly. We expose a thin guard hook that runGateBDecision calls before spend.
  const guardCalls = [];
  const guard = async ({ phase }) => { guardCalls.push(phase); };

  const measureCfg = opts.measureCfg || {};
  const probes = measureCfg.probes || DEFAULT_PROBES;

  // 3b) transport. TESTS inject a deterministic fake. The LIVE run builds the privacy- and
  //     budget-guarded cloud transport here: the allowed-set is the closed set of EVERY brief
  //     the pool's own personas + foreigner-pool produce (baseline '' + derived + fewShotOracle
  //     + register-echo) — foreign prose is never a target, only a fingerprint. The budget is
  //     sized from arms × pool × probes × (pilot + confirmatory) with headroom.
  const poolForGuard = [...personas, ...foreigners];
  const budget = opts.budget || {
    calls: 0,
    max: opts.maxCalls || (estimateCalls({ nArms: 4, nSubjects: poolForGuard.length, nProbes: probes.length }) * 3),
  };
  const transport = opts.transport || makeCloudTransport({
    apiKey,
    model: opts.model || ANTHROPIC_MODEL,
    allowedSys: buildAllowedSys(poolForGuard, measureCfg.harnessCfg || {}),
    allowedPr: new Set(probes),
    budget,
  });

  const measure = makeMeasure({
    transport,
    personas,
    foreigners,
    probes,
    minMeanMargin: measureCfg.minMeanMargin,
    minRealSubjects: measureCfg.minRealSubjects,
    harnessCfg: measureCfg.harnessCfg || {},
    registerDelta: measureCfg.registerDelta ?? 0.15,
  });

  // 4) freeze the pre-reg ONCE (tamper-evident) before any measure runs.
  const frozenRegistry = opts.frozenRegistry || new Map();
  const deps = {
    buildPreReg: (i) => {
      const pr = buildPreReg(i);
      assertFrozen(frozenRegistry, pr); // run-once: a re-registered runId throws
      return pr;
    },
    validate,
    guard,
    measure,
  };

  const decision = await runGateBDecision(deps, preRegInput);

  return {
    status: 'DONE',
    model: opts.model || ANTHROPIC_MODEL,
    spent: decision.spent,
    verdict: decision.verdict,
    runId: decision.runId,
    preRegHash: decision.preRegHash,
    validation: decision.validation,
    confirmatory: decision.confirmatory,
    pilot: decision.pilot,
    seeds: decision.seeds,
    guardPhases: guardCalls,
    nSubjects: personas.length,
    nForeigners: foreigners.length,
    cloudCalls: budget.calls,
    budgetMax: budget.max,
  };
}

// ---- production cloud transport (privacy + budget guarded) ----------------------------
// makeCloudTransport({ apiKey, model, allowedSys, allowedPr, budget }) → async (prompt)=>text.
// The harness composes prompt = `${brief}\n\nTask: ${task}`. We split it back into the system
// brief + the authored task, assert BOTH are in their closed allowed-sets, budget-count, then
// call Anthropic with the brief as the SYSTEM context (how a host injects a profile).
export function makeCloudTransport({
  apiKey, model = ANTHROPIC_MODEL, allowedSys, allowedPr, budget, maxTokens = 1024,
}) {
  if (!apiKey) throw new Error('makeCloudTransport: ANTHROPIC_API_KEY required');
  const URL = 'https://api.anthropic.com/v1/messages';
  return async function cloudTransport(prompt) {
    // recover (brief, task) from the harness's `${brief}\n\nTask: ${task}` composition.
    const idx = prompt.lastIndexOf('\n\nTask: ');
    const brief = idx >= 0 ? prompt.slice(0, idx) : '';
    const task = idx >= 0 ? prompt.slice(idx + '\n\nTask: '.length) : prompt;
    if (allowedSys && !allowedSys.has(brief)) throw new Error('PRIVACY GUARD: system brief not in allowed set — aborting');
    if (allowedPr && !allowedPr.has(task)) throw new Error('PRIVACY GUARD: prompt not in authored set — aborting');
    if (budget) {
      if (budget.calls >= budget.max) throw new Error(`BUDGET: exceeded ${budget.max} cloud calls`);
      budget.calls += 1;
    }
    const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: task }] };
    if (brief) body.system = brief;
    const res = await fetch(URL, {
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
  };
}

// Build the closed allowed-set of every system brief a cloud call may carry, from the
// personas' OWN briefs (derived + fewShotOracle + register-echo + baseline ''). Foreign
// prose is NEVER in this set. Used to wire makeCloudTransport for the live run.
export function buildAllowedSys(personas, cfg = {}) {
  const sys = new Set(['']); // baseline
  for (const p of personas) {
    const b = buildBriefs(p, cfg);
    sys.add(b.derived);
    sys.add(b.fewShotOracle);
    sys.add(buildRegisterEchoBrief(p));
  }
  return sys;
}

// Estimate the cloud-call budget: arms × subjects × probes, per spend phase.
export function estimateCalls({
  nArms = 4, nSubjects, nProbes,
}) {
  return nArms * nSubjects * nProbes;
}

// Human-readable verdict report. A NULL/CUT prints just as cleanly as a PASS — the runner
// NEVER retries to force a pass.
export function formatVerdict(r) {
  if (r.status === 'BLOCKED') return `BLOCKED: ${r.reason}`;
  const v = r.verdict || {};
  const lines = [
    `Gate B verdict: ${v.verdict}`,
    `  reason:      ${v.reason || ''}`,
    v.claim ? `  claim:       ${v.claim}` : null,
    v.ship ? `  ship:        ${v.ship}` : null,
    v.next ? `  next:        ${v.next}` : null,
    `  runId:       ${r.runId}`,
    `  preRegHash:  ${r.preRegHash}`,
    `  spent:       ${r.spent}   cloudCalls: ${r.cloudCalls}/${r.budgetMax}`,
    `  subjects:    ${r.nSubjects} headline + ${r.nForeigners} same-register foreigners`,
  ];
  const conf = r.confirmatory;
  if (conf && conf.control && conf.control.perArm) {
    const pa = conf.control.perArm;
    for (const arm of ['baseline', 'derived', 'fewShotOracle', ECHO_ARM]) {
      const a = pa[arm];
      if (!a) continue;
      const ci = `CI99-lo ${Number.isFinite(a.ciLower) ? a.ciLower.toFixed(4) : 'NaN'}`;
      lines.push(`  [${arm}] mean-margin ${Number.isFinite(a.meanMargin) ? a.meanMargin.toFixed(4) : 'NaN'} `
        + `dz ${a.verdict && Number.isFinite(a.verdict.dz) ? a.verdict.dz.toFixed(2) : 'NaN'} `
        + `${ci} pct+ ${Number.isFinite(a.pctPositive) ? a.pctPositive.toFixed(2) : 'NaN'} `
        + `passes ${a.verdict ? a.verdict.passes : '?'}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

export const __test = { describeBands, runEchoArm, fullStyleDistance };
export default {
  makeMeasure, runGateBProduction, makeCloudTransport, buildRegisterEchoBrief,
  buildAllowedSys, estimateCalls, formatVerdict, ECHO_ARM,
};

// ---- CLI entrypoint -------------------------------------------------------------------
// The exact command an operator runs for the LIVE verdict:
//   ANTHROPIC_API_KEY=… IJFW_GATEB_DUMP=/path/to/subreddit.jsonl \
//     node --experimental-sqlite src/profile/eval/gate-b-run.mjs
// Optional env: IJFW_EVAL_MODEL (default claude-opus-4-8), IJFW_GATEB_SEED,
//   IJFW_GATEB_NSUBJECTS (default 60), IJFW_GATEB_NPROBES (default 20),
//   IJFW_GATEB_FLOORK (default 0.25), IJFW_GATEB_MAXCALLS.
// Reads ANTHROPIC_API_KEY from env (BLOCKED if absent — never hardcoded). NO network unless a
// real key + dump are present; a missing dump / too-few authors fail-closes (throws/BLOCKED).
if (import.meta.url === `file://${process.argv[1]}`) {
  const dumpPath = process.env.IJFW_GATEB_DUMP;
  if (!dumpPath) {
    // eslint-disable-next-line no-console
    console.error('BLOCKED: set IJFW_GATEB_DUMP=/path/to/single-subreddit.jsonl (local file; no network fetch)');
    process.exit(1);
  }
  const nSubjects = Number(process.env.IJFW_GATEB_NSUBJECTS) || 60;
  const nProbes = Number(process.env.IJFW_GATEB_NPROBES) || 20;
  runGateBProduction({
    dumpPath,
    ingestCfg: { nPersonaAuthors: nSubjects, nForeignAuthors: nSubjects },
    preRegInput: {
      seed: Number(process.env.IJFW_GATEB_SEED) || 1,
      minSubjects: nSubjects,
      floorK: Number(process.env.IJFW_GATEB_FLOORK) || 0.25,
      nProbes,
    },
    measureCfg: {
      probes: DEFAULT_PROBES, // authored, closed set; expand to nProbes-many authored prompts for the real run
    },
    maxCalls: Number(process.env.IJFW_GATEB_MAXCALLS) || undefined,
  }).then((r) => {
    // eslint-disable-next-line no-console
    console.log(formatVerdict(r));
    // a clean NULL/CUT is a SUCCESSFUL run (the honest outcome), exit 0; only BLOCKED is non-zero.
    process.exit(r.status === 'BLOCKED' ? 1 : 0);
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('RUN ERROR (fail-closed):', e.message);
    process.exit(1);
  });
}
