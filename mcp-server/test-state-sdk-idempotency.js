/**
 * test-state-sdk-idempotency.js — v1.5.0 T4: intent/commit idempotency +
 * append dedup.
 *
 * Verifies STATE-SDK-CONTRACT.md §4 (CROSS-CUTTING MODEL 2 — Intent / commit
 * record):
 *
 *   - Every mutating verb writes a `begin` record to intent-journal.jsonl
 *     before its mutation and a matching `commit` after the atomic rename(s).
 *   - Replaying a committed verb (same dedupKey / same content) is a no-op —
 *     the underlying state is not mutated twice.
 *   - An interrupted verb (begin written, no commit) rolls back via
 *     `state.replay` — its partial mutation is undone, and the next clean
 *     invocation re-runs without double-applying.
 *   - Append-style verbs carrying a `dedupKey` never double-append on replay.
 *   - `payloadDigest` is canonical (key-sorted, recursive) — two payloads with
 *     identical content but different key insertion order hash identically, so
 *     replay safety survives a process restart.
 *
 * Real temp dirs + real `query()` calls. No mocks.
 *
 * Run: node --test test-state-sdk-idempotency.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, payloadDigest, VERBS } from './src/orchestrator/state-sdk.js';

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), 'state-sdk-idem-'));
  const home = mkdtempSync(join(tmpdir(), 'state-sdk-idem-home-'));
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

/** Parse the intent journal into an array of records. */
function readJournal(root) {
  const p = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ===========================================================================
// PART A — intent/commit records are written for every mutating verb
// ===========================================================================

// --- A1 — a mutating verb writes a begin + a matching commit --------------
test('journal: a mutating verb writes a begin then a matching commit', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const r = await query('workflow.set-phase', { phase: 'build' }, ctx);
    assert.equal(r.ok, true);

    const recs = readJournal(root);
    const begin = recs.find((x) => x.verbId === r.verbId && x.phase === 'begin');
    const commit = recs.find((x) => x.verbId === r.verbId && x.phase === 'commit');
    assert.ok(begin, 'a begin record was written');
    assert.ok(commit, 'a commit record was written');
    assert.equal(begin.verb, 'workflow.set-phase');
    assert.equal(begin.phase, 'begin');
    assert.equal(commit.phase, 'commit');
    assert.equal(begin.verbId, commit.verbId, 'begin + commit share verbId');
    assert.equal(typeof begin.ts, 'string');
    assert.ok(/^sha256-[0-9a-f]+$/.test(begin.payloadDigest), 'sha256 digest');
    assert.ok(Array.isArray(begin.targets) && begin.targets.length > 0,
      'begin lists the target files');
  } finally { cleanup(); }
});

// --- A2 — a read-only verb writes NO journal records ----------------------
test('journal: a read-only verb writes no intent records', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('workflow.get', {}, ctx);
    await query('state.validate', {}, ctx);
    assert.equal(readJournal(root).length, 0, 'no journal records for read verbs');
  } finally { cleanup(); }
});

// --- A3 — T4 owns creating intent-journal.jsonl on first write ------------
test('journal: intent-journal.jsonl is created lazily on first mutating verb', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const p = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
    assert.equal(existsSync(p), false, 'no journal before any write');
    await query('decision.add', { text: 'hi', dedupKey: 'dk-a3' }, ctx);
    assert.equal(existsSync(p), true, 'journal created on first write');
  } finally { cleanup(); }
});

// ===========================================================================
// PART B — replaying a committed verb is a no-op
// ===========================================================================

// --- B1 — replaying a committed write verb does not mutate state twice ----
test('replay: a committed write verb is a no-op on replay (state not mutated twice)', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('workflow.set-phase', { phase: 'build' }, ctx);
    const wf1 = JSON.parse(readFileSync(
      join(root, '.ijfw', 'state', 'workflow.json'), 'utf8',
    ));

    const replay = await query('state.replay', {}, ctx);
    assert.equal(replay.ok, true);
    assert.ok(replay.skipped.length >= 1, 'the committed verb is skipped');
    assert.equal(replay.rolledBack.length, 0, 'nothing to roll back');

    const wf2 = JSON.parse(readFileSync(
      join(root, '.ijfw', 'state', 'workflow.json'), 'utf8',
    ));
    assert.deepEqual(wf2, wf1, 'state unchanged — replay of a committed verb is a no-op');
  } finally { cleanup(); }
});

