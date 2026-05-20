/**
 * test-verification-gate-strict.js — strict-by-default gate semantics +
 * v1.5.0 T15 (G3) state-SDK verb-precondition wiring.
 *
 * Two layers of coverage live here:
 *
 *  1. Library-level (W12-F/F4 — RT2-H1, preserved): `enforceVerificationGate`
 *     is strict-by-default; it throws `VerificationGateViolation` on red.
 *     These tests are NOT duplicated in test-verification-gate.js — that file
 *     covers `checkVerificationGate` (the lower-level non-throwing variant) and
 *     `recordViolation`/`checkVerificationGateLowConfidence`. Removing these
 *     would silently drop the strict-mode contract from the suite.
 *
 *  2. State-SDK gate-precondition wiring (T15 — G3, new): the three
 *     gate-driven verbs (`phase.complete`, `phase.plan-check`,
 *     `subagent.post-done`) implement the contract §4 Model 4 three-valued
 *     gate-failure rule:
 *       - verdict-fail → REFUSE (verb returns ok:false / refused:true; NO
 *         state mutation; intent-journal has no commit for this verbId).
 *       - execution-fail → ADVISORY (gate threw / malformed input; verb
 *         logs a loud WARN to stderr and proceeds).
 *       - MCP-unavailable / `IJFW_STATE_GATE_BYPASS=1` → documented bypass
 *         (verb logs a loud WARN, marks the result advisory, and proceeds).
 *
 * All assertions exercise the verbs via the real `query()` dispatcher against
 * real temp dirs — no mocks beyond the env var + targeted gate-injection
 * patterns used to force exceptions deterministically.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enforceVerificationGate,
  VerificationGateViolation,
} from './src/orchestrator/verification-gate.js';

// ---------------------------------------------------------------------------
// Library-level: enforceVerificationGate strict-by-default contract.
// Preserved from the prior incarnation of this file. NOT covered by
// test-verification-gate.js (that file tests checkVerificationGate /
// recordViolation / low-confidence, not the strict wrapper).
// ---------------------------------------------------------------------------

// A message that claims completion but provides NO Bash test/build evidence
// in toolCalls — this is the failure path the gate is designed to catch.
const FAILING_MSG = 'all tests pass ✅ shipped successfully';
const PASSING_MSG = 'still investigating; no claim yet.';

test('enforceVerificationGate throws VerificationGateViolation when gate fails AND strict default', () => {
  assert.throws(
    () => enforceVerificationGate(FAILING_MSG, []),
    (err) => err instanceof VerificationGateViolation,
    'strict default should throw VerificationGateViolation on failure',
  );
});

test('enforceVerificationGate returns { ok: true } when gate passes', () => {
  const r = enforceVerificationGate(PASSING_MSG, []);
  assert.equal(r.ok, true, 'no completion claim ⇒ ok: true');
});

test('enforceVerificationGate strict:false does NOT throw on failure; returns advisory result', () => {
  let thrown = null;
  let result = null;
  try {
    result = enforceVerificationGate(FAILING_MSG, [], { strict: false });
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, null, 'strict:false must not throw');
  assert.equal(result.ok, false, 'returns advisory failure result');
  assert.ok(result.violation, 'violation reason present');
});

test('VerificationGateViolation.message includes the violation reason', () => {
  try {
    enforceVerificationGate(FAILING_MSG, []);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof VerificationGateViolation);
    assert.ok(err.message.length > 0, 'message non-empty');
    assert.ok(err.violation, 'violation field populated');
  }
});

test('VerificationGateViolation extends Error and is instanceof Error', () => {
  try {
    enforceVerificationGate(FAILING_MSG, []);
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof Error, 'subclass of Error');
    assert.ok(err instanceof VerificationGateViolation, 'is VerificationGateViolation');
    assert.equal(err.name, 'VerificationGateViolation');
  }
});

// ---------------------------------------------------------------------------
// State-SDK gate-precondition wiring — T15 (G3).
//
// Each test below loads state-sdk.js fresh (so the GATE_BYPASS module constant
// reflects the env var set for that test) and exercises `query()` end-to-end.
// We assert on the result shape, the on-disk state, the intent-journal records,
// and the stderr WARN line per the contract.
// ---------------------------------------------------------------------------

let stateSdkCounter = 0;

/**
 * Load a fresh state-sdk module so its module-level `GATE_BYPASS` constant
 * picks up the current `process.env.IJFW_STATE_GATE_BYPASS`. Returns
 * `{ query, VERBS }`. We bust the import cache via a query-string suffix.
 */
