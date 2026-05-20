/**
 * recovery/truncation.js — v1.5.0 T20: subagent truncation detection +
 * recovery against the T4 intent-journal + T5 per-subagent event stream.
 *
 * ROLES:
 *   * `detectTruncation({events, journal, expectedTerminalVerb})` — pure
 *     classification of a subagent's event stream + journal state. Returns
 *     `{ truncated:boolean, reason:string }`. The "tell" signals (in
 *     priority order, per T19's reporter contract):
 *       1. `events` ends with `outcome:'error'`            → truncated:'error-terminated'
 *       2. `events` is empty AND `journal` has an open
 *          begin (begin without commit)                    → truncated:'no-events-open-begin'
 *       3. last event predates the wave's expected
 *          terminal verb (e.g. `subagent.post-done`)       → truncated:'missing-terminal'
 *       4. journal has any begin-without-commit
 *          regardless of event stream end                  → truncated:'open-partial'
 *       5. else                                            → truncated:false (clean)
 *
 *   * `recoverSubagent({projectRoot, waveId, subId, sinceVerbId})` — calls
 *     `query('state.replay', { sinceVerbId })` which (per T4) snapshot-rolls-
 *     back overwrite-verb partials + seals append-verb partials. Returns
 *     `{ recovered:boolean, replayResult, verdict, reason }`.
 *
 *   * `measureTruncationRate({ fixtures, runOne })` — iterates a corpus of
 *     fixtures, runs the recovery routine against each via `runOne`, and
 *     returns `{ corpusSize, truncatedCount, recoveredCount, unrecoveredCount,
 *     ratePostRecovery, baselineRate, byCategory[] }`. The "rate" we publish
 *     is the FRACTION OF FIXTURES WHERE A TRUNCATION OCCURRED AND RECOVERY
 *     COULD NOT RESTORE THE EXPECTED FINAL STATE — i.e. the truncation rate
 *     that SURVIVES recovery. Clean fixtures (no truncation injected) are
 *     part of the denominator because they prove recovery does not corrupt
 *     non-truncated runs.
 *
 *   * `writeRateArtifact(projectRoot, result)` — atomically persists the
 *     measurement to `<projectRoot>/.ijfw/telemetry/truncation-rate.json`,
 *     fitting the T21 convergence-telemetry directory convention.
 *
 * NO PRODUCTION DEPENDENCIES; ESM; Node >=18.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { writeAtomic } from '../lib/atomic-io.js';
import { query } from '../orchestrator/state-sdk.js';

// -- Constants ------------------------------------------------------------

/**
 * Brief-locked threshold (BUILD-PLAN T20): the measured truncation rate that
 * survives recovery MUST be at or below this fraction to pass. Halves the
 * documented 62% baseline (see PLAN-CROSS-AUDIT-ADJUDICATION row M6).
 */
export const TRUNCATION_RATE_THRESHOLD = 0.31;

/**
 * Documented v1.4.x truncation-rate baseline (the rate WITHOUT this T20
 * recovery layer). Published so the artifact is self-describing — anyone
 * reading `.ijfw/telemetry/truncation-rate.json` can compute the improvement
 * factor against this number.
 */
export const TRUNCATION_BASELINE_RATE = 0.62;

/** Default expected terminal verb for a subagent's event stream. */
export const DEFAULT_TERMINAL_VERB = 'subagent.post-done';

// -- Detection -----------------------------------------------------------

/**
 * Classify a subagent's event stream + journal as truncated-or-not.
 *
 * @param {object} args
 * @param {object[]} args.events                 the event stream (T5 envelope shape)
 * @param {object[]} [args.journal]              intent-journal records visible to recovery
 * @param {string} [args.expectedTerminalVerb]   wave's expected terminal verb
 *                                               (default `subagent.post-done`)
 * @returns {{truncated: false|string, reason: string, lastEvent: object|null}}
 */
