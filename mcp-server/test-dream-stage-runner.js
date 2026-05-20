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
