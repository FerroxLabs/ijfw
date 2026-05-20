/**
 * state-sdk.js — v1.5.0 T2: the state-SDK verb core + dispatcher.
 *
 * ONE `query(verb, payload, ctx)` dispatcher over a frozen 20-verb registry.
 * The SDK is a **verb facade over the EXISTING physical state files** — it is
 * the single mutation surface, not a new storage format. Physical files keep
 * their existing locations and formats (see STATE-SDK-CONTRACT.md §1).
 *
 * Binds verbatim to `.planning/v150-gap-closure/STATE-SDK-CONTRACT.md` (T1,
 * FROZEN). Every verb's Signature / Payload / Returns / Day-1 behavior comes
 * straight off that contract.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SCOPE BOUNDARY — T2 builds the verb core; three later tasks wrap it:
 *
 *   T3 (lock hierarchy)   — wraps `_withLocks()`. Today it is a pass-through;
 *                           T3 swaps in `withFsLock` acquisition in the §3
 *                           canonical acquire-order. Handlers already declare
 *                           the ordered lock-target list they touch, so T3
 *                           only has to make `_withLocks` honor it.
 *   T4 (intent/commit)    — wraps `_journalBegin()` / `_journalCommit()`.
 *                           Today they are no-ops; T4 makes them write the
 *                           write-ahead `intent-journal.jsonl` records and
 *                           keeps the pre-write snapshot for rollback.
 *   T5 (event emission)   — wraps `_emitEvent()`. Today it is a no-op; T5
 *                           makes it append to the rotated per-subagent event
 *                           log AFTER lock release (fire-and-forget).
 *
 * Those three seams are the ONLY extension points later tasks touch. The verb
 * handlers themselves are frozen by this task.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * ESM, Node ≥18, zero new production dependencies.
 */

