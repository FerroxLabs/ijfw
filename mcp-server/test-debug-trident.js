/**
 * test-debug-trident.js — v1.5.0 T29 (W2): Trident-powered debug loop.
 *
 * Falsifiable proof for Moat #3: a multi-cycle debug campaign on a
 * deterministic, synthetic bug. The investigator stalls on cycle 2 (the
 * single-lens hypothesis tree refutes itself with no remaining
 * candidates); the orchestrator MUST dispatch codex + gemini in parallel
 * to generate competing hypotheses; one of those competing hypotheses
 * MUST be exercised in cycle 3 and resolve the campaign.
 *
 * Each test uses a real temp dir + real `state-sdk.query('telemetry.record')`
 * call. No mocks of the SDK; the only stubs are the per-cycle dispatch +
 * tridentDispatch DI hooks (mirrors how cross-orchestrator.js tests stub
 * the lens executor while exercising the real state path).
 *
 * Determinism: seed-derived hypothesis text + a fixed run-stamp so the
 * receipt and telemetry record are byte-stable across runs.
 *
 * Run: node --test test-debug-trident.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runDebugCampaign,
  hypothesisTreeSignature,
  detectStall,
  generateCompetingHypotheses,
  normaliseLensResponse,
  mergeHypothesesPatch,
  DEBUG_OUTCOMES,
} from './src/orchestrator/debug-trident.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'debug-trident-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// Read the telemetry file the state-SDK telemetry.record verb writes.
function readTelemetry(root) {
  const p = join(root, '.ijfw', 'telemetry', 'convergence.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ===========================================================================
// PART A — unit-level helpers
// ===========================================================================

// --- A1: hypothesisTreeSignature is order-independent ----------------------
test('signature: tree-signature is stable across row + key insertion order', () => {
  const a = [
    { id: 'H1', hypothesis: 'cookie samesite', status: 'open', evidence: '', refuted_by: '' },
    { id: 'H2', hypothesis: 'redirect URL', status: 'refuted', evidence: 'grep ok', refuted_by: 'H1' },
  ];
  const b = [
    { refuted_by: 'H1', evidence: 'grep ok', status: 'refuted', hypothesis: 'redirect URL', id: 'H2' },
    { evidence: '', refuted_by: '', status: 'open', hypothesis: 'cookie samesite', id: 'H1' },
  ];
  assert.equal(hypothesisTreeSignature(a), hypothesisTreeSignature(b));
});

// --- A2: stall detection covers the three documented triggers -------------
test('stall: INVESTIGATION_INCONCLUSIVE terminator triggers stall', () => {
  const s = detectStall({ terminator: 'INVESTIGATION_INCONCLUSIVE', signature: 'a', priorSignature: 'b' });
  assert.equal(s.stalled, true);
  assert.equal(s.reason, 'inconclusive_terminator');
});
test('stall: byte-identical hypothesis tree across cycles triggers stall', () => {
  const s = detectStall({ terminator: 'CONTINUE', signature: 'abc', priorSignature: 'abc' });
  assert.equal(s.stalled, true);
  assert.equal(s.reason, 'byte_identical_tree');
});
test('stall: DEBUG_COMPLETE never triggers stall even with identical signature', () => {
  const s = detectStall({ terminator: 'DEBUG_COMPLETE', signature: 'abc', priorSignature: 'abc' });
  assert.equal(s.stalled, false);
});
test('stall: forceTrident bypasses condition checks', () => {
  const s = detectStall({ terminator: 'CONTINUE', signature: 'a', priorSignature: 'b', forceTrident: true });
  assert.equal(s.stalled, true);
  assert.equal(s.reason, 'forced');
});

// --- A3: normaliseLensResponse rejects malformed input --------------------
test('normalise: malformed lens response coerces to zero hypotheses', () => {
  const r = normaliseLensResponse(null, 'codex');
  assert.equal(r.ok, false);
  assert.equal(r.hypotheses.length, 0);
});
test('normalise: drops rows without hypothesis text', () => {
  const r = normaliseLensResponse({ hypotheses: [
    { hypothesis: '  cookie issue  ', rationale: 'x' },
    { rationale: 'no hypothesis text' },
    null,
    { hypothesis: '' },
  ] }, 'codex');
  assert.equal(r.ok, true);
  assert.equal(r.hypotheses.length, 1);
  assert.equal(r.hypotheses[0].hypothesis, 'cookie issue');
});

// --- A4: generateCompetingHypotheses dedups + survives per-lens throw ----
test('competing: per-lens dispatch throw is captured as ok:false, campaign continues', async () => {
  let codexCalled = false;
  let geminiCalled = false;
  const stub = async ({ lens }) => {
    if (lens === 'codex') { codexCalled = true; throw new Error('codex stub explodes'); }
    if (lens === 'gemini') {
      geminiCalled = true;
      return { lens, hypotheses: [{ hypothesis: 'async race in middleware' }] };
    }
    return { lens, hypotheses: [] };
  };
  const r = await generateCompetingHypotheses({
    evidencePack: 'logs+repro',
    currentHypotheses: [{ id: 'H1', hypothesis: 'cookie samesite', status: 'refuted' }],
    lenses: ['codex', 'gemini'],
    tridentDispatch: stub,
  });
  assert.equal(codexCalled, true);
  assert.equal(geminiCalled, true);
  assert.equal(r.perLens.length, 2);
  const codexRes = r.perLens.find((p) => p.lens === 'codex');
  const geminiRes = r.perLens.find((p) => p.lens === 'gemini');
  assert.equal(codexRes.ok, false);
  assert.match(codexRes.reason, /codex stub explodes/);
  assert.equal(geminiRes.ok, true);
  assert.equal(r.totalAdded, 1);
  assert.equal(r.novelHypotheses[0].from, 'trident:gemini');
});

test('competing: deduplicates already-existing hypothesis text', async () => {
  const stub = async ({ lens }) => ({
    lens,
    hypotheses: [
      // Already in tree — should be dropped.
      { hypothesis: 'Cookie SameSite' },
      // Novel.
      { hypothesis: `${lens} unique theory` },
    ],
  });
  const r = await generateCompetingHypotheses({
    evidencePack: 'e',
    currentHypotheses: [{ id: 'H1', hypothesis: 'cookie samesite', status: 'refuted' }],
    lenses: ['codex', 'gemini'],
    tridentDispatch: stub,
  });
  // Two lenses, each proposes one novel + one duplicate → 2 novel rows.
  assert.equal(r.totalAdded, 2);
  const sources = r.novelHypotheses.map((h) => h.from).sort();
  assert.deepEqual(sources, ['trident:codex', 'trident:gemini']);
});

// --- A5: mergeHypothesesPatch handles replace + append --------------------
test('merge: patch replaces matching ids and appends new ones', () => {
  const existing = [
    { id: 'H1', hypothesis: 'a', status: 'open' },
    { id: 'H2', hypothesis: 'b', status: 'open' },
  ];
  const merged = mergeHypothesesPatch(existing, [
    { id: 'H1', status: 'refuted', evidence: 'grep' },  // replace
    { id: 'H3', hypothesis: 'c', status: 'open' },       // append by id
    { hypothesis: 'd', status: 'open' },                  // append, auto-id
  ]);
  assert.equal(merged.length, 4);
  assert.equal(merged[0].status, 'refuted');
  assert.equal(merged[0].evidence, 'grep');
  assert.equal(merged[2].id, 'H3');
  assert.equal(merged[3].id, 'H4');  // auto-assigned
});

// ===========================================================================
// PART B — multi-cycle campaign: the field-validation proof
// ===========================================================================

// --- B1: campaign that stalls and escalates to Trident, resolves ---------
test('campaign: stalls cycle-2, Trident generates competing hypotheses, resolves cycle-3', async (t) => {
  const { root, cleanup } = mkProject();
  t.after(cleanup);

  // Synthetic bug: "session cookie dropped after login redirect". The
  // investigator (single-lens) tries H1=cookie-samesite, then H2=redirect-
  // url. Both refute. Cycle 2 returns INVESTIGATION_INCONCLUSIVE → stall.
  // Cycle 3 picks up the Trident-supplied H3 from gemini ("async middleware
  // race") and resolves.

  const dispatchCalls = [];
  const tridentCalls = [];

  const dispatch = async ({ cycle, hypotheses }) => {
    dispatchCalls.push({ cycle, hypothesisCount: hypotheses.length });
    if (cycle === 1) {
      return {
        terminator: 'CONTINUE',
        hypothesesPatch: [
          { id: 'H1', hypothesis: 'cookie samesite drops on cross-origin', status: 'refuted', evidence: 'curl shows SameSite=Lax already' },
          { id: 'H2', hypothesis: 'wrong redirect URL in handler', status: 'open' },
        ],
      };
    }
    if (cycle === 2) {
      return {
        terminator: 'INVESTIGATION_INCONCLUSIVE',
        hypothesesPatch: [
          { id: 'H2', hypothesis: 'wrong redirect URL in handler', status: 'refuted', evidence: 'grep handler returns /dashboard literal' },
        ],
      };
    }
    if (cycle === 3) {
      // The Trident-added rows are now in the tree. The investigator picks
      // the gemini-contributed row and resolves.
      const tridentRow = hypotheses.find((h) => typeof h?.from === 'string' && h.from.startsWith('trident:'));
      assert.ok(tridentRow, 'cycle 3 must see a trident-contributed hypothesis row');
      return {
        terminator: 'DEBUG_COMPLETE',
        rootCause: tridentRow.hypothesis,
        fix: 'server/middleware/auth.js:42 — await sessionPersist before redirect',
        resolutionLens: tridentRow.from.replace(/^trident:/, ''),
      };
    }
    throw new Error(`unexpected cycle ${cycle}`);
  };

  const tridentDispatch = async ({ lens, currentHypotheses }) => {
    tridentCalls.push({ lens, currentCount: currentHypotheses.length });
    // Both lenses produce two candidates. Lens-specific to make the
    // provenance assertion meaningful.
    if (lens === 'codex') {
      return {
        lens,
        hypotheses: [
          { hypothesis: 'Set-Cookie header stripped by reverse-proxy', rationale: 'codex traced call-graph through nginx config' },
          { hypothesis: 'JWT signing key rotated mid-flight', rationale: 'codex saw key-rotation cron job' },
        ],
      };
    }
    if (lens === 'gemini') {
      return {
        lens,
        hypotheses: [
          { hypothesis: 'async middleware race: redirect fires before session persists', rationale: 'gemini cross-referenced session lib docs' },
          { hypothesis: 'CSRF token regenerated on every request, dropping login state', rationale: 'gemini broader scan of cookie middleware' },
        ],
      };
    }
    return { lens, hypotheses: [] };
  };

  const result = await runDebugCampaign({
    sessionId: 'auth-redirect-loop',
    symptoms: 'POST /login → 302 /dashboard, but next request lands on /login (no session cookie)',
    hypotheses: [],
    dispatch,
    tridentDispatch,
    tridentLenses: ['codex', 'gemini'],
    maxCycles: 6,
    evidencePack: 'logs.txt + browser-network.har + reproducible-curl-script',
    projectRoot: root,
    runStamp: '2026-05-20T19:00:00.000Z',
  });

  // Behavioural assertions —
  // (1) Trident was invoked (the headline moat capability).
  assert.equal(result.tridentInvocations, 1, 'exactly one Trident escalation');
  assert.equal(tridentCalls.length, 2, 'both lenses (codex + gemini) dispatched in parallel');
  const lensesCalled = tridentCalls.map((c) => c.lens).sort();
  assert.deepEqual(lensesCalled, ['codex', 'gemini']);

  // (2) The campaign resolved, not exhausted.
  assert.equal(result.outcome, DEBUG_OUTCOMES.RESOLVED);
  assert.equal(result.cycles, 3);
  assert.equal(result.stalls, 1);

  // (3) The resolution came from a Trident-contributed hypothesis.
  assert.ok(result.resolutionLens === 'codex' || result.resolutionLens === 'gemini',
    `resolutionLens should be codex|gemini, got ${result.resolutionLens}`);
  assert.match(result.rootCause || '', /async|cookie|jwt|csrf|proxy/i);

  // (4) The hypothesis tree carries provenance — the receipt can trace
  //     which lens contributed which row.
  const tridentRows = result.hypothesesFinal.filter((h) => typeof h.from === 'string' && h.from.startsWith('trident:'));
  assert.ok(tridentRows.length >= 2, `expected ≥2 trident-contributed rows, got ${tridentRows.length}`);
  const codexRows = tridentRows.filter((h) => h.from === 'trident:codex');
  const geminiRows = tridentRows.filter((h) => h.from === 'trident:gemini');
  assert.ok(codexRows.length >= 1, 'at least one codex-contributed row');
  assert.ok(geminiRows.length >= 1, 'at least one gemini-contributed row');

  // (5) Telemetry was recorded via state-SDK.
  const tel = readTelemetry(root);
  assert.ok(tel, 'telemetry file written');
  assert.ok(Array.isArray(tel.records) && tel.records.length === 1, 'one record');
  assert.equal(tel.records[0].kind, 'debug-campaign');
  assert.equal(tel.records[0].metrics.outcome, DEBUG_OUTCOMES.RESOLVED);
  assert.equal(tel.records[0].metrics.tridentInvocations, 1);
  assert.equal(tel.records[0].metrics.resolved, true);
  assert.ok(tel.records[0].metrics.hypothesesCompetingCount >= 2);

  // (6) Cycle log captures the Trident step.
  const tridentCycle = result.cyclesLog.find((c) => c.trident);
  assert.ok(tridentCycle, 'cycle log records the trident escalation');
  assert.deepEqual(tridentCycle.trident.lensesInvoked.sort(), ['codex', 'gemini']);
  assert.deepEqual(tridentCycle.trident.lensesOk.sort(), ['codex', 'gemini']);
});

// --- B2: campaign where Trident also dries up → TRIDENT_DRY outcome -------
test('campaign: Trident proposes only duplicates → outcome=trident_no_new_hypotheses', async (t) => {
  const { root, cleanup } = mkProject();
  t.after(cleanup);

  const dispatch = async ({ cycle, hypotheses: _hypotheses }) => {
    void _hypotheses;
    if (cycle === 1) {
      return {
        terminator: 'INVESTIGATION_INCONCLUSIVE',
        hypothesesPatch: [
          { id: 'H1', hypothesis: 'theory A', status: 'refuted' },
          { id: 'H2', hypothesis: 'theory B', status: 'refuted' },
        ],
      };
    }
    return { terminator: 'CONTINUE' };
  };
  // Both lenses propose ONLY duplicates of refuted rows — Trident dry.
  const tridentDispatch = async ({ lens }) => ({
    lens,
    hypotheses: [
      { hypothesis: 'theory A' },
      { hypothesis: 'theory B' },
    ],
  });

  const result = await runDebugCampaign({
    sessionId: 'dry-trident',
    symptoms: 'X != Y',
    dispatch,
    tridentDispatch,
    maxCycles: 4,
    projectRoot: root,
    runStamp: '2026-05-20T19:01:00.000Z',
  });

  assert.equal(result.outcome, DEBUG_OUTCOMES.TRIDENT_DRY);
  assert.equal(result.tridentInvocations, 1);
  assert.equal(result.hypothesesAdded, 0);

  const tel = readTelemetry(root);
  assert.equal(tel.records[0].metrics.outcome, DEBUG_OUTCOMES.TRIDENT_DRY);
});

// --- B3: dispatch throw is a clean failure, no telemetry corruption ------
test('campaign: dispatch throw produces outcome=campaign_failed; telemetry still written', async (t) => {
  const { root, cleanup } = mkProject();
  t.after(cleanup);

  const dispatch = async () => { throw new Error('investigator subagent timed out'); };
  const tridentDispatch = async ({ lens }) => ({ lens, hypotheses: [] });

  const result = await runDebugCampaign({
    sessionId: 'dispatch-throws',
    symptoms: 'never reached',
    dispatch,
    tridentDispatch,
    maxCycles: 3,
    projectRoot: root,
    runStamp: '2026-05-20T19:02:00.000Z',
  });

  assert.equal(result.outcome, DEBUG_OUTCOMES.FAILED);
  assert.match(result.lastError, /investigator subagent timed out/);
  assert.equal(result.tridentInvocations, 0);

  const tel = readTelemetry(root);
  assert.ok(tel);
  assert.equal(tel.records[0].metrics.outcome, DEBUG_OUTCOMES.FAILED);
});

// --- B4: campaign without projectRoot skips telemetry but still runs ------
test('campaign: no projectRoot → telemetry suppressed, campaign still completes', async () => {
  const dispatch = async ({ cycle }) => {
    if (cycle === 1) {
      return { terminator: 'DEBUG_COMPLETE', rootCause: 'rc', fix: 'f' };
    }
    return { terminator: 'CONTINUE' };
  };
  const tridentDispatch = async ({ lens }) => ({ lens, hypotheses: [] });
  const result = await runDebugCampaign({
    sessionId: 'no-root',
    symptoms: 'x',
    dispatch,
    tridentDispatch,
    maxCycles: 2,
  });
  assert.equal(result.outcome, DEBUG_OUTCOMES.RESOLVED);
});

// --- B5: telemetry.record dedups on repeat campaign with same runStamp ----
test('telemetry: identical (sessionId, runStamp) is dedup-recorded by state-SDK', async (t) => {
  const { root, cleanup } = mkProject();
  t.after(cleanup);

  const dispatch = async () => ({ terminator: 'DEBUG_COMPLETE', rootCause: 'r', fix: 'f' });
  const tridentDispatch = async ({ lens }) => ({ lens, hypotheses: [] });
  const common = {
    sessionId: 'dedup',
    symptoms: 's',
    dispatch,
    tridentDispatch,
    maxCycles: 2,
    projectRoot: root,
    runStamp: '2026-05-20T19:03:00.000Z',
  };
  await runDebugCampaign(common);
  await runDebugCampaign(common);  // same dedupKey → SDK dedups.
  const tel = readTelemetry(root);
  assert.equal(tel.records.length, 1, 'state-SDK dedup prevents duplicate record');
});
