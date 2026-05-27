// IJFW v1.5.0 M4.3 -- dream stage-runner tests (per-stage error isolation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStages } from './src/dream/stage-runner.js';
import { readDreamState } from './src/dream/state-file.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ijfw-stage-runner-'));
}

test('runStages runs each stage in order and records completion', async () => {
  const root = makeRoot();
  try {
    const order = [];
    await runStages(root, [
      { name: 'compress',    run: async () => { order.push('compress');    return { rows: 3 }; } },
      { name: 'consolidate', run: async () => { order.push('consolidate'); } },
      { name: 'decay',       run: async () => { order.push('decay'); } },
    ]);
    assert.deepEqual(order, ['compress', 'consolidate', 'decay']);
    const s = readDreamState(root);
    assert.equal(s.stages.compress.status, 'completed');
    assert.equal(s.stages.compress.rows, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runStages — stage failure does NOT cascade', async () => {
  const root = makeRoot();
  try {
    const order = [];
    const res = await runStages(root, [
      { name: 'compress',    run: async () => { order.push('compress'); } },
      { name: 'consolidate', run: async () => { throw new Error('boom'); } },
      { name: 'decay',       run: async () => { order.push('decay'); } },
    ]);
    assert.deepEqual(order, ['compress', 'decay']);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].name, 'consolidate');
    const s = readDreamState(root);
    assert.equal(s.stages.consolidate.status, 'failed');
    assert.equal(s.stages.decay.status, 'completed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runStages records ok=true on clean run', async () => {
  const root = makeRoot();
  try {
    const res = await runStages(root, [
      { name: 'compress', run: async () => ({ rows: 1 }) },
      { name: 'decay',    run: async () => ({}) },
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.completed.length, 2);
    assert.equal(res.failed.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runStages skips invalid stage definitions', async () => {
  const root = makeRoot();
  try {
    const res = await runStages(root, [
      { name: 'good', run: async () => ({}) },
      null,
      { name: 'no-run-fn' }, // missing run
      { run: async () => ({}) }, // missing name
    ]);
    assert.equal(res.completed.length, 1);
    assert.equal(res.failed.length, 3);
    assert.ok(res.failed.every((f) => f.reason === 'invalid_stage_definition'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// TP-003 (v1.5.5 Trident): V155-005's `status:'completed_with_error'` and
// `'skipped'` are written to .dream-state-v2.json, but operators don't read
// JSON unless something already feels wrong. Surface those shapes on stderr
// at run time so the operator discovers the truth proactively.
test('TP-003: completed_with_error stage emits a stderr discoverability line', async () => {
  const root = makeRoot();
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line no-param-reassign
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  };
  try {
    await runStages(root, [
      { name: 'compress', run: async () => ({ error: 'index rebuild failed' }) },
      { name: 'decay',    run: async () => ({ skipped: 'no rows to decay' }) },
    ]);
  } finally {
    // eslint-disable-next-line no-param-reassign
    process.stderr.write = origWrite;
    rmSync(root, { recursive: true, force: true });
  }
  const joined = captured.join('');
  assert.match(joined, /\[dream\] stage compress completed with error: index rebuild failed/);
  assert.match(joined, /\[dream\] stage decay skipped: no rows to decay/);
});
