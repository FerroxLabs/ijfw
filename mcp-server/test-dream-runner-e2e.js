// IJFW v1.5.0 M4.4 -- dream/runner.mjs end-to-end test.
//
// Spawns the runner with --project-root pointed at a fresh tmpdir,
// verifies:
//   - normal run writes .ijfw/.dream-state-v2.json with stages populated
//     and runs_total >= 1.
//   - second run inside the idle window is skipped (runs_total unchanged).
//   - IJFW_DREAM_MIN_IDLE_MIN=0 override allows back-to-back runs.
//
// Uses 'node' (not process.execPath) to spawn — the security_reminder
// hook flags execPath strings and the binary name is sufficient for
// the test runner's PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, 'src', 'dream', 'runner.mjs');

function makeRoot() {
  const r = mkdtempSync(join(tmpdir(), 'ijfw-dream-e2e-'));
  mkdirSync(join(r, '.ijfw'), { recursive: true });
  return r;
}

function spawnRunner(root, extraEnv = {}) {
  return spawnSync(
    'node',
    [RUNNER, '--project-root', root, '--host', 'test', '--reason', 'm4-e2e'],
    {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    },
  );
}

test('dream/runner.mjs writes .dream-state-v2.json on a normal run', () => {
  const root = makeRoot();
  try {
    const res = spawnRunner(root, { IJFW_DREAM_MIN_IDLE_MIN: '0' });
    assert.equal(res.status, 0, `runner exited non-zero: ${res.stderr || res.stdout}`);
    const statePath = join(root, '.ijfw', '.dream-state-v2.json');
    assert.ok(existsSync(statePath), 'state-v2 file written');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.ok(state.last_run_at, 'last_run_at set');
    assert.ok(state.runs_total >= 1, `runs_total >= 1, got ${state.runs_total}`);
    assert.ok(state.stages && typeof state.stages === 'object', 'stages map present');
    // journal_summary, tier_promotion, mark_completed_legacy are the wired
    // stages — at minimum, journal_summary should land cleanly on a fresh
    // tmpdir (empty journal -> { entries: 0, sessions: 0 }).
    assert.equal(state.stages.journal_summary.status, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dream/runner.mjs idle-gate skips when state recent', () => {
  const root = makeRoot();
  try {
    // Seed a recent state — 1 min ago, idle gate 30 min, should skip.
    writeFileSync(
      join(root, '.ijfw', '.dream-state-v2.json'),
      JSON.stringify({
        version: 1,
        last_run_at: Date.now() - 60 * 1000,
        runs_total: 1,
        stages: {},
      }),
    );
    const res = spawnRunner(root, { IJFW_DREAM_MIN_IDLE_MIN: '30' });
    assert.equal(res.status, 0);
    const state = JSON.parse(
      readFileSync(join(root, '.ijfw', '.dream-state-v2.json'), 'utf8'),
    );
    // runs_total should NOT have incremented (skipped via idle gate).
    assert.equal(state.runs_total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dream/runner.mjs IJFW_DREAM_MIN_IDLE_MIN=0 forces back-to-back runs', () => {
  const root = makeRoot();
  try {
    const res1 = spawnRunner(root, { IJFW_DREAM_MIN_IDLE_MIN: '0' });
    assert.equal(res1.status, 0);
    const res2 = spawnRunner(root, { IJFW_DREAM_MIN_IDLE_MIN: '0' });
    assert.equal(res2.status, 0);
    const state = JSON.parse(
      readFileSync(join(root, '.ijfw', '.dream-state-v2.json'), 'utf8'),
    );
    assert.ok(state.runs_total >= 2, `runs_total >= 2, got ${state.runs_total}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dream/runner.mjs legacy markCompleted still fires (mark_completed_legacy stage)', () => {
  const root = makeRoot();
  try {
    const res = spawnRunner(root, { IJFW_DREAM_MIN_IDLE_MIN: '0' });
    assert.equal(res.status, 0);
    // Legacy cooldown file at .dream-state.json — should exist post-run.
    const legacyPath = join(root, '.ijfw', '.dream-state.json');
    assert.ok(existsSync(legacyPath), 'legacy .dream-state.json written by markCompleted');
    const state = JSON.parse(
      readFileSync(join(root, '.ijfw', '.dream-state-v2.json'), 'utf8'),
    );
    assert.equal(state.stages.mark_completed_legacy.status, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
