import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readWaveState,
  writeWaveState,
  checkpointWave,
} from './src/orchestrator/wave-state.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'wave-state-'));
}

test('read returns null for nonexistent wave', async () => {
  const root = makeTmp();
  const result = await readWaveState('W10-A0', root);
  assert.equal(result, null);
});

test('write then read roundtrip', async () => {
  const root = makeTmp();
  const state = {
    frontmatter: { wave_id: 'W10-A0', status: 'in_progress', agents: ['a', 'b'] },
    body: '# Notes\n\nhi',
  };
  await writeWaveState('W10-A0', state, root);
  const read = await readWaveState('W10-A0', root);
  assert.ok(read !== null);
  assert.deepEqual(read.frontmatter.wave_id, 'W10-A0');
  assert.deepEqual(read.frontmatter.status, 'in_progress');
  assert.deepEqual(read.frontmatter.agents, ['a', 'b']);
  assert.equal(read.body, '# Notes\n\nhi');
});

test('write auto-creates parent dirs', async () => {
  const root = makeTmp();
  // .ijfw/ does not exist in fresh tmp
  assert.equal(existsSync(join(root, '.ijfw')), false);
  await writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0' }, body: '' }, root);
  assert.ok(existsSync(join(root, '.ijfw', 'wave-W10-A0', 'STATE.md')));
});

test('checkpointWave seeds new state when missing', async () => {
  const root = makeTmp();
  const result = await checkpointWave('W10-A0', root);
  assert.equal(result.frontmatter.wave_id, 'W10-A0');
  assert.equal(result.frontmatter.status, 'in_progress');
  assert.ok(typeof result.frontmatter.created_at === 'string');
  assert.ok(result.frontmatter.created_at.includes('T')); // ISO format
  assert.ok(typeof result.frontmatter.checkpoint_at === 'string');
  assert.ok(result.frontmatter.checkpoint_at.includes('T'));
  assert.ok(existsSync(join(root, '.ijfw', 'wave-W10-A0', 'STATE.md')));
});

test('checkpointWave updates only checkpoint_at on existing state', async () => {
  const root = makeTmp();
  const initial = {
    frontmatter: {
      wave_id: 'W10-A0',
      status: 'review',
      agents: ['x'],
      checkpoint_at: '2020-01-01T00:00:00.000Z',
    },
    body: '# Custom body\n\nkeep me',
  };
  await writeWaveState('W10-A0', initial, root);

  const result = await checkpointWave('W10-A0', root);

  assert.equal(result.frontmatter.status, 'review');
  assert.deepEqual(result.frontmatter.agents, ['x']);
  assert.equal(result.body, '# Custom body\n\nkeep me');
  assert.notEqual(result.frontmatter.checkpoint_at, '2020-01-01T00:00:00.000Z');
  assert.ok(result.frontmatter.checkpoint_at > '2020-01-01T00:00:00.000Z');
});

test('withFsLock parent-dir auto-create regression — no ENOENT on fresh tmpdir', async () => {
  // Regression: v1.4.3 aaf3052 — lock path parent must be auto-created.
  // A fresh tmpdir has no .ijfw/ subtree at all; writeWaveState must not throw ENOENT.
  const root = makeTmp();
  assert.equal(existsSync(join(root, '.ijfw')), false);
  // Must not throw
  await assert.doesNotReject(
    () => writeWaveState('W10-A0', { frontmatter: { wave_id: 'W10-A0' }, body: '' }, root),
  );
  // Lock path parent (.ijfw/wave-W10-A0/) was created
  assert.ok(existsSync(join(root, '.ijfw', 'wave-W10-A0')));
});
