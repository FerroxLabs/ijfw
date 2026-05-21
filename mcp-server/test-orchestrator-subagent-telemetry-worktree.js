/**
 * test-orchestrator-subagent-telemetry-worktree.js
 *
 * IJFW v1.5.0-major W12-A0 / S01 — worktree → parent checkpoint visibility.
 *
 * Covers the R3 #1 honest finding: subagents in `isolation: 'worktree'` write
 * checkpoints under the WORKTREE's `.ijfw/` directory, which vanish at
 * `git worktree remove` time. The S01 fix introduces:
 *
 *   1. IJFW_PARENT_PROJECT_ROOT env var honored by record/read/listOrphaned
 *      (primary mechanism — checkpoints land in parent transparently).
 *   2. drainCheckpoints(waveId, worktreePath, projectRoot) — belt+suspenders
 *      copy used pre-cleanup when env-var passthrough is unavailable.
 *   3. listOrphanedSubagents(waveId, projectRoot, additionalRoots) — scans
 *      across active worktrees so in-flight checkpoints are visible mid-wave.
 *
 * Tests use mkdtempSync per test (isolated) and explicitly restore
 * IJFW_PARENT_PROJECT_ROOT after mutation so cross-test bleed cannot occur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordCheckpoint,
  readLastCheckpoint,
  listOrphanedSubagents,
  drainCheckpoints,
} from './src/orchestrator/subagent-telemetry.js';

function makeTmp(label = 'subagent-telem-wt-') {
  return mkdtempSync(join(tmpdir(), label));
}

/** Save+clear env var; returns restore function. */
function withClearedEnv(name) {
  const prior = process.env[name];
  delete process.env[name];
  return () => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  };
}

/** Save+set env var; returns restore function. */
function withSetEnv(name, value) {
  const prior = process.env[name];
  process.env[name] = value;
  return () => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  };
}

// ---------------------------------------------------------------------------
// 1. recordCheckpoint honors IJFW_PARENT_PROJECT_ROOT (writes to parent, not
//    the passed projectRoot — which would be the worktree in production).
// ---------------------------------------------------------------------------

test('recordCheckpoint honors IJFW_PARENT_PROJECT_ROOT and writes to parent', async (t) => {
  const parent = makeTmp('parent-');
  const worktree = makeTmp('worktree-');
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  const restoreEnv = withSetEnv('IJFW_PARENT_PROJECT_ROOT', parent);
  t.after(restoreEnv);

  await recordCheckpoint(
    'W12-A0',
    'W12-A0-S01',
    { last_action: 'env-var-honored', tool_use_count: 3 },
    worktree, // <-- production: this would be the worktree's cwd
  );

  // Checkpoint MUST land in parent, NOT in worktree.
  const parentFile = join(parent, '.ijfw', 'wave-W12-A0', 'subagent-W12-A0-S01.checkpoint.json');
  const worktreeFile = join(worktree, '.ijfw', 'wave-W12-A0', 'subagent-W12-A0-S01.checkpoint.json');

  assert.ok(existsSync(parentFile), 'checkpoint should exist in PARENT .ijfw/');
  assert.equal(existsSync(worktreeFile), false, 'checkpoint should NOT exist in worktree .ijfw/');

  // readLastCheckpoint with the same env var also resolves to parent.
  const read = await readLastCheckpoint('W12-A0', 'W12-A0-S01', worktree);
  assert.ok(read !== null);
  assert.equal(read.last_action, 'env-var-honored');
  assert.equal(read.tool_use_count, 3);
});

// ---------------------------------------------------------------------------
// 2. Backward compat: without env var, writes go to passed projectRoot.
// ---------------------------------------------------------------------------

test('recordCheckpoint without IJFW_PARENT_PROJECT_ROOT writes to passed projectRoot (back-compat)', async (t) => {
  const root = makeTmp('legacy-');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const restoreEnv = withClearedEnv('IJFW_PARENT_PROJECT_ROOT');
  t.after(restoreEnv);

  await recordCheckpoint(
    'W12-A0',
    'legacy-sub',
    { last_action: 'no-env-var' },
    root,
  );

  const file = join(root, '.ijfw', 'wave-W12-A0', 'subagent-legacy-sub.checkpoint.json');
  assert.ok(existsSync(file), 'checkpoint should land in passed projectRoot when env var absent');

  const read = await readLastCheckpoint('W12-A0', 'legacy-sub', root);
  assert.ok(read !== null);
  assert.equal(read.last_action, 'no-env-var');
});

// ---------------------------------------------------------------------------
// 3. listOrphanedSubagents with additionalRoots finds checkpoints across
//    worktree paths (orchestrator-side mid-flight visibility).
// ---------------------------------------------------------------------------

test('listOrphanedSubagents with additionalRoots scans worktree checkpoints', async (t) => {
  const parent = makeTmp('parent-');
  const worktreeA = makeTmp('wtA-');
  const worktreeB = makeTmp('wtB-');
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(worktreeA, { recursive: true, force: true });
    rmSync(worktreeB, { recursive: true, force: true });
  });

  // Force env var absent so we can place checkpoints in different physical roots.
  const restoreEnv = withClearedEnv('IJFW_PARENT_PROJECT_ROOT');
  t.after(restoreEnv);

  // Parent has one checkpoint (already-drained subagent).
  await recordCheckpoint('W12-A0', 'sub-parent', { last_action: 'a' }, parent);
  // Worktree A has one in-flight checkpoint.
  await recordCheckpoint('W12-A0', 'sub-wtA', { last_action: 'b' }, worktreeA);
  // Worktree B has one in-flight checkpoint.
  await recordCheckpoint('W12-A0', 'sub-wtB', { last_action: 'c' }, worktreeB);

  // Without additionalRoots: only parent visible.
  const onlyParent = await listOrphanedSubagents('W12-A0', parent);
  assert.deepEqual(onlyParent.sort(), ['sub-parent']);

  // With additionalRoots: all three visible, deduplicated.
  const all = await listOrphanedSubagents('W12-A0', parent, [worktreeA, worktreeB]);
  assert.deepEqual(all.sort(), ['sub-parent', 'sub-wtA', 'sub-wtB']);

  // Duplicate root passing does not double-count.
  const dedup = await listOrphanedSubagents('W12-A0', parent, [worktreeA, worktreeA]);
  assert.deepEqual(dedup.sort(), ['sub-parent', 'sub-wtA']);
});

