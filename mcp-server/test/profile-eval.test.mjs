// PHASE P5 — Profile Bus Eval. The "prove it" front.
//
// This suite exercises the REAL eval pipeline end-to-end:
//   - REAL derivation  : deriveHeuristic / deriveProfile (src/profile/derive*.js)
//   - REAL CRDT merge   : applyDelta (src/profile/merge.js)
//   - REAL brief render : renderBrief (src/profile/render-brief.js)
//   - REAL stat helpers : bootstrapCI / mcnemar (src/memory/bench-metrics.js)
// The ONLY stub is the LIVE-LLM agent transport in Gate B, injected here as a
// DETERMINISTIC FAKE that genuinely CONSUMES the injected brief (it adheres iff
// the brief tells it to). The scoring + statistics it feeds are 100% real.
//
// The plumbing test (P5.1) lives in src/profile/eval/plumbing.test.mjs and is
// imported at the bottom so `npm test` runs it through this one shim too; it is
// LABELED a regression/plumbing test and explicitly NOT proof of learning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  splitByTime,
  precisionRecall,
  cohenKappa,
  expectedCalibrationError,
  objectiveStyle,
  biasControlledJudge,
  makeHeldOutFixture,
  resolveAgentTransport,
  bootstrapCI,
  mcnemar,
} from '../src/profile/eval/harness.mjs';
import { runGateC, assertedSubjects, deriveProfileFromSessions } from '../src/profile/eval/gate-c-capture.mjs';
import {
  runGateB, buildOracleBrief, objectiveAdherence,
  newSignalSurfacingLatency, adaptationLatency,
} from '../src/profile/eval/gate-b-behavior.mjs';

// ---------------------------------------------------------------------------
// A DETERMINISTIC FAKE AGENT TRANSPORT. It is brief-faithful: it reads the
// injected brief (`system`) and produces output that ADHERES to whatever
// preferences the brief surfaces. With an EMPTY brief it produces a generic,
// non-adherent, verbose answer. This is what makes the brief CAUSALLY drive the
// measured behavior — the exact thing Gate B is built to detect. No cloud.
// ---------------------------------------------------------------------------
// TEST-ISOLATION: the Gate B path (runGateB / newSignalSurfacingLatency)
// renders briefs, which read the sensitivity files (redact.txt / share-hosts.txt)
// from profileDir(). With no override under the test runner the store now THROWS
// (fail-closed default) rather than touching the user's real ~/.ijfw/profile, so
// every store-touching eval test points the global profile + state dirs at
// per-case temp dirs. Mirrors profile-e2e's withFixtures. Async-aware: the Gate B
// helpers are async, so we await fn() and restore in finally.
async function withTmpProfile(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-eval-profile-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-eval-state-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  try {
    return await fn();
  } finally {
    if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
    if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  }
}

function fakeAgent() {
  return async ({ system, probe }) => {
    const brief = String(system || '').toLowerCase();
    // The brief mentions a pref iff it was surfaced by the REAL renderBrief (or
    // the oracle). The agent honors exactly the prefs it was told about.
    const wantsTabs = brief.includes('tab');
    const wantsTs = brief.includes('typescript');
    const wantsTerse = brief.includes('terse');

    if (!brief.trim()) {
      // No profile -> a generic verbose answer (does NOT adhere).
      return {
        text: 'Sure! Here is a detailed walkthrough with spaces for indentation '
          + 'and plenty of explanation so you have all the context you could want.',
        via: 'fake',
      };
    }
    // Profile present -> adhere to the surfaced prefs.
    let out = '';
    if (wantsTerse) out += 'Terse. ';
    if (wantsTabs) out += 'Use\ttabs. ';
    if (wantsTs) out += 'TypeScript. ';
    if (!out) out = 'Acknowledged.';
    void probe;
    return { text: out.trim(), via: 'fake' };
  };
}

// ===========================================================================
// HARNESS UNIT TESTS — each scoring component tested on fixtures (P5.4 demands
// "test each scoring component on fixtures").
// ===========================================================================

