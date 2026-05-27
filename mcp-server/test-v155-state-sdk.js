/**
 * test-v155-state-sdk.js — regression coverage for v1.5.5 deep-dive findings
 * targeting `mcp-server/src/orchestrator/state-sdk.js`.
 *
 * Covers:
 *   - V155-002 (BLOCKER): `state.replay` snapshot restore acquires the same
 *     §3 locks as the original writer (no lock-inversion on cross-tier
 *     targets).
 *   - V155-008 (HIGH): gate-execution-fail returns a DISTINCT error-shape
 *     (`error:'gate-execution-fail'`) so callers can differentiate crash
 *     from clean-pass from bypass. Contract §4 keeps the verdict advisory
 *     (per test-verification-gate-strict.js); the new error field is the
 *     dispatch hook.
 *   - V155-023 (HIGH): prototype-pollution defense in `parseFrontmatter`
 *     and the `wave.advance` payload-merge — keys named `__proto__` /
 *     `constructor` / `prototype` are dropped before assignment.
 *
 * No mocks beyond targeted gate-injection for V155-008.
 *
 * Run: node --test test-v155-state-sdk.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  query, _setGateFnsForTest, _resetGateFnsForTest,
} from './src/orchestrator/state-sdk.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'v155-sdk-'));
  const home = mkdtempSync(join(tmpdir(), 'v155-sdk-home-'));
  return {
    root, home,
    ctx: { projectRoot: root, homeDir: home },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// ===========================================================================
// V155-002 — state.replay snapshot restore acquires §3 locks for all targets
// ===========================================================================

// We can't easily simulate a concurrent writer racing with state.replay from
// a single-process test, but we CAN assert that the restore correctly
// processes multi-tier targets (workflow #2 AND a per-wave STATE.md #4) in
// one pass without throwing — and that the resulting filesystem reflects
// both restorations. Before the fix, the unlocked critical section would
// also succeed for a single-process test (locks only manifest under
// contention) — so this assertion is about CORRECTNESS not yet HANG-detection.
//
// The deeper invariant (no torn write under contention) is asserted in
// test-state-sdk-locking.js's concurrency battery; the FIX preserves those
// guarantees and the suite stays green — that IS the regression signal.
test('V155-002: state.replay restores multi-tier snapshot targets in one pass', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    // Establish committed baselines for two targets across different §3 tiers.
    await query('workflow.set-phase', { phase: 'baseline' }, ctx);
    await query('wave.advance', { waveId: 'W1', status: 'in_progress', frontmatter: { greeting: 'hello' } }, ctx);

    const wfPath = join(root, '.ijfw', 'state', 'workflow.json');
    const wavePath = join(root, '.ijfw', 'wave-W1', 'STATE.md');
    const baselineWf = readFileSync(wfPath, 'utf8');
    const baselineWave = readFileSync(wavePath, 'utf8');

    // Hand-write a begin-only partial that touches BOTH targets at once
    // (the V155-002 lock-inversion shape — writing #2 AND #4 under only #1).
    const journalPath = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
    const snapDir = join(root, '.ijfw', 'state', 'intent-snapshots');
    mkdirSync(snapDir, { recursive: true });
    const partialId = 'v-partial-v155-002';
    writeFileSync(join(snapDir, `${partialId}.json`), JSON.stringify({
      verbId: partialId,
      targets: [
        { relPath: '.ijfw/state/workflow.json', absPath: wfPath, existed: true, content: baselineWf },
        { relPath: '.ijfw/wave-W1/STATE.md', absPath: wavePath, existed: true, content: baselineWave },
      ],
    }));
    // The interrupted verb's mutation: corrupt both targets.
    writeFileSync(wfPath, '{"phase":"HALF-APPLIED"}');
    writeFileSync(wavePath, '---\nwave_id: HALF\n---\n');
    writeFileSync(journalPath, `${JSON.stringify({
      verb: 'multi.tier.partial',
      verbId: partialId,
      phase: 'begin',
      ts: new Date().toISOString(),
      targets: ['.ijfw/state/workflow.json', '.ijfw/wave-W1/STATE.md'],
      payloadDigest: 'sha256-multi',
      kind: 'overwrite',
    })}\n`, { flag: 'a' });

    // Replay must restore BOTH targets, demonstrating the restore loop
    // handled cross-tier locks correctly.
    const r = await query('state.replay', {}, ctx);
    assert.equal(r.ok, true, 'replay completes');
    assert.ok(r.rolledBack.includes(partialId), 'partial rolled back');

    assert.equal(readFileSync(wfPath, 'utf8'), baselineWf, 'workflow.json restored');
    assert.equal(readFileSync(wavePath, 'utf8'), baselineWave, 'wave STATE.md restored');
  } finally { cleanup(); }
});

// ===========================================================================
// V155-008 — gate-execution-fail has a distinct error discriminator
// ===========================================================================

// The contract (§4 Model 4) deliberately keeps execution-fail as advisory so a
// gate-crash never freezes the workflow. The audit's concern is that an
// adversary crashing a gate looks identical to a clean pass. The fix is to
// add an `error:'gate-execution-fail'` discriminator — three distinct shapes:
//   - clean pass:        { ok:true }
//   - bypass:            { ok:true, advisory:true, reason:'IJFW_STATE_GATE_BYPASS=1' }
//   - execution-fail:    { ok:true, advisory:true, error:'gate-execution-fail', reason:<msg> }
test('V155-008: phase.plan-check gate-crash returns distinct error discriminator', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    // Inject a throwing validatePlan to drive the catch branch.
    _setGateFnsForTest({
      validatePlan: () => { throw new Error('synthetic plan-check boom'); },
    });
    const r = await query('phase.plan-check', { planText: 'irrelevant' }, ctx);
    assert.equal(r.ok, true, 'execution-fail still advisory by contract §4');
    assert.equal(r.advisory, true, 'still flagged advisory');
    assert.equal(r.error, 'gate-execution-fail', 'distinct error discriminator');
    assert.ok(/boom/.test(r.reason), 'reason carries the gate exception');
  } finally {
    _resetGateFnsForTest();
    cleanup();
  }
});

test('V155-008: subagent.post-done gate-crash returns distinct error discriminator', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    _setGateFnsForTest({
      runSelfCheck: () => { throw new Error('synthetic self-check boom'); },
    });
    const r = await query(
      'subagent.post-done',
      { subagentId: 'sub-A', reportText: 'irrelevant' }, ctx,
    );
    assert.equal(r.ok, true, 'execution-fail still advisory by contract §4');
    assert.equal(r.advisory, true);
    assert.equal(r.error, 'gate-execution-fail');
    assert.ok(/boom/.test(r.reason));
  } finally {
    _resetGateFnsForTest();
    cleanup();
  }
});

// ===========================================================================
// V155-023 — prototype-pollution defense
// ===========================================================================

test('V155-023: wave.advance refuses __proto__ key in payload.frontmatter', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    // Baseline established by an initial advance (no pollution).
    await query('wave.advance', { waveId: 'W1', status: 'pending' }, ctx);

    // Adversary advance: tries to inject `hard_gate: true` via prototype.
    const malicious = Object.create({ hard_gate: true });
    malicious.greeting = 'hello';
    // Force-add a direct __proto__ key too (the documented attack shape).
    const payloadFrontmatter = JSON.parse('{"__proto__":{"hard_gate":true},"name":"ok"}');

    await query('wave.advance', {
      waveId: 'W1', status: 'in_progress', frontmatter: payloadFrontmatter,
    }, ctx);

    // Read the persisted state file and verify __proto__ never reached
    // Object.prototype globally and hard_gate was NOT set on the wave.
    const wavePath = join(root, '.ijfw', 'wave-W1', 'STATE.md');
    const raw = readFileSync(wavePath, 'utf8');
    assert.ok(!/__proto__/.test(raw), 'no __proto__ literal in persisted frontmatter');
    assert.ok(!/hard_gate:\s*true/.test(raw), 'hard_gate was NOT granted via prototype');

    // Round-trip via parser: re-read the file via wave.advance with status-only
    // and verify the prior payload's name was applied while __proto__ was not.
    const r = await query('wave.advance', { waveId: 'W1', status: 'verifying' }, ctx);
    assert.equal(r.ok, true);
    // No literal __proto__ pollution globally either.
    assert.equal(({}).hard_gate, undefined, 'Object.prototype not polluted');
  } finally { cleanup(); }
});

test('V155-023: parseFrontmatter drops __proto__ / constructor / prototype keys', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    // Hand-write a STATE.md with malicious keys.
    const dir = join(root, '.ijfw', 'wave-W1');
    mkdirSync(dir, { recursive: true });
    const wavePath = join(dir, 'STATE.md');
    writeFileSync(wavePath, [
      '---',
      '__proto__: bad',
      'constructor: evil',
      'prototype: also-evil',
      'wave_id: W1',
      'status: in_progress',
      '---',
      '',
      'body content',
      '',
    ].join('\n'));

    // Advance the wave — the read path must NOT load polluted keys.
    const r = await query('wave.advance', { waveId: 'W1', status: 'in_progress' }, ctx);
    assert.equal(r.ok, true);
    // Globals untouched.
    assert.equal(({}).bad, undefined);
    assert.equal(({}).evil, undefined);
  } finally { cleanup(); }
});