async function loadFreshStateSdk() {
  stateSdkCounter += 1;
  // Cache-busting suffix forces Node to re-evaluate the module.
  const mod = await import(
    `./src/orchestrator/state-sdk.js?v=${Date.now()}-${stateSdkCounter}`
  );
  return mod;
}

function mkProject(label) {
  const root = mkdtempSync(join(tmpdir(), `vgate-strict-${label}-`));
  const home = mkdtempSync(join(tmpdir(), `vgate-strict-${label}-home-`));
  return {
    root,
    home,
    ctx: { projectRoot: root, homeDir: home },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Capture process.stderr.write calls during `fn`. Restores in finally so a
 * thrown assertion never leaks the patched stderr.
 */
async function captureStderr(fn) {
  const captured = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/**
 * Read the intent-journal entries for a project root. Returns an array of
 * { verbId, phase, ... } records. Used to assert refuse-on-red paths produce
 * NO journal commit for the refused verbId (refusals decided pre-lock never
 * enter `_withLocks` and write no begin/commit pair).
 */
function readIntentJournal(root) {
  const path = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((l) => JSON.parse(l));
}

function readWorkflow(root) {
  const path = join(root, '.ijfw', 'state', 'workflow.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// phase.complete — verdict-fail / refuse-on-red
// ---------------------------------------------------------------------------

test('T15 phase.complete: REFUSES on red verification gate (verdict-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('complete-red');
  try {
    // The evidence claims completion but supplies no verification command.
    // `enforceVerificationGate` raises VerificationGateViolation; the verb
    // must catch the typed throw and return refused.
    const r = await query('phase.complete', {
      phase: 'build',
      evidence: {
        reportText: 'all tests pass ✅ shipped successfully',
        toolCalls: [],
      },
    }, ctx);

    // Result shape: refused, NOT advisory.
    assert.equal(r.ok, false, 'red gate must produce ok:false');
    assert.equal(r.refused, true, 'red gate must mark refused:true');
    assert.equal(r.gate, 'verification');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0,
      'refused result must include a reason');
    assert.notEqual(r.advisory, true,
      'verdict-fail is NEVER advisory (that would mask the refusal)');

    // State invariants: NO mutation of workflow.json — the file must not
    // exist (Day-1 create that never ran).
    assert.equal(readWorkflow(root), null,
      'verdict-fail must not write workflow.json');

    // Intent-journal invariant: no commit for this verbId. A refusal decided
    // before `_withLocks` writes no begin/commit pair.
    const records = readIntentJournal(root);
    const commits = records.filter(
      (e) => e.verbId === r.verbId && e.phase === 'commit',
    );
    assert.equal(commits.length, 0,
      'refused verb must write no commit record for its verbId');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// phase.complete — execution-fail / degrade-on-exception
// ---------------------------------------------------------------------------

test('T15 phase.complete: DEGRADES TO ADVISORY when gate throws non-Violation (execution-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const sdk = await loadFreshStateSdk();
  const { query, _setGateFnsForTest, _resetGateFnsForTest } = sdk;
  const { root, ctx, cleanup } = mkProject('complete-throw');

  // Drive the execution-fail branch deterministically via the documented
  // test-only seam (`_setGateFnsForTest`). ESM bindings are read-only, so a
  // namespace-property assignment cannot replace the real gate; the state-SDK
  // routes every gate call through `_gateFns.*` precisely so this branch is
  // testable. The override is restored in `finally` so no state leaks.
  _setGateFnsForTest({
    enforceVerificationGate: () => {
      throw new Error('synthetic gate boom — execution-fail');
    },
  });

  try {
    let r;
    const stderr = await captureStderr(async () => {
      r = await query('phase.complete', {
        phase: 'build',
        evidence: { reportText: 'no claim here', toolCalls: [] },
      }, ctx);
    });

    // Result shape: advisory, NOT refused. ok stays true — the verb proceeded.
    assert.equal(r.ok, true, 'execution-fail must NOT refuse');
    assert.equal(r.advisory, true, 'execution-fail must mark advisory:true');
    assert.notEqual(r.refused, true,
      'execution-fail is NEVER a refusal — that would freeze the workflow');
    assert.equal(r.gate, 'verification');
    assert.ok(/boom|execution-fail/i.test(r.reason),
      'advisory reason must surface the gate-throw message');

    // Loud log: at least one stderr WARN line tagged for state-sdk + this verb.
    const warn = stderr.filter(
      (s) => s.includes('[state-sdk]') && s.includes('phase.complete')
        && s.includes('execution-fail'),
    );
    assert.ok(warn.length >= 1,
      'execution-fail must emit a loud stderr WARN line');

    // State invariant: the verb DID proceed — workflow.json was written.
    const wf = readWorkflow(root);
    assert.ok(wf, 'execution-fail must still write workflow.json (verb proceeded)');
    assert.equal(wf.phase, 'build');
    assert.equal(wf.status, 'complete');

    // Intent-journal invariant: a commit record exists for this verbId
    // (advisory verbs DO journal because they entered the critical section).
    const records = readIntentJournal(root);
    const commits = records.filter(
      (e) => e.verbId === r.verbId && e.phase === 'commit',
    );
    assert.equal(commits.length, 1,
      'advisory verb must commit the intent-journal pair');
  } finally {
    _resetGateFnsForTest();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// phase.plan-check + subagent.post-done — Model 4 execution-fail coverage
//
// Model 4 (contract §4) applies to ALL three gate-driven verbs, not just
// `phase.complete`. The same `_setGateFnsForTest` seam drives the
// gate-threw-non-Violation branch through `phase.plan-check` (validatePlan)
// and `subagent.post-done` (runSelfCheck), so the contract is proven via the
// public `query()` surface for every gate-driven verb — not just one.
// ---------------------------------------------------------------------------

test('T15 phase.plan-check: DEGRADES TO ADVISORY when gate throws non-Violation (execution-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query, _setGateFnsForTest, _resetGateFnsForTest } = await loadFreshStateSdk();
  const { ctx, cleanup } = mkProject('plancheck-throw');

  _setGateFnsForTest({
    validatePlan: () => {
      throw new Error('synthetic plan-check boom — execution-fail');
    },
  });

  try {
    let r;
    const stderr = await captureStderr(async () => {
      r = await query('phase.plan-check', { planText: '## Task t1\nDone when: x\n' }, ctx);
    });

    // Result shape per Model 4 row 2: ok:true, advisory:true, NOT refused.
    assert.equal(r.ok, true, 'execution-fail must NOT refuse');
    assert.equal(r.advisory, true, 'execution-fail must mark advisory:true');
    assert.notEqual(r.refused, true);
    assert.equal(r.gate, 'plan-check');
    assert.ok(/boom|execution-fail/i.test(r.reason),
      'advisory reason must surface the gate-throw message');

    const warn = stderr.filter(
      (s) => s.includes('[state-sdk]') && s.includes('phase.plan-check')
        && s.includes('execution-fail'),
    );
    assert.ok(warn.length >= 1,
      'plan-check execution-fail must emit a loud stderr WARN line');
  } finally {
    _resetGateFnsForTest();
    cleanup();
  }
});

test('T15 subagent.post-done: DEGRADES TO ADVISORY when gate throws non-Violation (execution-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query, _setGateFnsForTest, _resetGateFnsForTest } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('postdone-throw');

  _setGateFnsForTest({
    runSelfCheck: () => {
      throw new Error('synthetic self-check boom — execution-fail');
    },
  });

  try {
    let r;
    const stderr = await captureStderr(async () => {
      r = await query('subagent.post-done', {
        subagentId: 'sa-1',
        reportText: 'Done. No file claims here.',
        projectRoot: root,
      }, ctx);
    });

    // Result shape per Model 4 row 2: ok:true, advisory:true, NOT refused.
    assert.equal(r.ok, true, 'execution-fail must NOT refuse');
    assert.equal(r.advisory, true, 'execution-fail must mark advisory:true');
    assert.notEqual(r.refused, true);
    assert.equal(r.gate, 'post-done-self-check');
    assert.ok(/boom|execution-fail/i.test(r.reason),
      'advisory reason must surface the gate-throw message');

    const warn = stderr.filter(
      (s) => s.includes('[state-sdk]') && s.includes('subagent.post-done')
        && s.includes('execution-fail'),
    );
    assert.ok(warn.length >= 1,
      'post-done execution-fail must emit a loud stderr WARN line');
  } finally {
    _resetGateFnsForTest();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// phase.complete — IJFW_STATE_GATE_BYPASS=1 (MCP-unavailable / documented bypass)
// ---------------------------------------------------------------------------

test('T15 phase.complete: IJFW_STATE_GATE_BYPASS=1 bypasses gate (loud log + advisory)', async () => {
  process.env.IJFW_STATE_GATE_BYPASS = '1';
  const { query } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('complete-bypass');
  try {
    let r;
    const stderr = await captureStderr(async () => {
      // Evidence that would NORMALLY trigger a verdict-fail.
      r = await query('phase.complete', {
        phase: 'build',
        evidence: {
          reportText: 'all tests pass ✅ shipped successfully',
          toolCalls: [],
        },
      }, ctx);
    });

    // Bypass result is advisory, NOT refused — the verb proceeded.
    assert.equal(r.ok, true, 'bypass must NOT refuse');
    assert.equal(r.advisory, true, 'bypass must mark advisory:true');
    assert.notEqual(r.refused, true);
    assert.equal(r.gate, 'verification');
    assert.match(r.reason, /IJFW_STATE_GATE_BYPASS/,
      'bypass advisory reason must surface the env var');

    // Loud log: one stderr WARN line naming the bypass.
    const warn = stderr.filter(
      (s) => s.includes('[state-sdk]') && s.includes('phase.complete')
        && s.includes('IJFW_STATE_GATE_BYPASS'),
    );
    assert.ok(warn.length >= 1,
      'bypass must emit a loud stderr WARN line');

    // State invariant: workflow.json was written.
    const wf = readWorkflow(root);
    assert.ok(wf);
    assert.equal(wf.phase, 'build');
    assert.equal(wf.status, 'complete');
  } finally {
    delete process.env.IJFW_STATE_GATE_BYPASS;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// phase.plan-check — same three modes (refuse / degrade / bypass)
// ---------------------------------------------------------------------------

test('T15 phase.plan-check: REFUSES on red plan-check gate (verdict-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('plancheck-red');
  try {
    // An empty plan body triggers BLOCK severity findings in validatePlan
    // (no task headings, no steps). The verb must catch the !result.ok and
    // refuse — without ever entering `_withLocks`.
    const r = await query('phase.plan-check', { planText: '' }, ctx);

    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.equal(r.gate, 'plan-check');
    assert.ok(Array.isArray(r.findings) && r.findings.length > 0,
      'refused plan-check must surface the BLOCK findings');
    assert.notEqual(r.advisory, true);

    // Workflow.json was never written.
    assert.equal(readWorkflow(root), null,
      'verdict-fail plan-check must not write workflow.json');
    // No commit record for the refused verbId.
    const records = readIntentJournal(root);
    const commits = records.filter(
      (e) => e.verbId === r.verbId && e.phase === 'commit',
    );
    assert.equal(commits.length, 0);
  } finally { cleanup(); }
});

test('T15 phase.plan-check: IJFW_STATE_GATE_BYPASS=1 bypasses gate (loud log + advisory)', async () => {
  process.env.IJFW_STATE_GATE_BYPASS = '1';
  const { query } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('plancheck-bypass');
  try {
    let r;
    const stderr = await captureStderr(async () => {
      // Bad plan that would normally refuse — bypass must proceed anyway.
      r = await query('phase.plan-check', { planText: '' }, ctx);
    });
    assert.equal(r.ok, true);
    assert.equal(r.advisory, true);
    assert.equal(r.gate, 'plan-check');
    assert.match(r.reason, /IJFW_STATE_GATE_BYPASS/);

    const warn = stderr.filter(
      (s) => s.includes('[state-sdk]') && s.includes('phase.plan-check')
        && s.includes('IJFW_STATE_GATE_BYPASS'),
    );
    assert.ok(warn.length >= 1,
      'plan-check bypass must emit a loud stderr WARN line');

    // Workflow.json got a bypass marker.
    const wf = readWorkflow(root);
    assert.ok(wf);
    assert.equal(wf.plan_check?.verdict, 'bypass');
  } finally {
    delete process.env.IJFW_STATE_GATE_BYPASS;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// subagent.post-done — verdict-fail / refuse-on-red
//
// `subagent.post-done` is a READ verb (no state mutation), but its gate
// (`runSelfCheck`) follows the same Model 4 split. Refuse when files/commits
// claimed in reportText aren't present on disk.
// ---------------------------------------------------------------------------

test('T15 subagent.post-done: REFUSES when self-check finds claimed file missing (verdict-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('postdone-red');
  try {
    // Report claims a file that doesn't exist on disk. runSelfCheck →
    // verdict='FAILED' → verdict-fail → refused.
    const report = [
      'Done. Created the following file:',
      '- src/nonexistent-file-xyz.js',
      '',
      'Verified with `npm test`.',
    ].join('\n');

    const r = await query('subagent.post-done', {
      subagentId: 'sa-1',
      reportText: report,
      projectRoot: root,
    }, ctx);

    assert.equal(r.ok, false, 'missing-file claim must produce ok:false');
    assert.equal(r.refused, true);
    assert.equal(r.gate, 'post-done-self-check');
    assert.match(r.reason, /self-check FAILED/);
    assert.notEqual(r.advisory, true);
  } finally { cleanup(); }
});

test('T15 subagent.post-done: IJFW_STATE_GATE_BYPASS=1 bypasses a would-be refusal (loud log + advisory)', async () => {
  process.env.IJFW_STATE_GATE_BYPASS = '1';
  const { query } = await loadFreshStateSdk();
  const { root, ctx, cleanup } = mkProject('postdone-bypass');
  try {
    const report = [
      'Done. Created the following file:',
      '- src/missing-but-bypassed.js',
    ].join('\n');

    let r;
    const stderr = await captureStderr(async () => {
      r = await query('subagent.post-done', {
        subagentId: 'sa-1',
        reportText: report,
        projectRoot: root,
      }, ctx);
    });

    // Bypass downgrades the would-be refusal to a loud advisory.
    assert.equal(r.ok, true, 'bypass must not refuse');
    assert.equal(r.advisory, true);
    assert.equal(r.gate, 'post-done-self-check');
    assert.match(r.reason, /IJFW_STATE_GATE_BYPASS/);
    // The selfCheck.verified field must remain false — the bypass doesn't
    // lie about what enforcement actually saw.
    assert.equal(r.selfCheck?.verified, false,
      'bypass advisory must still report verified:false');

    const warn = stderr.filter(
      (s) => s.includes('[state-sdk]') && s.includes('subagent.post-done')
        && s.includes('IJFW_STATE_GATE_BYPASS'),
    );
    assert.ok(warn.length >= 1,
      'post-done bypass must emit a loud stderr WARN line');
    // The WARN must surface the would-refuse reason so the operator can audit
    // what the gate would have blocked.
    assert.ok(warn[0].includes('would-refuse'),
      'WARN line must name what enforcement was skipped');
  } finally {
    delete process.env.IJFW_STATE_GATE_BYPASS;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Dispatcher outcome tag — Model 4 'refused' / 'advisory' wiring.
//
// Contract §3: every query() emits a tap event with `outcome ∈
// {ok, refused, advisory, error}`. The dispatcher MUST classify a Model 4
// gate-refusal as 'refused' (not 'error') and an execution-fail as 'advisory'
// (not 'ok'). This proves the verb-level result shape flows into the
// observability surface correctly.
// ---------------------------------------------------------------------------

test('T15 dispatcher: refused result on red gate carries refused:true + ok:false', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdk();
  const { ctx, cleanup } = mkProject('dispatch-refused');
  try {
    const r = await query('phase.complete', {
      phase: 'build',
      evidence: { reportText: 'DONE — shipped ✅', toolCalls: [] },
    }, ctx);
    // The outer dispatcher wrapper must preserve `refused:true` from the
    // handler and propagate ok:false (it would be a bug to coerce to ok:true).
    assert.equal(r.ok, false);
    assert.equal(r.refused, true);
    assert.equal(typeof r.verbId, 'string');
  } finally { cleanup(); }
});