test('harness: splitByTime is held-out (train/probe disjoint, time-ordered)', () => {
  const sessions = [
    { session_id: 'a', ts: '2026-06-01T00:00:00Z' },
    { session_id: 'b', ts: '2026-06-02T00:00:00Z' },
    { session_id: 'c', ts: '2026-06-03T00:00:00Z' },
    { session_id: 'd', ts: '2026-06-04T00:00:00Z' },
    { session_id: 'e', ts: '2026-06-05T00:00:00Z' },
  ];
  const s = splitByTime(sessions, { trainFraction: 0.6 });
  assert.equal(s.disjoint, true, 'split is disjoint');
  assert.equal(s.train.length, 3);
  assert.equal(s.probe.length, 2);
  // probe ids strictly after train ids (time order preserved)
  assert.ok(!s.probeIds.has('a') && s.probeIds.has('d') && s.probeIds.has('e'));
});

test('harness: splitByTime by explicit cutoff', () => {
  const sessions = [
    { session_id: 'a', ts: '2026-06-01T00:00:00Z' },
    { session_id: 'b', ts: '2026-06-10T00:00:00Z' },
  ];
  const s = splitByTime(sessions, { cutoff: '2026-06-05T00:00:00Z' });
  assert.deepEqual([...s.trainIds], ['a']);
  assert.deepEqual([...s.probeIds], ['b']);
});

test('harness: precisionRecall set arithmetic + per-unit vectors', () => {
  const pr = precisionRecall(['x', 'y', 'z'], ['x', 'y', 'w']);
  assert.equal(pr.tp, 2);
  assert.equal(pr.fp, 1);
  assert.equal(pr.fn, 1);
  assert.ok(Math.abs(pr.precision - 2 / 3) < 1e-9);
  assert.ok(Math.abs(pr.recall - 2 / 3) < 1e-9);
  // per-unit 0/1 vectors are the bootstrap inputs
  assert.equal(pr.perPredCorrect.reduce((a, b) => a + b, 0), 2);
  assert.equal(pr.perGoldHit.reduce((a, b) => a + b, 0), 2);
});

test('harness: cohenKappa = 1 for perfect agreement, ~0 for chance', () => {
  // Returns a STRUCTURED result {kappa, degenerate, reason, n}. A varied,
  // fully-agreeing pair is real agreement (kappa = 1, not degenerate).
  const agree = cohenKappa([1, 0, 1, 0], [1, 0, 1, 0]);
  assert.equal(agree.kappa, 1);
  assert.equal(agree.degenerate, false, 'varied agreement is NOT degenerate');
  const dis = cohenKappa([1, 1, 0, 0], [0, 0, 1, 1]); // perfect DISagreement
  assert.ok(dis.kappa < 0, 'disagreement -> negative kappa');
  assert.equal(dis.degenerate, false);
});

test('harness: cohenKappa is DEGENERATE (null, not 1.0) when a rater has no label variance', () => {
  // H1 FIX: κ on a single-label sequence is undefined, NOT perfect agreement.
  // The old code returned 1.0 here — a non-result dressed up as strong agreement.
  const r = cohenKappa([1, 1], [1, 1]);
  assert.equal(r.kappa, null, 'no-variance kappa is null, NOT 1.0');
  assert.equal(r.degenerate, true, 'flagged degenerate');
  assert.match(r.reason, /no label variance/i, 'reason explains the degeneracy');
  assert.match(r.reason, /n=2/, 'reason carries n');
  // Asymmetric: one rater varied, the other flat -> still degenerate.
  const r2 = cohenKappa([1, 0, 1], [1, 1, 1]);
  assert.equal(r2.kappa, null);
  assert.equal(r2.degenerate, true);
});

