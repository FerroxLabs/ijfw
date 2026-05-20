/**
 * state-events.js -- v1.5.0 T5: per-subagent event log + tap + poll reader.
 *
 * Binds verbatim to .planning/v150-gap-closure/STATE-SDK-CONTRACT.md §5
 * (CROSS-CUTTING MODEL 3 -- Event record + log rotation).
 *
 * ROLES:
 *   * `emitEvent(envelope)` -- the implementation behind the dispatcher's
 *     `_emitEvent` observability tap. Fire-and-forget, AFTER lock release,
 *     idempotent on no-arg/malformed input (swallows all I/O errors -- never
 *     propagates). Appends one envelope-shaped JSONL record per call.
 *   * `assignNextSeqAndAppendUnderLock({...})` -- the SHARED seq+append helper
 *     called by the `event.emit` verb (which is journaled and runs INSIDE its
 *     own §3 lock). Same seq stream as the tap (per-path); same rotation
 *     behaviour; same size cap.
 *   * `pollEvents({since})` -- explicit-interval reader. Returns events with
 *     `seq > since` across the current file + any rotated archive. NEVER uses
 *     `fs.watch`.
 *   * `resolveEventLogPath(root, waveId, subId)` -- single source of truth for
 *     the per-subagent log path AND the fallback for tap-events without a
 *     subagent context.
 *
 * SEQ MONOTONICITY ACROSS ROTATION:
 *   The jsonl-rotation primitive archives the current log to a gzipped
 *   sibling (`<stem>.<date>.jsonl.gz`) and truncates the live file -- so a
 *   naive read-tail of the current log to derive the next seq would reset to 1
 *   after every rotation. We persist a tiny sidecar `<log>.seq` containing the
 *   last-assigned seq, written via tmp-rename atomic so a crash leaves either
 *   the old or the new value -- never half. On startup of an event stream the
 *   sidecar is read; if absent (first-ever emit OR a manual wipe), we fall
 *   back to scanning the current file + the most-recent archive for the max
 *   seq, then write the sidecar.
 *
 * IN-PROCESS APPEND SERIALIZATION:
 *   The tap fires off the critical section with NO §3 lock held. Concurrent
 *   tap emits to the same log (multiple verbs in flight) would race on seq
 *   assignment + appendFile. We serialize tap appends per-log-path with a
 *   simple in-process Promise-chain mutex. Cross-process serialization is not
 *   required because the tap fires only from one orchestrator process and the
 *   `event.emit` verb takes the §3 event-log lock itself (Model 3).
 *
 * NO PRODUCTION DEPENDENCIES; ESM; Node >=18.
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, statSync, writeFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { rotateJsonlIfNeeded, DEFAULT_ROTATE_SIZE } from '../lib/jsonl-rotation.js';

// -- Contract constants ----------------------------------------------------

/** Contract §5 -- 4 MiB byte ceiling per event log. */
export const EVENT_BYTE_CEILING = DEFAULT_ROTATE_SIZE; // 4 * 1024 * 1024

/** Contract §5 -- 10000-line ceiling per event log. */
export const EVENT_LINE_CEILING = 10000;

/** Contract §5 -- per-event 4 KiB size cap. Truncate, never drop. */
export const EVENT_MAX_LINE_BYTES = 4 * 1024;

// -- Path resolution -------------------------------------------------------

/**
 * Per-subagent event-log path per contract §1 + §5.
 * `<projectRoot>/.ijfw/wave-<waveId>/events-<subId>.jsonl`
 *
 * Routing is total -- the tap never silently drops:
 * - Both present: `<projectRoot>/.ijfw/wave-<waveId>/events-<subId>.jsonl`.
 * - waveId present, subagentId absent: route under the wave dir with the
 *   §5-canonical `'parent'` subId fallback —
 *   `<projectRoot>/.ijfw/wave-<waveId>/events-parent.jsonl`. The waveId is
 *   honored; the no-subagent caller surfaces as `subagentId:'parent'` per §5.
 * - subagentId present, waveId absent: legacy fallback under the system dir,
 *   `<projectRoot>/.ijfw/state/events-<sub>.jsonl`, because there is no wave
 *   directory to anchor to. (Rare in practice — verbs that carry a subagent
 *   carry a wave too.)
 * - Both absent: system fallback `<projectRoot>/.ijfw/state/events-system.jsonl`
 *   (e.g. dispatcher-tap events for verbs called without a `waveId` payload,
 *   like `state.validate`). Ratified by contract §5 (see Model 3 note).
 */
