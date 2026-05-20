import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordCheckpoint,
  readLastCheckpoint,
  listOrphanedSubagents,
  appendSummary,
  recordViolation,
  MAX_CHECKPOINT_SIZE,
} from './src/orchestrator/subagent-telemetry.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'subagent-telem-'));
}

test('basic write+read roundtrip preserves payload + envelope fields', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await recordCheckpoint(
    'W11-A0',
    'W11-A1',
    { tool_use_count: 7, last_action: 'wrote module' },
    root,
  );

  const read = await readLastCheckpoint('W11-A0', 'W11-A1', root);
  assert.ok(read !== null, 'checkpoint should round-trip');
  assert.equal(read.schema_version, 1);
  assert.equal(read.wave_id, 'W11-A0');
  assert.equal(read.sub_id, 'W11-A1');
  assert.equal(read.tool_use_count, 7);
  assert.equal(read.last_action, 'wrote module');
  assert.ok(typeof read.ts === 'string' && read.ts.includes('T'));
  assert.ok(
    existsSync(join(root, '.ijfw', 'wave-W11-A0', 'subagent-W11-A1.checkpoint.json')),
  );
});

test('multiple subagents in the same wave coexist as separate files', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await recordCheckpoint('W11-A0', 'sub-one', { last_action: 'a' }, root);
  await recordCheckpoint('W11-A0', 'sub-two', { last_action: 'b' }, root);

  const a = await readLastCheckpoint('W11-A0', 'sub-one', root);
  const b = await readLastCheckpoint('W11-A0', 'sub-two', root);
  assert.equal(a.last_action, 'a');
  assert.equal(b.last_action, 'b');
});

test('path traversal in subId is rejected', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => recordCheckpoint('W11-A0', '../etc', { last_action: 'x' }, root),
    /invalid subId/,
  );
});

test('path traversal in waveId is rejected', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => recordCheckpoint('../etc', 'sub', { last_action: 'x' }, root),
    /invalid waveId/,
  );
});

test('payload size cap is enforced', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      recordCheckpoint(
        'W11-A0',
        'big',
        { last_action: 'x'.repeat(5000) },
        root,
      ),
    new RegExp(`exceeds MAX_CHECKPOINT_SIZE ${MAX_CHECKPOINT_SIZE}`),
  );
});

test('readLastCheckpoint returns null for missing wave dir', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await readLastCheckpoint('W99-Z9', 'never-written', root);
  assert.equal(result, null);
});

test('listOrphanedSubagents returns [] for non-existent wave dir', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await listOrphanedSubagents('W99-Z9', root);
  assert.deepEqual(result, []);
});

test('listOrphanedSubagents lists every subagent with a checkpoint', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await recordCheckpoint('W11-A0', 'sub-alpha', { last_action: 'a' }, root);
  await recordCheckpoint('W11-A0', 'sub-beta', { last_action: 'b' }, root);

  const orphaned = await listOrphanedSubagents('W11-A0', root);
  assert.equal(orphaned.length, 2);
  assert.ok(orphaned.includes('sub-alpha'));
  assert.ok(orphaned.includes('sub-beta'));
});

// ---------------------------------------------------------------------------
// appendSummary tests
// ---------------------------------------------------------------------------

test('appendSummary writes an event and returns ok + seq', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await appendSummary(
    'W11-A0',
    'sub-one',
    { text: 'task complete', items: 3 },
    root,
  );
  assert.ok(result.ok, 'appendSummary should return ok:true');
  assert.equal(typeof result.seq, 'number', 'appendSummary should return a seq number');
  assert.equal(result.deduped, false, 'first call should not be deduped');
});

test('appendSummary is idempotent — same data dedups', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const data = { text: 'finished', score: 99 };
  const r1 = await appendSummary('W11-A0', 'sub-idem', data, root);
  const r2 = await appendSummary('W11-A0', 'sub-idem', data, root);
  assert.ok(r1.ok);
  assert.ok(r2.ok);
  assert.equal(r2.deduped, true, 'identical data should dedup on second call');
});

test('appendSummary rejects invalid waveId', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => appendSummary('../etc', 'sub', { text: 'x' }, root),
    /invalid waveId/,
  );
});

test('appendSummary rejects invalid subId', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => appendSummary('W11-A0', '../etc', { text: 'x' }, root),
    /invalid subId/,
  );
});

// ---------------------------------------------------------------------------
// recordViolation tests
// ---------------------------------------------------------------------------