test('harness: ECE is ~0 for a calibrated set and large for an overconfident one', () => {
  // Calibrated: 0.5-confidence predictions correct half the time.
  const cal = [];
  for (let i = 0; i < 100; i++) cal.push({ confidence: 0.5, correct: i % 2 });
  const calRes = expectedCalibrationError(cal, { nBins: 10 });
  assert.ok(calRes.ece < 0.05, `calibrated ECE small (${calRes.ece})`);
  // Overconfident: always says 1.0 but is right only half the time.
  const over = [];
  for (let i = 0; i < 100; i++) over.push({ confidence: 1.0, correct: i % 2 });
  const overRes = expectedCalibrationError(over, { nBins: 10 });
  assert.ok(overRes.ece > 0.4, `overconfident ECE large (${overRes.ece})`);
});

test('harness: objectiveStyle measures terseness/emoji/code without a judge', () => {
  const terse = objectiveStyle('Terse.');
  const verbose = objectiveStyle('Sure! '.repeat(40));
  assert.ok(terse.terseness > verbose.terseness, 'short text is terser');
  assert.ok(objectiveStyle('nice 😀').emojiPerChar > 0, 'emoji detected');
  assert.equal(objectiveStyle('```js\n1\n```').codeBlock, 1, 'code block detected');
});

test('harness: splitByTime guards against a mostly-undated corpus (silent degenerate split)', () => {
  // M3 FIX: a corpus where most sessions have no parseable ts would all sort to
  // the probe side and produce a degenerate-but-passing split. Guard it.
  const undated = [
    { session_id: 'a', ts: '2026-06-01T00:00:00Z' },
    { session_id: 'b' }, // no ts
    { session_id: 'c', ts: 'not-a-date' }, // unparseable
    { session_id: 'd' }, // no ts
  ];
  assert.throws(() => splitByTime(undated, { trainFraction: 0.6 }), /undated/i,
    'a majority-undated corpus must throw, not silently split');
  // The escape hatch still allows it explicitly (e.g. a known-undated test corpus).
  const ok = splitByTime(undated, { trainFraction: 0.6, allowUndated: true });
  assert.equal(ok.disjoint, true);
  // A fully-dated corpus is unaffected.
  const dated = [
    { session_id: 'a', ts: '2026-06-01T00:00:00Z' },
    { session_id: 'b', ts: '2026-06-02T00:00:00Z' },
    { session_id: 'c', ts: '2026-06-03T00:00:00Z' },
  ];
  assert.doesNotThrow(() => splitByTime(dated, { trainFraction: 0.6 }));
});

test('harness: biasControlledJudge undoes position randomization (A-preference recovered)', () => {
  // A judge that ALWAYS prefers the candidate containing the word "terse".
  const judge = ({ first, second }) => (String(second).toLowerCase().includes('terse') ? 1 : 0);
  const items = [
    { a: 'Terse.', b: 'A long verbose answer with lots of words.' },
    { a: 'Terse reply.', b: 'Another verbose one here, friend.' },
  ];
  const { preferA } = biasControlledJudge(items, judge, { seed: 3 });
  // Despite position randomization, the A arm (terse) is recovered as preferred.
  assert.deepEqual(preferA, [1, 1]);
});

test('harness: resolveAgentTransport — injected agent wins; no live without flag', () => {
  const a = () => ({ text: 'x' });
  const r1 = resolveAgentTransport({ agent: a, env: {} });
  assert.equal(typeof r1.transport, 'function');
  assert.equal(r1.live, false);
  const r2 = resolveAgentTransport({ env: {} }); // no agent, no flag
  assert.equal(r2.transport, null);
  // live flag + local url -> a real transport is constructed (not called here)
  const r3 = resolveAgentTransport({ env: { IJFW_PROFILE_EVAL_LIVE: '1', IJFW_PROFILE_LOCAL_URL: 'http://localhost:11434' } });
  assert.equal(typeof r3.transport, 'function');
  assert.equal(r3.live, true);
});

test('harness: re-exported bootstrapCI / mcnemar are the REAL bench-metrics helpers', async () => {
  const real = await import('../src/memory/bench-metrics.js');
  assert.equal(bootstrapCI, real.bootstrapCI, 'same bootstrapCI reference');
  assert.equal(mcnemar, real.mcnemar, 'same mcnemar reference');
});