export function detectTruncation({
  events, journal, expectedTerminalVerb,
} = {}) {
  const ev = Array.isArray(events) ? events : [];
  const j = Array.isArray(journal) ? journal : [];
  const terminal = typeof expectedTerminalVerb === 'string' && expectedTerminalVerb
    ? expectedTerminalVerb
    : DEFAULT_TERMINAL_VERB;

  const lastEvent = ev.length > 0 ? ev[ev.length - 1] : null;

  // Build a quick view of journal partial-vs-committed.
  const commits = new Set();
  const begins = new Map();
  for (const r of j) {
    if (!r || typeof r.verbId !== 'string') continue;
    if (r.phase === 'commit') commits.add(r.verbId);
    else if (r.phase === 'begin') begins.set(r.verbId, r);
  }
  const openPartials = [];
  for (const [verbId, beginRec] of begins) {
    if (!commits.has(verbId)) openPartials.push(beginRec);
  }

  // 1. outcome:'error' tail — T19 contract: the subagent's stream ending
  //    with an error verb is the canonical truncation tell.
  if (lastEvent && lastEvent.outcome === 'error') {
    return { truncated: 'error-terminated', reason: `last event outcome='error' (verb=${lastEvent.verb})`, lastEvent };
  }

  // 2. No events at all BUT journal carries an open begin → subagent
  //    started a mutating verb and never emitted (truncated before tap).
  if (ev.length === 0 && openPartials.length > 0) {
    return {
      truncated: 'no-events-open-begin',
      reason: `no events, ${openPartials.length} open begin(s) in journal`,
      lastEvent: null,
    };
  }

  // 3. Last event is not the expected terminal verb. We accept either an
  //    exact terminal-verb match OR an outcome marker explicitly indicating
  //    a clean exit ('ok' with the terminal verb). Anything else with an
  //    open partial OR with no terminal at all is treated as truncated.
  const lastIsTerminal = lastEvent && lastEvent.verb === terminal
    && (lastEvent.outcome === 'ok' || lastEvent.outcome === 'advisory');

  if (!lastIsTerminal && openPartials.length > 0) {
    return {
      truncated: 'open-partial',
      reason: `open begin without commit (${openPartials.length}) and no terminal verb`,
      lastEvent,
    };
  }

  if (!lastIsTerminal && ev.length > 0) {
    return {
      truncated: 'missing-terminal',
      reason: `last event verb='${lastEvent.verb}' (expected terminal '${terminal}')`,
      lastEvent,
    };
  }

  // 4. Clean: last event is the expected terminal AND no open partials.
  if (openPartials.length > 0) {
    // Edge: terminal verb fired but a partial mutating verb never committed.
    // Treat as truncated — recovery should still seal/rollback the partial.
    return {
      truncated: 'open-partial',
      reason: `terminal verb emitted but ${openPartials.length} open begin(s) remain`,
      lastEvent,
    };
  }

  return { truncated: false, reason: 'clean exit', lastEvent };
}

// -- Recovery ------------------------------------------------------------

/**
 * Apply T4's `state.replay` to recover a truncated subagent. Snapshot-rolls
 * back overwrite-verb partials; seals append-verb partials in place; leaves
 * already-committed verbs untouched.
 *
 * @param {object} args
 * @param {string} args.projectRoot   the wave's project root
 * @param {string} args.waveId        the truncated subagent's wave
 * @param {string} args.subId         the truncated subagent's id
 * @param {string} [args.sinceVerbId] scope replay to verbs at/after this id
 *                                    (default — full journal)
 * @returns {Promise<{recovered:boolean, replayResult:object, reason:string}>}
 */
export async function recoverSubagent({
  projectRoot, waveId, subId, sinceVerbId,
} = {}) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw new Error('recovery/truncation: projectRoot required');
  }
  const payload = {};
  if (typeof sinceVerbId === 'string' && sinceVerbId) payload.sinceVerbId = sinceVerbId;
  const ctx = { projectRoot, subagentId: subId };
  let replayResult;
  try {
    replayResult = await query('state.replay', payload, ctx);
  } catch (err) {
    return {
      recovered: false,
      replayResult: null,
      reason: `replay threw: ${err?.message || err}`,
      waveId,
      subId,
    };
  }
  const sealed = Array.isArray(replayResult?.sealed) ? replayResult.sealed.length : 0;
  const rolledBack = Array.isArray(replayResult?.rolledBack) ? replayResult.rolledBack.length : 0;
  const skipped = Array.isArray(replayResult?.skipped) ? replayResult.skipped.length : 0;
  return {
    recovered: replayResult?.ok === true,
    replayResult,
    reason: `replay ok=${replayResult?.ok} sealed=${sealed} rolledBack=${rolledBack} skipped=${skipped}`,
    waveId,
    subId,
  };
}

// -- Corpus harness ------------------------------------------------------