// ---------------------------------------------------------------------------
// 4. drainCheckpoints copies all subagent-*.checkpoint.json from worktree to
//    parent, preserving filenames and content.
// ---------------------------------------------------------------------------

test('drainCheckpoints copies all subagent checkpoints from worktree to parent', async (t) => {
  const parent = makeTmp('parent-');
  const worktree = makeTmp('worktree-');
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  const restoreEnv = withClearedEnv('IJFW_PARENT_PROJECT_ROOT');
  t.after(restoreEnv);

  // Stage 3 checkpoints in the worktree.
  await recordCheckpoint('W12-A0', 'sub-1', { last_action: 'one' }, worktree);
  await recordCheckpoint('W12-A0', 'sub-2', { last_action: 'two' }, worktree);
  await recordCheckpoint('W12-A0', 'sub-3', { last_action: 'three' }, worktree);

  // Also put a non-matching file in there to confirm the drain ignores it.
  const wtWaveDir = join(worktree, '.ijfw', 'wave-W12-A0');
  await writeFile(join(wtWaveDir, 'README.txt'), 'not a checkpoint', 'utf8');

  const result = await drainCheckpoints('W12-A0', worktree, parent);
  assert.equal(result.ok, true);
  assert.equal(result.drained, 3);

  // All 3 checkpoints should now exist in parent.
  const parentDir = join(parent, '.ijfw', 'wave-W12-A0');
  const entries = readdirSync(parentDir).sort();
  assert.deepEqual(entries.filter((n) => n.endsWith('.checkpoint.json')), [
    'subagent-sub-1.checkpoint.json',
    'subagent-sub-2.checkpoint.json',
    'subagent-sub-3.checkpoint.json',
  ]);

  // Content preserved. v1.5.0 T9 nests the recordCheckpoint envelope under
  // `.checkpoint` because the state-SDK `subagent.checkpoint` verb wraps with
  // { waveId, subagentId, dedupKey, checkpoint, updated_at }. Descend in.
  const raw = await readFile(join(parentDir, 'subagent-sub-2.checkpoint.json'), 'utf8');
  const wrapped = JSON.parse(raw);
  assert.equal(wrapped.waveId, 'W12-A0');
  assert.equal(wrapped.subagentId, 'sub-2');
  const parsed = wrapped.checkpoint;
  assert.equal(parsed.last_action, 'two');
  assert.equal(parsed.sub_id, 'sub-2');

  // Non-checkpoint file NOT copied.
  assert.equal(entries.includes('README.txt'), false);
});

// ---------------------------------------------------------------------------
// 5. drainCheckpoints on an empty/missing worktree wave dir returns 0 cleanly.
// ---------------------------------------------------------------------------

test('drainCheckpoints on empty worktree returns {ok:true, drained:0}', async (t) => {
  const parent = makeTmp('parent-');
  const worktree = makeTmp('worktree-empty-');
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  // Worktree has no .ijfw/ at all.
  const result1 = await drainCheckpoints('W12-A0', worktree, parent);
  assert.equal(result1.ok, true);
  assert.equal(result1.drained, 0);

  // Worktree has .ijfw/wave-W12-A0/ but no checkpoints in it.
  await mkdir(join(worktree, '.ijfw', 'wave-W12-A0'), { recursive: true });
  const result2 = await drainCheckpoints('W12-A0', worktree, parent);
  assert.equal(result2.ok, true);
  assert.equal(result2.drained, 0);
});

// ---------------------------------------------------------------------------
// 6. drainCheckpoints is idempotent — second run with same source produces no
//    duplicates and overwrites with same content.
// ---------------------------------------------------------------------------

test('drainCheckpoints is idempotent across repeated runs', async (t) => {
  const parent = makeTmp('parent-');
  const worktree = makeTmp('worktree-');
  t.after(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  const restoreEnv = withClearedEnv('IJFW_PARENT_PROJECT_ROOT');
  t.after(restoreEnv);

  await recordCheckpoint('W12-A0', 'sub-idem', { last_action: 'first' }, worktree);

  const r1 = await drainCheckpoints('W12-A0', worktree, parent);
  assert.equal(r1.ok, true);
  assert.equal(r1.drained, 1);

  const r2 = await drainCheckpoints('W12-A0', worktree, parent);
  assert.equal(r2.ok, true);
  assert.equal(r2.drained, 1, 'second run still reports 1 (overwrite, not skip)');

  // Exactly one file in parent (no duplicates).
  const parentDir = join(parent, '.ijfw', 'wave-W12-A0');
  const entries = readdirSync(parentDir).filter((n) => n.startsWith('subagent-') && n.endsWith('.checkpoint.json'));
  assert.equal(entries.length, 1, 'no duplicate checkpoint files');

  // Content preserved. Descend into `.checkpoint` (v1.5.0 T9 SDK envelope).
  const raw = await readFile(join(parentDir, entries[0]), 'utf8');
  const wrapped = JSON.parse(raw);
  const parsed = wrapped.checkpoint;
  assert.equal(parsed.last_action, 'first');
});