import {
  readFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

import { writeAtomic, readSafe } from '../lib/atomic-io.js';
import { rotateJsonlIfNeeded } from '../lib/jsonl-rotation.js';
import { withFsLock, canonicalLockOrder, lockPathFor } from '../fs-lock.js';
import { enforceVerificationGate, VerificationGateViolation } from './verification-gate.js';
import { validatePlan } from './plan-checker.js';
import { runSelfCheck } from './post-done-runner.js';
import {
  emitEvent as emitEventToLog,
  appendUnderHeldLock as appendEventUnderHeldLock,
  resolveEventLogPath,
} from './state-events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** waveId / subagentId safe-token shape (contract §7 wave.get). */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Env escape hatch for the gate subsystem (Model 4 MCP-unavailable row). */
const GATE_BYPASS = process.env.IJFW_STATE_GATE_BYPASS === '1';

/**
 * Lock-acquisition tuning (T3). `staleMs` is the window after which a holder
 * that has STOPPED refreshing (a crashed process) is reclaimed; `heartbeatMs`
 * is well under it so a *live* long-running verb always renews its lock before
 * a concurrent caller's stale check fires. `acquireTimeoutMs` is generous so a
 * legitimate queue of concurrent verbs all get their turn rather than throwing
 * `FsLockBusyError` under a burst.
 */
const LOCK_OPTS = {
  staleMs: 10_000,
  heartbeatMs: 2_000,
  acquireTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Physical-path resolvers — every canonical state file from contract §1.
// The SDK introduces NO new file locations; these mirror the table verbatim.
// ---------------------------------------------------------------------------

const paths = {
  workflow: (root) => join(root, '.ijfw', 'state', 'workflow.json'),
  waves: (root) => join(root, '.ijfw', 'state', 'waves.json'),
  intentJournal: (root) => join(root, '.ijfw', 'state', 'intent-journal.jsonl'),
  waveDir: (root, waveId) => join(root, '.ijfw', `wave-${waveId}`),
  waveState: (root, waveId) => join(root, '.ijfw', `wave-${waveId}`, 'STATE.md'),
  checkpoint: (root, waveId, subId) =>
    join(root, '.ijfw', `wave-${waveId}`, `subagent-${subId}.checkpoint.json`),
  eventLog: (root, waveId, subId) =>
    join(root, '.ijfw', `wave-${waveId}`, `events-${subId}.jsonl`),
  decisions: (root) => join(root, '.ijfw', 'blackboard', 'decisions.jsonl'),
  telemetry: (root) => join(root, '.ijfw', 'telemetry', 'convergence.json'),
  teamWorkflow: (root) => join(root, '.ijfw', 'team', 'workflow.json'),
  teamCharter: (root) => join(root, '.ijfw', 'team', 'charter.json'),
  activeExtension: (home) => join(home, '.ijfw', 'state', 'active-extension.json'),
};

// ---------------------------------------------------------------------------
// T3 / T4 / T5 SEAMS — deliberately thin pass-throughs.
//
// These exist so the cross-cutting tasks have a single, well-named place to
// hook in. T2 must NOT implement locking / journaling / events itself.
// ---------------------------------------------------------------------------

/**
 * Lock-acquisition seam (T3) + journal-begin source of truth (T4 — issue 2).
 *
 * `lockTargets` is the canonical-sorted list of physical files a verb mutates.
 * It is the verb's SINGLE declaration of its target set — `_withLocks` both
 * acquires the locks from it AND (for a mutating verb) writes the write-ahead
 * `begin` record + rollback snapshot from the SAME list. There is no second
 * place that re-derives a verb's targets.
 *
 * `_withLocks` routes the list through `canonicalLockOrder` (defense in depth)
 * so the acquire-order is always the STATE-SDK-CONTRACT §3 coarse-to-fine
 * order regardless of caller input, then acquires every lock coarse-to-fine
 * and releases in reverse by NESTING `withFsLock` calls — the innermost call
 * runs `fn`, and the `finally` unwind of each `withFsLock` releases in exact
 * reverse order. Because the acquire-order is total and deterministic, two
 * verbs touching an overlapping file set can never form a lock-ordering cycle
 * → the SDK is deadlock-free by construction.
 *
 * JOURNAL-BEGIN (T4): when `env` carries `{ isMutating:true }`, `_withLocks`
 * runs `_journalBegin` AFTER acquiring the intent-journal lock but BEFORE `fn`
 * — write-ahead by construction. The real journal targets are derived from
 * `lockTargets` minus the intent-journal path itself (infrastructure, never a
 * verb target). The resulting handle is stashed on `env.journalHandle` for the
 * dispatcher's `_journalCommit`.
 *
 * Locks are heartbeat-refreshed (`LOCK_OPTS.heartbeatMs`) so a long-running
 * verb is never wrongly reclaimed; a crashed holder still ages out at
 * `LOCK_OPTS.staleMs`. No subprocess is spawned anywhere inside the lock
 * (the verb core does no spawning — confirmed for T3).
 *
 * @param {string[]} lockTargets  physical paths the verb mutates (any order)
 * @param {() => Promise<T>} fn   the verb's critical section
 * @param {object} [env]  per-invocation env — when mutating, carries verbId /
 *                        verb / dedupKey / payloadDigest / isMutating /
 *                        appendVerb; `_withLocks` writes `journalHandle` back.
 * @returns {Promise<T>}
 * @template T
 */
async function _withLocks(lockTargets, fn, env) {
  const declared = Array.isArray(lockTargets) ? lockTargets : [];
  const ordered = canonicalLockOrder(declared);
  if (ordered.length === 0) {
    // No file targets → no locks. A mutating verb with no file targets still
    // needs a journal begin/commit pair so it is replay-classifiable; the
    // dispatcher handles that case (env.journalHandle stays null here).
    return fn();
  }

  // Recursively nest withFsLock: acquire ordered[0] coarse-to-fine; the
  // innermost frame runs `fn`. Each withFsLock's release fires on unwind, so
  // locks release in exact reverse order automatically. For a mutating verb,
  // immediately after the intent-journal lock (always ordered[0] — §3 #1) is
  // held we run `_journalBegin`: write-ahead, and from the verb's OWN target
  // list — never a re-derived one.
  const journalAbs = ordered[0]; // §3 #1 — intent-journal is always first.
  const realTargets = ordered.filter((t) => t !== journalAbs);

  const acquireFrom = async (index) => {
    if (index >= ordered.length) return fn();
    return withFsLock(
      lockPathFor(ordered[index]),
      async () => {
        // Just inside the intent-journal lock, before any other lock or `fn`:
        // write the write-ahead begin record from this verb's real targets.
        if (index === 0 && env && env.isMutating && !env.journalHandle) {
          env.journalHandle = await _journalBegin({
            root: env.root,
            verb: env.verb,
            verbId: env.verbId,
            dedupKey: env.dedupKey,
            payloadDigest: env.payloadDigest,
            targets: realTargets,
            // Append/dedupKey verbs are NOT snapshot-rolled-back (§4) — skip
            // capturing a snapshot we would never restore.
            snapshot: !env.appendVerb,
          });
        }
        return acquireFrom(index + 1);
      },
      LOCK_OPTS,
    );
  };
  return acquireFrom(0);
}

/**
 * Relative-path form for a journal `targets[]` entry. Project-scope files are
 * rendered relative to `projectRoot` (the §4 example shape — e.g.
 * `.ijfw/wave-W12-A/STATE.md`). The homedir active-extension file lives on a
 * different filesystem root, so it cannot be made relative — it is recorded by
 * its absolute path. Replay reconstructs `absPath` from the snapshot sidecar
 * regardless, so the journal `targets[]` form is purely informational.
 */
function relForJournal(root, abs) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

// ---------------------------------------------------------------------------
// T4 — Intent / commit journal (STATE-SDK-CONTRACT §4, CROSS-CUTTING MODEL 2).
//
// Every mutating verb writes a write-ahead `begin` record to
// `.ijfw/state/intent-journal.jsonl` BEFORE touching any target file and a
// `commit` record AFTER the atomic rename(s) succeed.
//
// SINGLE SOURCE OF TRUTH FOR A VERB'S TARGET SET (T4 spec-review issue 2):
// `_withLocks(targets, fn, env)` is the ONE place a verb's target list is
// known. The handler passes its real, canonical-sorted target list there to
// acquire locks; `_withLocks` *reuses that exact list* to write the `begin`
// record and capture the rollback snapshot. There is NO second switch that
// re-derives targets — a handler that changes its target set changes it in
// exactly one place (its own `_withLocks` call), and journaling follows for
// free. `_withLocks` runs strictly BEFORE `fn` (the mutation) and is
// write-ahead by construction; the dispatcher's `_journalCommit` runs after
// the handler returns, reading the handle `_withLocks` stashed on `env`.
//
// Rollback source: alongside the `begin` record, `_journalBegin` captures a
// pre-write snapshot of every target file into a per-verbId sidecar at
// `.ijfw/state/intent-snapshots/<verbId>.json`. `_journalCommit` deletes the
// sidecar (the write is durable — nothing to roll back). `state.replay` reads
// a partial's sidecar to restore its targets. Append/dedupKey verbs do NOT
// capture a snapshot (see ROLLBACK MODEL below).
//
// ROLLBACK MODEL — by verb kind (T4 spec-review issue 4):
//   * Overwrite / read-modify-write verbs (no dedupKey — workflow.set-phase,
//     wave.advance, phase.*, extension.set-active, …): a begin-without-commit
//     partial is snapshot-rolled-back by `state.replay`. The whole target is
//     restored to its pre-begin content.
//   * Append / dedupKey verbs (wave.record-task, subagent.checkpoint,
//     event.emit, telemetry.record, roster.record, decision.add, blocker.add,
//     blocker.resolve): a partial append is LEFT IN PLACE. The append is
//     durable and the `dedupKey` makes the caller's retry a no-op (§4) — so
//     snapshot-rollback would only DESTROY a durably-committed record. Replay
//     seals the partial with a commit marker; it never reverts the file.
//     Append verbs therefore capture no snapshot at all.
//
// CRASH-SAFETY — honest scope (T4 spec-review issue 3): the LIVE double-call
// fast path is atomic — a verb's target-log dedup scan and its mutation run
// inside the verb's own §3 critical section. The `begin` record and the
// `commit` record, however, are written by TWO separate intent-journal lock
// acquisitions with the handler running between them; a crash can land in
// that window. That is precisely what `state.replay` reconciles — replay-level
// recovery is BEST-EFFORT across a crash, and the journal is the authority for
// it. No comment here claims a single-critical-section guarantee that does not
// exist; the design is a write-ahead log + replay, not a two-phase commit.
// ---------------------------------------------------------------------------

/** Snapshot-sidecar directory for in-flight (begin-but-not-commit) verbs. */
function snapshotDir(root) {
  return join(root, '.ijfw', 'state', 'intent-snapshots');
}

/** Snapshot-sidecar path for one verb invocation. */
function snapshotPath(root, verbId) {
  return join(snapshotDir(root), `${verbId}.json`);
}

/**
 * LOCKING NOTE — `_journalBegin` runs INSIDE the §3 intent-journal lock that
 * `_withLocks` already holds (it is the verb's outermost lock, §3 #1). It must
 * NOT re-acquire that lock — `withFsLock` is a non-re-entrant `mkdir`-based
 * mutex, so a nested acquire on the same path would deadlock against itself.
 * `_journalBegin` is therefore lock-free by contract: its sole caller is
 * `_withLocks`, immediately after the intent-journal lock is held.
 *
 * `_journalCommit` runs at the DISPATCHER level, strictly AFTER the handler
 * has returned and released ALL §3 locks (including the intent-journal lock).
 * It therefore acquires the intent-journal lock itself — no nesting, no
 * re-entry. begin (inside the handler's journal lock) → handler → commit
 * (its own fresh journal lock) is a sequential chain across TWO separate lock
 * acquisitions; the window between them is reconciled by `state.replay`, not
 * eliminated (see CRASH-SAFETY note above — this is a WAL + replay design).
 */

/**
 * Intent-journal `begin` writer (T4). LOCK-FREE — the caller (`_withLocks`)
 * already holds the intent-journal lock. For overwrite verbs, captures a
 * pre-write snapshot sidecar of every target; for append verbs
 * (`record.snapshot === false`) it captures NOTHING (a partial append is
 * never snapshot-rolled-back — §4). Then appends the `begin` record. Returns a
 * handle the matching `_journalCommit` consumes.
 *
 * @param {{root:string, verb:string, verbId:string, dedupKey?:string, targets:string[], payloadDigest:string, snapshot:boolean}} record
 *        `targets` is the absolute-path list the verb mutates (the
 *        intent-journal file itself is excluded — it is infrastructure).
 *        `snapshot` — false for append/dedupKey verbs (no rollback snapshot).
 * @returns {Promise<object>} journal handle — `{ begun, root, verbId, ... }`
 */
async function _journalBegin(record) {
  const {
    root, verb, verbId, dedupKey, targets, snapshot,
  } = record;
  const journal = paths.intentJournal(root);
  const relTargets = [];
  if (snapshot) {
    const snapTargets = [];
    for (const abs of targets) {
      const rel = relForJournal(root, abs);
      relTargets.push(rel);
      // Pre-write snapshot: content + existence — rollback restores-or-deletes.
      if (existsSync(abs)) {
        snapTargets.push({
          relPath: rel, absPath: abs, existed: true,
          content: readFileSync(abs, 'utf8'),
        });
      } else {
        snapTargets.push({ relPath: rel, absPath: abs, existed: false, content: null });
      }
    }
    // Snapshot sidecar is written BEFORE the begin record: if we crash between
    // the two, replay sees no begin record and treats the verb as never-started
    // (the orphan sidecar is harmless — `state.validate` ignores it).
    ensureDir(snapshotDir(root));
    writeAtomic(snapshotPath(root, verbId), JSON.stringify({ verbId, targets: snapTargets }));
  } else {
    // Append/dedupKey verb — no snapshot. The begin record still lists the
    // real targets so the journal stays a complete record of intent.
    for (const abs of targets) relTargets.push(relForJournal(root, abs));
  }
  const begin = {
    verb, verbId, phase: 'begin', ts: nowIso(), targets: relTargets,
    payloadDigest: record.payloadDigest,
  };
  if (typeof dedupKey === 'string' && dedupKey) begin.dedupKey = dedupKey;
  // `kind` lets `state.replay` decide rollback vs seal-only without re-deriving
  // verb taxonomy — the begin record is self-describing.
  begin.kind = snapshot ? 'overwrite' : 'append';
  ensureDir(join(journal, '..'));
  appendFileSync(journal, `${JSON.stringify(begin)}\n`, { mode: 0o600 });
  return {
    begun: true, root, verbId, verb, dedupKey, snapshot,
    payloadDigest: record.payloadDigest,
  };
}

/**
 * Intent-journal `commit` seam (T4 — IMPLEMENTED). Runs at the dispatcher
 * level AFTER the handler released all §3 locks — so it acquires the
 * intent-journal lock itself (no nesting, no re-entry). Appends the `commit`
 * record (durable-applied marker) and deletes the now-redundant snapshot
 * sidecar (overwrite verbs only — append verbs never wrote one).
 *
 * @param {object} handle  the handle returned by `_journalBegin`
 */
async function _journalCommit(handle) {
  if (!handle || !handle.begun) return;
  const {
    root, verbId, verb, dedupKey, snapshot,
  } = handle;
  const journal = paths.intentJournal(root);
  await withFsLock(lockPathFor(journal), async () => {
    const commit = {
      verb, verbId, phase: 'commit', ts: nowIso(),
      payloadDigest: handle.payloadDigest,
      kind: snapshot ? 'overwrite' : 'append',
    };
    if (typeof dedupKey === 'string' && dedupKey) commit.dedupKey = dedupKey;
    appendFileSync(journal, `${JSON.stringify(commit)}\n`, { mode: 0o600 });
    // The write is durable — the snapshot is no longer needed for rollback.
    // Append verbs never captured one; the unlink is a harmless no-op for them.
    if (snapshot) {
      try { const s = snapshotPath(root, verbId); if (existsSync(s)) unlinkSync(s); }
      catch { /* best-effort; a stale sidecar of a committed verb is harmless */ }
    }
  }, LOCK_OPTS);
}

/**
 * Event-emit seam (T5 — IMPLEMENTED). Fire-and-forget, AFTER lock release
 * (Model 3). Distinct from the `event.emit` *verb* — the verb is a
 * caller-facing journaled append that acquires its own §3 lock; this seam is
 * the implicit per-query observability tap that fires for EVERY verb dispatch
 * (read + mutating). The dispatcher invokes this AFTER the handler returns
 * and AFTER all §3 locks are released — see the dispatcher's call sites.
 *
 * The tap takes NO §3 lock and is serialized per-log-path by an in-process
 * Promise-chain mutex inside `state-events.emitEvent`. Errors are swallowed
 * (logged to stderr in the impl); a tap failure NEVER propagates to the
 * caller. This call returns immediately — the underlying append happens on
 * the microtask queue but is not awaited by the dispatcher.
 *
 * @param {{verb:string, subagentId:string, ts:string, verbId:string,
 *          outcome:string, payloadDigest:string,
 *          projectRoot:string, waveId?:string}} event
 */
function _emitEvent(event) {
  if (!event || !event.projectRoot) return;
  // Fire-and-forget: do NOT await. `emitEvent` swallows its own errors so
  // an unhandled rejection cannot escape here either.
  emitEventToLog({
    projectRoot: event.projectRoot,
    waveId: event.waveId,
    subagentId: event.subagentId,
    verb: event.verb,
    verbId: event.verbId,
    outcome: event.outcome,
    payloadDigest: event.payloadDigest,
    ts: event.ts,
  }).catch(() => { /* impossible — emitEvent swallows; belt-and-suspenders */ });
}

// ---------------------------------------------------------------------------
// Internal I/O helpers — every verb routes file I/O through these so T3 has a
// single chokepoint to wrap and the atomic-write contract is enforced in one
// place (no handler ever calls fs.writeFile on a final path directly).
// ---------------------------------------------------------------------------

/** Read + JSON-parse a file; returns `fallback` when absent/unparseable. */
function readJson(path, fallback = null) {
  const r = readSafe(path);
  return r.ok ? r.data : fallback;
}

/** Atomic JSON write (tmp-write + fsync + rename via atomic-io). */
function writeJson(path, obj) {
  return writeAtomic(path, JSON.stringify(obj, null, 2));
}

/** Ensure a directory exists (0o700 — matches atomic-io / fs-lock posture). */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Append one JSONL line. Rotates first when over the 4 MiB ceiling
 * (jsonl-rotation `DEFAULT_ROTATE_SIZE`). Not idempotent on its own — callers
 * supply a `dedupKey` and pre-check via `jsonlHasDedupKey` (Model 2).
 */
function appendJsonl(path, obj) {
  ensureDir(join(path, '..'));
  rotateJsonlIfNeeded(path);
  appendFileSync(path, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
}

/** Read a JSONL file into an array of parsed objects (skips blank/bad lines). */
function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip a corrupt line */ }
  }
  return out;
}

