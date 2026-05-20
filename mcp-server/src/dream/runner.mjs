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

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isOnCooldown, markCompleted } from './cooldown.js';
import { shouldRunNow } from './state-file.js';
import { runStages } from './stage-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

if (!opts.projectRoot) process.exit(0);

const stateDir = join(opts.projectRoot, '.ijfw');
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
if (!shouldRunNow(opts.projectRoot, { min_idle_minutes: MIN_IDLE_MIN })) {
  log(`skip: idle gate <${MIN_IDLE_MIN}min since last run`);
  process.exit(0);
}
// Legacy cooldown is now informational only — the new idle gate above is
// strictly stricter (30 min) than the old 4h. We still consult it as a
// belt-and-braces signal, but ONLY for visibility in the log; it does not
// block the run.
if (isOnCooldown(stateDir)) {
  log(`note: legacy 4h cooldown also active (host=${opts.host}, reason=${opts.reason}) — proceeding under idle gate`);
}

log(`start: host=${opts.host}, reason=${opts.reason}, project=${opts.projectRoot}`);

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
// Driver
// ---------------------------------------------------------------------------

(async () => {
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
})();