// --- B2 — replay does not append a duplicate effect to the journal --------
test('replay: replaying committed verbs adds no new journal records', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('workflow.set-phase', { phase: 'plan' }, ctx);
    await query('decision.add', { text: 'x', dedupKey: 'dk-b2' }, ctx);
    const before = readJournal(root).length;

    await query('state.replay', {}, ctx);
    const after = readJournal(root).length;
    assert.equal(after, before, 'replay (read-only verb) writes no journal records');
  } finally { cleanup(); }
});

// ===========================================================================
// PART C — interrupted verb (begin, no commit) rolls back via state.replay
// ===========================================================================

// --- C1 — a hand-written begin-only partial is rolled back ----------------
// Simulate an interrupted verb: write a fresh workflow.json, then hand-write a
// begin record (with a pre-begin snapshot) but NO commit. state.replay must
// restore workflow.json to its pre-begin content.
test('rollback: a begin-without-commit partial is rolled back by state.replay', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    // Establish a committed baseline.
    await query('workflow.set-phase', { phase: 'baseline' }, ctx);
    const baseline = readFileSync(
      join(root, '.ijfw', 'state', 'workflow.json'), 'utf8',
    );

    // Simulate a partial: a verb that began (snapshot captured), mutated the
    // file, then crashed before writing commit.
    const wfPath = join(root, '.ijfw', 'state', 'workflow.json');
    const journalPath = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
    const snapDir = join(root, '.ijfw', 'state', 'intent-snapshots');
    mkdirSync(snapDir, { recursive: true });
    const partialId = 'v-partial-c1-0000';
    // Snapshot = the pre-begin content (the committed baseline).
    writeFileSync(join(snapDir, `${partialId}.json`), JSON.stringify({
      verbId: partialId,
      targets: [{
        relPath: '.ijfw/state/workflow.json',
        absPath: wfPath,
        existed: true,
        content: baseline,
      }],
    }));
    // The interrupted verb's mutation: a corrupt/half-applied phase.
    writeFileSync(wfPath, JSON.stringify({ phase: 'HALF-APPLIED' }));
    // The begin record — NO commit follows.
    writeFileSync(journalPath, `${JSON.stringify({
      verb: 'workflow.set-phase',
      verbId: partialId,
      phase: 'begin',
      ts: new Date().toISOString(),
      targets: ['.ijfw/state/workflow.json'],
      payloadDigest: 'sha256-deadbeef',
    })}\n`, { flag: 'a' });

    const replay = await query('state.replay', {}, ctx);
    assert.equal(replay.ok, true);
    assert.ok(replay.rolledBack.includes(partialId), 'the partial verb was rolled back');

    const restored = readFileSync(wfPath, 'utf8');
    assert.equal(restored, baseline, 'workflow.json restored to its pre-begin content');
  } finally { cleanup(); }
});

// --- C2 — a partial that CREATED a new file is rolled back by deletion ----
test('rollback: a partial that created a fresh file is removed on replay', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const journalPath = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
    const snapDir = join(root, '.ijfw', 'state', 'intent-snapshots');
    mkdirSync(snapDir, { recursive: true });
    const tgtRel = '.ijfw/state/waves.json';
    const tgtAbs = join(root, '.ijfw', 'state', 'waves.json');
    const partialId = 'v-partial-c2-0000';
    // Snapshot records the file did NOT exist pre-begin.
    writeFileSync(join(snapDir, `${partialId}.json`), JSON.stringify({
      verbId: partialId,
      targets: [{ relPath: tgtRel, absPath: tgtAbs, existed: false, content: null }],
    }));
    // The interrupted verb created the file.
    writeFileSync(tgtAbs, JSON.stringify({ partial: true }));
    writeFileSync(journalPath, `${JSON.stringify({
      verb: 'wave.advance',
      verbId: partialId,
      phase: 'begin',
      ts: new Date().toISOString(),
      targets: [tgtRel],
      payloadDigest: 'sha256-cafe',
    })}\n`, { flag: 'a' });

    const replay = await query('state.replay', {}, ctx);
    assert.ok(replay.rolledBack.includes(partialId));
    assert.equal(existsSync(tgtAbs), false,
      'a partially-created file is deleted on rollback');
  } finally { cleanup(); }
});