/** True when any record in the JSONL log already carries `dedupKey`. */
function jsonlHasDedupKey(path, dedupKey) {
  return readJsonl(path).some((rec) => rec && rec.dedupKey === dedupKey);
}

/**
 * Canonical JSON serialization — recursive, key-sorted. The digest must be
 * STABLE across process restarts (replay safety: a verb is recognized as
 * already-committed by digest). Plain `JSON.stringify` preserves key INSERTION
 * order, so two payloads with the same content but different key order would
 * hash differently and a replay would wrongly re-apply. This sorts every
 * object's keys recursively so the canonical form is content-addressable.
 *
 * Arrays are NOT reordered — array element order is meaningful data.
 * `undefined` collapses to `null` (matches JSON's own value space).
 */
function canonicalJson(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      if (value[k] === undefined) continue; // JSON.stringify drops these too
      parts.push(`${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  // function / symbol / bigint — not valid JSON; collapse to null.
  return 'null';
}

/**
 * sha256-<hex> digest of the CANONICAL-JSON payload (intent/event records).
 * Deterministic regardless of payload key insertion order — see `canonicalJson`.
 * Exported so T4's idempotency suite can assert cross-run digest stability.
 */
export function payloadDigest(payload) {
  return `sha256-${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

// --- STATE.md (YAML frontmatter + md body) flat read/write ------------------
// A self-contained flat-YAML subset — string/number/boolean/string[]. The SDK
// is a facade: this matches wave-state.js's on-disk format exactly so a wave
// written by either surface round-trips through the other.

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) {
    throw new Error('state-sdk: STATE.md missing YAML frontmatter');
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) throw new Error('state-sdk: STATE.md has unclosed frontmatter');
  const block = raw.slice(4, end);
  const body = raw.slice(end + 4).replace(/^\n+/, '');
  const fm = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const c = line.indexOf(':');
    if (c === -1) continue;
    const key = line.slice(0, c).trim();
    const rest = line.slice(c + 1).trim();
    if (!key) continue;
    if (rest === '') {
      // block sequence ("  - item" lines) or empty
      const seq = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trimStart().startsWith('- ')) {
        seq.push(lines[j].replace(/^\s*-\s?/, ''));
        j += 1;
      }
      if (seq.length) { fm[key] = seq; i = j - 1; } else { fm[key] = null; }
    } else if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]$/, '');
      fm[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) : [];
    } else if (rest === 'true') { fm[key] = true; }
    else if (rest === 'false') { fm[key] = false; }
    else if (rest === 'null' || rest === '~') { fm[key] = null; }
    else if (rest !== '' && !Number.isNaN(Number(rest))) { fm[key] = Number(rest); }
    else { fm[key] = rest.replace(/^['"]|['"]$/g, ''); }
  }
  return { frontmatter: fm, body };
}

function emitFrontmatter(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) lines.push(`${k}: null`);
    else if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${k}: []`);
      else { lines.push(`${k}:`); for (const it of v) lines.push(`  - ${it}`); }
    } else if (typeof v === 'object') {
      throw new Error(`state-sdk: nested YAML not supported (key "${k}")`);
    } else lines.push(`${k}: ${v}`);
  }
  return lines.join('\n');
}

/** Read a wave STATE.md → { frontmatter, body, raw } | null when absent. */
function readWaveStateFile(root, waveId) {
  const p = paths.waveState(root, waveId);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { frontmatter, body, raw };
}

/** Atomically write a wave STATE.md from { frontmatter, body }. */
function writeWaveStateFile(root, waveId, frontmatter, body) {
  ensureDir(paths.waveDir(root, waveId));
  const raw = `---\n${emitFrontmatter(frontmatter)}\n---\n\n${body || ''}`;
  writeAtomic(paths.waveState(root, waveId), raw);
  return { frontmatter, body: body || '', raw };
}

// ---------------------------------------------------------------------------
// Context / payload validation
// ---------------------------------------------------------------------------

function requireRoot(ctx) {
  if (!ctx || typeof ctx.projectRoot !== 'string' || ctx.projectRoot.length === 0) {
    throw new Error('state-sdk: ctx.projectRoot is required');
  }
  return ctx.projectRoot;
}

function requireId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(`state-sdk: ${field} must match ${ID_RE} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function requireStr(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`state-sdk: ${field} is required (non-empty string)`);
  }
  return value;
}