export function resolveEventLogPath(projectRoot, waveId, subagentId) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw new Error('state-events: projectRoot required');
  }
  const safeId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
  const wid = safeId(waveId);
  const sid = safeId(subagentId);
  if (wid && sid) return join(projectRoot, '.ijfw', `wave-${wid}`, `events-${sid}.jsonl`);
  if (wid) return join(projectRoot, '.ijfw', `wave-${wid}`, 'events-parent.jsonl');
  if (sid) return join(projectRoot, '.ijfw', 'state', `events-${sid}.jsonl`);
  return join(projectRoot, '.ijfw', 'state', 'events-system.jsonl');
}

/** Sidecar path holding the last-assigned seq for a given event log. */
function seqSidecarPath(eventLogPath) {
  const dir = dirname(eventLogPath);
  const base = basename(eventLogPath);
  return join(dir, `.${base}.seq`);
}

// -- Internal helpers ------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function nowIso() { return new Date().toISOString(); }

/**
 * Read + parse the seq sidecar. Returns 0 when absent / corrupt.
 */
function readSeqSidecar(eventLogPath) {
  const sidecar = seqSidecarPath(eventLogPath);
  if (!existsSync(sidecar)) return 0;
  try {
    const raw = readFileSync(sidecar, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Atomic sidecar write (tmp-rename) so a crash leaves either old or new. */
function writeSeqSidecar(eventLogPath, seq) {
  const sidecar = seqSidecarPath(eventLogPath);
  ensureDir(dirname(sidecar));
  const tmp = `${sidecar}.tmp.${process.pid}`;
  writeFileSync(tmp, String(seq), { mode: 0o600 });
  renameSync(tmp, sidecar);
}

/**
 * Recover the last-emitted seq when the sidecar is absent (first-ever emit
 * for this log, or sidecar wiped). Scans the live file + the newest .jsonl.gz
 * archive and returns the max `seq` field. Returns 0 when nothing found.
 */
function recoverLastSeqFromDisk(eventLogPath) {
  let max = 0;
  const seenSeq = (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.seq === 'number' && obj.seq > max) max = obj.seq;
    } catch { /* skip a corrupt line */ }
  };

  // Live file.
  if (existsSync(eventLogPath)) {
    for (const line of readFileSync(eventLogPath, 'utf8').split('\n')) seenSeq(line);
  }
  // Newest archive sibling (lexicographically sorted .jsonl.gz files).
  const dir = dirname(eventLogPath);
  const base = basename(eventLogPath); // e.g. events-W12-A1.jsonl
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  if (existsSync(dir)) {
    let archives = [];
    try {
      archives = readdirSync(dir)
        .filter((n) => n.startsWith(`${stem}.`) && n.endsWith('.jsonl.gz'))
        .sort()
        .reverse(); // newest first by date-suffix
    } catch { /* ignore */ }
    for (const a of archives) {
      try {
        const raw = gunzipSync(readFileSync(join(dir, a))).toString('utf8');
        for (const line of raw.split('\n')) seenSeq(line);
      } catch { /* corrupt archive -- skip */ }
    }
  }
  return max;
}

/**
 * In-process serializer keyed by log path. Multiple tap emits to the same
 * log from this process queue on a single Promise chain so seq assignment +
 * append + sidecar update are atomic w.r.t. concurrent callers in-process.
 */
const APPEND_QUEUES = new Map();

function queueAppend(path, work) {
  const prev = APPEND_QUEUES.get(path) || Promise.resolve();
  const next = prev.then(work, work);
  // Store `next` itself (NOT a `.finally()`-wrapped copy) so the cleanup
  // check below `=== next` actually identifies the queue head. A `.finally()`
  // wrapper returns a different Promise object, which would make the
  // identity-check `APPEND_QUEUES.get(path) === next` permanently false and
  // leak Map entries (one per unique log path).
  APPEND_QUEUES.set(path, next);
  next.then(() => {
    // Only delete when no follow-up emit has chained onto `next` -- if a
    // subsequent `queueAppend(path, ...)` call has already set a new head,
    // leave it in place. This keeps the Map bounded by the number of
    // CURRENTLY-IN-FLIGHT log paths rather than ever-seen ones.
    if (APPEND_QUEUES.get(path) === next) APPEND_QUEUES.delete(path);
  }, () => {
    if (APPEND_QUEUES.get(path) === next) APPEND_QUEUES.delete(path);
  });
  return next;
}

/**
 * Count newline-terminated lines in the live file (cheap -- only the live
 * file, not archives, because rotation is gated by the live file's size+lines).
 */
function countLines(path) {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, 'utf8');
  if (!raw) return 0;
  let n = 0;
  for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * Apply the per-event 4 KiB cap. Returns the (possibly-truncated) record.
 * If the serialized form would exceed `EVENT_MAX_LINE_BYTES`, we keep the
 * envelope (seq/verb/subagentId/ts/verbId/outcome/payloadDigest) and add a
 * `truncated:true` marker, truncating the digest if even THAT is too large.
 */
function applySizeCap(record) {
  let line = JSON.stringify(record);
  if (Buffer.byteLength(line, 'utf8') <= EVENT_MAX_LINE_BYTES) return record;
  // Reduce to envelope-only + truncation marker.
  const envelope = {
    seq: record.seq,
    verb: record.verb,
    subagentId: record.subagentId,
    ts: record.ts,
    verbId: record.verbId,
    outcome: record.outcome,
    payloadDigest: record.payloadDigest,
    truncated: true,
  };
  line = JSON.stringify(envelope);
  if (Buffer.byteLength(line, 'utf8') <= EVENT_MAX_LINE_BYTES) return envelope;
  // Last resort -- truncate payloadDigest itself. We still keep the prefix
  // so the truncation is visibly a sha256-<hex>... cut, not a dropped event.
  const room = EVENT_MAX_LINE_BYTES - Buffer.byteLength(JSON.stringify({
    ...envelope, payloadDigest: '',
  }), 'utf8') - 8; // 8 bytes of safety slack
  const dig = String(record.payloadDigest || '');
  envelope.payloadDigest = dig.slice(0, Math.max(0, room));
  return envelope;
}

// -- Rotation ---------------------------------------------------------------

/**
 * Rotate the live event log if it has crossed the byte OR line ceiling.
 * Reuses the shared `jsonl-rotation` primitive for the byte ceiling (it
 * gzip-archives + truncates atomically). The library is byte-only, so we
 * implement the line ceiling by re-calling the primitive with `maxBytes: 1`
 * once the line count is at the ceiling -- which forces a rotation because
 * any non-empty file is necessarily larger than 1 byte. Choosing `1` (rather
 * than `0`) is deliberate: `jsonl-rotation.js`'s argument-normaliser treats
 * `maxBytes <= 0` as "fall back to DEFAULT_ROTATE_SIZE", which would silently
 * defeat the force-rotate. `1` survives the normaliser and is unconditionally
 * below any real file's size.
 *
 * Test override: `rotateOptions.maxBytes` / `rotateOptions.maxLines` allow
 * tests to force rotation at small thresholds without writing megabytes.
 */
function rotateIfNeeded(eventLogPath, rotateOptions = {}) {
  const maxBytes = Number.isFinite(rotateOptions.maxBytes)
    ? rotateOptions.maxBytes : EVENT_BYTE_CEILING;
  const maxLines = Number.isFinite(rotateOptions.maxLines)
    ? rotateOptions.maxLines : EVENT_LINE_CEILING;

  // Byte path -- delegate to the library.
  const byteResult = rotateJsonlIfNeeded(eventLogPath, { maxBytes });
  if (byteResult.rotated) return byteResult;

  // Line path -- the library is byte-only, so we force a rotation by
  // calling it again with maxBytes=1 IF the live line count is at/past the
  // ceiling. `1` (not `0`) is critical: the lib normalises `maxBytes <= 0`
  // back to DEFAULT_ROTATE_SIZE (4 MiB), so `0` would not actually force.
  const lineCount = countLines(eventLogPath);
  if (lineCount >= maxLines && existsSync(eventLogPath) && statSync(eventLogPath).size > 0) {
    return rotateJsonlIfNeeded(eventLogPath, { maxBytes: 1 });
  }
  return byteResult;
}

// -- The shared append core -------------------------------------------------

/**
 * Append one event to the per-subagent log. Assigns `seq` (monotonic across
 * rotation), applies the size cap, rotates if at ceiling, writes the line,
 * then persists the seq sidecar. SYNCHRONOUS file I/O so that the post-tap
 * sequence (rotate -> append -> sidecar) is observably atomic from the
 * caller's point of view.
 *
 * The caller is responsible for serializing concurrent invocations on the
 * SAME `path` (either via an in-process queue -- the tap's `emitEvent` does
 * this -- or via a §3 fs lock -- the `event.emit` verb does this).
 *
 * Returns the persisted event record (with assigned seq + any truncation).
 */
export function assignNextSeqAndAppend({ path, envelope, rotateOptions }) {
  ensureDir(dirname(path));

  // Determine the next seq.
  let lastSeq = readSeqSidecar(path);
  if (lastSeq === 0) {
    // First-ever emit OR sidecar wiped -- recover from disk.
    lastSeq = recoverLastSeqFromDisk(path);
  }
  const nextSeq = lastSeq + 1;

  // Rotation BEFORE the append (per contract §5 -- "on reaching either
  // ceiling, rotate ... and start a fresh log; seq continues monotonically
  // across rotation"). seq does NOT reset because we keep the sidecar.
  rotateIfNeeded(path, rotateOptions);

  // Compose the record + size cap.
  const record = applySizeCap({ ...envelope, seq: nextSeq });

  // Append the JSONL line.
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });

  // Persist the sidecar AFTER the append succeeds. If we crash between the
  // append and the sidecar write, the next emit's recovery scans disk and
  // recovers the true max seq -- so we are crash-safe with at most a
  // re-derived seq, never a reset.
  writeSeqSidecar(path, nextSeq);

  return record;
}

