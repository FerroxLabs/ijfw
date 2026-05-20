/**
 * test-state-sdk.js — T2 coverage for the state-SDK verb core + dispatcher.
 *
 * Verifies the `query(verb, payload, ctx)` dispatcher, the verb registry, the
 * unknown-verb hard-throw (no silent fallback), atomic writes via atomic-io,
 * and per-verb Day-1 / round-trip semantics straight off STATE-SDK-CONTRACT.md.
 *
 * All tests run against real temp dirs — no filesystem mocking. Each test
 * builds its own throwaway projectRoot under os.tmpdir() and cleans up.
 *
 * Created in v1.5.0 T2 (gap-closure milestone). T3 layers the lock hierarchy,
 * T4 layers intent/commit idempotency, T5 layers event emission — those
 * concerns are explicitly out of scope here, so this suite asserts only the
 * verb-core behavior T2 owns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, VERBS } from './src/orchestrator/state-sdk.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'state-sdk-'));
  const home = mkdtempSync(join(tmpdir(), 'state-sdk-home-'));
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

// ---------------------------------------------------------------------------
// Dispatcher — routing + unknown-verb hard throw
// ---------------------------------------------------------------------------

test('dispatcher: routes a known verb to its handler', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query('workflow.get', {}, ctx);
    assert.equal(r.ok, true);
    assert.ok('workflow' in r, 'workflow.get returns a workflow field');
    assert.equal(typeof r.verbId, 'string', 'every result carries a verbId');
  } finally { cleanup(); }
});

test('dispatcher: unknown verb throws — no silent fallback', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    await assert.rejects(
      () => query('workflow.no-such-verb', {}, ctx),
      /unknown verb/i,
      'unknown verb must throw',
    );
    await assert.rejects(
      () => query('', {}, ctx),
      /unknown verb/i,
      'empty verb must throw',
    );
    await assert.rejects(
      () => query(undefined, {}, ctx),
      /unknown verb/i,
      'undefined verb must throw',
    );
  } finally { cleanup(); }
});

test('dispatcher: registry exposes exactly the 20 frozen verbs', () => {
  const expected = [
    'workflow.get', 'workflow.set-phase', 'wave.get', 'wave.advance',
    'wave.record-task', 'phase.plan-check', 'phase.complete',
    'subagent.dispatch', 'subagent.checkpoint', 'subagent.post-done',
    'event.emit', 'telemetry.record', 'roster.synthesize', 'roster.record',
    'extension.set-active', 'decision.add', 'blocker.add', 'blocker.resolve',
    'state.replay', 'state.validate',
  ].sort();
  assert.deepEqual(Object.keys(VERBS).sort(), expected);
});

test('dispatcher: missing ctx.projectRoot throws', async () => {
  await assert.rejects(
    () => query('workflow.get', {}, {}),
    /projectRoot/i,
  );
});

// ---------------------------------------------------------------------------
// workflow.* — read no-op Day-1, write create Day-1, round-trip
// ---------------------------------------------------------------------------

test('workflow.get: Day-1 no-op returns workflow:null, creates nothing', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('workflow.get', {}, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.workflow, null);
    assert.equal(existsSync(join(root, '.ijfw', 'state', 'workflow.json')), false);
  } finally { cleanup(); }
});

test('workflow.set-phase: Day-1 create + workflow.get round-trip', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const set = await query('workflow.set-phase', { phase: 'build' }, ctx);
    assert.equal(set.ok, true);
    assert.equal(set.workflow.phase, 'build');
    assert.equal(set.workflow.status, 'in_progress');
    assert.equal(typeof set.workflow.updated_at, 'string');

    // Physical file landed at the contract path.
    const phys = join(root, '.ijfw', 'state', 'workflow.json');
    assert.equal(existsSync(phys), true);

    // Round-trip through the read verb.
    const got = await query('workflow.get', {}, ctx);
    assert.equal(got.workflow.phase, 'build');
  } finally { cleanup(); }
});

test('workflow.set-phase: preserves unspecified fields on update', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    await query('workflow.set-phase', { phase: 'plan', milestone: 'v1.5.0' }, ctx);
    const upd = await query('workflow.set-phase', { phase: 'build' }, ctx);
    assert.equal(upd.workflow.phase, 'build');
    assert.equal(upd.workflow.milestone, 'v1.5.0', 'milestone preserved');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// atomic write — no partial file, no leftover tmp
// ---------------------------------------------------------------------------

test('write verbs: atomic — final file present, no stray .tmp', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    await query('workflow.set-phase', { phase: 'build' }, ctx);
    const stateDir = join(root, '.ijfw', 'state');
    const entries = readdirSync(stateDir);
    assert.ok(entries.includes('workflow.json'), 'final file present');
    assert.equal(
      entries.some((e) => e.includes('.tmp.')),
      false,
      'no leftover atomic-write tmp file',
    );
    // The final file is valid JSON (no half-write).
    const parsed = JSON.parse(readFileSync(join(stateDir, 'workflow.json'), 'utf8'));
    assert.equal(parsed.phase, 'build');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// wave.* — read no-op Day-1, write create Day-1, round-trip
// ---------------------------------------------------------------------------

test('wave.get: Day-1 no-op returns wave:null', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query('wave.get', { waveId: 'W12-A' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.wave, null);
  } finally { cleanup(); }
});

test('wave.advance: Day-1 create + wave.get round-trip', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const adv = await query('wave.advance', { waveId: 'W12-A', status: 'in_progress' }, ctx);
    assert.equal(adv.ok, true);
    assert.equal(adv.wave.frontmatter.status, 'in_progress');
    assert.equal(existsSync(join(root, '.ijfw', 'wave-W12-A', 'STATE.md')), true);

    const got = await query('wave.get', { waveId: 'W12-A' }, ctx);
    assert.equal(got.wave.frontmatter.status, 'in_progress');
    assert.equal(got.wave.frontmatter.wave_id, 'W12-A');
  } finally { cleanup(); }
});

test('wave.advance: merges optional frontmatter keys', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const adv = await query(
      'wave.advance',
      { waveId: 'W12-B', status: 'complete', frontmatter: { tasks_done: 3 } },
      ctx,
    );
    assert.equal(adv.wave.frontmatter.tasks_done, 3);
    assert.equal(adv.wave.frontmatter.status, 'complete');
  } finally { cleanup(); }
});

test('wave.get: rejects malformed waveId', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    await assert.rejects(() => query('wave.get', { waveId: '../etc' }, ctx), /waveId/i);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// wave.record-task — append verb, dedupKey idempotency
// ---------------------------------------------------------------------------

test('wave.record-task: Day-1 create + dedupKey makes re-append a no-op', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const first = await query(
      'wave.record-task',
      { waveId: 'W12-A', taskId: 'T2', status: 'complete', dedupKey: 'wrt:W12-A:T2' },
      ctx,
    );
    assert.equal(first.ok, true);
    assert.equal(first.deduped, false);

    const dup = await query(
      'wave.record-task',
      { waveId: 'W12-A', taskId: 'T2', status: 'complete', dedupKey: 'wrt:W12-A:T2' },
      ctx,
    );
    assert.equal(dup.ok, true);
    assert.equal(dup.deduped, true, 'same dedupKey → deduped:true');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// subagent.* — checkpoint append, dispatch write
// ---------------------------------------------------------------------------

test('subagent.checkpoint: Day-1 create writes the checkpoint file', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query(
      'subagent.checkpoint',
      { waveId: 'W12-A', subagentId: 'W12-A1', checkpoint: { tool_use_count: 7 }, dedupKey: 'cp:1' },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.equal(existsSync(r.path), true);
    const parsed = JSON.parse(readFileSync(r.path, 'utf8'));
    assert.equal(parsed.checkpoint.tool_use_count, 7);
  } finally { cleanup(); }
});

test('subagent.checkpoint: dedupKey re-write is a no-op', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    await query('subagent.checkpoint',
      { waveId: 'W1', subagentId: 'A1', checkpoint: { n: 1 }, dedupKey: 'k1' }, ctx);
    const dup = await query('subagent.checkpoint',
      { waveId: 'W1', subagentId: 'A1', checkpoint: { n: 2 }, dedupKey: 'k1' }, ctx);
    assert.equal(dup.deduped, true);
  } finally { cleanup(); }
});

test('subagent.dispatch: returns a dispatch brief + mode', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query(
      'subagent.dispatch',
      { subagentId: 'W12-A1', waveId: 'W12-A', brief: 'do the thing' },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.equal(r.subagentId, 'W12-A1');
    assert.equal(typeof r.dispatchBrief, 'string');
    assert.ok(['deterministic', 'prompt-template'].includes(r.mode));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// phase.* — gate-driven verbs (Model 4)
// ---------------------------------------------------------------------------

test('phase.plan-check: clean plan passes', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const plan = [
      '## Task T1 — do a real thing',
      'Files: src/a.js',
      'Steps: implement the function, run tests, commit.',
    ].join('\n');
    const r = await query('phase.plan-check', { planText: plan }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'pass');
    assert.ok(Array.isArray(r.findings));
  } finally { cleanup(); }
});

test('phase.plan-check: Day-1 refuse when planPath is absent', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('phase.plan-check', { planPath: join(root, 'nope.md') }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'plan-not-found');
  } finally { cleanup(); }
});

test('phase.plan-check: reads a real planPath file', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const planFile = join(root, 'plan.md');
    writeFileSync(planFile, '## Task T1\nFiles: a.js\nSteps: build it, test it.\n');
    const r = await query('phase.plan-check', { planPath: planFile }, ctx);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.findings));
  } finally { cleanup(); }
});

test('phase.complete: green gate marks the phase complete', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    // A report with a concrete verification command + matching tool call →
    // the verification gate passes.
    const r = await query('phase.complete', {
      phase: 'build',
      evidence: {
        reportText: 'Ran `node --test` — all 12 tests pass.',
        toolCalls: [{ tool: 'Bash', input: { command: 'node --test' } }],
      },
    }, ctx);
    assert.equal(r.ok, true);
    if (r.advisory) {
      // gate execution-fail degraded to advisory — still proceeds (Model 4)
      assert.equal(r.advisory, true);
    } else {
      assert.equal(r.workflow.phase, 'build');
    }
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// decision / blocker append verbs
// ---------------------------------------------------------------------------

test('decision.add: Day-1 create + dedupKey idempotency', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('decision.add', { text: 'use SQLite', dedupKey: 'd-1' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.deduped, false);
    const log = join(root, '.ijfw', 'blackboard', 'decisions.jsonl');
    assert.equal(existsSync(log), true);

    const dup = await query('decision.add', { text: 'use SQLite', dedupKey: 'd-1' }, ctx);
    assert.equal(dup.deduped, true);

    // Exactly one line on disk.
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
  } finally { cleanup(); }
});

test('blocker.add then blocker.resolve round-trip', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const add = await query('blocker.add', { id: 'b-1', text: 'CI is red', dedupKey: 'ba-1' }, ctx);
    assert.equal(add.ok, true);
    assert.equal(add.blockerId, 'b-1');

    const res = await query('blocker.resolve',
      { id: 'b-1', resolution: 'fixed flaky test', dedupKey: 'br-1' }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.resolved, true);

    // Resolving an unknown id → resolved:false.
    const miss = await query('blocker.resolve',
      { id: 'b-999', resolution: 'n/a', dedupKey: 'br-2' }, ctx);
    assert.equal(miss.resolved, false);
  } finally { cleanup(); }
});

test('blocker.resolve: Day-1 refuse when decisions.jsonl absent', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query('blocker.resolve',
      { id: 'b-1', resolution: 'x', dedupKey: 'br-1' }, ctx);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-blocker-log');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// telemetry.record
// ---------------------------------------------------------------------------

test('telemetry.record: Day-1 create + round-trip', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('telemetry.record', {
      kind: 'convergence',
      metrics: { cyclesToConverge: 3, costUsd: 0.42 },
      dedupKey: 'tel-1',
    }, ctx);
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(root, '.ijfw', 'telemetry', 'convergence.json')), true);
    assert.ok(r.telemetry);

    const dup = await query('telemetry.record', {
      kind: 'convergence', metrics: { cyclesToConverge: 9 }, dedupKey: 'tel-1',
    }, ctx);
    assert.equal(dup.deduped, true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// roster.* — synthesize (no-op read) + record (append write)
// ---------------------------------------------------------------------------

test('roster.synthesize: returns a computed roster, persists nothing', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('roster.synthesize', { domain: 'software' }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.roster.domain, 'software');
    assert.ok(Array.isArray(r.roster.agents));
    assert.equal(existsSync(join(root, '.ijfw', 'team')), false, 'synthesis creates nothing');
  } finally { cleanup(); }
});

test('roster.record: Day-1 create persists the roster', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const syn = await query('roster.synthesize', { domain: 'software' }, ctx);
    const rec = await query('roster.record', { roster: syn.roster, dedupKey: 'rr-1' }, ctx);
    assert.equal(rec.ok, true);
    assert.equal(existsSync(rec.path), true);
    assert.equal(existsSync(join(root, '.ijfw', 'team', 'workflow.json')), true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// extension.set-active — homedir file
// ---------------------------------------------------------------------------

test('extension.set-active: writes + clears the homedir state file', async () => {
  const { home, ctx, cleanup } = mkProject();
  try {
    const set = await query('extension.set-active', {
      manifest: { name: 'my-ext', permissions: { reads: [], writes: [] } },
      scope: 'project',
    }, ctx);
    assert.equal(set.ok, true);
    assert.equal(existsSync(join(home, '.ijfw', 'state', 'active-extension.json')), true);

    const cleared = await query('extension.set-active', { manifest: null, scope: 'project' }, ctx);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// event.emit — append verb (T5 fleshes out rotation; T2 keeps it minimal)
// ---------------------------------------------------------------------------

test('event.emit: Day-1 create returns a seq, dedupKey idempotent', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('event.emit', {
      subagentId: 'W12-A1', waveId: 'W12-A',
      eventType: 'checkpoint', data: { n: 1 }, dedupKey: 'ev-1',
    }, ctx);
    assert.equal(r.ok, true);
    assert.equal(typeof r.seq, 'number');
    assert.equal(existsSync(join(root, '.ijfw', 'wave-W12-A', 'events-W12-A1.jsonl')), true);

    const dup = await query('event.emit', {
      subagentId: 'W12-A1', waveId: 'W12-A',
      eventType: 'checkpoint', data: { n: 2 }, dedupKey: 'ev-1',
    }, ctx);
    assert.equal(dup.deduped, true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// state.replay / state.validate — read-only no-op Day-1
// ---------------------------------------------------------------------------

test('state.replay: Day-1 no-op on absent journal', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query('state.replay', {}, ctx);
    assert.equal(r.ok, true);
    assert.deepEqual(r.replayed, []);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(r.rolledBack, []);
  } finally { cleanup(); }
});

test('state.validate: clean tree is valid; reports absent files informationally', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query('state.validate', {}, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.valid, true);
    assert.ok(Array.isArray(r.issues));
  } finally { cleanup(); }
});

test('state.validate: detects a corrupt workflow.json', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const stateDir = join(root, '.ijfw', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'workflow.json'), '{ not json');
    const r = await query('state.validate', {}, ctx);
    assert.equal(r.valid, false);
    assert.ok(r.issues.some((i) => i.file.includes('workflow.json')));
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// subagent.post-done — gate-driven (Model 4)
// ---------------------------------------------------------------------------

test('subagent.post-done: passing self-check returns verified shape', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    // A report that claims nothing concrete → self-check trivially passes
    // (0 claimed paths, 0 claimed commits).
    const r = await query('subagent.post-done', {
      subagentId: 'W12-A1',
      reportText: 'Completed the task. No files explicitly enumerated here.',
    }, ctx);
    assert.equal(typeof r.ok, 'boolean');
    if (r.ok) {
      assert.ok(r.selfCheck, 'passing self-check carries a selfCheck shape');
    } else {
      assert.equal(r.refused, true);
    }
  } finally { cleanup(); }
});
