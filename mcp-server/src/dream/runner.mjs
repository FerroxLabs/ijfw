#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- D3 dream-cycle runner.
//
// Replaces the legacy 5-session deferral
// (SESSION_NUM % 5 == 0 -> .ijfw/.startup-flags) with INLINE
// consolidation at SessionEnd via detached spawn. Mirrors the Phase 3
// cold-scan-runner.mjs contract: tiny CLI adapter, fire-and-forget,
// best-effort. Any throw is swallowed so a broken dream cycle never
// surfaces a non-zero exit to the parent SessionEnd hook.
//
// Sequence per run:
//   1. Cooldown check (4h via .ijfw/.dream-state.json) -- skip on hit.
//   2. Optional: invoke D1's tier-promotion module when present
//      (Working -> Episodic, Episodic -> Semantic, Working -> Procedural
//      per D-PILLAR-SPEC.md). Absent during D1 build window -> log and
//      degrade to a "no promotion module" line.
//   3. Optional: invoke the existing project-journal -> knowledge.md
//      consolidation policy (claude/commands/consolidate.md). When the
//      Claude command itself runs as the consolidator (host=claude),
//      runner.mjs records the dream-cycle attempt and returns; the
//      heavy work happens in the slash command. For Codex/Gemini/
//      Wayland/Hermes hosts, runner.mjs is the only consolidator.
//   4. Mark completion via cooldown.markCompleted() so the next
//      SessionEnd within 4h is skipped.
//
// All output lands in `<repoRoot>/.ijfw/logs/dream-<timestamp>.log`.
//
// Usage:
//   node runner.mjs --project-root <path> [--host <name>] [--reason <txt>]
//
// Discipline:
//   - ESM, zero deps.
//   - LC_ALL=C semantics (we only emit ASCII).
//   - process.exit(0) on every code path -- the parent hook depends on
//     a clean exit even for cooldown skips.