/**
 * Discover fixture subdirectories under a corpus root. Every subdir must
 * carry a `meta.json`; subdirs without one are skipped (allows README files /
 * stray dirs to coexist).
 *
 * @param {string} corpusDir
 * @returns {{id:string, dir:string, meta:object}[]}
 */
export function listFixtures(corpusDir) {
  if (!existsSync(corpusDir)) return [];
  const out = [];
  for (const name of readdirSync(corpusDir).sort()) {
    const dir = join(corpusDir, name);
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); }
    catch { continue; }
    out.push({ id: name, dir, meta });
  }
  return out;
}

/**
 * Run the recovery routine across a corpus + return a measurement.
 *
 * The caller supplies `runOne(fixture)` — a function that materialises the
 * fixture into a real temp project, invokes `recoverSubagent`, and returns
 * `{ truncated, recovered, expectedFinalStateMatches, category }`. We keep
 * runOne pluggable so the test can use real `query()` while a future caller
 * could plug in a different I/O backend without changing this aggregator.
 *
 * @param {object} args
 * @param {{id:string, meta:object}[]} args.fixtures
 * @param {(fixture:object) => Promise<{truncated:string|false, recovered:boolean, expectedFinalStateMatches:boolean, category:string}>} args.runOne
 * @returns {Promise<{corpusSize, truncatedCount, recoveredCount,
 *                    unrecoveredCount, ratePostRecovery, baselineRate,
 *                    byCategory:Array, fixtures:Array}>}
 */
export async function measureTruncationRate({ fixtures, runOne }) {
  if (!Array.isArray(fixtures)) throw new Error('measureTruncationRate: fixtures[] required');
  if (typeof runOne !== 'function') throw new Error('measureTruncationRate: runOne fn required');

  const perFixture = [];
  const byCategoryMap = new Map();
  for (const fx of fixtures) {
    const r = await runOne(fx);
    const row = {
      id: fx.id,
      category: r.category || fx.meta?.category || 'unknown',
      truncated: r.truncated,
      recovered: r.recovered,
      expectedFinalStateMatches: r.expectedFinalStateMatches,
    };
    perFixture.push(row);
    const key = row.category;
    if (!byCategoryMap.has(key)) {
      byCategoryMap.set(key, {
        category: key, total: 0, truncated: 0, unrecovered: 0,
      });
    }
    const bucket = byCategoryMap.get(key);
    bucket.total += 1;
    if (row.truncated) bucket.truncated += 1;
    if (!row.expectedFinalStateMatches) bucket.unrecovered += 1;
  }

  const corpusSize = perFixture.length;
  const truncatedCount = perFixture.filter((r) => r.truncated).length;
  // A fixture COUNTS AS UNRECOVERED when its post-recovery state does not
  // match the expected final state. Clean fixtures contribute 0 (their
  // expectedFinalStateMatches is required to be true regardless).
  const unrecoveredCount = perFixture.filter((r) => !r.expectedFinalStateMatches).length;
  const recoveredCount = corpusSize - unrecoveredCount;
  const ratePostRecovery = corpusSize === 0 ? 0 : unrecoveredCount / corpusSize;

  return {
    corpusSize,
    truncatedCount,
    recoveredCount,
    unrecoveredCount,
    ratePostRecovery,
    baselineRate: TRUNCATION_BASELINE_RATE,
    threshold: TRUNCATION_RATE_THRESHOLD,
    passed: ratePostRecovery <= TRUNCATION_RATE_THRESHOLD,
    byCategory: Array.from(byCategoryMap.values()).sort(
      (a, b) => a.category.localeCompare(b.category),
    ),
    fixtures: perFixture,
    measuredAt: new Date().toISOString(),
  };
}

// -- Artifact emission --------------------------------------------------

/**
 * Persist the measurement under `<projectRoot>/.ijfw/telemetry/`. Atomic
 * write (tmp-rename) via `writeAtomic`. Returns the absolute path written.
 *
 * @param {string} projectRoot
 * @param {object} result   value returned by `measureTruncationRate`
 * @returns {string}        absolute path of the artifact
 */
export function writeRateArtifact(projectRoot, result) {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    throw new Error('recovery/truncation: writeRateArtifact requires projectRoot');
  }
  const path = join(projectRoot, '.ijfw', 'telemetry', 'truncation-rate.json');
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeAtomic(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}
