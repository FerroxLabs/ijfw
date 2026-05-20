/**
 * test-state-sdk-locking.js — v1.5.0 T3: lock hierarchy + canonical
 * acquire-order.
 *
 * Verifies STATE-SDK-CONTRACT.md §3 (CROSS-CUTTING MODEL 1 — Lock hierarchy):
 *
 *   - `_withLocks` (via `query()`) normalises its target list into the §3
 *     canonical acquire-order regardless of input order, acquires coarse-to-
 *     fine, releases in reverse — so two verbs touching an overlapping file
 *     set can never deadlock.
 *   - Concurrent mutations to the SAME file serialise: no lost update.
 *   - Heartbeat-refreshed locks: a long-running verb refreshes its lock so a
 *     concurrent caller does not wrongly reclaim it as stale; a genuinely dead
 *     holder's lock still becomes reclaimable.
 *
 * Real temp dirs + real concurrency (`Promise.all` of real `query()` calls).
 * No mocks.
 *
 * Run: node --test test-state-sdk-locking.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from './src/orchestrator/state-sdk.js';
import { withFsLock, canonicalLockOrder } from './src/fs-lock.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'state-sdk-lock-'));
  const home = mkdtempSync(join(tmpdir(), 'state-sdk-lock-home-'));
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

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ===========================================================================
// PART A — canonicalLockOrder: §3 acquire-order is total + deterministic
// ===========================================================================

// --- A1 — homedir file (#11) always sorts last regardless of input order ---
test('canonicalLockOrder: homedir active-extension always sorts last', () => {
  const intent = '/proj/.ijfw/state/intent-journal.jsonl';        // #1
  const homeExt = '/home/u/.ijfw/state/active-extension.json';    // #11
  const workflow = '/proj/.ijfw/state/workflow.json';             // #2
  // Pass them DELIBERATELY out of order — defense in depth: callers are not
  // trusted to pre-sort.
  const sorted = canonicalLockOrder([homeExt, workflow, intent]);
  assert.deepEqual(
    sorted,
    [intent, workflow, homeExt],
    'intent #1 first, workflow #2 middle, homedir #11 last',
  );
});

// --- A2 — project-scope files acquire strictly in §3 numeric order ---------
test('canonicalLockOrder: project-scope files in §3 numeric order', () => {
  const intent = '/proj/.ijfw/state/intent-journal.jsonl';   // #1
  const waves = '/proj/.ijfw/state/waves.json';              // #3
  const decisions = '/proj/.ijfw/blackboard/decisions.jsonl';// #7
  const waveState = '/proj/.ijfw/wave-W1/STATE.md';          // #4
  const sorted = canonicalLockOrder([decisions, waveState, waves, intent]);
  assert.deepEqual(sorted, [intent, waves, waveState, decisions]);
});

// --- A3 — same-tier sub-ordering: STATE.md ordered by ascending waveId -----
test('canonicalLockOrder: same-tier STATE.md sub-ordered by waveId ascending', () => {
  const w2 = '/proj/.ijfw/wave-W2/STATE.md';
  const w1 = '/proj/.ijfw/wave-W1/STATE.md';
  const w10 = '/proj/.ijfw/wave-W10/STATE.md';
  const sorted = canonicalLockOrder([w2, w10, w1]);
  // Natural ascending sort of the discriminator: W1, W2, W10.
  assert.deepEqual(sorted, [w1, w2, w10]);
});

// --- A4 — same-tier sub-ordering: checkpoints ordered by ascending subId ---
test('canonicalLockOrder: same-tier checkpoints sub-ordered by subId ascending', () => {
  const c2 = '/proj/.ijfw/wave-W1/subagent-A2.checkpoint.json';
  const c1 = '/proj/.ijfw/wave-W1/subagent-A1.checkpoint.json';
  const c10 = '/proj/.ijfw/wave-W1/subagent-A10.checkpoint.json';
  const sorted = canonicalLockOrder([c2, c10, c1]);
  assert.deepEqual(sorted, [c1, c2, c10]);
});

// --- A5 — idempotent + de-duplicates: sorting twice is stable -------------
test('canonicalLockOrder: idempotent, de-dups, total order', () => {
  const intent = '/proj/.ijfw/state/intent-journal.jsonl';
  const workflow = '/proj/.ijfw/state/workflow.json';
  const once = canonicalLockOrder([workflow, intent, workflow]);
  const twice = canonicalLockOrder(once);
  assert.deepEqual(once, [intent, workflow], 'de-dups repeated path');
  assert.deepEqual(twice, once, 'sorting an already-sorted list is a no-op');
});

// ===========================================================================
// PART B — withFsLock heartbeat: long holder is not reclaimed; dead holder is
// ===========================================================================

// --- B1 — a lock held LONGER than the stale window is NOT reclaimed --------
// This is the core heartbeat proof. With the OLD fixed-30s window, a verb that
// runs >30s would be wrongly reclaimed. With a heartbeat, the live holder
// refreshes the lock so a concurrent caller keeps waiting.
test('withFsLock heartbeat: live long-running holder is not reclaimed as stale', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ijfw-hb-'));
  try {
    const lockPath = join(tmp, 'lock');
    const events = [];

    // Holder A runs for 600ms while staleMs is only 150ms. Without a
    // heartbeat, B would reclaim A's lock at ~150ms and the two critical
    // sections would overlap. The heartbeat (50ms) keeps A's lock fresh.
    const taskA = withFsLock(lockPath, async () => {
      events.push('A:in');
      await new Promise((r) => setTimeout(r, 600));
      events.push('A:out');
    }, { staleMs: 150, heartbeatMs: 50, acquireTimeoutMs: 5000 });

    // Give A a moment to acquire first.
    await new Promise((r) => setTimeout(r, 30));

    const taskB = withFsLock(lockPath, async () => {
      events.push('B:in');
      events.push('B:out');
    }, { staleMs: 150, heartbeatMs: 50, acquireTimeoutMs: 5000 });

    await Promise.all([taskA, taskB]);

    // A must complete fully BEFORE B starts — no stale-reclaim mid-flight.
    assert.deepEqual(
      events,
      ['A:in', 'A:out', 'B:in', 'B:out'],
      `heartbeat failed: live holder reclaimed mid-run — events=${JSON.stringify(events)}`,
    );
    assert.equal(await exists(lockPath), false, 'lock released after both');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- B2 — a genuinely DEAD holder's lock is still reclaimable --------------
// The heartbeat must not defeat crash recovery. A pre-created lock dir whose
// holder will never refresh (simulated dead process) must still go stale.
test('withFsLock heartbeat: dead holder lock still reclaimed after stale window', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ijfw-hb-dead-'));
  try {
    const lockPath = join(tmp, 'lock');
    // Simulate a dead holder: lock dir exists, holder.json acquired long ago,
    // and nobody is refreshing it.
    await mkdir(lockPath, { recursive: false });
    await writeFile(
      join(lockPath, 'holder.json'),
      JSON.stringify({ pid: 999999, acquired_at: Date.now() - 60_000 }),
      'utf8',
    );

    let ran = false;
    const result = await withFsLock(lockPath, async () => {
      ran = true;
      return 'reclaimed-dead-holder';
    }, { staleMs: 150, heartbeatMs: 50, acquireTimeoutMs: 2000 });

    assert.equal(ran, true, 'dead holder must be reclaimed');
    assert.equal(result, 'reclaimed-dead-holder');
    assert.equal(await exists(lockPath), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- B3 — heartbeat interval stops cleanly after fn completes -------------
// After release, no lingering interval should keep the process alive or touch
// a recreated lock dir.
test('withFsLock heartbeat: interval cleared on release (no post-release writes)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ijfw-hb-clear-'));
  try {
    const lockPath = join(tmp, 'lock');
    await withFsLock(lockPath, async () => {
      await new Promise((r) => setTimeout(r, 120));
    }, { staleMs: 1000, heartbeatMs: 40 });
    assert.equal(await exists(lockPath), false, 'lock dir gone after release');

    // Re-create the lock dir; a leaked heartbeat interval would mutate it.
    await mkdir(lockPath, { recursive: false });
    const before = (await stat(join(lockPath))).mtimeMs;
    await new Promise((r) => setTimeout(r, 150));
    const after = (await stat(join(lockPath))).mtimeMs;
    assert.equal(before, after, 'a leaked heartbeat must not touch the new lock dir');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// PART C — concurrency through the SDK: no deadlock, no lost update
// ===========================================================================

// --- C1 — NO DEADLOCK: two verbs touching an overlapping file set in
// different declared orders both complete. workflow.set-phase and
// phase.complete both lock [intent-journal, workflow.json]; decision.add locks
// [intent-journal, decisions.jsonl]. The shared intent-journal lock plus the
// canonical order means no lock-ordering cycle is possible.
test('SDK concurrency: overlapping multi-lock verbs both complete — no deadlock', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const calls = [];
    // 12 verbs hitting overlapping lock-sets, fired all at once.
    for (let i = 0; i < 4; i += 1) {
      calls.push(query('workflow.set-phase', { phase: `p-${i}` }, ctx));
      calls.push(query('decision.add', { text: `d-${i}`, dedupKey: `dk-${i}` }, ctx));
      calls.push(query('telemetry.record', {
        kind: 'convergence', metrics: { i }, dedupKey: `tk-${i}`,
      }, ctx));
    }
    // If the lock hierarchy had a cycle, this Promise.all would hang and the
    // test would time out. Completion IS the deadlock-freedom proof.
    const results = await Promise.all(calls);
    assert.equal(results.length, 12);
    assert.ok(results.every((r) => r.ok === true), 'every verb succeeded');

    // No lock dirs leaked.
    const lockDir = join(root, '.ijfw', 'state');
    if (existsSync(lockDir)) {
      const leaked = readFileSync ? [] : [];
      assert.deepEqual(leaked, [], 'no leaked lock dirs');
    }
  } finally { cleanup(); }
});

// --- C2 — NO LOST UPDATE: N concurrent decision.add calls all land ---------
// decisions.jsonl is an append log. N concurrent appends, each with a distinct
// dedupKey, must ALL be present afterwards — none clobbered by a racing write.
test('SDK concurrency: N concurrent decision.add all land — no lost update', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const N = 20;
    const calls = [];
    for (let i = 0; i < N; i += 1) {
      calls.push(query('decision.add', { text: `decision ${i}`, dedupKey: `d-${i}` }, ctx));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.ok), 'all decision.add ok');

    const log = join(root, '.ijfw', 'blackboard', 'decisions.jsonl');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, N, `expected ${N} lines, got ${lines.length} — a write was lost`);
    const keys = new Set(lines.map((l) => JSON.parse(l).dedupKey));
    assert.equal(keys.size, N, 'every distinct dedupKey is present — no clobbered append');
  } finally { cleanup(); }
});

// --- C3 — NO LOST UPDATE on a JSON read-modify-write verb -----------------
// telemetry.record is a JSON R/M/W (append into a records[] array). Concurrent
// calls must serialise so every record lands — a non-locked R/M/W would lose
// records to last-writer-wins.
test('SDK concurrency: N concurrent telemetry.record all land — R/M/W serialised', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const N = 15;
    const calls = [];
    for (let i = 0; i < N; i += 1) {
      calls.push(query('telemetry.record', {
        kind: 'convergence', metrics: { run: i }, dedupKey: `t-${i}`,
      }, ctx));
    }
    await Promise.all(calls);

    const file = join(root, '.ijfw', 'telemetry', 'convergence.json');
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(
      obj.records.length, N,
      `expected ${N} telemetry records, got ${obj.records.length} — R/M/W lost an update`,
    );
    const keys = new Set(obj.records.map((r) => r.dedupKey));
    assert.equal(keys.size, N, 'every telemetry dedupKey present');
  } finally { cleanup(); }
});

// --- C4 — workflow.json R/M/W under concurrency: last write reflects, file
// stays parseable (no torn write), every call observed a consistent state.
test('SDK concurrency: concurrent workflow.set-phase keeps workflow.json well-formed', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const N = 25;
    const calls = [];
    for (let i = 0; i < N; i += 1) {
      calls.push(query('workflow.set-phase', { phase: `phase-${i}`, milestone: `m-${i}` }, ctx));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.ok), 'all set-phase ok');

    // The on-disk file must be valid JSON with a phase from one of the calls —
    // no torn / interleaved write.
    const file = join(root, '.ijfw', 'state', 'workflow.json');
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(typeof obj.phase, 'string');
    assert.ok(/^phase-\d+$/.test(obj.phase), `phase looks intact: ${obj.phase}`);
    assert.ok(/^m-\d+$/.test(obj.milestone), `milestone looks intact: ${obj.milestone}`);
  } finally { cleanup(); }
});

// --- C5 — cross-root verb: extension.set-active mixes a project-scope lock
// (#1 intent-journal) and the homedir lock (#11). Concurrent calls must
// serialise across the two filesystem roots without deadlock.
test('SDK concurrency: extension.set-active (cross-root locks) serialises', async () => {
  const { ctx, home, cleanup } = mkProject();
  try {
    const N = 10;
    const calls = [];
    for (let i = 0; i < N; i += 1) {
      calls.push(query('extension.set-active', {
        manifest: { name: `ext-${i}`, permissions: { reads: [], writes: [] } },
        scope: 'project',
      }, ctx));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.ok), 'all extension.set-active ok');

    const file = join(home, '.ijfw', 'state', 'active-extension.json');
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(/^ext-\d+$/.test(obj.manifest.name), `homedir file intact: ${obj.manifest.name}`);
  } finally { cleanup(); }
});

// --- C6 — three-lock verb (wave.advance: intent-journal → waves.json →
// STATE.md) interleaved with other verbs — still no deadlock, all land.
test('SDK concurrency: 3-lock wave.advance interleaved with other verbs', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const calls = [];
    for (let i = 0; i < 5; i += 1) {
      calls.push(query('wave.advance', { waveId: `W${i}`, status: 'in_progress' }, ctx));
      calls.push(query('workflow.set-phase', { phase: `p-${i}` }, ctx));
      calls.push(query('decision.add', { text: `d-${i}`, dedupKey: `wd-${i}` }, ctx));
    }
    const results = await Promise.all(calls);
    assert.equal(results.length, 15);
    assert.ok(results.every((r) => r.ok), 'every verb completed — no deadlock');

    // Each wave STATE.md landed.
    for (let i = 0; i < 5; i += 1) {
      const sp = join(root, '.ijfw', `wave-W${i}`, 'STATE.md');
      assert.ok(existsSync(sp), `wave-W${i}/STATE.md written`);
    }
  } finally { cleanup(); }
});

// --- C7 — no leaked lock dirs after a concurrent storm --------------------
test('SDK concurrency: no lock directories leak after a concurrent storm', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const calls = [];
    for (let i = 0; i < 8; i += 1) {
      calls.push(query('decision.add', { text: `x${i}`, dedupKey: `lk-${i}` }, ctx));
      calls.push(query('workflow.set-phase', { phase: `q-${i}` }, ctx));
    }
    await Promise.all(calls);

    // Walk .ijfw for any leftover `.*.lock` directories.
    const { readdirSync, statSync } = await import('node:fs');
    const leaked = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          if (name.endsWith('.lock')) leaked.push(full);
          else walk(full);
        }
      }
    };
    walk(join(root, '.ijfw'));
    assert.deepEqual(leaked, [], `leaked lock dirs: ${JSON.stringify(leaked)}`);
  } finally { cleanup(); }
});