import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOnCooldown, markCompleted } from './cooldown.js';
import { shouldRunNow } from './state-file.js';
import { runStages } from './stage-runner.js';
import { runDreamCycle } from '../brain/dream-pipeline.js';
import { openDb } from '../memory/fts5.js';
import { deriveProfile } from '../profile/derive.js';
import { mergeAndWrite as profileMergeAndWrite } from '../profile/merge.js';
import { toDeriveMeta, computeIdentity } from '../profile/capture.js';
// S2 runtime wire: stamp `precision_eligible` on derived preference slugs so the
// serve-path snapshot gate (render-brief.js) is no longer dead code. This module
// imports eval/ — that is SAFE here because the dream/derive path is already
// LLM-capable (it imports derive.js). The zero-LLM SERVE path never imports this.
import { stampPrecisionEligible } from '../profile/precision-stamp.mjs';
import { readProfile as profileReadProfile } from '../profile/store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Is this module the process entry point, or merely IMPORTED (e.g. by the
// profile_derive stage test)? When imported, we must NOT parse argv, run the
// idle gate, or process.exit — we only expose the exported stage helpers. The
// CLI side effects below are all guarded by `isMain`.
const IS_MAIN = (() => {
  try {
    return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opts = {
  projectRoot: null,
  host: 'unknown',
  reason: 'session_end',
  sessionId: process.env.IJFW_SESSION_ID || null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project-root') opts.projectRoot = argv[++i];
  else if (a === '--host') opts.host = argv[++i];
  else if (a === '--reason') opts.reason = argv[++i];
  else if (a === '--session-id') opts.sessionId = argv[++i];
}

if (IS_MAIN && !opts.projectRoot) process.exit(0);

// When imported (not main) with no --project-root, fall back to cwd so the
// path joins below never see `null`; the CLI driver is gated on IS_MAIN anyway.
const stateDir = join(opts.projectRoot || process.cwd(), '.ijfw');
const logDir = join(stateDir, 'logs');

// ---------------------------------------------------------------------------
// log helper -- best-effort, never throws
// ---------------------------------------------------------------------------

function isoStamp() {
  return new Date().toISOString();
}

function logFilename() {
  // dream-2026-05-08T10-15-32Z.log
  return `dream-${isoStamp().replace(/[:]/g, '-')}.log`;
}

const LOG_PATH = join(logDir, logFilename());

function log(line) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(LOG_PATH, `[${isoStamp()}] ${line}\n`, 'utf8');
  } catch {
    // never throw out of the runner
  }
}

// ---------------------------------------------------------------------------
// Idle gate (M4 — replaces legacy 4h cooldown with min_idle_minutes
// gate, default 30 min, override via IJFW_DREAM_MIN_IDLE_MIN).
// Legacy cooldown.markCompleted() is still called as a final stage so
// downstream code reading the old marker keeps working.
// ---------------------------------------------------------------------------

const MIN_IDLE_MIN = Number(process.env.IJFW_DREAM_MIN_IDLE_MIN || 30);
if (IS_MAIN && !shouldRunNow(opts.projectRoot, { min_idle_minutes: MIN_IDLE_MIN })) {
  log(`skip: idle gate <${MIN_IDLE_MIN}min since last run`);
  process.exit(0);
}
// Legacy cooldown is now informational only — the new idle gate above is
// strictly stricter (30 min) than the old 4h. We still consult it as a
// belt-and-braces signal, but ONLY for visibility in the log; it does not
// block the run.
if (IS_MAIN && isOnCooldown(stateDir)) {
  log(`note: legacy 4h cooldown also active (host=${opts.host}, reason=${opts.reason}) — proceeding under idle gate`);
}

if (IS_MAIN) {
  log(`start: host=${opts.host}, reason=${opts.reason}, project=${opts.projectRoot}`);
}

// ---------------------------------------------------------------------------
// Step 1: D1 tier-promotion (when available)
// ---------------------------------------------------------------------------
//
// D1 (Wave 2 Agent E) lands `mcp-server/src/memory/tier-promotion.js`
// with the deterministic promotion rules from D-PILLAR-SPEC.md section 1. We
// import-by-URL so a missing module is a soft skip rather than a top-
// level ESM resolve failure.
//
// Expected surface (per D-PILLAR-SPEC.md + brief):
//   export async function runTierPromotion({ projectRoot, log })
//     -> { promoted, superseded, skipped }
//
// Any contract drift is caught and logged; the dream cycle still
// continues to step 2.

async function runTierPromotion() {
  // Resolve tier-promotion module (D1, Agent E). Search both the
  // bundled mcp-server/src/memory layout and the repo-local layout so
  // the runner works whether it's invoked from ~/.ijfw or the dev repo.
  const candidates = [
    join(__dirname, '..', 'memory', 'tier-promotion.js'),
    join(opts.projectRoot, 'mcp-server', 'src', 'memory', 'tier-promotion.js'),
  ];
  let modulePath = null;
  for (const cand of candidates) {
    if (existsSync(cand)) { modulePath = cand; break; }
  }
  if (!modulePath) {
    log('tier-promotion: module not present (D1 in flight) -- skip step');
    return null;
  }

  // Resolve the matching fts5.js (provides openDb / closeDb).
  const fts5Path = join(dirname(modulePath), 'fts5.js');
  let openDb, closeDb;
  try {
    const fts5 = await import(pathToFileURL(fts5Path).href);
    openDb = fts5.openDb;
    closeDb = fts5.closeDb;
  } catch (err) {
    log(`tier-promotion: fts5 module not loadable (${err && err.message ? err.message : err}) -- skip step`);
    return null;
  }
  if (typeof openDb !== 'function' || typeof closeDb !== 'function') {
    log('tier-promotion: fts5 module missing openDb/closeDb -- skip step');
    return null;
  }

  // Load the promotion module and dispatch all four promotions in
  // sequence. Each promotion is wrapped individually so a single
  // failure (e.g. supersession scan throws on bad data) doesn't abort
  // the others.
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    log(`tier-promotion: import failed: ${err && err.message ? err.message : err}`);
    return null;
  }

  // Two-shape contract:
  //   1. New shape: `runTierPromotion({ projectRoot, log })` (preferred,
  //      future-proof if Agent E refactors to a single entry point).
  //   2. Current shape (Agent E v1): named exports
  //      `promoteWorkingToEpisodic(db)` + `promoteEpisodicToSemantic(db)`
  //      that take a DB handle.
  if (typeof mod.runTierPromotion === 'function') {
    try {
      const out = await mod.runTierPromotion({ projectRoot: opts.projectRoot, log });
      log(`tier-promotion: ok ${JSON.stringify(out || {})}`);
      return out;
    } catch (err) {
      log(`tier-promotion: runTierPromotion failed: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  // Per-export shape -- open DB, dispatch, close.
  let db;
  try {
    db = await openDb(opts.projectRoot);
  } catch (err) {
    // No DB yet (fresh project, schema not initialised). Treat as
    // skip rather than failure -- consolidation has nothing to do.
    log(`tier-promotion: db open skipped (${err && err.message ? err.message : err})`);
    return null;
  }

  const totals = { we: null, es: null };
  try {
    if (typeof mod.promoteWorkingToEpisodic === 'function') {
      // Working->Episodic requires a session_id. When the runner was
      // invoked without one (e.g. test fixture), skip the rollup with a
      // clear log line rather than passing through Agent E's
      // "session_id required" diagnostic on every dream cycle.
      if (!opts.sessionId) {
        totals.we = { skipped: 'session_id absent' };
      } else {
        try { totals.we = mod.promoteWorkingToEpisodic(db, { session_id: opts.sessionId }); }
        catch (err) { totals.we = { error: String(err && err.message || err) }; }
      }
    }
    if (typeof mod.promoteEpisodicToSemantic === 'function') {
      try { totals.es = mod.promoteEpisodicToSemantic(db); }
      catch (err) { totals.es = { error: String(err && err.message || err) }; }
    }
    // GA real fix-wave F4: Working->Procedural was missing from the
    // dream-cycle dispatch. The function exists in tier-promotion.js
    // (per D-PILLAR-SPEC section 1) but the runner only fired We + Es,
    // leaving the Procedural tier orphaned. Wire it here.
    //
    // Source signal per spec: TaskUpdate completed events with duration
    // >= 5min + matching git commit window. This runner does NOT yet
    // have a TaskUpdate event source (event ledger lands as part of the
    // Working observation pipeline; deeper integration with TaskUpdate
    // events is queued). When no source events are available, the
    // promotion call is a clean no-op (returns { promoted: 0 } since
    // status !== 'completed' is the early-return path inside the
    // promotion function). Wiring the call here means the moment the
    // event source goes live the promotion fires automatically.
    //
    // Pattern: the runner calls promoteWorkingToProcedural with a
    // SYNTHETIC zero-shape envelope. This exercises the dispatch path,
    // returns { promoted: 0 }, and lands a log line so the wiring is
    // observable. When TaskUpdate events become available, callers can
    // pass the real envelope and promotion will fire.
    if (typeof mod.promoteWorkingToProcedural === 'function') {
      try {
        // Discover any pending TaskUpdate completed events. The
        // event source is not yet wired into the alpha runner; lookup
        // returns an empty list, in which case we exercise the
        // dispatch path with a deterministic zero-shape call so the
        // tier-promotion log line confirms the wiring is live.
        const taskEvents = discoverTaskUpdateEvents(db);
        if (taskEvents.length === 0) {
          // No-op call to confirm the dispatch path exists. The
          // function early-returns on status !== 'completed'.
          totals.wp = mod.promoteWorkingToProcedural(db, {
            status: 'noop',
            task_completed_event_window_hours: 24,
          });
        } else {
          let promotedTotal = 0;
          const errors = [];
          for (const ev of taskEvents) {
            try {
              const r = mod.promoteWorkingToProcedural(db, ev);
              promotedTotal += Number(r.promoted || 0);
              if (Array.isArray(r.errors)) errors.push(...r.errors);
            } catch (err) {
              errors.push(String(err && err.message || err));
            }
          }
          totals.wp = { promoted: promotedTotal, errors, sources: taskEvents.length };
        }
      } catch (err) {
        totals.wp = { error: String(err && err.message || err) };
      }
    }
    log(`tier-promotion: working->episodic=${JSON.stringify(totals.we)} episodic->semantic=${JSON.stringify(totals.es)} working->procedural=${JSON.stringify(totals.wp)}`);

    // GA-B1: Episodic->Semantic supersession fires D4 cascading staleness
    // BFS over the symbol graph. Wire is best-effort -- a missing graph,
    // missing entity match, or empty supersession array all skip silently.
    // The runner is a SessionEnd best-effort consolidator; staleness
    // propagation is value-add, not integrity-critical.
    const superseded = totals.es && Array.isArray(totals.es.superseded)
      ? totals.es.superseded
      : [];
    if (superseded.length > 0) {
      try {
        const wiringMod = await import('./staleness-wiring.js');
        const sum = await wiringMod.propagateStaleForSupersessions({
          projectRoot: opts.projectRoot,
          supersededEntries: superseded,
          log,
        });
        totals.staleness = sum;
        log(`staleness-wiring: superseded=${sum.superseded_count} entities=${sum.entities_resolved} nodes=${sum.nodes_propagated} flagged=${sum.flagged_total}`);
      } catch (err) {
        log(`staleness-wiring: failed (${err && err.message ? err.message : err})`);
      }
    } else {
      log('staleness-wiring: no Episodic->Semantic supersessions this cycle -- skip');
    }
  } finally {
    try { closeDb(db); } catch { /* best effort */ }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// F4 helper: discover TaskUpdate completed events for Procedural promotion.
// ---------------------------------------------------------------------------
//
// D-PILLAR-SPEC section 1 Working->Procedural promotion fires from TaskUpdate
// completed events with duration >= 5min and matching git commit window.
// The alpha runner does not yet have a dedicated TaskUpdate event source
// in the working memory ledger (events arrive via observation bodies but
// are not parsed into structured task envelopes). When the event source
// goes live, this function will return real envelopes; until then, it
// returns an empty array so the runner exercises the dispatch path
// without firing real promotions.
//
// Returns: Array<TaskUpdateEnvelope> per the contract documented in
// mcp-server/src/memory/tier-promotion.js#promoteWorkingToProcedural.
// Each envelope: { task_id, status, start_ts, end_ts, body, session_id }.

function discoverTaskUpdateEvents(_db) {
  // Alpha: zero-shape source. F4 wires the dispatch path; the source
  // table itself is queued (deeper TaskUpdate ledger integration).
  // Returning [] keeps the call path exercised + the runner's log line
  // visible without firing spurious promotions on synthetic data.
  return [];
}

// ---------------------------------------------------------------------------
// Step 2: legacy journal -> knowledge consolidation pass
// ---------------------------------------------------------------------------
//
// Pre-D1 the canonical consolidator is the Claude /consolidate slash
// command (claude/commands/consolidate.md). For non-Claude hosts the
// runner records the attempt + writes a placeholder pattern-extraction
// summary so SessionEnd has a positive trail to point at. The actual
// scan runs against `.ijfw/memory/project-journal.md`.

function safeJournalSummary() {
  try {
    const journalPath = join(stateDir, 'memory', 'project-journal.md');
    if (!existsSync(journalPath)) return { entries: 0, sessions: 0 };
    const raw = readFileSync(journalPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.startsWith('- ['));
    const sessions = new Set();
    for (const l of lines) {
      const m = l.match(/#(\d+)/);
      if (m) sessions.add(m[1]);
    }
    return { entries: lines.length, sessions: sessions.size };
  } catch {
    return { entries: 0, sessions: 0 };
  }
}

// ---------------------------------------------------------------------------
// Profile derivation (P3.1) — the cross-system profile bus SessionEnd stage.
// ---------------------------------------------------------------------------
//
// This is THE wire connecting capture -> derivation -> merge. At SessionEnd we
// read the project-local signal JSONLs that the capture layer wrote
// (<REPO_ROOT>/.ijfw/.session-style.jsonl + .session-feedback.jsonl), build the
// deriveHeuristic input, run the fallback ladder (deriveProfile: heuristic floor
// + optional local-LLM dialectic, NEVER silent cloud), and fold the resulting
// ProfileDelta into the ONE user-global profile via mergeAndWrite under the
// global profile lock.
//
// Best-effort + idempotent: a missing signal file yields a clean no-op delta
// (never throws); a failure is LOGGED (the audit flagged a swallowed-error
// class — we surface it) and the dream cycle continues.

/**
 * Read a JSONL signal file into an array of parsed rows. Missing file -> [].
 * Corrupt lines are skipped (the rest still parse). Never throws.
 */
function readJsonlSignals(filePath) {
  const rows = [];
  try {
    if (!existsSync(filePath)) return rows;
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
    }
  } catch {
    // unreadable file -> treat as no signal (best-effort)
  }
  return rows;
}

// ---------------------------------------------------------------------------
// FIX 1 (C1/C2/M3) — per-stream consumption CURSOR (one-fold-per-row).
//
// The capture layer only ever APPENDS to .session-style.jsonl /
// .session-feedback.jsonl. Before this fix, profileDeriveStage re-read the WHOLE
// file every dream cycle, so a row was folded again on cycle 2,3,…N: its
// evidence_count inflated (false "confirmed" at >=5) and the per-session
// anti-drift guarantees were defeated because the same row re-amplified. The fix
// is a persisted CURSOR (safer than truncation — no data loss on merge failure):
// each cycle folds ONLY rows newer than the cursor, and the cursor advances ONLY
// after mergeAndWrite succeeds. If the merge fails, the cursor does NOT move, so
// the rows are retried next cycle (idempotency holds because the re-read is then
// benign — the cursor makes a re-fold impossible once the merge has committed).
//
// Cursor key per row: a [ts, tiebreaker] pair. Rows are appended chronologically,
// so "newer than the cursor" = ts strictly greater, OR ts equal AND the
// tiebreaker sorts strictly after the cursor's tiebreaker. The tiebreaker is the
// session_id for style rows and a stable content hash for feedback rows (feedback
// rows carry no id), so two rows that share a ts are still consumed exactly once.
// ---------------------------------------------------------------------------

const CURSOR_FILE = '.profile-derive-cursor.json';

function cursorPath(ijfwDir) {
  return join(ijfwDir, CURSOR_FILE);
}

function readCursor(ijfwDir) {
  try {
    const raw = readFileSync(cursorPath(ijfwDir), 'utf8');
    const c = JSON.parse(raw);
    if (c && typeof c === 'object') return c;
  } catch {
    // missing/corrupt cursor -> start from the beginning (fold everything once).
  }
  return {};
}

function writeCursor(ijfwDir, cursor) {
  // Best-effort atomic-ish write: tmp + rename in the same dir. A failed cursor
  // write must NOT throw out of the stage (the merge already committed); worst
  // case the next cycle re-reads already-consumed rows — which is exactly the
  // bug we are fixing, so we log it at the call site when it happens.
  try {
    if (!existsSync(ijfwDir)) mkdirSync(ijfwDir, { recursive: true });
    const tmp = `${cursorPath(ijfwDir)}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cursor), 'utf8');
    renameSync(tmp, cursorPath(ijfwDir)); // atomic replace within the same dir
    return true;
  } catch {
    return false;
  }
}