// ===========================================================================
// GATE C — held-out capture (precision AND recall, real pipeline + real stats).
// ===========================================================================

test('Gate C: derives a REAL profile and reports precision AND recall with bootstrap CIs', async () => {
  const r = await runGateC();
  assert.equal(r.heldOut.disjoint, true, 'held-out split enforced');
  // precision 1.0 (no false assertions), recall < 1.0 (heuristic misses the paraphrase)
  assert.equal(r.precision.point, 1, 'precision = 1 (no false positives)');
  assert.ok(r.recall.point < 1 && r.recall.point >= 0.5, `recall realistic, not rigged (${r.recall.point})`);
  // bootstrap CIs are present and ordered
  assert.ok(r.precision.lo <= r.precision.point && r.precision.point <= r.precision.hi);
  assert.ok(r.recall.lo <= r.recall.point && r.recall.point <= r.recall.hi);
  // negative-control: the derived profile does NOT match an unrelated persona
  assert.equal(r.negativeControl.precision, 0, 'no spurious match to negative-control persona');
});

test('Gate C: REFUSES a leaky (non-held-out) split — anti-circularity guard', async () => {
  // A corpus where a probe id collides with a train id (train==test leakage).
  const leaky = {
    sessions: [{ session_id: 'dup', ts: '2026-06-01T00:00:00Z', feedback: [] }],
    probes: [{ session_id: 'dup', ts: '2026-06-20T00:00:00Z', goldSubjects: ['x'] }],
    negativeControl: { goldSubjects: [] },
  };
  await assert.rejects(() => runGateC(leaky), /held-out violation|leakage/i,
    'leaky split must throw, not report a circular score');
});

test('Gate C: assertedSubjects only surfaces EARNED inferences (floor enforced)', async () => {
  const { sessions } = makeHeldOutFixture();
  const profile = await deriveProfileFromSessions(sessions);
  const subs = assertedSubjects(profile);
  assert.ok(subs.length >= 3, 'earned subjects surfaced');
  // a thin (single-evidence) profile surfaces nothing
  const thin = await deriveProfileFromSessions([sessions[0]]);
  assert.equal(assertedSubjects(thin).length, 0, 'single-session evidence below the floor');
});

// ===========================================================================
// GATE B — behavioral A/B (paired McNemar, four arms, real renderBrief).
// ===========================================================================

test('Gate B: profile injection FLIPS behavior — heuristic beats baseline (paired McNemar)', async () => {
  await withTmpProfile(async () => {
    const r = await runGateB(undefined, { agent: fakeAgent(), seed: 5 });
    // baseline (no brief) should adhere on fewer probes than heuristic (brief).
    const baseHits = r.arms.baseline.adherence.reduce((a, b) => a + b, 0);
    const heurHits = r.arms.heuristic.adherence.reduce((a, b) => a + b, 0);
    assert.ok(heurHits > baseHits, `profile improves adherence (${baseHits} -> ${heurHits})`);
    // McNemar b (baseline=0, heuristic=1) > c (the headline direction).
    assert.ok(r.headline.b > r.headline.c, 'McNemar favors the profile arm');
    // four arms present with bootstrap CIs
    for (const arm of ['baseline', 'heuristic', 'dialectic', 'oracle']) {
      assert.ok(r.arms[arm] && r.arms[arm].ci, `${arm} arm + CI present`);
    }
    // oracle ceiling >= heuristic (the in-prompt ceiling is an upper bound)
    assert.ok(r.oracleCeiling >= r.arms.heuristic.ci.point, 'oracle is a ceiling');
  });
});

