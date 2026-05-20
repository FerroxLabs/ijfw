/**
 * test-subagent-event-stream.js — v1.5.0 T19 (G1).
 *
 * Falsifiable proof: the parent sees a dispatched subagent's progress LIVE
 * via the per-subagent event log. Every verb the subagent calls fires the
 * dispatcher's `_emitEvent` observability tap (T5); the parent polls
 * `pollEvents({projectRoot, waveId, subagentId, since})` and sees the
 * subagent's verb stream in real time.
 *
 * The "live execution" is simulated by directly calling state-SDK verbs in
 * a context whose `subagentId` is set — exactly what a dispatched subagent
 * would do via the same `query()` core. The dispatcher's tap is identical.
 *
 * SCOPE: T19 owns the dispatch verb + event stream. T20 (truncation
 * recovery) consumes this same stream from the parent.
 *
 * ESM, Node >=18, zero new deps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from './src/orchestrator/state-sdk.js';
import { pollEvents, resolveEventLogPath } from './src/orchestrator/state-events.js';
import {
  dispatchSubagent,
  streamSubagentEvents,
} from './src/orchestrator/subagent-telemetry.js';
import { composeDispatchEnv } from './src/dispatch-planner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 't19-event-stream-'));
  const home = mkdtempSync(join(tmpdir(), 't19-event-stream-home-'));
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

// `_emitEvent` is fire-and-forget on a microtask queue inside `state-events`.
// Tests sleep briefly so the tap-append work settles before assertions.
async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 1. composeDispatchEnv — pure compute, env-var contract.
// ---------------------------------------------------------------------------

test('composeDispatchEnv: bakes in the SDK contract env vars', () => {
  const env = composeDispatchEnv({
    projectRoot: '/tmp/x',
    waveId: 'W12-A',
    subagentId: 'W12-A1',
    isolation: 'worktree',
    parentEnv: { IJFW_SESSION_ID: 'sess-123' },
  });
  assert.equal(env.IJFW_PROJECT_DIR, '/tmp/x');
  assert.equal(env.IJFW_PARENT_PROJECT_ROOT, '/tmp/x');
  assert.equal(env.IJFW_WAVE_ID, 'W12-A');
  assert.equal(env.IJFW_SUBAGENT_ID, 'W12-A1');
  assert.equal(env.IJFW_ISOLATION, 'worktree');
  assert.equal(env.IJFW_SESSION_ID, 'sess-123');
});

test('composeDispatchEnv: caller extraEnv overrides SDK contract', () => {
  const env = composeDispatchEnv({
    projectRoot: '/tmp/x',
    waveId: 'W12-A',
    subagentId: 'W12-A1',
    extraEnv: { IJFW_PROJECT_DIR: '/override', CUSTOM_VAR: 'hello' },
  });
  assert.equal(env.IJFW_PROJECT_DIR, '/override');
  assert.equal(env.CUSTOM_VAR, 'hello');
});

test('composeDispatchEnv: defaults isolation to worktree, parent root to projectRoot', () => {
  const env = composeDispatchEnv({
    projectRoot: '/tmp/x',
    waveId: 'W1',
    subagentId: 'A1',
  });
  assert.equal(env.IJFW_ISOLATION, 'worktree');
  assert.equal(env.IJFW_PARENT_PROJECT_ROOT, '/tmp/x');
  assert.equal(env.IJFW_SESSION_ID, undefined, 'IJFW_SESSION_ID omitted when not in parentEnv');
});

test('composeDispatchEnv: rejects missing required fields', () => {
  assert.throws(() => composeDispatchEnv({}), /projectRoot required/);
  assert.throws(() => composeDispatchEnv({ projectRoot: '/x' }), /waveId required/);
  assert.throws(
    () => composeDispatchEnv({ projectRoot: '/x', waveId: 'W1' }),
    /subagentId required/,
  );
});

// ---------------------------------------------------------------------------
// 2. subagent.dispatch verb — deterministic brief + env-var passthrough.
// ---------------------------------------------------------------------------

test('subagent.dispatch: deterministic brief bakes in env passthrough', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query(
      'subagent.dispatch',
      {
        subagentId: 'W19-A1',
        waveId: 'W19-A',
        brief: 'do the falsifiable thing',
        role: 'implementer',
        isolation: 'worktree',
        env: { CUSTOM_KEY: 'custom_value' },
      },
      ctx,
    );
    assert.equal(r.ok, true);
    assert.equal(r.subagentId, 'W19-A1');
    assert.equal(r.waveId, 'W19-A');
    assert.equal(r.isolation, 'worktree');
    assert.ok(['deterministic', 'prompt-template'].includes(r.mode));
    // The brief is platform-agnostic markdown — verify every contract field
    // is baked into it so a best-effort prompt-template platform can read
    // the env-var contract verbatim from the brief itself.
    assert.match(r.dispatchBrief, /# Subagent dispatch — W19-A1 \(wave W19-A\)/);
    assert.match(r.dispatchBrief, /Role: implementer/);
    assert.match(r.dispatchBrief, /Isolation: worktree/);
    assert.match(r.dispatchBrief, /Event log: \.ijfw\/wave-W19-A\/events-W19-A1\.jsonl/);
    assert.match(r.dispatchBrief, /IJFW_PROJECT_DIR=/);
    assert.match(r.dispatchBrief, /IJFW_WAVE_ID=W19-A/);
    assert.match(r.dispatchBrief, /IJFW_SUBAGENT_ID=W19-A1/);
    assert.match(r.dispatchBrief, /IJFW_ISOLATION=worktree/);
    assert.match(r.dispatchBrief, /CUSTOM_KEY=custom_value/);
    assert.match(r.dispatchBrief, /do the falsifiable thing/);
    // inheritedEnv mirrors what the subagent process should inherit.
    assert.equal(r.inheritedEnv.IJFW_PROJECT_DIR, root);
    assert.equal(r.inheritedEnv.IJFW_WAVE_ID, 'W19-A');
    assert.equal(r.inheritedEnv.IJFW_SUBAGENT_ID, 'W19-A1');
    assert.equal(r.inheritedEnv.IJFW_ISOLATION, 'worktree');
    assert.equal(r.inheritedEnv.CUSTOM_KEY, 'custom_value');
    // Event-log path is returned so the parent can reach the stream
    // immediately, without re-resolving.
    assert.equal(r.eventLogPath, resolveEventLogPath(root, 'W19-A', 'W19-A1'));
  } finally { cleanup(); }
});

test('subagent.dispatch: mode = deterministic when ctx.platform=claude', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query(
      'subagent.dispatch',
      { subagentId: 'A1', waveId: 'W1', brief: 'x' },
      { ...ctx, platform: 'claude' },
    );
    assert.equal(r.mode, 'deterministic');
  } finally { cleanup(); }
});

test('subagent.dispatch: mode = prompt-template on a generic platform', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    const r = await query(
      'subagent.dispatch',
      { subagentId: 'A1', waveId: 'W1', brief: 'x' },
      ctx,
    );
    assert.equal(r.mode, 'prompt-template');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 3. dispatchSubagent helper — same shape as the raw verb.
// ---------------------------------------------------------------------------

test('dispatchSubagent: thin wrapper returns the verb result verbatim', async () => {
  const { root, cleanup } = mkProject();
  try {
    const r = await dispatchSubagent('W19-B', 'W19-B1', 'reviewer', 'review the PR', root, {
      isolation: 'shared',
      env: { REVIEW_SCOPE: 'security' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.subagentId, 'W19-B1');
    assert.equal(r.isolation, 'shared');
    assert.equal(r.inheritedEnv.REVIEW_SCOPE, 'security');
    assert.match(r.dispatchBrief, /Role: reviewer/);
    assert.match(r.dispatchBrief, /Isolation: shared/);
  } finally { cleanup(); }
});

test('dispatchSubagent: rejects empty brief', async () => {
  const { root, cleanup } = mkProject();
  try {
    await assert.rejects(
      () => dispatchSubagent('W1', 'A1', 'role', '', root),
      /non-empty brief/,
    );
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 4. THE CORE PROOF — parent sees the subagent's verb stream live.
// ---------------------------------------------------------------------------

test('parent sees subagent verbs arrive live in the event stream', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    // 1) PARENT dispatches the subagent. This itself fires a `subagent.dispatch`
    //    event for the PARENT (subagentId:'parent') — NOT the subagent we
    //    just registered. The subagent's own stream starts when IT calls
    //    its first verb.
    const dispatch = await dispatchSubagent('W19-C', 'W19-C1', 'implementer',
      'do the work', root, {});
    assert.equal(dispatch.ok, true);

    // 2) PARENT polls the subagent's event log BEFORE any subagent verb fires.
    //    The log doesn't exist yet — the poller returns an empty stream with
    //    cursor 0.
    const before = streamSubagentEvents('W19-C', 'W19-C1', root, 0);
    assert.deepEqual(before.events, []);
    assert.equal(before.cursor, 0);

    // 3) SIMULATE SUBAGENT EXECUTION. The dispatched subagent runs in a context
    //    whose `subagentId` is set to the dispatch id — exactly what a real
    //    Claude subagent harness would do. Every verb fires `_emitEvent` per T5.
    //
    //    Per contract §5 the tap routes by (waveId, subagentId): wave-scoped
    //    verbs land on `.ijfw/wave-<waveId>/events-<subId>.jsonl`. A verb
    //    whose payload has no waveId falls through to the system stream
    //    (`.ijfw/state/events-<subId>.jsonl`) — those aren't visible to a
    //    `pollEvents` rooted at the wave. A real dispatched subagent always
    //    works inside its wave, so its verbs DO carry waveId.
    const subCtx = { projectRoot: root, subagentId: 'W19-C1' };
    await query('wave.get', { waveId: 'W19-C' }, subCtx);
    await query('subagent.checkpoint', {
      waveId: 'W19-C',
      subagentId: 'W19-C1',
      checkpoint: { tool_use_count: 1, last_action: 'read file' },
      dedupKey: 'ck-1',
    }, subCtx);
    await query('subagent.checkpoint', {
      waveId: 'W19-C',
      subagentId: 'W19-C1',
      checkpoint: { tool_use_count: 2, last_action: 'edit file' },
      dedupKey: 'ck-2',
    }, subCtx);
    await query('event.emit', {
      waveId: 'W19-C',
      subagentId: 'W19-C1',
      eventType: 'progress',
      data: { phase: 'compile' },
      dedupKey: 'ev-1',
    }, subCtx);

    // 4) Tap is fire-and-forget — settle the microtask queue.
    await settle();

    // 5) PARENT polls again. The subagent's verb stream is now visible.
    const after = streamSubagentEvents('W19-C', 'W19-C1', root, 0);
    assert.ok(after.events.length >= 4, `expected >=4 events, got ${after.events.length}`);
    const verbs = after.events.map((e) => e.verb);
    assert.ok(verbs.includes('wave.get'), 'wave.get appeared in stream');
    // subagent.checkpoint fires the tap once per call (2x); event.emit appears
    // as both the verb's append + its tap. Sufficient that we see them.
    assert.ok(verbs.includes('subagent.checkpoint'), 'subagent.checkpoint appeared in stream');
    assert.ok(verbs.includes('event.emit'), 'event.emit appeared in stream');

    // 6) Every record carries the contract envelope.
    for (const ev of after.events) {
      assert.equal(typeof ev.seq, 'number');
      assert.equal(ev.subagentId, 'W19-C1', 'all events tagged with subagent id');
      assert.equal(typeof ev.ts, 'string');
      assert.equal(typeof ev.verbId, 'string');
      assert.ok(['ok', 'refused', 'advisory', 'error'].includes(ev.outcome));
    }

    // 7) Cursor is the highest seq seen — feed it back for an INCREMENTAL poll.
    const cursor1 = after.cursor;
    assert.ok(cursor1 > 0, 'cursor advanced past zero');

    // 8) PARENT incrementally polls after the cursor. No new events yet → empty.
    const empty = streamSubagentEvents('W19-C', 'W19-C1', root, cursor1);
    assert.deepEqual(empty.events, [], 'incremental poll returns no new events');

    // 9) SUBAGENT fires another verb. Parent's incremental poll picks JUST it up.
    await query('subagent.checkpoint', {
      waveId: 'W19-C',
      subagentId: 'W19-C1',
      checkpoint: { tool_use_count: 3, last_action: 'run tests' },
      dedupKey: 'ck-3',
    }, subCtx);
    await settle();

    const next = streamSubagentEvents('W19-C', 'W19-C1', root, cursor1);
    assert.ok(next.events.length >= 1, 'cursor-based poll picks up new events');
    assert.ok(next.cursor > cursor1, 'cursor advances on incremental poll');
    for (const ev of next.events) {
      assert.ok(ev.seq > cursor1, 'all new events have seq > prior cursor');
    }
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 5. Tap routing — parent's own dispatch event lands on the parent stream,
//    NOT the subagent's. The two streams are independent per §5.
// ---------------------------------------------------------------------------

test('parent vs subagent: streams are independent (subagentId-routed)', async () => {
  const { root, cleanup } = mkProject();
  try {
    // Parent dispatches: tap fires with subagentId='parent' (default for
    // the orchestrator's own ctx).
    await dispatchSubagent('W19-D', 'W19-D1', 'role', 'brief', root);

    // Subagent runs ONE wave-scoped verb (wave-scoped → routes under the wave
    // dir per contract §5 — see "core proof" test above for the rationale).
    await query('wave.get', { waveId: 'W19-D' }, { projectRoot: root, subagentId: 'W19-D1' });
    await settle();

    // Subagent's stream contains the subagent's verb, not the parent's dispatch.
    const subStream = streamSubagentEvents('W19-D', 'W19-D1', root, 0);
    const subVerbs = subStream.events.map((e) => e.verb);
    assert.ok(subVerbs.includes('wave.get'));
    for (const ev of subStream.events) {
      assert.equal(ev.subagentId, 'W19-D1', 'subagent stream only carries subagent events');
    }

    // Parent's stream (subagentId:'parent' under the same wave) holds the
    // dispatch. We use the raw `pollEvents` API to verify the routing.
    const parentStream = pollEvents({
      projectRoot: root,
      waveId: 'W19-D',
      subagentId: 'parent',
    });
    const parentVerbs = parentStream.events.map((e) => e.verb);
    assert.ok(parentVerbs.includes('subagent.dispatch'),
      'parent stream carries the dispatch event');
    for (const ev of parentStream.events) {
      assert.equal(ev.subagentId, 'parent', 'parent stream only carries parent events');
    }
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 6. Tap NEVER blocks — a parent that hangs would not see real-time progress.
// ---------------------------------------------------------------------------

test('event tap does not block the dispatch verb (fire-and-forget)', async () => {
  const { root, cleanup } = mkProject();
  try {
    const t0 = Date.now();
    await dispatchSubagent('W19-E', 'W19-E1', 'r', 'b', root);
    const elapsed = Date.now() - t0;
    // Dispatch is essentially instant — give a generous 500ms ceiling so a
    // slow filesystem in CI doesn't false-positive, while still failing if
    // the tap somehow blocked on async I/O.
    assert.ok(elapsed < 500, `subagent.dispatch took ${elapsed}ms — expected fire-and-forget`);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 7. Event-log file presence — the verb DOES create the wave dir + STATE.md,
//    and after the first subagent verb, the events log materialises on disk.
// ---------------------------------------------------------------------------

test('event log materialises on disk after subagent fires its first verb', async () => {
  const { root, cleanup } = mkProject();
  try {
    await dispatchSubagent('W19-F', 'W19-F1', 'r', 'b', root);
    const eventPath = resolveEventLogPath(root, 'W19-F', 'W19-F1');
    // Before any subagent verb: no events for W19-F1 yet.
    assert.equal(existsSync(eventPath), false);

    // Wave-scoped verb routes the tap under the wave dir.
    await query('wave.get', { waveId: 'W19-F' }, { projectRoot: root, subagentId: 'W19-F1' });
    await settle();

    assert.equal(existsSync(eventPath), true, 'event log file created on first subagent verb');
    const raw = readFileSync(eventPath, 'utf8');
    assert.match(raw, /"verb":"wave.get"/);
    assert.match(raw, /"subagentId":"W19-F1"/);
  } finally { cleanup(); }
});