function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// VERB HANDLERS — one per contract §7 block. Signature: (payload, ctx, env).
// `env` carries the per-invocation { verbId } so handlers can stamp records.
// Read verbs return the documented shape; write verbs create-or-refuse Day-1.
// ---------------------------------------------------------------------------

const handlers = {
  // --- workflow.get — read, Day-1 no-op ------------------------------------
  async 'workflow.get'(_payload, ctx) {
    const root = requireRoot(ctx);
    const workflow = readJson(paths.workflow(root), null);
    return { ok: true, workflow };
  },

  // --- workflow.set-phase — write, Day-1 create ----------------------------
  async 'workflow.set-phase'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const phase = requireStr(payload?.phase, 'phase');
    const file = paths.workflow(root);
    const targets = [paths.intentJournal(root), file];
    return _withLocks(targets, async () => {
      const current = readJson(file, {}) || {};
      const next = { ...current, phase, updated_at: nowIso() };
      next.status = payload.status ?? current.status ?? 'in_progress';
      if (payload.milestone !== undefined) next.milestone = payload.milestone;
      if (payload.version !== undefined) next.version = payload.version;
      writeJson(file, next);
      return { ok: true, workflow: next };
    }, env);
  },

  // --- wave.get — read, Day-1 no-op ----------------------------------------
  async 'wave.get'(payload, ctx) {
    const root = requireRoot(ctx);
    const waveId = requireId(payload?.waveId, 'waveId');
    return { ok: true, wave: readWaveStateFile(root, waveId) };
  },

  // --- wave.advance — write, Day-1 create ----------------------------------
  async 'wave.advance'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const waveId = requireId(payload?.waveId, 'waveId');
    const status = requireStr(payload?.status, 'status');
    const targets = [
      paths.intentJournal(root), paths.waves(root), paths.waveState(root, waveId),
    ];
    return _withLocks(targets, async () => {
      const existing = readWaveStateFile(root, waveId);
      const fm = {
        ...(existing?.frontmatter || {}),
        wave_id: waveId,
        status,
        created_at: existing?.frontmatter?.created_at ?? nowIso(),
        updated_at: nowIso(),
      };
      if (payload.frontmatter && typeof payload.frontmatter === 'object') {
        for (const [k, v] of Object.entries(payload.frontmatter)) fm[k] = v;
      }
      const wave = writeWaveStateFile(root, waveId, fm, existing?.body ?? '');
      return { ok: true, wave };
    }, env);
  },

  // --- wave.record-task — append, Day-1 create, dedupKey -------------------
  async 'wave.record-task'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const waveId = requireId(payload?.waveId, 'waveId');
    const taskId = requireStr(payload?.taskId, 'taskId');
    const status = requireStr(payload?.status, 'status');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const targets = [paths.intentJournal(root), paths.waveState(root, waveId)];
    return _withLocks(targets, async () => {
      const existing = readWaveStateFile(root, waveId);
      const tasks = Array.isArray(existing?.frontmatter?.tasks)
        ? [...existing.frontmatter.tasks] : [];
      // Tasks are recorded as "taskId:status:dedupKey" — flat-YAML-safe.
      if (tasks.some((t) => t.endsWith(`:${dedupKey}`))) {
        const wave = existing ?? readWaveStateFile(root, waveId);
        return { ok: true, wave, deduped: true };
      }
      tasks.push(`${taskId}:${status}:${dedupKey}`);
      const fm = {
        ...(existing?.frontmatter || {}),
        wave_id: waveId,
        created_at: existing?.frontmatter?.created_at ?? nowIso(),
        updated_at: nowIso(),
        tasks,
      };
      if (existing?.frontmatter?.status === undefined) fm.status = 'in_progress';
      const wave = writeWaveStateFile(root, waveId, fm, existing?.body ?? '');
      return { ok: true, wave, deduped: false };
    }, env);
  },

  // --- phase.plan-check — write, Day-1 refuse, gate=validatePlan -----------
  async 'phase.plan-check'(payload, ctx, env) {
    const root = requireRoot(ctx);
    let planText = payload?.planText;
    if (typeof planText !== 'string') {
      const planPath = payload?.planPath;
      if (typeof planPath !== 'string' || planPath.length === 0) {
        throw new Error('state-sdk: phase.plan-check needs planPath or planText');
      }
      const abs = isAbsolute(planPath) ? planPath : join(root, planPath);
      if (!existsSync(abs)) {
        return { ok: false, refused: true, gate: 'plan-check', reason: 'plan-not-found' };
      }
      planText = readFileSync(abs, 'utf8');
    }
    // Model 4: gate-fail → refuse; gate threw → advisory (proceed).
    let result;
    try {
      result = validatePlan(planText, { strict: true });
    } catch (e) {
      process.stderr.write(`[state-sdk] WARN phase.plan-check gate execution-fail: ${e.message}\n`);
      return { ok: true, advisory: true, gate: 'plan-check', reason: e.message, findings: [] };
    }
    if (!result.ok) {
      return {
        ok: false, refused: true, gate: 'plan-check',
        findings: result.findings, reason: 'plan-check HIGH finding',
      };
    }
    // Clean plan: record the verdict on the workflow object.
    const file = paths.workflow(root);
    const targets = [paths.intentJournal(root), file];
    return _withLocks(targets, async () => {
      const current = readJson(file, {}) || {};
      current.plan_check = {
        verdict: 'pass', phaseId: payload?.phaseId ?? null, checked_at: nowIso(),
      };
      writeJson(file, current);
      return { ok: true, findings: result.findings, verdict: 'pass' };
    }, env);
  },

  // --- phase.complete — write, Day-1 create, gate=verification ------------
  async 'phase.complete'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const phase = requireStr(payload?.phase, 'phase');
    const ev = payload?.evidence || {};
    // Model 4: verdict-fail → refuse; execution-fail / MCP-unavailable →
    // advisory (proceed). GATE_BYPASS short-circuits to advisory.
    let gateAdvisory = null;
    if (!GATE_BYPASS) {
      try {
        enforceVerificationGate(
          typeof ev.reportText === 'string' ? ev.reportText : '',
          Array.isArray(ev.toolCalls) ? ev.toolCalls : [],
          { strict: true },
        );
      } catch (e) {
        if (e instanceof VerificationGateViolation) {
          return {
            ok: false, refused: true, gate: 'verification',
            reason: e.message,
          };
        }
        // Gate itself threw — execution-fail → degrade to advisory.
        process.stderr.write(`[state-sdk] WARN phase.complete gate execution-fail: ${e.message}\n`);
        gateAdvisory = e.message;
      }
    } else {
      gateAdvisory = 'IJFW_STATE_GATE_BYPASS=1';
      process.stderr.write('[state-sdk] WARN phase.complete gate bypassed via IJFW_STATE_GATE_BYPASS\n');
    }
    const file = paths.workflow(root);
    const targets = [paths.intentJournal(root), file];
    return _withLocks(targets, async () => {
      const current = readJson(file, {}) || {};
      const next = {
        ...current, phase, status: 'complete', updated_at: nowIso(),
      };
      writeJson(file, next);
      if (gateAdvisory) {
        return { ok: true, advisory: true, gate: 'verification', reason: gateAdvisory, workflow: next };
      }
      return { ok: true, workflow: next };
    }, env);
  },

  // --- subagent.dispatch — write, Day-1 create -----------------------------
  async 'subagent.dispatch'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const subagentId = requireId(payload?.subagentId, 'subagentId');
    const waveId = requireId(payload?.waveId, 'waveId');
    const brief = requireStr(payload?.brief, 'brief');
    const isolation = payload?.isolation === 'shared' ? 'shared' : 'worktree';
    const targets = [paths.intentJournal(root), paths.waveState(root, waveId)];
    return _withLocks(targets, async () => {
      // Register the subagent on the wave STATE.md.
      const existing = readWaveStateFile(root, waveId);
      const roster = Array.isArray(existing?.frontmatter?.subagents)
        ? [...existing.frontmatter.subagents] : [];
      if (!roster.includes(subagentId)) roster.push(subagentId);
      const fm = {
        ...(existing?.frontmatter || {}),
        wave_id: waveId,
        status: existing?.frontmatter?.status ?? 'in_progress',
        created_at: existing?.frontmatter?.created_at ?? nowIso(),
        updated_at: nowIso(),
        subagents: roster,
      };
      writeWaveStateFile(root, waveId, fm, existing?.body ?? '');
      // `mode` is deterministic on Claude (real subagent primitive),
      // prompt-template elsewhere. T16 owns the per-platform matrix; the
      // verb core picks deterministic when a Claude subagent context is set.
      const mode = ctx?.platform === 'claude' || ctx?.subagentId
        ? 'deterministic' : 'prompt-template';
      const dispatchBrief = [
        `# Subagent dispatch — ${subagentId} (wave ${waveId})`,
        `Isolation: ${isolation}`,
        payload?.env && typeof payload.env === 'object'
          ? `Env passthrough: ${Object.keys(payload.env).join(', ') || '(none)'}`
          : 'Env passthrough: (none)',
        '',
        brief,
      ].join('\n');
      return { ok: true, dispatchBrief, subagentId, mode };
    }, env);
  },

  // --- subagent.checkpoint — append, Day-1 create, dedupKey ---------------
  async 'subagent.checkpoint'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const waveId = requireId(payload?.waveId, 'waveId');
    const subagentId = requireId(payload?.subagentId, 'subagentId');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    if (!payload?.checkpoint || typeof payload.checkpoint !== 'object') {
      throw new Error('state-sdk: subagent.checkpoint needs a checkpoint object');
    }
    const file = paths.checkpoint(root, waveId, subagentId);
    const targets = [paths.intentJournal(root), file];
    return _withLocks(targets, async () => {
      const existing = readJson(file, null);
      if (existing && existing.dedupKey === dedupKey) {
        return { ok: true, path: file, deduped: true };
      }
      writeJson(file, {
        waveId, subagentId, dedupKey,
        checkpoint: payload.checkpoint, updated_at: nowIso(),
      });
      return { ok: true, path: file, deduped: false };
    }, env);
  },

  // --- subagent.post-done — write, Day-1 create, gate=self-check ----------
  async 'subagent.post-done'(payload, ctx) {
    const root = requireRoot(ctx);
    const subagentId = requireId(payload?.subagentId, 'subagentId');
    const reportText = requireStr(payload?.reportText, 'reportText');
    const projectRoot = typeof payload?.projectRoot === 'string' && payload.projectRoot
      ? payload.projectRoot : root;
    // Model 4: failed self-check is a verdict-fail → refuse. A thrown
    // self-check is an execution-fail → advisory (proceed).
    let selfCheck;
    try {
      selfCheck = runSelfCheck(reportText, projectRoot);
    } catch (e) {
      process.stderr.write(`[state-sdk] WARN subagent.post-done gate execution-fail: ${e.message}\n`);
      return { ok: true, advisory: true, gate: 'post-done-self-check', reason: e.message };
    }
    if (selfCheck.verdict !== 'PASSED' && !GATE_BYPASS) {
      return {
        ok: false, refused: true, gate: 'post-done-self-check',
        reason: `self-check FAILED — ${selfCheck.files_missing.length} missing file(s), `
          + `${selfCheck.commits_missing.length} missing commit(s)`,
      };
    }
    return {
      ok: true,
      selfCheck: {
        claimedPaths: selfCheck.files_claimed,
        claimedCommits: selfCheck.commits_claimed,
        verified: selfCheck.verdict === 'PASSED',
      },
    };
  },

  // --- event.emit — append, Day-1 create ----------------------------------
  // The `event.emit` *verb* is a caller-facing append (distinct from the
  // implicit per-query observability tap `_emitEvent`, which is the §3 #10
  // fire-and-forget one). §3 says the event-log entry "appears in the list
  // only so its relative position is defined if a future verb ever needs it
  // inline" — `event.emit` is that verb. It acquires the intent-journal lock
  // (for the §4 begin/commit pair) + the event-log lock so its
  // read-seq-then-append is atomic; both are released before the handler
  // returns. T5 fleshes out rotation + the post-lock observability envelope.
  async 'event.emit'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const subagentId = requireId(payload?.subagentId, 'subagentId');
    const waveId = requireId(payload?.waveId, 'waveId');
    const eventType = requireStr(payload?.eventType, 'eventType');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    if (!payload?.data || typeof payload.data !== 'object') {
      throw new Error('state-sdk: event.emit needs a data object');
    }
    const log = paths.eventLog(root, waveId, subagentId);
    const targets = [paths.intentJournal(root), log];
    return _withLocks(targets, async () => {
      // Dedup against any prior record with the same dedupKey -- both in the
      // live file (cheap) and, if absent there, in the most-recent archive
      // (cross-rotation dedup). Live-file scan first for the hot path.
      const liveRecords = readJsonl(log);
      const dup = liveRecords.find((e) => e && e.dedupKey === dedupKey);
      if (dup) return { ok: true, seq: dup.seq, deduped: true };

      // T5: seq is assigned by the shared `state-events` helper so the verb's
      // seq stream + the dispatcher tap's seq stream are ONE stream, monotonic
      // across rotation. We are under the §3 event-log lock here, so we use
      // the under-lock path that bypasses the in-process tap mutex.
      const record = appendEventUnderHeldLock({
        path: log,
        envelope: {
          eventType, subagentId, waveId,
          ts: nowIso(), dedupKey, data: payload.data,
        },
      });
      return { ok: true, seq: record.seq, deduped: false };
    }, env);
  },

  // --- telemetry.record — append, Day-1 create, dedupKey -----------------
  async 'telemetry.record'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const kind = requireStr(payload?.kind, 'kind');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    if (!payload?.metrics || typeof payload.metrics !== 'object') {
      throw new Error('state-sdk: telemetry.record needs a metrics object');
    }
    const file = paths.telemetry(root);
    const targets = [paths.intentJournal(root), file];
    return _withLocks(targets, async () => {
      const current = readJson(file, null) || { records: [] };
      if (!Array.isArray(current.records)) current.records = [];
      if (current.records.some((r) => r && r.dedupKey === dedupKey)) {
        return { ok: true, telemetry: current, deduped: true };
      }
      current.records.push({
        kind, dedupKey, metrics: payload.metrics, recorded_at: nowIso(),
      });
      current.updated_at = nowIso();
      writeJson(file, current);
      return { ok: true, telemetry: current, deduped: false };
    }, env);
  },

  // --- roster.synthesize — read, Day-1 no-op ------------------------------
  // Pure synthesis: computes a roster from the domain. roster.record persists.
  // The verb-core ships a built-in default roster per known domain; T25/T26
  // layer richer domain-template-driven synthesis on top.
  async 'roster.synthesize'(payload, ctx) {
    requireRoot(ctx);
    const domain = requireStr(payload?.domain, 'domain');
    const DEFAULT_ROSTERS = {
      software: [
        { id: 'architect', role: 'system design', source: 'builtin' },
        { id: 'builder', role: 'implementation', source: 'builtin' },
        { id: 'reviewer', role: 'code review', source: 'builtin' },
      ],
      book: [
        { id: 'outliner', role: 'structure', source: 'builtin' },
        { id: 'writer', role: 'drafting', source: 'builtin' },
        { id: 'editor', role: 'revision', source: 'builtin' },
      ],
      campaign: [
        { id: 'strategist', role: 'positioning', source: 'builtin' },
        { id: 'copywriter', role: 'messaging', source: 'builtin' },
        { id: 'analyst', role: 'measurement', source: 'builtin' },
      ],
    };
    const agents = DEFAULT_ROSTERS[domain];
    if (!agents) {
      return { ok: false, reason: 'domain-template-missing', domain };
    }
    return { ok: true, roster: { domain, agents } };
  },

  // --- roster.record — append, Day-1 create, dedupKey --------------------
  async 'roster.record'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const roster = payload?.roster;
    if (!roster || typeof roster !== 'object' || !Array.isArray(roster.agents)) {
      throw new Error('state-sdk: roster.record needs a roster { domain, agents }');
    }
    const file = paths.teamWorkflow(root);
    // The verb writes BOTH team/workflow.json AND team/charter.json — both are
    // declared targets so the journal `begin` records the full mutation set.
    const targets = [paths.intentJournal(root), file, paths.teamCharter(root)];
    return _withLocks(targets, async () => {
      const existing = readJson(file, null);
      if (existing && existing.dedupKey === dedupKey) {
        return { ok: true, path: file, deduped: true };
      }
      ensureDir(join(root, '.ijfw', 'team'));
      const record = { ...roster, dedupKey, recorded_at: nowIso() };
      writeJson(file, record);
      writeJson(paths.teamCharter(root), {
        domain: roster.domain,
        agent_count: roster.agents.length,
        recorded_at: record.recorded_at,
      });
      return { ok: true, path: file, deduped: false };
    }, env);
  },

  // --- extension.set-active — write, Day-1 create, homedir file ----------
  async 'extension.set-active'(payload, ctx, env) {
    requireRoot(ctx);
    const scope = payload?.scope;
    if (!['project', 'org', 'user'].includes(scope)) {
      throw new Error("state-sdk: extension.set-active scope must be 'project'|'org'|'user'");
    }
    const home = payload?.homeDir || ctx?.homeDir || homedir();
    const file = paths.activeExtension(home);
    const targets = [paths.intentJournal(requireRoot(ctx)), file];
    return _withLocks(targets, async () => {
      if (payload?.manifest === null) {
        // Clear the active extension.
        try { if (existsSync(file)) unlinkSync(file); } catch { /* best-effort */ }
        return { ok: true, path: file, cleared: true };
      }
      const manifest = payload?.manifest;
      if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') {
        throw new Error('state-sdk: extension.set-active needs a manifest { name, permissions } or null');
      }
      writeJson(file, { manifest, scope, updated_at: nowIso() });
      return { ok: true, path: file };
    }, env);
  },

  // --- decision.add — append, Day-1 create, dedupKey --------------------
  async 'decision.add'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const text = requireStr(payload?.text, 'text');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const kind = typeof payload?.kind === 'string' && payload.kind ? payload.kind : 'decision';
    const log = paths.decisions(root);
    const targets = [paths.intentJournal(root), log];
    return _withLocks(targets, async () => {
      if (jsonlHasDedupKey(log, dedupKey)) return { ok: true, deduped: true };
      appendJsonl(log, { kind, text, dedupKey, ts: nowIso() });
      return { ok: true, deduped: false };
    }, env);
  },

  // --- blocker.add — append, Day-1 create, dedupKey --------------------
  // Appends a kind:'blocker' record to decisions.jsonl — its ONLY mutation.
  // `waveId`, when given, is recorded INSIDE that blocker record; the verb does
  // NOT write any wave-<waveId>/STATE.md. The `blockers_open` wave-summary is
  // owned by `wave-state.js` (a separate co-writer of that key) — reconciling
  // it to a single writer is deferred to T7 (migrate wave-state.js to the SDK).
  // Lock targets therefore list exactly the one file the verb mutates.
  async 'blocker.add'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const id = requireStr(payload?.id, 'id');
    const text = requireStr(payload?.text, 'text');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const waveId = payload?.waveId === undefined
      ? undefined : requireId(payload.waveId, 'waveId');
    const log = paths.decisions(root);
    const targets = [paths.intentJournal(root), log];
    return _withLocks(targets, async () => {
      if (jsonlHasDedupKey(log, dedupKey)) {
        return { ok: true, blockerId: id, deduped: true };
      }
      appendJsonl(log, {
        kind: 'blocker', blockerId: id, text, dedupKey,
        waveId: waveId ?? null, resolved: false, ts: nowIso(),
      });
      return { ok: true, blockerId: id, deduped: false };
    }, env);
  },

  // --- blocker.resolve — append, Day-1 refuse, dedupKey ---------------
  // Appends a kind:'blocker-resolution' record to decisions.jsonl — its ONLY
  // mutation. `waveId`, when given, is recorded INSIDE that resolution record;
  // the verb does NOT write any wave-<waveId>/STATE.md. The `blockers_open`
  // wave-summary is owned by `wave-state.js`; its single-writer reconciliation
  // is deferred to T7 (migrate wave-state.js to the SDK). Lock targets list
  // exactly the one file the verb mutates.
  async 'blocker.resolve'(payload, ctx, env) {
    const root = requireRoot(ctx);
    const id = requireStr(payload?.id, 'id');
    const resolution = requireStr(payload?.resolution, 'resolution');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const waveId = payload?.waveId === undefined
      ? undefined : requireId(payload.waveId, 'waveId');
    const log = paths.decisions(root);
    if (!existsSync(log)) {
      return { ok: false, refused: true, reason: 'no-blocker-log' };
    }
    const targets = [paths.intentJournal(root), log];
    return _withLocks(targets, async () => {
      if (jsonlHasDedupKey(log, dedupKey)) {
        return { ok: true, blockerId: id, resolved: true, deduped: true };
      }
      // An open blocker exists iff there is a kind:'blocker' record with this
      // id and no later kind:'blocker-resolution' record for the same id.
      const records = readJsonl(log);
      const opened = records.some((r) => r && r.kind === 'blocker' && r.blockerId === id);
      const alreadyResolved = records.some(
        (r) => r && r.kind === 'blocker-resolution' && r.blockerId === id,
      );
      const resolvable = opened && !alreadyResolved;
      appendJsonl(log, {
        kind: 'blocker-resolution', blockerId: id, resolution, dedupKey,
        waveId: waveId ?? null, resolved: resolvable, ts: nowIso(),
      });
      return { ok: true, blockerId: id, resolved: resolvable, deduped: false };
    }, env);
  },

  // --- state.replay — read (recovery), Day-1 no-op -------------------
  // T4 (this task): reads the intent journal, classifies each verbId, and
  // resolves partials BY VERB KIND (the begin record's `kind` field):
  //   * begin + commit          → already applied → skip (no-op).
  //   * begin, no commit, kind:'overwrite' → snapshot-rollback: restore each
  //     target from the pre-begin snapshot sidecar (restore-or-delete), then
  //     seal with a synthetic commit.
  //   * begin, no commit, kind:'append'    → DO NOT roll back. A partial
  //     append is durable and its dedupKey makes the caller's retry a no-op
  //     (§4) — reverting the file would silently destroy a committed record.
  //     Replay only seals it with a synthetic commit marker.
  // A second replay sees the synthetic commit and treats the partial as
  // resolved. T20 layers truncation-recovery orchestration on top.
  async 'state.replay'(payload, ctx) {
    const root = requireRoot(ctx);
    const journal = paths.intentJournal(root);
    if (!existsSync(journal)) {
      return { ok: true, replayed: [], skipped: [], rolledBack: [] };
    }
    // The replay walk + any rollback restores happen under the intent-journal
    // lock so a concurrent mutating verb cannot interleave with recovery.
    return withFsLock(lockPathFor(journal), async () => {
      const records = readJsonl(journal);
      const sinceVerbId = payload?.sinceVerbId;
      let scoped = records;
      if (typeof sinceVerbId === 'string' && sinceVerbId) {
        const idx = records.findIndex((r) => r && r.verbId === sinceVerbId);
        if (idx !== -1) scoped = records.slice(idx);
      }
      const begins = new Map();
      const commits = new Set();
      for (const r of scoped) {
        if (!r || typeof r.verbId !== 'string') continue;
        if (r.phase === 'begin') begins.set(r.verbId, r);
        else if (r.phase === 'commit') commits.add(r.verbId);
      }
      const skipped = [];
      const rolledBack = [];
      const sealed = [];
      for (const [verbId, beginRec] of begins) {
        if (commits.has(verbId)) {
          // begin + commit → durably applied. Re-issuing it would be a no-op,
          // so replay simply records it as skipped and mutates nothing.
          skipped.push(verbId);
          continue;
        }
        // Partial: begin without commit. Resolve it by verb kind.
        //   `kind:'append'`  → seal only; NEVER revert (a durable append's
        //                      record would be lost). The dedupKey makes the
        //                      caller's retry a no-op anyway (§4).
        //   `kind:'overwrite'` (or a legacy begin with no `kind` but a
        //                      snapshot sidecar) → snapshot-rollback.
        // The snapshot sidecar's presence is the legacy-safe discriminator:
        // append verbs never write one.
        const snap = readJson(snapshotPath(root, verbId), null);
        const isAppend = beginRec.kind === 'append'
          || (beginRec.kind === undefined && snap === null);
        if (!isAppend && snap && Array.isArray(snap.targets)) {
          // Overwrite verb: restore every target from the snapshot sidecar —
          // restore-or-delete per its pre-begin existence.
          for (const t of snap.targets) {
            try {
              if (t.existed) {
                writeAtomic(t.absPath, t.content ?? '');
              } else if (existsSync(t.absPath)) {
                unlinkSync(t.absPath); // the partial created it — undo by delete
              }
            } catch { /* a single target restore failing must not abort the walk */ }
          }
        }
        // Discard any snapshot sidecar (overwrite verbs only — append verbs
        // never wrote one) and seal the verbId with a synthetic `commit` so a
        // re-run of replay treats this partial as resolved.
        try {
          const s = snapshotPath(root, verbId);
          if (existsSync(s)) unlinkSync(s);
        } catch { /* best-effort */ }
        appendFileSync(journal, `${JSON.stringify({
          verb: beginRec.verb, verbId, phase: 'commit', ts: nowIso(),
          payloadDigest: beginRec.payloadDigest,
          kind: isAppend ? 'append' : 'overwrite',
          // `rolledBack:true` only for an overwrite verb whose targets were
          // reverted; an append partial is sealed in place, not rolled back.
          ...(isAppend ? { sealed: true } : { rolledBack: true }),
        })}\n`, { mode: 0o600 });
        // `rolledBack[]` = overwrite partials whose targets were restored
        // (contract §7). `sealed[]` = append partials left durably in place
        // and only marked terminal — additive, does not redefine the three
        // documented arrays.
        if (isAppend) sealed.push(verbId);
        else rolledBack.push(verbId);
      }
      return {
        ok: true, replayed: [], skipped, rolledBack, sealed,
      };
    }, LOCK_OPTS);
  },

  // --- state.validate — read, Day-1 no-op ----------------------------
  async 'state.validate'(_payload, ctx) {
    const root = requireRoot(ctx);
    const issues = [];
    // Parse-integrity scan of the canonical JSON state files.
    for (const [label, p] of [
      ['workflow.json', paths.workflow(root)],
      ['waves.json', paths.waves(root)],
      ['telemetry/convergence.json', paths.telemetry(root)],
      ['team/workflow.json', paths.teamWorkflow(root)],
    ]) {
      if (!existsSync(p)) {
        issues.push({ file: label, problem: 'absent' });
        continue;
      }
      const r = readSafe(p);
      if (!r.ok) issues.push({ file: label, problem: `parse: ${r.error}` });
    }
    // Orphaned begin-without-commit records in the intent journal.
    const journal = paths.intentJournal(root);
    if (existsSync(journal)) {
      const records = readJsonl(journal);
      const commits = new Set(
        records.filter((r) => r && r.phase === 'commit').map((r) => r.verbId),
      );
      for (const r of records) {
        if (r && r.phase === 'begin' && !commits.has(r.verbId)) {
          issues.push({ file: 'intent-journal.jsonl', problem: `orphaned begin: ${r.verbId}` });
        }
      }
    }
    // `absent` is informational, not a failure — `valid` reflects only
    // genuine integrity problems among PRESENT files (contract §7).
    const valid = !issues.some((i) => i.problem !== 'absent');
    return { ok: true, valid, issues };
  },
};

