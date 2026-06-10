// Gate B v2 — PRODUCTION runner wiring. These tests prove the integration seam, not the
// statistics (those are unit-tested in the module tests). The load-bearing claims:
//
//   * makeMeasure produces the EXACT confirmatory shape decideGateB/confirmatoryBooleans
//     consume — registerEchoPasses + realArmsCarried are COMPUTED booleans, never absent
//     (the rails THROW on undefined; we prove they don't fire here).
//   * The register-echo arm is actually run + spliced, so the VOID rail is live.
//   * A voice-matching fake transport drives toward PASS; a generic fake → NULL.
//   * INSTRUMENT GATE BEFORE SPEND: when validateInstrument fails, the runner refuses to
//     spend and the transport is NEVER called (zero calls asserted).
//   * Fail-closed: missing API key ⇒ BLOCKED, never a silent empty pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeMeasure, runGateBProduction, buildRegisterEchoBrief, ECHO_ARM,
} from './gate-b-run.mjs';
import { buildPreReg } from './prereg.mjs';
import { fullStyleVector } from './stylometry.js';
import { generatePersonaText } from './synthetic-personas.js';

// ---- persona fixtures: real human-ish text, formal register (archetype 0) ----
function persona(id, seed) {
  const trainDocs = [generatePersonaText(0, seed + 1, 20), generatePersonaText(0, seed + 2, 20)];
  const testDocs = [generatePersonaText(0, seed + 9001, 16)];
  return {
    id,
    synthetic: false,
    headlineEligible: true,
    trainDocs,
    testDocs,
    trainTokens: 999,
    testTokens: 999,
    fingerprint: fullStyleVector(testDocs.join('\n')),
  };
}
// 8 same-register subjects + 4 same-register foreigners (so every subject is decidable).
const SUBJECTS = Array.from({ length: 8 }, (_, i) => persona(`s${i}`, 1000 + i * 37));
const FOREIGNERS = Array.from({ length: 4 }, (_, i) => persona(`f${i}`, 7000 + i * 53));