test('recordViolation writes an event and returns ok + seq', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await recordViolation(
    'W11-A0',
    'sub-v1',
    { type: 'raw-write', detail: 'fs.writeFile called directly' },
    root,
  );
  assert.ok(result.ok, 'recordViolation should return ok:true');
  assert.equal(typeof result.seq, 'number', 'recordViolation should return a seq number');
  assert.equal(result.deduped, false, 'first call should not be deduped');
});

test('recordViolation is idempotent — same data dedups', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const data = { type: 'timeout', detail: 'exceeded 60s' };
  const r1 = await recordViolation('W11-A0', 'sub-videm', data, root);
  const r2 = await recordViolation('W11-A0', 'sub-videm', data, root);
  assert.ok(r1.ok);
  assert.ok(r2.ok);
  assert.equal(r2.deduped, true, 'identical violation should dedup on second call');
});

test('recordViolation rejects non-object data', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => recordViolation('W11-A0', 'sub-v2', null, root),
    /requires a data object/,
  );
});

// ---------------------------------------------------------------------------
// SDK routing regression: writes go through SDK, not raw fs (T9 migration spy)
// ---------------------------------------------------------------------------
// These tests enforce that recordCheckpoint / appendSummary / recordViolation
// route ALL writes through the state-SDK query() → atomic-io chain. They do
// so by:
//
//   1. Installing a call-counting spy on fs.writeFile (async — the async path
//      subagent-telemetry.js previously used before T9). Any call to this
//      method from the telemetry layer itself would indicate a direct-write
//      bypass. The SDK's internal chain uses appendFileSync + writeAtomic
//      (sync rename), so writeFile (async) should see ZERO calls.
//
//   2. Verifying the expected SDK-produced artifacts exist on disk — proving
//      the write DID happen (through the SDK), not that writing was skipped.
//
// Note: we do NOT block appendFileSync / writeFileSync here because those are
// the SDK's own internal write primitives (intent journal, atomic-io rename).
// Blocking them would make the SDK itself fail — that is NOT the goal. The
// goal is to prove subagent-telemetry.js no longer calls the async writeFile
// (its pre-T9 raw write path) directly.

test('spy: recordCheckpoint uses SDK — no async fs.writeFile bypass', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const calls = [];
  const spy = mock.method(fs, 'writeFile', (...args) => {
    calls.push(args[0]); // capture path for diagnosis
    // Don't throw — let it proceed if called; we assert count after.
    return fs.writeFile.wrappedFn?.(...args);
  });
  try {
    await recordCheckpoint('W11-A0', 'spy-sub1', { last_action: 'spy-test' }, root);
  } finally {
    spy.mock.restore();
  }
  // The checkpoint file MUST exist (SDK wrote it via atomic-io sync path).
  const cpFile = join(root, '.ijfw', 'wave-W11-A0', 'subagent-spy-sub1.checkpoint.json');
  assert.ok(existsSync(cpFile), 'SDK must have written the checkpoint file');
  // No async writeFile calls — subagent-telemetry.js does not use this path.
  assert.equal(
    calls.length, 0,
    `recordCheckpoint made async fs.writeFile call(s) to: ${calls.join(', ')} — must route through SDK`,
  );
});

test('spy: appendSummary uses SDK — no async fs.writeFile bypass', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const calls = [];
  const spy = mock.method(fs, 'writeFile', (...args) => {
    calls.push(args[0]);
    return fs.writeFile.wrappedFn?.(...args);
  });
  try {
    await appendSummary('W11-A0', 'spy-sub2', { text: 'spy summary' }, root);
  } finally {
    spy.mock.restore();
  }
  // The event log MUST exist (SDK wrote it via state-events append path).
  const logFile = join(root, '.ijfw', 'wave-W11-A0', 'events-spy-sub2.jsonl');
  assert.ok(existsSync(logFile), 'SDK must have written the event log file');
  assert.equal(
    calls.length, 0,
    `appendSummary made async fs.writeFile call(s) to: ${calls.join(', ')} — must route through SDK`,
  );
});

test('spy: recordViolation uses SDK — no async fs.writeFile bypass', async (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const calls = [];
  const spy = mock.method(fs, 'writeFile', (...args) => {
    calls.push(args[0]);
    return fs.writeFile.wrappedFn?.(...args);
  });
  try {
    await recordViolation('W11-A0', 'spy-sub3', { type: 'spy', detail: 'test' }, root);
  } finally {
    spy.mock.restore();
  }
  // The event log MUST exist (SDK wrote it via state-events append path).
  const logFile = join(root, '.ijfw', 'wave-W11-A0', 'events-spy-sub3.jsonl');
  assert.ok(existsSync(logFile), 'SDK must have written the event log file');
  assert.equal(
    calls.length, 0,
    `recordViolation made async fs.writeFile call(s) to: ${calls.join(', ')} — must route through SDK`,
  );
});