/** The frozen verb registry — verb name → handler. Exported for tests. */
export const VERBS = handlers;

/**
 * Verbs that mutate state and therefore write an intent-journal begin/commit
 * pair (T4). Each one funnels through `_withLocks`, which is the single place
 * a verb's target set is declared — there is NO parallel `targetsFor` switch
 * (removed in the T4 spec-review fix; it was a second source of truth that
 * already drifted from the handlers).
 *
 * `subagent.post-done` is NOT here — contract §8 classes it as a `read` verb
 * (no-op Day-1, no file mutation) and §4 says read verbs write no journal
 * records. It runs only the post-done self-check gate.
 */
const MUTATING = new Set([
  'workflow.set-phase', 'wave.advance', 'wave.record-task', 'phase.plan-check',
  'phase.complete', 'subagent.dispatch', 'subagent.checkpoint',
  'event.emit', 'telemetry.record', 'roster.record',
  'extension.set-active', 'decision.add', 'blocker.add', 'blocker.resolve',
]);

/**
 * Append/dedupKey verbs (contract §8). A partial append is replay-safe via its
 * `dedupKey` (§4), NOT via snapshot-rollback — so `_journalBegin` captures no
 * snapshot for these and `state.replay` never reverts their target file (it
 * would destroy a durably-committed record). All other mutating verbs are
 * overwrite / read-modify-write and DO snapshot-rollback.
 */
