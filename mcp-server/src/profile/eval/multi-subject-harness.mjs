// multi-subject-harness.mjs — Gate B v2, Task T4. Runs the arms for every subject and
// scores each arm's output against the subject's HELD-OUT TEST fingerprint.
//
// Arms:
//   baseline     — no style brief ('')  → anchor
//   derived      — STYLE-AXIS-BAND-ONLY brief built from TRAIN register (no numbers, no
//                  raw user prose). Verdict-bearing.
//   fewShotOracle— raw OWN_TRAIN exemplars injected as "match this voice" (public corpus
//                  only — see operator decision 1). The TRUE instrument ceiling. Verdict-bearing.
//
// Circularity kills enforced here:
//   * Briefs are built from persona.trainDocs ONLY. The harness NEVER touches testDocs in a
//     brief builder (AST guard test) and NEVER imports styleTargetFromAxes (AST guard test).
//   * assertBriefNonLeaky throws if a non-baseline brief contains a verbatim OWN_test
//     document or sits inside the func+trigram leak floor of OWN_test (prose-leak guard C1').
//   * Scoring is PER-SUBJECT aggregated: all of a subject's probe outputs for an arm are
//     concatenated into ONE authorship vector, so the high-dim func/trigram vector is stable
//     (not per-probe noise).

import { styleVector, fullStyleVector, fullStyleDistance } from './stylometry.js';

export const ARMS = ['baseline', 'derived', 'fewShotOracle'];
export const VERDICT_ARMS = ['derived', 'fewShotOracle']; // baseline is the anchor, not a verdict
export const DEFAULT_PROBES = [
  'Write a short note about your plans for the coming week.',
  'Describe, in your own words, how you would approach a new project.',
  'Give a brief reaction to a change a teammate just proposed.',
];

// Map the 9-axis register vector to neutral BAND words. No numbers; no raw user prose.
function describeBands(reg) {
  const band = (v, lo, hi, low, mid, high) => (v < lo ? low : v > hi ? high : mid);
  return [
    `length ${band(reg.terseness, 0.4, 0.6, 'expansive', 'moderate', 'very terse')}`,
    `tone ${band(reg.formality, 0.15, 0.4, 'casual', 'neutral', 'formal')}`,
    reg.emojiRate > 0.08 ? 'uses emoji' : 'no emoji',
    `punctuation ${band(reg.punctProfile, 0.25, 0.5, 'sparse', 'moderate', 'heavy')}`,
    `hedging ${band(reg.hedgeRate, 0.1, 0.3, 'direct', 'some', 'frequent')}`,
  ].join('; ');
}

// Deterministic exemplar selection from TRAIN docs (longest-first for signal density).
function pickExemplars(trainDocs, n) {
  return [...trainDocs].sort((a, b) => b.length - a.length).slice(0, n);
}

// buildBriefs(persona, cfg) → { baseline, derived, fewShotOracle }. TRAIN-ONLY by
// construction — references persona.trainDocs and never persona.testDocs.
export function buildBriefs(persona, cfg = {}) {
  const trainText = persona.trainDocs.join('\n');
  const reg = styleVector(trainText);
  const derived = `Write in this style — ${describeBands(reg)}.`;
  const exemplars = pickExemplars(persona.trainDocs, cfg.nExemplars || 2);
  const fewShotOracle = `Match the voice of these writing samples:\n${exemplars.map((e) => `"""${e}"""`).join('\n')}`;
  return { baseline: '', derived, fewShotOracle };
}

const FUNC_TRI_WEIGHTS = { register: 0, func: 0.67, tri: 0.33, punct: 0 };

// assertBriefNonLeaky(brief, persona, cfg): a non-baseline brief must not contain OWN_test
// content. (1) no verbatim OWN_test document; (2) not inside the func+trigram leak floor of
// OWN_test (catches near-verbatim test prose). Train exemplars (disjoint docs) clear this.
export function assertBriefNonLeaky(brief, persona, cfg = {}) {
  if (!brief) return; // baseline
  const leakFloor = cfg.leakFloor ?? 0.02;
  for (const td of persona.testDocs) {
    if (td.length > 20 && brief.includes(td)) {
      throw new Error(`brief leaks a verbatim OWN_test document (persona ${persona.id})`);
    }
  }
  const d = fullStyleDistance(brief, persona.testDocs.join('\n'), FUNC_TRI_WEIGHTS);
  if (d < leakFloor) {
    throw new Error(`brief too close to OWN_test func+tri signature (${d.toFixed(3)} < ${leakFloor}, persona ${persona.id})`);
  }
}

function buildPrompt(brief, task) {
  return (brief ? `${brief}\n\n` : '') + `Task: ${task}`;
}

// runHarness(personas, { transport, probes, cfg }) → per-(subject, arm) aggregated result.
// transport: async (prompt) => string. Real cloud transport at run time; a style-faithful
// fake in tests.
export async function runHarness(personas, opts) {
  const { transport, probes = DEFAULT_PROBES, cfg = {} } = opts;
  if (typeof transport !== 'function') throw new Error('runHarness requires a transport(prompt)=>text');
  const results = {};
  for (const p of personas) {
    const briefs = buildBriefs(p, cfg);
    for (const arm of ARMS) if (arm !== 'baseline') assertBriefNonLeaky(briefs[arm], p, cfg);
    results[p.id] = {};
    for (const arm of ARMS) {
      const outputs = [];
      for (const task of probes) {
        // eslint-disable-next-line no-await-in-loop
        outputs.push(String(await transport(buildPrompt(briefs[arm], task))));
      }
      const aggregated = outputs.join('\n'); // PER-SUBJECT aggregation → one vector/arm
      const vector = fullStyleVector(aggregated);
      results[p.id][arm] = { vector, distOwn: fullStyleDistance(vector, p.fingerprint), outputs };
    }
  }
  return { personaIds: personas.map((p) => p.id), arms: ARMS, results };
}

export const __test = { describeBands, pickExemplars, buildPrompt };
