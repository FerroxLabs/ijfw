// IJFW v1.5.0 M4.2 -- dream state-file tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDreamState, writeDreamState,
  markStageStarted, markStageCompleted, shouldRunNow,
} from './src/dream/state-file.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'ijfw-dream-state-'));
}

test('readDreamState returns default shape when file absent', () => {
  const root = makeRoot();
  try {
    const s = readDreamState(root);
    assert.equal(s.version, 1);
    assert.equal(s.last_run_at, null);
    assert.equal(s.runs_total, 0);
    assert.deepEqual(s.stages, {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeDreamState round-trips', () => {
  const root = makeRoot();
  try {
    writeDreamState(root, { version: 1, runs_total: 7, last_run_at: 12345, stages: {} });
    const s = readDreamState(root);
    assert.equal(s.runs_total, 7);
    assert.equal(s.last_run_at, 12345);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('markStageStarted + markStageCompleted track lifecycle', () => {
  const root = makeRoot();
  try {
    markStageStarted(root, 'compress');
    let s = readDreamState(root);
    assert.equal(s.stages.compress.status, 'in_progress');
    markStageCompleted(root, 'compress', { rows_written: 4 });
    s = readDreamState(root);
    assert.equal(s.stages.compress.status, 'completed');
    assert.equal(s.stages.compress.rows_written, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shouldRunNow respects min_idle_minutes', () => {
  const root = makeRoot();
  try {
    assert.equal(shouldRunNow(root, { min_idle_minutes: 30 }), true);
    writeDreamState(root, {
      version: 1, runs_total: 1, last_run_at: Date.now() - 5 * 60 * 1000, stages: {},
    });
    assert.equal(shouldRunNow(root, { min_idle_minutes: 30 }), false);
    writeDreamState(root, {
      version: 1, runs_total: 1, last_run_at: Date.now() - 31 * 60 * 1000, stages: {},
    });
    assert.equal(shouldRunNow(root, { min_idle_minutes: 30 }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readDreamState fail-safe on corrupt file', () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    writeFileSync(join(root, '.ijfw', '.dream-state-v2.json'), 'NOT JSON');
    const s = readDreamState(root);
    assert.equal(s.runs_total, 0);
    assert.equal(s.last_run_at, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