const APPEND_VERBS = new Set([
  'wave.record-task', 'subagent.checkpoint', 'event.emit', 'telemetry.record',
  'roster.record', 'decision.add', 'blocker.add', 'blocker.resolve',
]);

// ---------------------------------------------------------------------------
// THE DISPATCHER
// ---------------------------------------------------------------------------

/**
 * query(verb, payload, ctx) — the single state-SDK mutation/read surface.
 *
 * Routes `verb` to its registered handler. An UNKNOWN verb throws — there is
 * NO silent fallback and NO default handler (contract §8, frozen for T2).
 *
 * @param {string} verb     a verb name from the frozen 20-verb registry.
 * @param {object} [payload]  verb-specific payload (see STATE-SDK-CONTRACT §7).
 * @param {{projectRoot:string, subagentId?:string, homeDir?:string, platform?:string}} [ctx]
 * @returns {Promise<object>}  the verb's result shape; always carries `ok` + `verbId`.
 */
export async function query(verb, payload = {}, ctx = {}) {
  const handler = typeof verb === 'string' ? handlers[verb] : undefined;
  if (typeof handler !== 'function') {
    throw new Error(
      `state-sdk: unknown verb "${verb}" — no silent fallback. `
      + `Known verbs: ${Object.keys(handlers).sort().join(', ')}`,
    );
  }

  // Per-invocation id — `begin`/`commit` journal records (T4) and every event
  // record (T5) for this query share this verbId.
  const verbId = `v-${randomUUID()}-0000`;
  const digest = payloadDigest(payload);
  const isMutating = MUTATING.has(verb);

  // The `env` object is the single channel between the dispatcher and the
  // verb's `_withLocks` call. For a mutating verb it carries everything
  // `_withLocks` needs to write the write-ahead `begin` record FROM THE VERB'S
  // OWN TARGET LIST (issue 2 — no re-derivation): `_withLocks` populates
  // `env.journalHandle` for `_journalCommit` to consume. The journal root is
  // required up-front so a mutating verb with a malformed ctx fails fast.
  const env = { verbId };
  if (isMutating) {
    env.isMutating = true;
    env.verb = verb;
    env.root = requireRoot(ctx);
    env.dedupKey = payload?.dedupKey;
    env.payloadDigest = digest;
    env.appendVerb = APPEND_VERBS.has(verb);
    env.journalHandle = null;
  }

  // The tap envelope's projectRoot is best-effort: `ctx.projectRoot` is
  // required for mutating verbs but may be unset for invalid calls — in that
  // case the tap silently no-ops (an erroring unknown verb / missing-root
  // call has nowhere to write its tap event). `waveId` is derived from the
  // payload when the verb names one — the tap routes to the wave-scoped log.
  const eventRoot = typeof ctx?.projectRoot === 'string' ? ctx.projectRoot : null;
  const eventWaveId = typeof payload?.waveId === 'string' ? payload.waveId : null;

  let result;
  let outcome = 'ok';
  try {
    result = await handler(payload, ctx, env);
    if (result && result.refused) outcome = 'refused';
    else if (result && result.advisory) outcome = 'advisory';
  } catch (err) {
    outcome = 'error';
    // T4 — the handler threw: if a `begin` was written (`env.journalHandle`
    // set) the verb is a partial. Leave the begin record + snapshot in place
    // so `state.replay` rolls it back (overwrite verb) or seals it (append
    // verb). T5 — emit the failure event before re-throwing. Fire-and-forget,
    // no §3 lock taken, errors swallowed inside `_emitEvent`.
    _emitEvent({
      verb, subagentId: ctx?.subagentId ?? 'parent', ts: nowIso(),
      verbId, outcome, payloadDigest: digest,
      projectRoot: eventRoot, waveId: eventWaveId,
    });
    throw err;
  }

  // T4 — `commit` marker after the handler returned. `env.journalHandle` is
  // set iff `_withLocks` ran a `begin` (every mutating verb that reaches its
  // critical section). A handler that returned early WITHOUT calling
  // `_withLocks` (e.g. `phase.plan-check` Day-1 refuse / gate refuse) wrote no
  // `begin` and needs no `commit` — it mutated nothing. When a `begin` exists,
  // commit regardless of refused/ok. This commit-on-refuse is sound ONLY
  // because of the §4 handler invariant: a handler MUST NOT return a refusal
  // after entering `_withLocks` / after any mutation — refusals are decided
  // before the critical section (verdict gates already run pre-`_withLocks`).
  // So a `begin`-then-`refused` result mutated nothing inside the lock, the
  // snapshot still equals disk, and committing only marks the verbId terminal
  // so replay never treats a clean pre-lock refusal as a recoverable partial.
  if (env.journalHandle) {
    await _journalCommit(env.journalHandle);
  }

  // T5 — fire-and-forget event AFTER the critical section. Per Model 3 the
  // tap is observability, not state — it runs post-lock-release and never
  // blocks the caller. `_emitEvent` returns synchronously after queueing.
  _emitEvent({
    verb, subagentId: ctx?.subagentId ?? 'parent', ts: nowIso(),
    verbId, outcome, payloadDigest: digest,
    projectRoot: eventRoot, waveId: eventWaveId,
  });

  // Every query() result carries `verbId` + `ok` (contract §7).
  return { ok: result?.ok !== false, verbId, ...result };
}

export default { query, VERBS };