// --- C3 — after rollback, re-running the verb cleanly applies once --------
test('rollback: after a partial rollback the verb re-runs cleanly (no double-apply)', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('workflow.set-phase', { phase: 'baseline' }, ctx);
    const wfPath = join(root, '.ijfw', 'state', 'workflow.json');
    const baseline = readFileSync(wfPath, 'utf8');

    // Inject a begin-only partial.
    const journalPath = join(root, '.ijfw', 'state', 'intent-journal.jsonl');
    const snapDir = join(root, '.ijfw', 'state', 'intent-snapshots');
    mkdirSync(snapDir, { recursive: true });
    const partialId = 'v-partial-c3-0000';
    writeFileSync(join(snapDir, `${partialId}.json`), JSON.stringify({
      verbId: partialId,
      targets: [{
        relPath: '.ijfw/state/workflow.json', absPath: wfPath,
        existed: true, content: baseline,
      }],
    }));
    writeFileSync(wfPath, JSON.stringify({ phase: 'HALF' }));
    writeFileSync(journalPath, `${JSON.stringify({
      verb: 'workflow.set-phase', verbId: partialId, phase: 'begin',
      ts: new Date().toISOString(), targets: ['.ijfw/state/workflow.json'],
      payloadDigest: 'sha256-1234',
    })}\n`, { flag: 'a' });

    await query('state.replay', {}, ctx);
    // Now re-run the real verb — it must apply exactly once.
    const r = await query('workflow.set-phase', { phase: 'final' }, ctx);
    assert.equal(r.ok, true);
    const wf = JSON.parse(readFileSync(wfPath, 'utf8'));
    assert.equal(wf.phase, 'final', 'the re-run applied cleanly');
  } finally { cleanup(); }
});

// ===========================================================================
// PART D — append dedup: a double append with the same dedupKey lands once
// ===========================================================================

// --- D1 — double decision.add with same dedupKey appends exactly once ----
test('append-dedup: double decision.add same dedupKey → exactly one record', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const r1 = await query('decision.add', { text: 'once', dedupKey: 'dk-d1' }, ctx);
    const r2 = await query('decision.add', { text: 'once', dedupKey: 'dk-d1' }, ctx);
    assert.equal(r1.deduped, false, 'first add is fresh');
    assert.equal(r2.deduped, true, 'second add is deduped');

    const log = join(root, '.ijfw', 'blackboard', 'decisions.jsonl');
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one record appended despite two calls');
  } finally { cleanup(); }
});

// --- D2 — the journal and the target-log dedup agree (no split-brain) -----
test('append-dedup: journal commit records and target-log scan agree', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('decision.add', { text: 'agree', dedupKey: 'dk-d2' }, ctx);
    await query('decision.add', { text: 'agree', dedupKey: 'dk-d2' }, ctx);

    // Target-log scan: exactly one decisions.jsonl record with the dedupKey.
    const log = join(root, '.ijfw', 'blackboard', 'decisions.jsonl');
    const logRecs = readFileSync(log, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const logHits = logRecs.filter((x) => x.dedupKey === 'dk-d2');
    assert.equal(logHits.length, 1, 'target log holds the dedupKey once');

    // Journal scan: the dedupKey appears on a commit record (the authoritative
    // idempotency truth). It must be present — agreement, not split-brain.
    const journalRecs = readJournal(root);
    const committedKey = journalRecs.some(
      (x) => x.phase === 'commit' && x.dedupKey === 'dk-d2',
    );
    assert.equal(committedKey, true,
      'the journal records the dedupKey as committed — agrees with the target log');
  } finally { cleanup(); }
});

// --- D3 — append dedup holds across an append into a JSON R/M/W verb -----
test('append-dedup: telemetry.record double dedupKey → one records[] entry', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('telemetry.record', {
      kind: 'convergence', metrics: { a: 1 }, dedupKey: 'dk-d3',
    }, ctx);
    const r2 = await query('telemetry.record', {
      kind: 'convergence', metrics: { a: 1 }, dedupKey: 'dk-d3',
    }, ctx);
    assert.equal(r2.deduped, true);
    const file = join(root, '.ijfw', 'telemetry', 'convergence.json');
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(obj.records.length, 1, 'exactly one telemetry record');
  } finally { cleanup(); }
});

// ===========================================================================
// PART E — canonical-digest stability (cross-run replay safety)
// ===========================================================================

