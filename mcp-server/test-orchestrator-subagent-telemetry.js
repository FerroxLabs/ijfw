import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordCheckpoint,
  readLastCheckpoint,
  listOrphanedSubagents,
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