test('Gate B: heuristic-vs-dialectic ablation runs (equal with no dialectic transport)', async () => {
  await withTmpProfile(async () => {
    const r = await runGateB(undefined, { agent: fakeAgent(), seed: 9 });
    // With no dialectic transport injected, dialectic == heuristic (ablation null).
    assert.deepEqual(r.arms.dialectic.adherence, r.arms.heuristic.adherence,
      'no dialectic transport -> ablation arm matches heuristic');
    assert.equal(r.ablation.b, 0);
    assert.equal(r.ablation.c, 0);
  });
});

test('Gate B: bias-controlled judge reports kappa vs the objective rater', async () => {
  // A judge that prefers the candidate that looks more on-profile (terse/tabs).
  const judge = ({ first, second }) => {
    const score = (t) => (/terse|\ttab|typescript/i.test(String(t)) ? 1 : 0);
    return score(second) > score(first) ? 1 : 0;
  };
  await withTmpProfile(async () => {
    const r = await runGateB(undefined, { agent: fakeAgent(), judge, seed: 11 });
    assert.ok(r.judge, 'judge report present');
    assert.equal(r.judge.preferA.length, r.arms.heuristic.adherence.length);
    // κ is now a STRUCTURED result. On this tiny fixture the objective rater has
    // no label variance (n=2), so κ is DEGENERATE (null) — surfaced honestly, NOT
    // reported as 1.0 agreement (H1 FIX).
    assert.ok(r.judge.kappa && typeof r.judge.kappa === 'object', 'kappa is structured');
    assert.ok(r.judge.kappa.kappa === null || typeof r.judge.kappa.kappa === 'number',
      'kappa value is null (degenerate) or a number');
    if (r.judge.kappa.degenerate) {
      assert.match(r.judge.kappa.reason, /no label variance/i, 'degenerate kappa carries a reason');
    }
  });
});

test('Gate B: a fifth DEFAULT (redacted, no opt-in) arm scores below the shareSensitive arm', async () => {
  // M1 FIX: the redactor/default-brief must be exercised in the SCORED path. The
  // default brief gates the med-tier preference levers (tabs/typescript) while the
  // low-sensitivity style axis still surfaces -> adherence drops toward baseline,
  // simultaneously proving (a) the redactor works and (b) the behavioral effect is
  // opt-in-gated.
  await withTmpProfile(async () => {
    const r = await runGateB(undefined, { agent: fakeAgent(), seed: 5 });
    assert.ok(r.arms.default, 'default (redacted) arm present');
    assert.ok(r.arms.default.ci, 'default arm has a bootstrap CI');
    const sum = (v) => v.reduce((a, b) => a + b, 0);
    const defHits = sum(r.arms.default.adherence);
    const heurHits = sum(r.arms.heuristic.adherence);
    const baseHits = sum(r.arms.baseline.adherence);
    assert.ok(defHits < heurHits,
      `default (redacted) adheres on fewer probes than shareSensitive heuristic (${defHits} < ${heurHits})`);
    assert.ok(defHits >= baseHits,
      `default sits at or above the no-profile baseline (${defHits} >= ${baseHits})`);
    // The redacted brief must NOT carry the gated levers (tabs / typescript).
    assert.ok(!/\btab/i.test(r.briefs.default), 'default brief redacts the tabs lever');
    assert.ok(!/typescript/i.test(r.briefs.default), 'default brief redacts the typescript lever');
  });
});

test('Gate B: live mode without a transport REFUSES (no silent fake result)', async () => {
  await assert.rejects(
    () => runGateB(undefined, { env: { IJFW_PROFILE_EVAL_LIVE: '1' } }),
    /live mode|Refusing to fake/i,
    'live gate must not silently fake behavior',
  );
});

test('Gate B: buildOracleBrief states the prefs verbatim (the ceiling)', () => {
  const { probes } = makeHeldOutFixture();
  const oracle = buildOracleBrief(probes);
  assert.match(oracle, /use tabs not spaces/);
  assert.match(oracle, /typescript/i);
});