// --- E1 — payloadDigest is key-order independent --------------------------
test('digest: two payloads with same content / different key order hash equal', () => {
  const a = { phase: 'build', status: 'in_progress', milestone: 'v1.5.0' };
  const b = { milestone: 'v1.5.0', phase: 'build', status: 'in_progress' };
  assert.equal(payloadDigest(a), payloadDigest(b),
    'canonical JSON → key order does not affect the digest');
});

// --- E2 — canonical digest recurses into nested objects ------------------
test('digest: canonicalization is recursive (nested key order ignored)', () => {
  const a = { outer: { x: 1, y: 2 }, list: [{ p: 1, q: 2 }] };
  const b = { list: [{ q: 2, p: 1 }], outer: { y: 2, x: 1 } };
  assert.equal(payloadDigest(a), payloadDigest(b),
    'nested objects are canonicalized recursively');
});

// --- E3 — different content still produces different digests -------------
test('digest: distinct payloads produce distinct digests', () => {
  assert.notEqual(
    payloadDigest({ phase: 'a' }),
    payloadDigest({ phase: 'b' }),
    'a content difference must change the digest',
  );
  // Array order IS significant (arrays are ordered) — not canonicalized away.
  assert.notEqual(
    payloadDigest({ list: [1, 2] }),
    payloadDigest({ list: [2, 1] }),
    'array element order is preserved (arrays are ordered data)',
  );
});

// --- E4 — digest is stable for null / undefined payloads -----------------
test('digest: null and undefined payloads are handled deterministically', () => {
  assert.equal(payloadDigest(null), payloadDigest(undefined),
    'null / undefined collapse to the same canonical form');
  assert.ok(/^sha256-[0-9a-f]+$/.test(payloadDigest(null)));
});

// ===========================================================================
// PART F — replay-safety end-to-end: an append verb replayed never doubles
// ===========================================================================

// --- F1 — replaying after a committed append verb does not re-append ------
test('replay: a committed append verb is skipped and never re-appended', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('wave.record-task', {
      waveId: 'W1', taskId: 'T-1', status: 'complete', dedupKey: 'dk-f1',
    }, ctx);
    const stateBefore = readFileSync(
      join(root, '.ijfw', 'wave-W1', 'STATE.md'), 'utf8',
    );

    const replay = await query('state.replay', {}, ctx);
    assert.ok(replay.skipped.length >= 1, 'the committed append verb is skipped');

    const stateAfter = readFileSync(
      join(root, '.ijfw', 'wave-W1', 'STATE.md'), 'utf8',
    );
    assert.equal(stateAfter, stateBefore,
      'STATE.md unchanged — the append verb was not replayed');
  } finally { cleanup(); }
});

// ===========================================================================
// PART G — GENUINELY interrupted query() (issue 5): a real throwing handler
// drives the dispatcher's actual catch path, producing a real begin-without-
// commit partial. No hand-written journal/snapshot — the SDK writes them.
//
// The "injected throwing handler" wraps the REAL handler: it runs the real
// handler fully (real `_withLocks` → real `begin` + snapshot + mutation) then
// throws BEFORE returning, simulating the process dying after the handler's
// work but before the dispatcher's `_journalCommit`. Real `query()`, real
// dispatcher catch, real temp dirs.
// ===========================================================================

/** Run `fn` with `VERBS[verb]` swapped for `wrapper`; always restore after. */
async function withInjectedHandler(verb, wrapper, fn) {
  const original = VERBS[verb];
  VERBS[verb] = wrapper(original);
  try {
    return await fn();
  } finally {
    VERBS[verb] = original;
  }
}

