/**
 * test-state-events.js -- v1.5.0 T5 coverage for the per-subagent event log.
 *
 * Verifies:
 *  - Every dispatched verb (read AND mutating) emits exactly one event via the
 *    dispatcher's `_emitEvent` observability tap.
 *  - `_emitEvent` is fire-and-forget AFTER lock release -- it never slows the
 *    caller and an internal write failure does NOT propagate to the verb.
 *  - The per-subagent event log rotates at the contract's 4 MiB / 10000-line
 *    ceiling using the shared `jsonl-rotation` primitive.
 *  - `seq` is strictly monotonic across rotation (a rotated archive does NOT
 *    cause seq to reset -- the seq cursor sidecar survives rotation).
 *  - `pollEvents(since)` returns events from a cursor; spans rotation.
 *  - Per-event size cap (4 KiB) truncates `payloadDigest`-bearing-only envelope
 *    fields without dropping the event.
 *  - The caller-facing `event.emit` verb shares the same monotonic-seq source.
 *
 * Tests run against real temp dirs -- no mocks. T5 owns the
 * `mcp-server/src/orchestrator/state-events.js` module; this file pins its
 * contract before implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, readdirSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { query } from './src/orchestrator/state-sdk.js';
import {
  emitEvent,
  pollEvents,
  resolveEventLogPath,
  EVENT_BYTE_CEILING,
  EVENT_LINE_CEILING,
  EVENT_MAX_LINE_BYTES,
} from './src/orchestrator/state-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 't5-state-events-'));
  const home = mkdtempSync(join(tmpdir(), 't5-state-events-home-'));
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

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Sleep helper so the dispatcher's microtask-deferred emit can complete.
async function settle(ms = 25) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Module surface -- the exports the rest of the milestone binds to.
// ---------------------------------------------------------------------------

test('state-events: module exports the documented surface', () => {
  assert.equal(typeof emitEvent, 'function', 'emitEvent exported');
  assert.equal(typeof pollEvents, 'function', 'pollEvents exported');
  assert.equal(typeof resolveEventLogPath, 'function', 'resolveEventLogPath exported');
  assert.equal(typeof EVENT_BYTE_CEILING, 'number');
  assert.equal(typeof EVENT_LINE_CEILING, 'number');
  assert.equal(EVENT_BYTE_CEILING, 4 * 1024 * 1024, 'contract: 4 MiB byte ceiling');
  assert.equal(EVENT_LINE_CEILING, 10000, 'contract: 10000-line ceiling');
  assert.equal(EVENT_MAX_LINE_BYTES, 4 * 1024, 'contract: 4 KiB per-event cap');
});

test('resolveEventLogPath: returns a per-subagent log path per contract §5', () => {
  const { root, cleanup } = mkProject();
  try {
    const p = resolveEventLogPath(root, 'W12-A', 'W12-A1');
    assert.ok(p.endsWith(`/.ijfw/wave-W12-A/events-W12-A1.jsonl`)
      || p.endsWith(`\\.ijfw\\wave-W12-A\\events-W12-A1.jsonl`));

    // Fallback for tap-events without a wave/subagent context -- documented
    // path under the system fallback location.
    const sys = resolveEventLogPath(root, null, null);
    assert.ok(sys.includes('events-system') || sys.includes('events-parent'),
      'fallback path documented');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Dispatcher tap -- every verb emits an event.
// ---------------------------------------------------------------------------

test('dispatcher: a read verb (workflow.get) emits one event after lock release', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    const r = await query('workflow.get', {}, { ...ctx, subagentId: 'W12-A1' });
    await settle();
    assert.equal(r.ok, true);

    // The tap event lands under the documented fallback path (no waveId in
    // ctx -- workflow.get does not carry a wave). It MUST land somewhere.
    const dir = join(root, '.ijfw');
    assert.ok(existsSync(dir), 'event-log parent exists');
    // Walk the .ijfw tree to find any events-*.jsonl produced.
    const found = [];
    function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.startsWith('events-') && e.name.endsWith('.jsonl')) found.push(p);
      }
    }
    walk(dir);
    assert.ok(found.length >= 1, 'at least one tap-event log was written');
    const allEvents = found.flatMap(readJsonl);
    assert.ok(allEvents.length >= 1, 'one event for one verb dispatch');
    const ev = allEvents[0];
    assert.equal(ev.verb, 'workflow.get');
    assert.equal(ev.subagentId, 'W12-A1');
    assert.equal(ev.outcome, 'ok');
    assert.equal(typeof ev.seq, 'number');
    assert.equal(typeof ev.ts, 'string');
    assert.equal(typeof ev.verbId, 'string');
    assert.equal(typeof ev.payloadDigest, 'string');
  } finally { cleanup(); }
});

test('dispatcher: a mutating verb emits one tap event with outcome:ok', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    await query('workflow.set-phase', { phase: 'build' }, { ...ctx, subagentId: 'W12-A1' });
    await settle();
    // Count tap events across the tree.
    let total = 0;
    function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.startsWith('events-') && e.name.endsWith('.jsonl')) {
          total += readJsonl(p).length;
        }
      }
    }
    walk(join(root, '.ijfw'));
    assert.equal(total, 1, 'exactly one tap event per dispatch');
  } finally { cleanup(); }
});

test('dispatcher: an unknown verb does NOT crash event-emit (throws before tap)', async () => {
  const { ctx, cleanup } = mkProject();
  try {
    await assert.rejects(() => query('not.a.verb', {}, ctx), /unknown verb/i);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Fire-and-forget guarantee -- emit failures do NOT propagate.
// ---------------------------------------------------------------------------

test('emitEvent: a write failure NEVER propagates -- the verb still succeeds', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    // Pre-create a READ-ONLY file at the tap path so the append fails.
    // The tap path for a workflow.get with no subagentId is the system fallback.
    const tapPath = resolveEventLogPath(root, null, 'W12-A1');
    const dir = dirname(tapPath);
    // Create the parent dir + a non-writable file in its place.
    mkdirSync(dir, { recursive: true });
    writeFileSync(tapPath, '');
    chmodSync(tapPath, 0o400); // read-only
    // Now make the parent dir read-only as well (so even rename can't recover).
    // On macOS / Linux a non-root user can still unlink in a writable parent --
    // so we make the file unwritable AND the directory unwritable. Skip this
    // hardening on Windows where chmod is mostly cosmetic.
    if (process.platform !== 'win32') {
      chmodSync(dir, 0o500);
    }

    // The verb MUST still succeed. The tap silently swallows the I/O error.
    let didThrow = false;
    let result;
    try {
      result = await query('workflow.get', {}, { ...ctx, subagentId: 'W12-A1' });
    } catch (e) {
      didThrow = true;
    }
    await settle();
    // Restore permissions so cleanup can succeed.
    if (process.platform !== 'win32') {
      try { chmodSync(dir, 0o700); } catch {}
    }
    try { chmodSync(tapPath, 0o600); } catch {}
    assert.equal(didThrow, false, 'tap I/O error does NOT propagate to caller');
    assert.equal(result?.ok, true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Off the critical section -- the tap appends AFTER lock release.
// ---------------------------------------------------------------------------

test('dispatcher: tap fires AFTER the verb returns (no lock held during emit)', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    // Run a mutating verb and check the lock file is gone by the time the
    // tap event has landed -- ergo the tap appended off the critical section.
    await query('workflow.set-phase', { phase: 'plan' }, { ...ctx, subagentId: 'W12-A1' });
    await settle();
    const lock = join(root, '.ijfw', 'state', '.workflow.json.lock');
    // The lock dir is mkdir-based; after release it is removed.
    assert.equal(existsSync(lock), false, 'workflow.json lock released by the time we check');

    // The tap event for the verb landed (under the system fallback because
    // workflow.set-phase has no waveId).
    let total = 0;
    function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.startsWith('events-') && e.name.endsWith('.jsonl')) {
          total += readJsonl(p).length;
        }
      }
    }
    walk(join(root, '.ijfw'));
    assert.equal(total, 1, 'tap event present after release');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Monotonic seq -- across rotation, across multiple emits, across both
// `_emitEvent` and the `event.emit` verb (same seq source).
// ---------------------------------------------------------------------------

test('emitEvent: seq is monotonic across many appends to the same log', async () => {
  const { root, cleanup } = mkProject();
  try {
    const path = resolveEventLogPath(root, 'W12-A', 'W12-A1');
    for (let i = 0; i < 10; i += 1) {
      await emitEvent({
        projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
        verb: 'workflow.get', verbId: `v-${i}`, outcome: 'ok',
        payloadDigest: `sha256-${i}`,
      });
    }
    const events = readJsonl(path);
    assert.equal(events.length, 10);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(events[i].seq, i + 1, `seq #${i + 1}`);
    }
  } finally { cleanup(); }
});

test('emitEvent: seq is monotonic ACROSS rotation -- counter does not reset', async () => {
  const { root, cleanup } = mkProject();
  try {
    // Force rotation at a very small ceiling to keep the test fast.
    const path = resolveEventLogPath(root, 'W12-A', 'W12-A1');
    // First, fill the log just past a small line ceiling.
    for (let i = 0; i < 50; i += 1) {
      await emitEvent({
        projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
        verb: 'workflow.get', verbId: `v-${i}`, outcome: 'ok',
        payloadDigest: `sha256-${i}`,
        // Test-only override -- forces rotation early.
        rotateOptions: { maxBytes: 1024, maxLines: 20 },
      });
    }
    // The log should have rotated at least twice.
    const dir = dirname(path);
    const archives = readdirSync(dir).filter(
      (n) => n.startsWith('events-W12-A1.') && (n.endsWith('.jsonl.gz') || n.endsWith('.jsonl.1')),
    );
    assert.ok(archives.length >= 1, `at least one archive exists (got ${archives.length})`);

    // Read the current file. Its first event must have seq > 1.
    const currentEvents = readJsonl(path);
    assert.ok(currentEvents.length >= 1, 'current file has at least one event');
    assert.ok(currentEvents[0].seq > 1, `first event in post-rotation file has seq>1 (got ${currentEvents[0].seq})`);

    // The very last event's seq must equal the total number emitted (50).
    const last = currentEvents[currentEvents.length - 1];
    assert.equal(last.seq, 50, 'final seq matches total emits across rotations');
  } finally { cleanup(); }
});

test('event.emit verb: shares the same seq source as the tap (no reset across rotation)', async () => {
  const { root, ctx, cleanup } = mkProject();
  try {
    // Drive a few verb-level emits.
    for (let i = 0; i < 5; i += 1) {
      const r = await query('event.emit', {
        waveId: 'W12-A', subagentId: 'W12-A1', eventType: 'progress',
        data: { i }, dedupKey: `evt-${i}`,
      }, ctx);
      assert.equal(r.ok, true);
      assert.equal(r.seq, i + 1, `verb-level seq #${i + 1}`);
    }
    // Now drive a tap emit directly to the SAME log (waveId/subId match).
    await emitEvent({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
      verb: 'workflow.get', verbId: 'v-tap-1', outcome: 'ok',
      payloadDigest: 'sha256-tap',
    });
    // The next verb-level emit must NOT collide with the tap's seq.
    const r = await query('event.emit', {
      waveId: 'W12-A', subagentId: 'W12-A1', eventType: 'progress',
      data: { final: true }, dedupKey: 'evt-final',
    }, ctx);
    // 5 verb + 1 tap + 1 verb = 7 events total, all sequential.
    assert.equal(r.seq, 7, 'verb and tap share monotonic seq stream');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Rotation -- the active log rotates at the contract ceiling.
// ---------------------------------------------------------------------------

test('rotation: log rotates when byte ceiling exceeded', async () => {
  const { root, cleanup } = mkProject();
  try {
    const path = resolveEventLogPath(root, 'W12-A', 'W12-A1');
    // 512-byte payload digest pad to push us past 1 KiB quickly.
    const pad = 'x'.repeat(200);
    for (let i = 0; i < 30; i += 1) {
      await emitEvent({
        projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
        verb: 'workflow.get', verbId: `v-${i}-${pad}`, outcome: 'ok',
        payloadDigest: `sha256-${i}-${pad}`,
        rotateOptions: { maxBytes: 2 * 1024 },
      });
    }
    // The current path exists and its size is <= the ceiling (post-rotation).
    const sz = statSync(path).size;
    assert.ok(sz <= 4 * 1024, `current log truncated post-rotation (size=${sz})`);
    // At least one archive sibling exists.
    const dir = dirname(path);
    const archives = readdirSync(dir).filter(
      (n) => n.startsWith('events-W12-A1.') && (n.endsWith('.jsonl.gz') || n.endsWith('.jsonl.1')),
    );
    assert.ok(archives.length >= 1, `archive present (count=${archives.length})`);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// pollEvents(since) -- the consumer surface.
// ---------------------------------------------------------------------------

test('pollEvents: returns the empty slice when cursor is at head', async () => {
  const { root, cleanup } = mkProject();
  try {
    await emitEvent({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
      verb: 'workflow.get', verbId: 'v-1', outcome: 'ok', payloadDigest: 'sha256-1',
    });
    const all = pollEvents({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1', since: 0,
    });
    assert.equal(all.events.length, 1);
    assert.equal(all.events[0].seq, 1);
    assert.equal(all.cursor, 1);

    const empty = pollEvents({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1', since: all.cursor,
    });
    assert.equal(empty.events.length, 0);
    assert.equal(empty.cursor, 1);
  } finally { cleanup(); }
});

test('pollEvents: returns events strictly newer than the cursor', async () => {
  const { root, cleanup } = mkProject();
  try {
    for (let i = 0; i < 5; i += 1) {
      await emitEvent({
        projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
        verb: 'workflow.get', verbId: `v-${i}`, outcome: 'ok',
        payloadDigest: `sha256-${i}`,
      });
    }
    const r = pollEvents({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1', since: 2,
    });
    assert.equal(r.events.length, 3, 'events with seq > 2');
    assert.equal(r.events[0].seq, 3);
    assert.equal(r.events[2].seq, 5);
    assert.equal(r.cursor, 5);
  } finally { cleanup(); }
});

test('pollEvents: spans a rotation -- finds events in the archive', async () => {
  const { root, cleanup } = mkProject();
  try {
    // Force a small ceiling so a rotation lands between events.
    for (let i = 0; i < 30; i += 1) {
      await emitEvent({
        projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
        verb: 'workflow.get', verbId: `v-${i}`, outcome: 'ok',
        payloadDigest: `sha256-${i}`,
        rotateOptions: { maxBytes: 1024, maxLines: 10 },
      });
    }
    const r = pollEvents({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1', since: 0,
    });
    // pollEvents must surface ALL emitted events across the rotated archive(s)
    // and the live file. seq strictly monotonic 1..30.
    assert.equal(r.events.length, 30, 'all 30 events recoverable post-rotation');
    for (let i = 0; i < 30; i += 1) {
      assert.equal(r.events[i].seq, i + 1, `seq #${i + 1} in order`);
    }
  } finally { cleanup(); }
});

test('pollEvents: missing log returns empty + cursor:0', () => {
  const { root, cleanup } = mkProject();
  try {
    const r = pollEvents({
      projectRoot: root, waveId: 'W99-X', subagentId: 'W99-X1', since: 0,
    });
    assert.equal(r.events.length, 0);
    assert.equal(r.cursor, 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Per-event size cap -- truncate, never drop.
// ---------------------------------------------------------------------------

test('emitEvent: oversize payloadDigest is truncated, event still landed', async () => {
  const { root, cleanup } = mkProject();
  try {
    const path = resolveEventLogPath(root, 'W12-A', 'W12-A1');
    const huge = 'z'.repeat(8 * 1024); // 8 KiB -- well past the 4 KiB cap.
    await emitEvent({
      projectRoot: root, waveId: 'W12-A', subagentId: 'W12-A1',
      verb: 'workflow.get', verbId: 'v-big', outcome: 'ok',
      payloadDigest: `sha256-${huge}`,
    });
    const events = readJsonl(path);
    assert.equal(events.length, 1, 'oversize event was NOT dropped');
    const lineSize = Buffer.byteLength(JSON.stringify(events[0]), 'utf8');
    assert.ok(lineSize <= EVENT_MAX_LINE_BYTES + 16, // small slack for envelope keys
      `truncated event line <= ${EVENT_MAX_LINE_BYTES} bytes (got ${lineSize})`);
    // Envelope keys preserved.
    assert.equal(events[0].seq, 1);
    assert.equal(events[0].verb, 'workflow.get');
    assert.equal(events[0].verbId, 'v-big');
    assert.equal(events[0].outcome, 'ok');
    // A truncation marker is present so downstream knows.
    assert.equal(events[0].truncated, true, 'truncation marker set');
  } finally { cleanup(); }
});