// -- Public surface --------------------------------------------------------

/**
 * The implementation behind the dispatcher's `_emitEvent` observability tap.
 * Fire-and-forget, AFTER lock release. Swallows all errors -- writes any
 * failure to stderr and returns. Never throws, never propagates.
 *
 * @param {{projectRoot:string, waveId?:string, subagentId?:string,
 *          verb:string, verbId:string, outcome:string, payloadDigest:string,
 *          ts?:string, rotateOptions?:object}} input
 * @returns {Promise<void>}
 */
export async function emitEvent(input) {
  if (!input || typeof input !== 'object') return;
  const {
    projectRoot, waveId, subagentId, verb, verbId, outcome, payloadDigest,
    ts, rotateOptions,
  } = input;
  if (!projectRoot || !verb || !verbId) return; // soft-fail, no throw
  const path = resolveEventLogPath(projectRoot, waveId, subagentId);

  // Build the envelope per contract §5.
  const envelope = {
    verb,
    subagentId: subagentId || 'parent',
    ts: ts || nowIso(),
    verbId,
    outcome: outcome || 'ok',
    payloadDigest: payloadDigest || '',
  };

  // Serialize per-path so concurrent tap emits to the same log don't race
  // on the seq sidecar.
  await queueAppend(path, async () => {
    try {
      assignNextSeqAndAppend({ path, envelope, rotateOptions });
    } catch (err) {
      // NEVER propagate -- the tap is fire-and-forget. Log to stderr.
      try {
        process.stderr.write(`[ijfw state-events] emit failed: ${err?.message || err}\n`);
      } catch { /* even stderr failed -- swallow */ }
    }
  });
}