// --- G1 — a genuinely interrupted OVERWRITE verb is snapshot-rolled-back --
test('rollback (real interruption): an interrupted overwrite verb is rolled back', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    // Committed baseline written by a normal query().
    await query('workflow.set-phase', { phase: 'baseline' }, ctx);
    const wfPath = join(root, '.ijfw', 'state', 'workflow.json');
    const baseline = readFileSync(wfPath, 'utf8');

    // Inject: run the real workflow.set-phase handler (real begin + snapshot
    // + the real workflow.json overwrite), THEN throw — the process "crashes"
    // after the mutation but before _journalCommit.
    await assert.rejects(
      withInjectedHandler(
        'workflow.set-phase',
        (real) => async (payload, c, env) => {
          await real(payload, c, env); // real mutation happens here
          throw new Error('simulated crash after mutation, before commit');
        },
        () => query('workflow.set-phase', { phase: 'INTERRUPTED' }, ctx),
      ),
      /simulated crash/,
      'the interrupted query() rejects through the dispatcher catch path',
    );

    // The mutation landed but no commit was written → workflow.json now holds
    // the interrupted value. The journal has a begin and NO commit.
    const afterCrash = JSON.parse(readFileSync(wfPath, 'utf8'));
    assert.equal(afterCrash.phase, 'INTERRUPTED',
      'the interrupted verb did mutate the file before crashing');
    const journal = readJournal(root);
    const partial = journal.find(
      (r) => r.phase === 'begin' && r.verb === 'workflow.set-phase'
        && r.payloadDigest === payloadDigest({ phase: 'INTERRUPTED' }),
    );
    assert.ok(partial, 'a real begin record was written by the SDK');
    assert.equal(
      journal.some((r) => r.phase === 'commit' && r.verbId === partial.verbId),
      false, 'no commit was written — it is a genuine partial',
    );

    // Replay rolls the overwrite back to its pre-begin snapshot.
    const replay = await query('state.replay', {}, ctx);
    assert.ok(replay.rolledBack.includes(partial.verbId),
      'the genuinely-interrupted overwrite verb was rolled back');
    assert.equal(readFileSync(wfPath, 'utf8'), baseline,
      'workflow.json restored to its pre-begin (baseline) content');
  } finally { cleanup(); }
});

// --- G2 — a genuinely interrupted APPEND verb keeps its durable record ----
// The append landed durably before the crash. Replay must NOT revert the file
// (that would lose a committed record) and must NOT double-apply (the next
// clean retry with the same dedupKey is a no-op).
test('rollback (real interruption): an interrupted append verb keeps its durable record', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const log = join(root, '.ijfw', 'blackboard', 'decisions.jsonl');

    // Inject: run the real decision.add handler (real begin + the real,
    // durable JSONL append), THEN throw — crash after the append, before
    // _journalCommit.
    await assert.rejects(
      withInjectedHandler(
        'decision.add',
        (real) => async (payload, c, env) => {
          await real(payload, c, env); // the durable append happens here
          throw new Error('simulated crash after append, before commit');
        },
        () => query('decision.add', { text: 'durable', dedupKey: 'dk-g2' }, ctx),
      ),
      /simulated crash/,
      'the interrupted append query() rejects through the dispatcher catch path',
    );

    // The append is durable on disk despite the crash.
    assert.equal(existsSync(log), true, 'decisions.jsonl exists');
    let lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'the append landed durably before the crash');
    assert.equal(JSON.parse(lines[0]).dedupKey, 'dk-g2');

    // No snapshot sidecar should exist for an append verb (issue 4 — appends
    // are not snapshot-rolled-back, so the SDK captures none).
    const journal0 = readJournal(root);
    const beginRec = journal0.find(
      (r) => r.phase === 'begin' && r.verb === 'decision.add'
        && r.dedupKey === 'dk-g2',
    );
    assert.ok(beginRec, 'a real begin record was written');
    assert.equal(beginRec.kind, 'append', 'the begin record is kind:append');
    assert.equal(
      existsSync(join(root, '.ijfw', 'state', 'intent-snapshots', `${beginRec.verbId}.json`)),
      false, 'append verbs capture NO snapshot sidecar',
    );

    // Replay seals the partial — it must NOT revert decisions.jsonl.
    const replay = await query('state.replay', {}, ctx);
    assert.ok(Array.isArray(replay.sealed) && replay.sealed.includes(beginRec.verbId),
      'the interrupted append verb was sealed (not rolled back)');
    assert.equal(replay.rolledBack.includes(beginRec.verbId), false,
      'an append partial is never in rolledBack — its file is not reverted');
    lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1,
      'the durably-committed record SURVIVED replay — not lost');

    // The clean retry with the same dedupKey is a no-op — not double-applied.
    const retry = await query('decision.add', { text: 'durable', dedupKey: 'dk-g2' }, ctx);
    assert.equal(retry.deduped, true, 'the retry is deduped — no double-apply');
    lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'still exactly one record after the retry');
  } finally { cleanup(); }
});