// A FAITHFUL agent: when the prompt carries fewShotOracle exemplars (""" """), echo them
// (→ that subject's own train voice). When it carries the register-echo instruction, emit a
// register-centered generic blob (no idiosyncratic voice). Otherwise a fixed casual default.
function voiceMatchingTransport(subjectById) {
  return (prompt) => {
    const ex = prompt.match(/"""([\s\S]*?)"""/g);
    if (ex) return ex.map((s) => s.replace(/"""/g, '')).join(' ');
    if (prompt.includes('REGISTER-ONLY')) return generatePersonaText(0, 424242, 16);
    // derived/baseline: land near OWN voice if the brief names the subject's id, else generic
    for (const [id, p] of Object.entries(subjectById)) {
      if (prompt.includes(`__voice:${id}__`)) return p.trainDocs.join(' ');
    }
    return generatePersonaText(0, 424242, 16);
  };
}
// A GENERIC agent: same register-centered blob no matter the brief → no own-voice advantage.
function genericTransport() {
  return () => generatePersonaText(0, 424242, 16);
}
// A call-counting wrapper so we can assert ZERO spend on the instrument-fail path.
function counting(fn) {
  const t = (p) => { t.calls += 1; return fn(p); };
  t.calls = 0;
  return t;
}

const TEST_CFG = {
  minMeanMargin: 0.0005, // fixture-scaled measured floor (real run derives floorK*(between-within))
  probes: ['Write a short note about your week.', 'React to a teammate proposal.'],
  minRealSubjects: 1,
  // synthetic templated train≈test ⇒ relax the 2nd-tier leak floor (real corpus uses prereg.leakFloor).
  harnessCfg: { leakFloor: 0.0001 },
};

test('buildRegisterEchoBrief: a register-ONLY echo, distinct + honestly labeled', () => {
  const b = buildRegisterEchoBrief(SUBJECTS[0]);
  assert.ok(b.includes('REGISTER-ONLY'), 'echo brief is explicitly register-only');
  // must NOT carry any train exemplar prose (it is a register echo, not a voice brief)
  assert.ok(!SUBJECTS[0].trainDocs.some((d) => b.includes(d)));
});

test('makeMeasure returns the EXACT confirmatory shape (all rails are computed booleans)', async () => {
  const measure = makeMeasure({
    transport: voiceMatchingTransport(Object.fromEntries(SUBJECTS.map((p) => [p.id, p]))),
    personas: SUBJECTS,
    foreigners: FOREIGNERS,
    ...TEST_CFG,
  });
  const preReg = buildPreReg({ verdictArms: ['derived', 'fewShotOracle'] });
  const m = await measure({ seed: 1, phase: 'confirmatory', preReg, minMeanMargin: TEST_CFG.minMeanMargin });
  for (const k of ['instrumentValid', 'baselinePasses', 'registerEchoPasses', 'derivedPasses', 'oraclePasses', 'realArmsCarried']) {
    assert.equal(typeof m[k], 'boolean', `${k} must be a computed boolean, got ${typeof m[k]}`);
  }
  // the register-echo arm really ran (rail is live, not silent-false)
  assert.ok(m.control.perArm[ECHO_ARM], 'register-echo arm spliced into the control');
});

test('the register-echo arm is spliced so confirmatoryBooleans does NOT throw', async () => {
  // confirmatoryBooleans throws if control.registerEchoPasses === undefined. Prove it is defined.
  const measure = makeMeasure({
    transport: genericTransport(), personas: SUBJECTS, foreigners: FOREIGNERS, ...TEST_CFG,
  });
  const preReg = buildPreReg({});
  const m = await measure({ seed: 1, phase: 'confirmatory', preReg, minMeanMargin: TEST_CFG.minMeanMargin });
  assert.notEqual(m.control.registerEchoPasses, undefined);
});

test('GENERIC transport ⇒ derived does NOT pass the wrong-target control (honest NULL)', async () => {
  const measure = makeMeasure({
    transport: genericTransport(), personas: SUBJECTS, foreigners: FOREIGNERS, ...TEST_CFG,
  });
  const preReg = buildPreReg({});
  const m = await measure({ seed: 1, phase: 'confirmatory', preReg, minMeanMargin: TEST_CFG.minMeanMargin });
  assert.equal(m.derivedPasses, false, 'generic output is equidistant from same-register targets');
});

test('VOICE-MATCHING transport ⇒ fewShotOracle margin beats generic (drives toward PASS)', async () => {
  const measure = makeMeasure({
    transport: voiceMatchingTransport(Object.fromEntries(SUBJECTS.map((p) => [p.id, p]))),
    personas: SUBJECTS,
    foreigners: FOREIGNERS,
    ...TEST_CFG,
  });
  const preReg = buildPreReg({});
  const m = await measure({ seed: 1, phase: 'confirmatory', preReg, minMeanMargin: TEST_CFG.minMeanMargin });
  // The oracle arm, echoing OWN train voice, lands closer to OWN test than to the nearest
  // same-register foreigner → positive mean margin (the structural PASS direction).
  assert.ok(m.control.perArm.fewShotOracle.meanMargin > m.control.perArm.baseline.meanMargin,
    'oracle own-voice margin exceeds the no-brief baseline margin');
});

// ---- the full runner: instrument gate, refuse-to-spend, fail-closed ----

test('INSTRUMENT GATE: validateInstrument fails ⇒ NULL verdict, ZERO transport calls', async () => {
  const transport = counting(genericTransport());
  const r = await runGateBProduction({
    apiKey: 'sk-test-fake',
    corpus: SUBJECTS.map((p) => ({ id: p.id, docs: [...p.trainDocs, ...p.testDocs] })),
    foreignersCorpus: FOREIGNERS.map((p) => ({ id: p.id, docs: [...p.trainDocs, ...p.testDocs] })),
    transport,
    personaCfg: { minTrainTokens: 50, minTestTokens: 30 }, // fixture-scaled (prod = 1200/600)
    // force the instrument gate to fail regardless of fixture AUC:
    validateOverride: () => ({ passes: false, failedChecks: ['forced-fail'], betweenMean: 0.4, withinMean: 0.3 }),
  });
  assert.equal(r.spent, false);
  assert.equal(r.verdict.verdict, 'NULL');
  assert.equal(transport.calls, 0, 'NO cloud spend when the instrument gate fails');
});

test('FAIL-CLOSED: missing API key ⇒ BLOCKED, never a silent empty pass', async () => {
  const r = await runGateBProduction({ apiKey: '', corpus: [], foreignersCorpus: [], transport: genericTransport() });
  assert.equal(r.status, 'BLOCKED');
  assert.match(r.reason, /ANTHROPIC_API_KEY|key/i);
});

test('runner wires validate→prereg→measure and returns a verdict when the gate passes', async () => {
  const transport = counting(genericTransport());
  const r = await runGateBProduction({
    apiKey: 'sk-test-fake',
    corpus: SUBJECTS.map((p) => ({ id: p.id, docs: [...p.trainDocs, ...p.testDocs] })),
    foreignersCorpus: FOREIGNERS.map((p) => ({ id: p.id, docs: [...p.trainDocs, ...p.testDocs] })),
    transport,
    personaCfg: { minTrainTokens: 50, minTestTokens: 30 }, // fixture-scaled (prod = 1200/600)
    validateOverride: () => ({ passes: true, betweenMean: 0.5, withinMean: 0.3 }),
    preRegInput: { minSubjects: 1, floorK: 0.001 },
    measureCfg: { ...TEST_CFG, minRealSubjects: 1 },
  });
  assert.equal(r.spent, true);
  assert.ok(['PASS', 'PASS_ORACLE', 'CUT', 'NULL', 'VOID'].includes(r.verdict.verdict));
  assert.ok(typeof r.preRegHash === 'string' && r.preRegHash.length === 64, 'frozen prereg hash surfaced');
  assert.ok(transport.calls > 0, 'the gate passed, so the transport WAS exercised');
});

test('END-TO-END: voice-matching transport never VOIDs (baseline + register-echo NULL)', async () => {
  // The honesty rail: a no-signal arm (baseline / register-echo) must NOT pass the control.
  // With a faithful agent only the OWN-voice arms move; baseline + echo land on register-center.
  const transport = voiceMatchingTransport(Object.fromEntries(SUBJECTS.map((p) => [p.id, p])));
  const r = await runGateBProduction({
    apiKey: 'sk-test-fake',
    corpus: SUBJECTS.map((p) => ({ id: p.id, docs: [...p.trainDocs, ...p.testDocs] })),
    foreignersCorpus: FOREIGNERS.map((p) => ({ id: p.id, docs: [...p.trainDocs, ...p.testDocs] })),
    transport,
    personaCfg: { minTrainTokens: 50, minTestTokens: 30 },
    validateOverride: () => ({ passes: true, betweenMean: 0.5, withinMean: 0.3 }),
    preRegInput: { minSubjects: 4, floorK: 0.001 },
    measureCfg: { ...TEST_CFG, minRealSubjects: 1 },
  });
  assert.notEqual(r.verdict.verdict, 'VOID', 'no-signal arms did not contaminate the control');
  const pa = r.confirmatory.control.perArm;
  assert.equal(pa.baseline.verdict.passes, false, 'baseline NULLs (no own-voice signal)');
  assert.equal(pa.registerEcho.verdict.passes, false, 'register-echo NULLs (register alone cannot win)');
});

test('formatVerdict prints a NULL/CUT as cleanly as a PASS (no retry-to-force)', async () => {
  const { formatVerdict } = await import('./gate-b-run.mjs');
  const out = formatVerdict({
    status: 'DONE', spent: true, cloudCalls: 10, budgetMax: 100, nSubjects: 4, nForeigners: 4,
    runId: 'gateb-x', preRegHash: 'h'.repeat(64),
    verdict: { verdict: 'NULL', reason: 'real authors did not carry it', ship: 'portability' },
    confirmatory: { control: { perArm: {} } },
  });
  assert.match(out, /Gate B verdict: NULL/);
  assert.match(out, /ship:\s+portability/);
});