/** Numeric epoch for a row ts (ISO string or epoch number). NaN -> -Infinity. */
function rowTsMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : -Infinity;
}

/** Stable, dependency-free content hash for a feedback row tiebreaker. */
function feedbackKey(row) {
  const s = JSON.stringify([row && row.kind, row && row.phrase, row && row.context]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/** Per-row cursor tiebreaker for the S4 edit-delta stream (proposed+committed hash). */
function editKey(row) {
  const s = JSON.stringify([
    row && row.session_id, row && row.proposed_hash, row && row.committed_hash, row && row.outcome,
  ]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/** Session id of a signal row, tolerating both wire spellings. */
function rowSessionId(row) {
  return (row && (row.session_id || row.sessionId)) || null;
}

/**
 * Harvest the GROUNDED preference gold from the currently-stored global profile:
 * every preference/correction atom that carries an edit-delta citation (value.
 * cited.committed_hash/proposed_hash). These are the user's diff-grounded "real"
 * preferences and seed the precision gate's held-out gold so a feedback slug can
 * corroborate against historical grounded evidence (not just this cycle's). Best-
 * effort: any read error -> empty gold (the gate is fail-closed on empty gold).
 * `readFn` is injectable for test isolation; defaults to the store reader.
 */
function harvestGroundedGold(readFn) {
  const read = typeof readFn === 'function' ? readFn : profileReadProfile;
  const out = [];
  try {
    const r = read();
    const dialectic = r && r.ok && r.profile && r.profile.global
      ? r.profile.global.dialectic : null;
    if (!Array.isArray(dialectic)) return out;
    for (const inf of dialectic) {
      if (!inf || (inf.kind !== 'preference' && inf.kind !== 'correction')) continue;
      const v = inf.value;
      const grounded = v && typeof v === 'object' && v.cited && typeof v.cited === 'object'
        && (v.cited.committed_hash || v.cited.proposed_hash);
      if (!grounded) continue;
      // Use the same phrase a brief would render: value.phrase if present, else
      // the subject with the scope prefix stripped (scopeKey::citedSlug).
      let phrase = '';
      if (typeof v.phrase === 'string' && v.phrase.trim()) phrase = v.phrase.trim();
      else {
        const subject = String(inf.subject || '');
        const ci = subject.indexOf('::');
        phrase = ci >= 0 ? subject.slice(ci + 2) : subject;
      }
      if (phrase) out.push(phrase);
    }
  } catch {
    // best-effort: a corrupt/absent profile yields no extra gold (fail-closed).
  }
  return out;
}

/**
 * Split `rows` into the UNCONSUMED tail (strictly after `cursor`) and the new
 * cursor that covers ALL of `rows`. `keyOf(row)` returns the per-row tiebreaker.
 * A row is unconsumed when its [ts,key] is strictly greater than the cursor's.
 */
function splitByCursor(rows, cursor, keyOf) {
  const curTs = cursor && Number.isFinite(rowTsMs(cursor.ts)) ? rowTsMs(cursor.ts) : -Infinity;
  const curKey = cursor && typeof cursor.key === 'string' ? cursor.key : '';
  const fresh = [];
  let maxTs = curTs;
  let maxKey = curKey;
  for (const row of rows) {
    const ts = rowTsMs(row && row.ts);
    const key = String(keyOf(row) || '');
    const isNew = ts > curTs || (ts === curTs && key > curKey);
    if (isNew) fresh.push(row);
    // The advanced cursor is the MAX [ts,key] over ALL rows present this cycle,
    // so even an out-of-order older row never drags the cursor backward.
    if (ts > maxTs || (ts === maxTs && key > maxKey)) { maxTs = ts; maxKey = key; }
  }
  const nextCursor = (Number.isFinite(maxTs) && maxTs > -Infinity)
    ? { ts: new Date(maxTs).toISOString(), key: maxKey }
    : (cursor && cursor.ts ? cursor : null);
  return { fresh, nextCursor };
}

/**
 * profileDeriveStage(params) — read signals -> deriveProfile -> mergeAndWrite.
 * Exported so the integration test can exercise the read->derive->merge wire
 * without spawning the whole runner. Returns the mergeAndWrite result shape
 * `{ ok, code?, message? }`; { ok:true } on a clean no-op (no signal files).
 *
 * @param {object} params
 *   @param {string}   params.projectRoot   REPO_ROOT holding .ijfw/<signals>
 *   @param {string}   [params.host]
 *   @param {string}   [params.sessionId]
 *   @param {Function} [params.log]          best-effort logger (failures LOGGED)
 *   @param {string}   [params.lockPath]     global-lock override (test isolation)
 *   @param {object}   [params.env]          env for the derive ladder
 *   @param {Function} [params._mergeAndWrite] inject the merge (tests)
 *   @param {Function} [params._localTransport] inject the dialectic local transport (tests)
 */
export async function profileDeriveStage(params = {}) {
  const root = params.projectRoot;
  // DEFECT 1 fix (live-path): default `env` to the REAL process env when a caller
  // omits it. The production dream entry (runDream's profile_derive stage) used to
  // call this WITHOUT env, so computeIdentity ran over an empty env -> the
  // ambiguous 'UNKNOWN' identity, which can NEVER equal the identity capture
  // stamped from the real process.env -> EVERY style row was rejected as an
  // identity-mismatch and the global profile was never written. Defaulting here
  // makes any env-omitting caller resolve THIS machine's real identity (correct),
  // while PRESERVING the security property: a row stamped by a different
  // machine/user still won't match this machine's identity.
  const env = params.env || process.env;
  const logFn = typeof params.log === 'function' ? params.log : () => {};
  const mergeFn = typeof params._mergeAndWrite === 'function'
    ? params._mergeAndWrite : profileMergeAndWrite;
  if (!root) {
    logFn('profile_derive: no projectRoot -> skip');
    return { ok: true, skipped: 'no-project-root' };
  }

  const ijfwDir = join(root, '.ijfw');
  const stylePath = join(ijfwDir, '.session-style.jsonl');
  const feedbackPath = join(ijfwDir, '.session-feedback.jsonl');
  const editsPath = join(ijfwDir, '.session-edits.jsonl');

  const allStyle = readJsonlSignals(stylePath);    // RAW per-session wire records
  const allFeedback = readJsonlSignals(feedbackPath); // {ts,kind,phrase,context}
  const allEdits = readJsonlSignals(editsPath);    // S4 edit-delta evidence rows

  if (allStyle.length === 0 && allFeedback.length === 0 && allEdits.length === 0) {
    // Clean no-op: no signals captured this cycle. Do not even touch the global
    // profile — an empty delta would just be a needless lock+write.
    logFn('profile_derive: no signals -> no-op');
    return { ok: true, skipped: 'no-signals' };
  }

  // FIX 1 (C1/C2/M3) — CONSUME EACH ROW EXACTLY ONCE. Read the per-stream cursor
  // and fold ONLY rows newer than it. The cursor is advanced (persisted) ONLY
  // after the merge commits, below — on merge failure the rows are retried next
  // cycle. This is what stops evidence_count inflating + anti-drift being
  // defeated by re-folding the same append-only rows every dream cycle.
  const cursor = readCursor(ijfwDir);
  const styleSplit = splitByCursor(allStyle, cursor.style, (r) => (r && (r.session_id || r.sessionId)) || '');
  const feedbackSplit = splitByCursor(allFeedback, cursor.feedback, feedbackKey);
  const editsSplit = splitByCursor(allEdits, cursor.edits, editKey);
  const rawStyle = styleSplit.fresh;
  const rawFeedback = feedbackSplit.fresh;
  const rawEdits = editsSplit.fresh;

  if (rawStyle.length === 0 && rawFeedback.length === 0 && rawEdits.length === 0) {
    // All rows already consumed by a prior (committed) cycle. No-op — and DO NOT
    // re-fold. This is the load-bearing one-fold-per-row guarantee.
    logFn('profile_derive: all rows already consumed (cursor up to date) -> no-op');
    return { ok: true, skipped: 'cursor-up-to-date' };
  }

  // SEAM 2 + FIX 3 (HIGH-3) — FAIL-CLOSED global eligibility, identity-bound.
  // The capture layer tags every wire record with eligibility gates the global
  // merge MUST honor, or the design's security guarantees are dead on arrival:
  //   - global_eligible must be the STRICT boolean `true`. Absent / "false" / 0
  //     / any non-boolean => INELIGIBLE (fail-closed). A hand-written or injected
  //     JSONL row that omits or forges the flag must NOT reach the global merge.
  //   - identity must EQUAL computeIdentity({env}) of THIS machine. We never
  //     trust the row's self-asserted identity for cross-machine promotion; a
  //     foreign / missing / mismatched identity is excluded (a build agent's or
  //     another user's row can't poison the cross-machine profile).
  //   - profile_influenced === true => a profile brief was injected into that
  //     session, so re-deriving from it would let the profile reinforce itself.
  // Every exclusion is COUNTED + LOGGED (the audit flagged a swallowed-error
  // class — never silent).
  const selfIdentity = computeIdentity({ env }).identity;
  let excludedIneligible = 0;
  let excludedIdentity = 0;
  let excludedInfluenced = 0;
  // SELF-CORROBORATION BARRIER (HIGH-2). Every session that had a profile brief
  // injected (profile_influenced === true) is QUARANTINED: nothing derived from
  // its output may re-corroborate the very preference it was primed with. The set
  // is built from BOTH the style and edit streams (the two that carry the flag)
  // so it is complete; feedback rows are then gated on it by session id below.
  const quarantinedSessions = new Set();
  const eligibleStyle = [];
  for (const row of rawStyle) {
    const r = row && typeof row === 'object' ? row : {};
    if (r.profile_influenced === true) {
      excludedInfluenced += 1;
      const sid = rowSessionId(r);
      if (sid) quarantinedSessions.add(sid);
      continue;
    }
    if (r.global_eligible !== true) { excludedIneligible += 1; continue; } // fail-closed
    if (r.identity !== selfIdentity) { excludedIdentity += 1; continue; }  // identity-bound
    eligibleStyle.push(r);
  }

  // EDIT-DELTA stream (S4 — the CORRECTION LOOP). The edit rows carry the SAME
  // eligibility fields the style rows do (capture.js stamps profile_influenced /
  // global_eligible / identity), so we gate them IDENTICALLY and fail-closed. An
  // edit landed in a profile-influenced session is excluded (and quarantines that
  // session) so an injected preference can never re-corroborate itself via a diff.
  const eligibleEdits = [];
  for (const row of rawEdits) {
    const r = row && typeof row === 'object' ? row : {};
    if (r.profile_influenced === true) {
      excludedInfluenced += 1;
      const sid = rowSessionId(r);
      if (sid) quarantinedSessions.add(sid);
      continue;
    }
    if (r.global_eligible !== true) { excludedIneligible += 1; continue; } // fail-closed
    if (r.identity !== selfIdentity) { excludedIdentity += 1; continue; }  // identity-bound
    eligibleEdits.push(r);
  }

  // FEEDBACK stream. HIGH-2/MED-5 fix: feedback rows now carry session_id +
  // profile_influenced (the pre-prompt writer stamps both). Gate them the SAME
  // fail-closed way as style/edit so a CI/shared-runner or a profile-primed
  // session can never promote: exclude a row that is itself profile_influenced OR
  // whose session is in the quarantine set built above. A row WITHOUT a usable
  // session id is treated as eligible only when it is not self-flagged (legacy
  // wire shape) — the cross-session corroboration barrier (evidence_count >= 3)
  // remains the backstop for any such legacy row.
  let excludedFeedbackInfluenced = 0;
  const eligibleFeedback = [];
  for (const row of rawFeedback) {
    const r = row && typeof row === 'object' ? row : {};
    if (r.profile_influenced === true) { excludedFeedbackInfluenced += 1; continue; }
    const sid = rowSessionId(r);
    if (sid && quarantinedSessions.has(sid)) { excludedFeedbackInfluenced += 1; continue; }
    eligibleFeedback.push(r);
  }
  const feedback = eligibleFeedback;

  if (excludedIneligible > 0 || excludedIdentity > 0 || excludedInfluenced > 0
      || excludedFeedbackInfluenced > 0) {
    logFn(`profile_derive: excluded ${excludedIneligible} non-eligible (global_eligible!==true) + `
      + `${excludedIdentity} identity-mismatch + ${excludedInfluenced} profile_influenced style/edit rows + `
      + `${excludedFeedbackInfluenced} self-corroborating feedback rows (profile_influenced or quarantined session) `
      + 'from the global merge');
  }

  // SEAM 1 (field-name mismatch) — the RAW wire records carry `emoji_rate` and
  // `turn_cadence_s`; `deriveStyle` reads `emoji_per_msg` and
  // `turn_cadence_per_min`. capture.js exports `toDeriveMeta` to bridge that
  // unit/name gap. Passing the RAW row straight to derivation silently zeroes
  // the emoji_use + energy axes (deriveStyle sees no signal for them). Map EVERY
  // eligible row through toDeriveMeta so BOTH the heuristic floor (`metadata`,
  // most-recent) AND the dialectic corroboration (`style` array) get the exact
  // shape deriveStyle consumes: avg_msg_chars, emoji_per_msg, code_block_ratio,
  // formality_markers, turn_cadence_per_min.
  const style = eligibleStyle.map((r) => toDeriveMeta(r));

  // The session ordinal feeds the merge's NON-ADJACENCY gate: it must be a
  // monotonic, per-cycle index so 3 corroborations from 3 spread-out cycles carry
  // 3 distinct (gap-bearing) ordinals, while 3 edits in ONE cycle share one
  // ordinal (cannot self-confirm). Priority: an explicit caller ordinal (tests /
  // a future scheduler that knows the true session index) wins; otherwise a
  // persisted monotonic counter on the cursor. We STEP BY 2 (not 1) per cycle so
  // auto-derived ordinals are NON-ADJACENT by construction: each dream cycle is a
  // distinct SessionEnd separated from the next, so the merge's hasNonAdjacentSpread
  // (which demands a gap > 1) correctly sees real spread rather than rejecting a
  // genuine 3-cycle corroboration as a back-to-back burst. (A single cycle's edits
  // still share ONE ordinal, so an in-session burst can never self-confirm.)
  // Declared here (before advanceCursor) so the all-excluded no-op path records it.
  const sessionOrdinal = Number.isFinite(Number(params.sessionOrdinal))
    ? Number(params.sessionOrdinal)
    : (Number.isFinite(Number(cursor.editOrdinal)) ? Number(cursor.editOrdinal) + 2 : 0);

  // FIX 1 — advance BOTH stream cursors to cover every row READ this cycle (the
  // splits computed nextCursor over ALL rows present, including excluded ones).
  // Persisted only when called; called after the merge commits, OR on a terminal
  // no-op where the fresh rows were genuinely consumed (all excluded). Returns
  // the cursor-write success so a failed write is observable (logged by caller).
  const advanceCursor = () => {
    const next = { ...cursor };
    if (styleSplit.nextCursor) next.style = styleSplit.nextCursor;
    if (feedbackSplit.nextCursor) next.feedback = feedbackSplit.nextCursor;
    if (editsSplit.nextCursor) next.edits = editsSplit.nextCursor;
    // Persist the per-cycle ordinal ONLY when this cycle actually derived an
    // ordinal AND it advanced the counter (so the next edit-bearing cycle gets a
    // distinct, larger ordinal -> the merge's non-adjacency gate sees real spread,
    // not a self-asserted burst). A caller-supplied ordinal is recorded as-is.
    if (Number.isFinite(sessionOrdinal)) {
      const prev = Number.isFinite(Number(cursor.editOrdinal)) ? Number(cursor.editOrdinal) : -Infinity;
      next.editOrdinal = sessionOrdinal > prev ? sessionOrdinal : prev;
    }
    return writeCursor(ijfwDir, next);
  };

  if (style.length === 0 && feedback.length === 0 && eligibleEdits.length === 0) {
    // Every fresh row was excluded (non-eligible / identity-mismatch / influenced)
    // and there is no eligible feedback or edit — a clean no-op empty delta, never
    // a throw. The excluded rows WERE consumed this cycle, so advance the cursor:
    // they must not be re-examined (and re-logged) on every future cycle. No merge
    // ran, so no global state changed — advancing here loses nothing.
    if (!advanceCursor()) {
      logFn('profile_derive: WARNING cursor write failed after all-excluded no-op (rows may be re-examined)');
    }
    logFn('profile_derive: all rows excluded and no eligible feedback/edits -> no-op');
    return { ok: true, skipped: 'all-excluded' };
  }

  // The heuristic floor reads `metadata` for the CURRENT-session style fold; we
  // use the MOST-RECENT eligible (mapped) row as that session's metadata (the
  // full mapped `style` array feeds the dialectic's cross-session corroboration).
  const metadata = style.length ? style[style.length - 1] : undefined;

  // S4 — thread the edit-delta evidence + a monotonic session ordinal into the
  // derive bundle. deriveHeuristic maps eligible edit-after rows to grounded
  // `correction` inferences (deriveEditPreferences) and routes accept/edit-after
  // into expertise (editOutcomes); the merge's admission gate then enforces
  // non-adjacency (>= 3 spread-out sessions) + contradiction-flips-with-history.
  // The ordinal is derived from the row ts ordering so "3 corroborations across
  // 3 spread-out sessions" (confirm) is distinguishable from "3 edits back to
  // back" (do NOT confirm) WITHOUT trusting a self-asserted ordinal.
  const edits = eligibleEdits;

  const signals = {
    metadata,
    style,
    feedback,
    edits,
    sessionId: params.sessionId,
    sessionOrdinal,
    host: params.host,
  };

  let delta;
  try {
    delta = await deriveProfile(signals, {
      env,
      log: (m) => logFn(`profile_derive: ${m}`),
      _localTransport: params._localTransport,
      _cloudTransport: params._cloudTransport,
    });
  } catch (err) {
    // deriveProfile is contracted never to throw, but defend anyway: surface +
    // continue rather than crash the dream cycle.
    logFn(`profile_derive: derive failed (${err && err.message ? err.message : err})`);
    return { ok: false, code: 'EDERIVE', message: String(err && err.message ? err.message : err) };
  }

  // S2 PRECISION GATE (the dead-code fix) — STAMP `precision_eligible` on every
  // derived preference/correction slug BEFORE it can be merged + served. The gold
  // is the user's OWN edit-delta-grounded corrections (this cycle's delta + any
  // already-confirmed grounded corrections on the stored profile), so a slug only
  // clears when it semantically matches a diff-grounded preference. A noise slug
  // ("not to deal with this garbage") matches nothing grounded -> stamped false ->
  // can never reach the brief. Fail-closed + never throws (see precision-stamp).
  try {
    const grounded = harvestGroundedGold(params._readProfile);
    stampPrecisionEligible(delta, { goldPhrases: grounded });
  } catch (err) {
    // A stamping failure must NOT crash the cycle; the snapshot gate is itself
    // fail-closed (absent flag => held back), so an unstamped delta degrades to
    // "nothing injects" — safe, not silently permissive.
    logFn(`profile_derive: precision stamp degraded (${err && err.message ? err.message : err})`);
  }

  const mergeOpts = {};
  if (params.lockPath) mergeOpts.lockPath = params.lockPath;
  let res;
  try {
    res = await mergeFn(delta, mergeOpts);
  } catch (err) {
    logFn(`profile_derive: merge threw (${err && err.message ? err.message : err})`);
    return { ok: false, code: 'EMERGE', message: String(err && err.message ? err.message : err) };
  }
  if (!res || !res.ok) {
    // The audit found a swallowed-error class bug — do NOT repeat it. LOG the
    // failure (with code) and surface it; the caller (stage runner) continues.
    // FIX 1 — the cursor is NOT advanced on a failed merge, so the same rows are
    // retried next cycle (no data loss; re-read is benign because nothing was
    // committed). This is the whole reason a cursor is safer than truncation.
    logFn(`profile_derive: merge failed code=${res && res.code} msg=${res && res.message}`);
    return res || { ok: false, code: 'EMERGE' };
  }

  // FIX 1 — the merge COMMITTED. Advance the cursor so these rows are NEVER
  // folded again on a subsequent cycle (the one-fold-per-row guarantee). A cursor
  // write failure is logged but does not fail the stage — the merge already
  // succeeded; worst case the next cycle re-reads (idempotency degrades to the
  // old behaviour only for this window, and only if the FS write failed).
  if (!advanceCursor()) {
    logFn('profile_derive: WARNING cursor write failed after a committed merge (rows may be re-folded next cycle)');
  }
  logFn(`profile_derive: merged delta (style=${style.length} feedback=${feedback.length} inferences=${(delta.inferences || []).length})`);
  return res;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function runDream() {
  try {
    // M4 hardening: lift each step into a stage-runner stage so a failure
    // in one stage logs + continues; downstream stages still execute.
    // State file records each stage's status independently.
    const summary = await runStages(opts.projectRoot, [
      {
        name: 'journal_summary',
        run: async () => {
          const s = safeJournalSummary();
          log(`journal: ${s.entries} entries across ${s.sessions} sessions`);
          return s;
        },
      },
      {
        name: 'tier_promotion',
        run: async () => {
          const out = await runTierPromotion();
          return out || { skipped: 'no-op' };
        },
      },
      {
        name: 'wiki-compile',
        run: async () => {
          let db;
          try {
            db = await openDb(opts.projectRoot);
          } catch (err) {
            log(`wiki-compile: db open skipped (${err && err.message ? err.message : err})`);
            return { skipped: 'db-unavailable' };
          }
          try {
            const out = await runDreamCycle({ db, repoRoot: opts.projectRoot, cycleId: `${Date.now()}-wiki` });
            log(`wiki-compile: processed=${out.processed} pages=${out.pagesCompiled} facts=${out.factsInserted} budgetExhausted=${out.budgetExhausted}`);
            return out;
          } finally {
            try { db.close(); } catch { /* best effort */ }
          }
        },
      },
      {
        // P3.1 — the cross-system profile bus. Read SessionEnd signal JSONLs ->
        // deriveProfile (heuristic floor + optional local dialectic) ->
        // mergeAndWrite into the user-global profile under the global lock.
        // Best-effort: a failure is recorded in `extras.error` (surfaced by the
        // stage runner) and the cycle continues; it never throws out.
        name: 'profile_derive',
        run: async () => {
          const res = await profileDeriveStage({
            projectRoot: opts.projectRoot,
            host: opts.host,
            sessionId: opts.sessionId,
            // DEFECT 1 fix: pass the REAL process env so the identity-bound
            // eligibility gate computes THIS machine's identity (matching the
            // identity capture stamped at flush time). profileDeriveStage now
            // also defaults env to process.env when omitted, but we pass it
            // explicitly here so the production path is self-documenting.
            env: process.env,
            log,
          });
          if (res && res.skipped) return { skipped: res.skipped };
          if (!res || !res.ok) {
            return { error: `profile merge failed: ${res && res.code ? res.code : 'unknown'}` };
          }
          return { ok: true };
        },
      },
      {
        name: 'mark_completed_legacy',
        run: async () => {
          // Preserve the legacy 4h cooldown marker so any downstream code
          // still reading .dream-state.json continues to work.
          const ok = markCompleted(stateDir);
          log(`mark-completed: ${ok ? 'ok' : 'failed (non-fatal)'}`);
          return { ok };
        },
      },
    ]);
    log(`end: completed=${summary.completed.length} failed=${summary.failed.length}`);
  } catch (err) {
    // Defensive: any unexpected throw lands in the log but never
    // surfaces a non-zero exit to the parent hook.
    try {
      log(`end: caught ${err && err.message ? err.message : err}`);
    } catch {
      // give up silently
    }
  } finally {
    process.exit(0);
  }
}

// Run the dream cycle ONLY when this module is the process entry point. When
// imported (e.g. by the profile_derive stage test), the exported helpers are
// available without triggering the CLI driver / process.exit.
if (IS_MAIN) {
  runDream();
}