// --- G3 — interrupted append + replay + retry round-trips through query() --
// Same as G2 but for telemetry.record (a dedupKey verb backed by a JSON
// records[] array) — proves the append-safe replay split is verb-agnostic.
test('rollback (real interruption): an interrupted telemetry.record is sealed, not lost', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const file = join(root, '.ijfw', 'telemetry', 'convergence.json');

    await assert.rejects(
      withInjectedHandler(
        'telemetry.record',
        (real) => async (payload, c, env) => {
          await real(payload, c, env);
          throw new Error('simulated crash after record, before commit');
        },
        () => query('telemetry.record', {
          kind: 'convergence', metrics: { cycles: 3 }, dedupKey: 'dk-g3',
        }, ctx),
      ),
      /simulated crash/,
    );

    let obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(obj.records.length, 1, 'the record landed durably before crash');

    const replay = await query('state.replay', {}, ctx);
    const beginRec = readJournal(root).find(
      (r) => r.phase === 'begin' && r.verb === 'telemetry.record',
    );
    assert.ok(replay.sealed.includes(beginRec.verbId), 'sealed, not rolled back');

    obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(obj.records.length, 1, 'the durable telemetry record survived replay');

    const retry = await query('telemetry.record', {
      kind: 'convergence', metrics: { cycles: 3 }, dedupKey: 'dk-g3',
    }, ctx);
    assert.equal(retry.deduped, true, 'retry is deduped — no double-apply');
    obj = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(obj.records.length, 1, 'still exactly one telemetry record');
  } finally { cleanup(); }
});

// ===========================================================================
// PART H — blocker.add / blocker.resolve mutate STATE.md (issue 1)
// ===========================================================================

/** Parse a wave STATE.md frontmatter into an object (minimal flat-YAML). */
function readWaveFm(root, waveId) {
  const p = join(root, '.ijfw', `wave-${waveId}`, 'STATE.md');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const end = raw.indexOf('\n---', 3);
  const block = raw.slice(4, end);
  const fm = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const c = lines[i].indexOf(':');
    if (c === -1) continue;
    const key = lines[i].slice(0, c).trim();
    const rest = lines[i].slice(c + 1).trim();
    if (rest === '') {
      const seq = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith('- ')) {
        seq.push(lines[j].replace(/^\s*-\s?/, '')); j += 1;
      }
      fm[key] = seq; i = j - 1;
    } else if (rest === '[]') fm[key] = [];
    else fm[key] = rest;
  }
  return fm;
}

// --- H1 — blocker.add with waveId bumps blockers_open on STATE.md ---------
test('blocker.add: with waveId, bumps blockers_open on the wave STATE.md', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    const r = await query('blocker.add', {
      id: 'blk-1', text: 'CI red', waveId: 'W7', dedupKey: 'bh-1',
    }, ctx);
    assert.equal(r.ok, true);

    const fm = readWaveFm(root, 'W7');
    assert.ok(fm, 'STATE.md was created for the wave');
    assert.deepEqual(fm.blockers_open, ['blk-1'],
      'blockers_open holds the new blocker id');
  } finally { cleanup(); }
});

// --- H2 — blocker.resolve with waveId decrements blockers_open -----------
test('blocker.resolve: with waveId, removes the id from blockers_open', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('blocker.add', {
      id: 'blk-a', text: 'a', waveId: 'W7', dedupKey: 'bh-2a',
    }, ctx);
    await query('blocker.add', {
      id: 'blk-b', text: 'b', waveId: 'W7', dedupKey: 'bh-2b',
    }, ctx);
    assert.deepEqual(readWaveFm(root, 'W7').blockers_open, ['blk-a', 'blk-b']);

    const res = await query('blocker.resolve', {
      id: 'blk-a', resolution: 'fixed', waveId: 'W7', dedupKey: 'bh-2r',
    }, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.resolved, true);
    assert.deepEqual(readWaveFm(root, 'W7').blockers_open, ['blk-b'],
      'the resolved blocker id was removed from blockers_open');
  } finally { cleanup(); }
});

// --- H3 — without waveId, no STATE.md is created (lock targets match) -----
test('blocker.add: without waveId, mutates only decisions.jsonl', async () => {
  const { ctx, root, cleanup } = mkProject();
  try {
    await query('blocker.add', { id: 'blk-x', text: 'x', dedupKey: 'bh-3' }, ctx);
    assert.equal(existsSync(join(root, '.ijfw', 'blackboard', 'decisions.jsonl')), true);
    // No wave id → no wave dir, and no STATE.md to claim a lock on.
    assert.equal(existsSync(join(root, '.ijfw', 'wave-undefined')), false,
      'no spurious wave directory created');
  } finally { cleanup(); }
});
