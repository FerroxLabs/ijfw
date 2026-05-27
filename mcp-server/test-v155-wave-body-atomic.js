/**
 * test-v155-wave-body-atomic.js — regression coverage for V155-014.
 *
 * V155-014 (HIGH): `writeWaveState` used to write frontmatter via the
 * state-SDK (journaled) and then re-acquire ONLY the per-wave STATE.md lock
 * to write the body in a separate critical section. The body write had no
 * intent-journal record, so `state.replay` could not roll back a body-write
 * partial.
 *
 * The fix folds body into the SDK's `wave.advance` payload, so frontmatter
 * and body land inside ONE journaled critical section holding #1 (intent
 * journal) + #3 (waves.json) + #4 (per-wave STATE.md). After the SDK call,
 * the intent journal MUST contain a single begin/commit pair covering the
 * combined write.
 *
 * Run: node --test test-v155-wave-body-atomic.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeWaveState } from './src/orchestrator/wave-state.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'v155-wave-body-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function readJournal(root) {
  const p = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
  try {
    return readFileSync(p, 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('V155-014: writeWaveState lands frontmatter+body in ONE journaled wave.advance', async () => {
  const { root, cleanup } = mkProject();
  try {
    await writeWaveState('W1', {
      frontmatter: { wave_id: 'W1', status: 'in_progress', tag: 'first' },
      body: '## body content\n\nthis is the wave body\n',
    }, root);

    // STATE.md round-trip — frontmatter AND body persisted.
    const statePath = join(root, '.ijfw', 'wave-W1', 'STATE.md');
    const raw = readFileSync(statePath, 'utf8');
    assert.match(raw, /wave_id: W1/);
    assert.match(raw, /tag: first/);
    assert.match(raw, /## body content/, 'body persisted alongside frontmatter');

    // Intent journal carries the wave.advance begin/commit pair for THIS
    // wave-state write — no orphan #4-only body record.
    const records = readJournal(root);
    const begins = records.filter((r) => r.phase === 'begin' && r.verb === 'wave.advance');
    const commits = records.filter((r) => r.phase === 'commit' && r.verb === 'wave.advance');
    assert.equal(begins.length, 1, 'exactly one wave.advance begin record');
    assert.equal(commits.length, 1, 'exactly one wave.advance commit record');
    assert.equal(begins[0].verbId, commits[0].verbId, 'same verbId across begin/commit pair');

    // begin record must list the per-wave STATE.md as a target — the body
    // write was inside the SDK critical section, not a follow-up.
    const targets = begins[0].targets || [];
    assert.ok(
      targets.some((t) => /wave-W1\/STATE\.md$/.test(t)),
      'STATE.md target listed on the journaled begin record',
    );
  } finally { cleanup(); }
});

test('V155-014: second writeWaveState with body preserves atomicity', async () => {
  const { root, cleanup } = mkProject();
  try {
    await writeWaveState('W2', {
      frontmatter: { wave_id: 'W2', status: 'in_progress' },
      body: 'first body\n',
    }, root);

    await writeWaveState('W2', {
      frontmatter: { wave_id: 'W2', status: 'completed' },
      body: 'second body content\n',
    }, root);

    const statePath = join(root, '.ijfw', 'wave-W2', 'STATE.md');
    const raw = readFileSync(statePath, 'utf8');
    assert.match(raw, /status: completed/, 'second status applied');
    assert.match(raw, /second body content/, 'second body applied');
    assert.ok(!raw.includes('first body'), 'first body replaced');

    // Both writes journaled.
    const records = readJournal(root);
    const begins = records.filter((r) => r.phase === 'begin' && r.verb === 'wave.advance');
    const commits = records.filter((r) => r.phase === 'commit' && r.verb === 'wave.advance');
    assert.equal(begins.length, 2);
    assert.equal(commits.length, 2);
  } finally { cleanup(); }
});