/**
 * Synchronous core for callers that ALREADY hold a §3 lock on the event log
 * (currently: the `event.emit` verb in state-sdk.js). Bypasses the in-process
 * queue -- the lock serializes; returns the persisted record. Errors here DO
 * propagate -- the caller is journaled and wants to surface the failure.
 */
export function appendUnderHeldLock({ path, envelope, rotateOptions }) {
  return assignNextSeqAndAppend({ path, envelope, rotateOptions });
}

// -- pollEvents reader -----------------------------------------------------

/**
 * Explicit-interval reader. Returns events with `seq > since` across the
 * live file and any rotated archive(s). NEVER uses `fs.watch`.
 *
 * Cursor shape: a plain number (the highest seq the consumer has already
 * processed). `since: 0` -> the entire stream.
 *
 * Return shape: `{ events: <array>, cursor: <number> }` -- `cursor` is the
 * highest seq present (suitable to feed back as `since` on the next poll).
 *
 * Spans rotation: scans the most-recent .jsonl.gz archive(s) when the
 * cursor predates the live file's first line.
 */
export function pollEvents(input) {
  const { projectRoot, waveId, subagentId } = input || {};
  const since = Number.isFinite(input?.since) ? input.since : 0;
  const path = resolveEventLogPath(projectRoot, waveId, subagentId);

  const out = [];
  let maxSeq = since;

  const consumeRaw = (raw) => {
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      if (!obj || typeof obj.seq !== 'number') continue;
      if (obj.seq > since) out.push(obj);
      if (obj.seq > maxSeq) maxSeq = obj.seq;
    }
  };

  // Read archives FIRST so the returned `events` array stays seq-sorted.
  // Archives are date-stamped; we scan ALL .jsonl.gz siblings so a poll with
  // a very old `since` recovers events from a rotated archive.
  const dir = dirname(path);
  const base = basename(path);
  const stem = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
  if (existsSync(dir)) {
    let archives = [];
    try {
      archives = readdirSync(dir)
        .filter((n) => n.startsWith(`${stem}.`) && n.endsWith('.jsonl.gz'))
        .sort(); // oldest first by date-suffix
    } catch { /* ignore */ }
    for (const a of archives) {
      try {
        const raw = gunzipSync(readFileSync(join(dir, a))).toString('utf8');
        consumeRaw(raw);
      } catch { /* skip corrupt archive */ }
    }
  }

  // Then the live file.
  if (existsSync(path)) {
    consumeRaw(readFileSync(path, 'utf8'));
  }

  // Sort by seq (archives + live may overlap in degenerate cases).
  out.sort((a, b) => a.seq - b.seq);

  // Return cursor = max seen seq, or `since` if nothing seen + no file at all.
  // When the log is absent entirely AND since:0 was passed, cursor stays 0.
  const cursor = out.length > 0 ? out[out.length - 1].seq : maxSeq;
  return { events: out, cursor };
}