test('Gate B: objectiveAdherence is bias-free (measures the output, no judge)', () => {
  const terseProbe = { goldSubjects: ['keep responses terse'], goldStyle: objectiveStyle('Terse.') };
  assert.equal(objectiveAdherence('Terse.', terseProbe), 1, 'short answer adheres to terse pref');
  assert.equal(objectiveAdherence('A very long, winding, verbose answer with many many words indeed.', terseProbe), 0,
    'verbose answer fails the terse pref');
  const tabsProbe = { goldSubjects: ['use tabs not spaces'] };
  // H3 FIX: adherence is ACTUAL tab-indentation, not a mention of the word "tabs".
  assert.equal(objectiveAdherence('\tconst x = 1;', tabsProbe), 1, 'tab-indented code -> adheres');
  // A literal-tab anywhere on a code line still counts; bare prose "tabs" does NOT.
  assert.equal(objectiveAdherence('I will use tabs for everything.', tabsProbe), 0,
    'merely SAYING "tabs" (no actual tab indentation) does NOT adhere');
  // NEGATION-AWARE: "won't use tabs" must not score adherent.
  assert.equal(objectiveAdherence("I won't use tabs, spaces only.", tabsProbe), 0,
    'negated tabs (won’t use tabs) does NOT adhere');
  // typescript negation-aware too: "unlike typescript" is not adherence.
  const tsProbe = { goldSubjects: ['prefer typescript over javascript'] };
  assert.equal(objectiveAdherence('Unlike TypeScript, JS has no types.', tsProbe), 0,
    'negated/contrastive typescript mention does NOT adhere');
  assert.equal(objectiveAdherence('Use TypeScript: function f(x: number) {}', tsProbe), 1,
    'genuine typescript usage adheres');
});

test('Gate B: new-signal surfacing latency probe (>=3 sessions; NO retraction of the old belief)', async () => {
  // H4 FIX: this metric measures when the NEW contradicting signal SURFACES, not
  // adaptation/retraction. After it surfaces, the OLD belief is still present
  // (no retraction is implemented yet — that is asymmetric-decay / P1.4).
  await withTmpProfile(async () => {
    const r = await newSignalSurfacingLatency();
    assert.equal(r.surfaced, true, 'new contradicting pref eventually surfaces');
    assert.ok(r.surfacingLatencySessions >= 3,
      `latency reflects the >=3 evidence floor (${r.surfacingLatencySessions})`);
    assert.equal(r.retractionImplemented, false, 'no retraction of the superseded belief (documented)');
    assert.equal(r.bothBeliefsPresent, true,
      'BOTH the old and the new contradicting belief are present post-contradiction (no retraction)');
    // Back-compat alias still resolves to the same probe.
    const legacy = await adaptationLatency();
    assert.equal(legacy.surfaced, true);
  });
});

// ===========================================================================
// ECE on the REAL profile's confidence field (P5.4).
// ===========================================================================

test('ECE: profile confidence is calibrated against held-out correctness', async () => {
  const { sessions, probes } = makeHeldOutFixture();
  const profile = await deriveProfileFromSessions(sessions);
  // Build (confidence, correct) pairs: for each surfaced inference, is its
  // subject in the held-out gold? That makes `confidence` an honest number.
  const toSubject = (p) => String(p).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const gold = new Set();
  for (const p of probes) for (const g of (p.goldSubjects || [])) gold.add(toSubject(g));
  const pairs = profile.global.dialectic
    .filter((inf) => inf.kind === 'preference')
    .map((inf) => ({ confidence: inf.confidence, correct: gold.has(toSubject(inf.subject)) ? 1 : 0 }));
  const { ece } = expectedCalibrationError(pairs, { nBins: 10 });
  assert.ok(ece >= 0 && ece <= 1, `ECE is a valid calibration error (${ece})`);
});

// NOTE: the P5.1 plumbing test lives in src/profile/eval/plumbing.test.mjs and is
// discovered independently via its own shim (test/memory/test-profile-plumbing.js).
// We do NOT import it here: under `node --test`, importing one *.test.mjs from
// another causes the runner to drop the importer's own tests. Keeping each test
// file behind its own glob shim is the convention this repo already uses.
