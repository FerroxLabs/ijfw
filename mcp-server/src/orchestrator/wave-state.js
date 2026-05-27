/**
 * wave-state.js — Atomic STATE.md read/write for orchestrator wave tracking.
 *
 * STATE.md lives at <projectRoot>/.ijfw/wave-<waveId>/STATE.md.
 * Format: YAML frontmatter (---delimited) + markdown body.
 * Writes are atomic: withFsLock + write-to-tmp + rename.
 *
 * Landed in W10-A0 (v1.4.4 prelude). checkpointWave is a stub;
 * N4 (W10-A2) will flesh out the blackboard→STATE rollup logic.
 *
 * v1.5.0 T7 (this task): wave.* writes route through the state-SDK
 * (`query('wave.advance', ...)`) — tmp+rename + locks + intent/commit
 * journalling happen inside the SDK. STATE.md frontmatter is the single
 * source of truth; the `blockers_open` key is now derived FROM
 * `decisions.jsonl` at checkpoint time (the SDK's `blocker.add`/
 * `blocker.resolve` verbs append there), giving a single writer and a single
 * representation. `blockers_open` carries the blocker **id** array (machine-
 * consumed); a separate `blockers_open_summary` carries human-readable text.
 *
 * SDK GAP CLOSED (v1.5.5 — V155-014): the SDK's `wave.advance` verb now
 * accepts an optional `body` field — frontmatter + body land inside ONE
 * journaled critical section (intent-journal #1 + waves.json #3 + per-wave
 * STATE.md #4). The prior two-write shape (SDK frontmatter, release all
 * locks, re-acquire only #4 to write the body) is gone — `state.replay`
 * can now roll back partial body writes via the same begin/commit pair.
 */

import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFsLock } from '../fs-lock.js';
import { readBlackboard } from '../blackboard.js';
import { query } from './state-sdk.js';

// Lazy S4 loader. Top-level `await import` would break `node:test` (unsettled
// top-level await). Resolves on first checkpointWave call instead. Missing
// module is non-fatal (silent fail — populateBlackboardBlock stays null).
//
// v1.5.0 audit-MED-work-M9: previously this used a `_s4LoadAttempted` boolean
// + a sync `_populateBlackboardBlock` mutation. That had a race window: two
// concurrent callers entering before the `await import` settled would BOTH
// fire `import()` (cheap on resolved-module cache, but the race-condition
// taxonomy still flagged it as a singleton smell). Replaced with a Promise
// singleton: the first caller stores the promise; subsequent callers await
// the same promise. No double-import, no race on the result variable.
let _populateBlackboardBlockPromise = null;
function loadPopulateBlackboardBlock() {
  if (_populateBlackboardBlockPromise === null) {
    _populateBlackboardBlockPromise = (async () => {
      try {
        const mod = await import('./agents-md-blackboard.js');
        return mod.populateBlackboardBlock ?? null;
      } catch {
        // S4 not landed — advisory only
        return null;
      }
    })();
  }
  return _populateBlackboardBlockPromise;
}

// Wave 5B wiring (post-cross-audit W1 fix): same lazy-Promise-singleton
// pattern as populateBlackboardBlock above. populateDisciplineBlock is
// idempotent (no-op short-circuit when content unchanged), so firing on
// every wave checkpoint is free and guarantees the DISCIPLINE marker block
// in AGENTS.md actually gets populated during a real workflow — closes the
// "ships as dead code" wiring gap the cross-audit caught.
let _populateDisciplineBlockPromise = null;
function loadPopulateDisciplineBlock() {
  if (_populateDisciplineBlockPromise === null) {
    _populateDisciplineBlockPromise = (async () => {
      try {
        const mod = await import('./agents-md-blackboard.js');
        return mod.populateDisciplineBlock ?? null;
      } catch {
        return null;
      }
    })();
  }
  return _populateDisciplineBlockPromise;
}

/**
 * Test-only helper: reset the populateBlackboardBlock promise singleton so a
 * test can simulate "first call after process start" semantics. Internal.
 *
 * @internal
 */
export function _resetPopulateBlackboardBlockSingleton() {
  _populateBlackboardBlockPromise = null;
}

/**
 * Test-only helper: reset the populateDisciplineBlock promise singleton.
 * @internal
 */
export function _resetPopulateDisciplineBlockSingleton() {
  _populateDisciplineBlockPromise = null;
}

// ---------------------------------------------------------------------------
// Internal YAML helpers — flat subset only (string/number/boolean/string[])
// ---------------------------------------------------------------------------

/**
 * Parse a YAML frontmatter block (lines between the two `---` delimiters).
 * Supports: scalar string/number/boolean values, arrays of strings (block style).
 * Rejects nested maps with a clear error.
 *
 * @param {string} block  Lines between the two `---` markers (no delimiters)
 * @returns {object}
 */
function parseYaml(block) {
  const result = {};
  const lines = block.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (!key) { i++; continue; }

    // Detect nested map: next non-empty lines are indented key: value pairs
    if (rest === '') {
      // Could be array or nested map — peek ahead
      const nextLines = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '' && !lines[j].match(/^\S.*:/)) {
        nextLines.push(lines[j]);
        j++;
      }
      if (nextLines.length > 0 && nextLines[0].trimStart().startsWith('- ')) {
        // Block sequence
        result[key] = nextLines.map((l) => l.replace(/^\s*-\s?/, ''));
        i = j;
        continue;
      } else if (nextLines.length > 0) {
        throw new Error(`wave-state: nested YAML maps are not supported (key: "${key}")`);
      }
      result[key] = null;
      i++;
      continue;
    }

    // Inline array: [a, b, c]
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]$/, '');
      result[key] = inner ? inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) : [];
      i++;
      continue;
    }

    // Scalar
    if (rest === 'true') { result[key] = true; }
    else if (rest === 'false') { result[key] = false; }
    else if (rest === 'null' || rest === '~') { result[key] = null; }
    else if (!Number.isNaN(Number(rest)) && rest !== '') { result[key] = Number(rest); }
    else { result[key] = rest.replace(/^['"]|['"]$/g, ''); }
    i++;
  }
  return result;
}

// V155-014 (TR-003): emitYaml was previously used to render the wave-state
// body inline. After folding body writes into the SDK's journaled critical
// section (state-sdk now owns emit), the helper is unused. Removed.

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function wavePaths(waveId, projectRoot) {
  const dir = join(projectRoot, '.ijfw', `wave-${waveId}`);
  return {
    dir,
    state: join(dir, 'STATE.md'),
    summary: join(dir, 'SUMMARY.md'),
    lock: join(dir, '.STATE.md.lock'),
    summaryLock: join(dir, '.SUMMARY.md.lock'),
    tmp: join(dir, '.STATE.md.tmp'),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a wave's STATE.md and return parsed { frontmatter, body, raw }.
 * Returns null if the wave directory or file doesn't exist.
 * Throws on malformed frontmatter.
 *
 * @param {string} waveId       e.g. "W10-A0"
 * @param {string} projectRoot  absolute path to project root
 * @returns {Promise<{frontmatter: object, body: string, raw: string} | null>}
 */
export async function readWaveState(waveId, projectRoot) {
  const { state } = wavePaths(waveId, projectRoot);
  let raw;
  try {
    raw = await readFile(state, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  // Parse frontmatter
  if (!raw.startsWith('---')) {
    throw new Error(`wave-state: STATE.md for "${waveId}" is missing YAML frontmatter`);
  }
  const secondDelim = raw.indexOf('\n---', 3);
  if (secondDelim === -1) {
    throw new Error(`wave-state: STATE.md for "${waveId}" has unclosed YAML frontmatter`);
  }
  const fmBlock = raw.slice(4, secondDelim); // skip "---\n"
  const body = raw.slice(secondDelim + 4).replace(/^\n+/, ''); // skip "\n---\n\n"

  const frontmatter = parseYaml(fmBlock);
  return { frontmatter, body, raw };
}

/**
 * Atomically write a wave's STATE.md.
 *
 * v1.5.0 T7: frontmatter writes route through the state-SDK
 * (`query('wave.advance', {waveId, status, frontmatter}, {projectRoot})`) so
 * tmp+rename + locks + intent/commit journalling happen inside the SDK. The
 * body — which the SDK contract does not yet expose a write verb for — is
 * applied via a follow-up atomic write inside the same wave-STATE lock. The
 * SDK's `wave.advance` handler preserves the existing body when it rewrites
 * frontmatter, so the follow-up write only mutates body content and never
 * loses an in-flight frontmatter update.
 *
 * Auto-creates `.ijfw/wave-<waveId>/` if missing (the SDK handler creates it
 * on first call).
 *
 * @param {string} waveId
 * @param {{frontmatter: object, body?: string}} state
 * @param {string} projectRoot
 * @returns {Promise<void>}
 */
export async function writeWaveState(waveId, state, projectRoot) {
  const fm = state.frontmatter || {};
  // SDK's wave.advance requires `status` — supply 'pending' as a safe default
  // for callers that haven't materialised one yet (matches deriveStatus's
  // default-on-empty-blackboard behaviour).
  const status = (typeof fm.status === 'string' && fm.status.length > 0)
    ? fm.status : 'pending';
  // wave.advance MERGES payload.frontmatter into the existing frontmatter;
  // pass the full requested frontmatter so unrelated keys are overwritten
  // intentionally (writeWaveState semantics: caller supplies the full
  // frontmatter shape they want persisted).
  //
  // V155-014 (HIGH): body is now passed THROUGH the SDK call so frontmatter +
  // body land inside ONE journaled critical section holding all three SDK
  // locks (intent-journal #1, waves.json #3, per-wave STATE.md #4). The prior
  // shape — call wave.advance for frontmatter, release SDK locks, re-acquire
  // ONLY the STATE.md lock to write the body — gave a #4-only second
  // critical section with no #1 journal record, so `state.replay` could not
  // roll back a body-write partial. The two writes are now atomic and
  // replay-safe.
  const sdkPayload = { waveId, status, frontmatter: { ...fm } };
  if (state.body !== undefined && state.body !== null) {
    sdkPayload.body = state.body;
  }
  await query('wave.advance', sdkPayload, { projectRoot });
}

/**
 * Append a delta entry to a wave's SUMMARY.md — markdown append-only log.
 * r13-M-03 (post-Trident r13 fix): minimum-viable implementation closing the
 * handoff §N4 promise. Full blackboard→STATE rollup remains future work for
 * v1.5.0 (would mean reading blackboard.js claims/findings and summarising).
 *
 * Delta shape (caller chooses what to record):
 *   { agent_id?, task_id?, commits?: string[], tests_delta?: string,
 *     contracts_touched?: string[], surprises?: string }
 *
 * Atomic via withFsLock + appendFile. Each delta is rendered as a markdown
 * H3 section dated by ISO timestamp; subsequent entries append below.
 *
 * @param {string} waveId
 * @param {object} delta
 * @param {string} projectRoot
 * @returns {Promise<void>}
 */
export async function appendSummary(waveId, delta, projectRoot) {
  const { dir, summary, summaryLock } = wavePaths(waveId, projectRoot);
  const ts = new Date().toISOString();
  const lines = [`### ${ts}`];
  if (delta.agent_id) lines.push(`- **agent:** ${delta.agent_id}`);
  if (delta.task_id) lines.push(`- **task:** ${delta.task_id}`);
  if (Array.isArray(delta.commits) && delta.commits.length) {
    lines.push(`- **commits:** ${delta.commits.join(', ')}`);
  }
  if (delta.tests_delta) lines.push(`- **tests:** ${delta.tests_delta}`);
  if (Array.isArray(delta.contracts_touched) && delta.contracts_touched.length) {
    lines.push(`- **contracts:** ${delta.contracts_touched.join(', ')}`);
  }
  if (delta.surprises) lines.push(`- **surprises:** ${delta.surprises}`);
  const payload = lines.join('\n') + '\n\n';

  await withFsLock(summaryLock, async () => {
    await mkdir(dir, { recursive: true });
    await appendFile(summary, payload, 'utf8');
  });
}

// ---------------------------------------------------------------------------
// Rollup helpers — exported for direct testing (W11-B1 / S5)
// ---------------------------------------------------------------------------

/**
 * Derive the next STATE.md status from the wave-filtered blackboard slice and
 * the previously-persisted state.
 *
 * Rules (R1 §S5):
 *   1. any open blocker       → 'blocked'
 *   2. no claims at all       → preserve existing status (default 'pending')
 *   3. every claim 'released' → 'review'
 *   4. otherwise              → 'in_progress'
 *
 * @param {{claims: object[], findings: object[], blockers: object[]}} filtered
 * @param {{frontmatter?: object} | null} existing
 * @returns {'blocked'|'pending'|'review'|'in_progress'}
 */
export function deriveStatus(filtered, existing) {
  if (filtered.blockers && filtered.blockers.length > 0) return 'blocked';
  if (filtered.claims.length === 0) return existing?.frontmatter?.status ?? 'pending';
  if (filtered.claims.every((c) => c.status === 'released')) return 'review';
  return 'in_progress';
}

/**
 * Tag a blackboard entry as belonging to a wave by checking, in order:
 *   - explicit `wave_id` field
 *   - artifact_id prefixed `<waveId>:`
 *   - message containing `[<waveId>]`
 *
 * @param {{claims?: {data?: {claims?: object[]}}, recent?: {findings?: object[], blockers?: object[]}}} blackboard
 * @param {string} waveId
 * @returns {{claims: object[], findings: object[], blockers: object[]}}
 */
export function filterByWave(blackboard, waveId) {
  const tag = (entry) => {
    if (!entry) return false;
    if (entry.wave_id === waveId) return true;
    if (typeof entry.artifact_id === 'string' && entry.artifact_id.startsWith(`${waveId}:`)) return true;
    if (typeof entry.message === 'string' && entry.message.includes(`[${waveId}]`)) return true;
    return false;
  };
  const claims = (blackboard.claims?.data?.claims ?? []).filter(tag);
  const findings = (blackboard.recent?.findings ?? []).filter(tag);
  const blockers = (blackboard.recent?.blockers ?? []).filter(tag);
  return { claims, findings, blockers };
}

/**
 * Quote YAML strings that would otherwise confuse the flat-subset parser/emitter:
 * presence of `:`, `#`, `[`, `]`, `{`, `}`, `"`, newline, or `<space>-`.
 *
 * Fold-in: Trident r13 F6 — emit safety for STATE.md frontmatter strings.
 *
 * @param {string} s
 * @returns {string}
 */
export function quoteYamlStr(s) {
  if (typeof s !== 'string') return String(s);
  if (/[:#[\]{}"\n]|\s-/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/**
 * Render the markdown body for STATE.md from the wave-filtered blackboard slice.
 * Findings are capped to the last 5 (matches frontmatter.findings_recent window).
 *
 * @param {{findings: object[], blockers: object[]}} filtered
 * @param {{body?: string} | null} _existing  (reserved for future merge logic)
 * @returns {string}
 */
export function renderBody(filtered, _existing) {
  const lines = [];
  if (filtered.findings.length > 0) {
    lines.push('## Recent findings');
    for (const f of filtered.findings.slice(-5)) {
      lines.push(`- ${f.message ?? '(unspecified)'}`);
    }
    lines.push('');
  }
  if (filtered.blockers.length > 0) {
    lines.push('## Open blockers');
    for (const b of filtered.blockers) {
      lines.push(`- ${b.message ?? '(unspecified)'}`);
    }
  }
  return lines.join('\n');
}

/**
 * v1.5.0 T7: derive the open-blocker set for a wave from `decisions.jsonl`.
 *
 * The SDK's `blocker.add` / `blocker.resolve` verbs append `kind:'blocker'` /
 * `kind:'blocker-resolution'` records to `.ijfw/blackboard/decisions.jsonl`
 * (T4 contract §7). A blocker is **open** when:
 *   - a `kind:'blocker'` record exists for the wave (matched by
 *     record.waveId === waveId), AND
 *   - no later `kind:'blocker-resolution'` record carries the same
 *     `blockerId`.
 *
 * Returns parallel arrays of stable ids (for `blockers_open`, machine-
 * consumed) and human messages (for `blockers_open_summary`, optional UI).
 *
 * @param {{recent?: {decisions?: object[]}}} blackboard
 * @param {string} waveId
 * @returns {{ids: string[], summaries: string[]}}
 */
export function deriveOpenBlockers(blackboard, waveId) {
  const decisions = Array.isArray(blackboard?.recent?.decisions)
    ? blackboard.recent.decisions : [];
  const resolvedIds = new Set();
  for (const r of decisions) {
    if (r && r.kind === 'blocker-resolution' && typeof r.blockerId === 'string') {
      resolvedIds.add(r.blockerId);
    }
  }
  const ids = [];
  const summaries = [];
  const seen = new Set();
  for (const r of decisions) {
    if (!r || r.kind !== 'blocker') continue;
    if (typeof r.blockerId !== 'string' || !r.blockerId) continue;
    if (r.waveId !== waveId) continue;
    if (resolvedIds.has(r.blockerId)) continue;
    if (seen.has(r.blockerId)) continue;
    seen.add(r.blockerId);
    ids.push(r.blockerId);
    summaries.push(quoteYamlStr(typeof r.text === 'string' ? r.text : ''));
  }
  return { ids, summaries };
}

/**
 * Roll up the blackboard slice for `waveId` into STATE.md frontmatter+body.
 *
 * Steps:
 *  1. Read existing STATE.md (preserve created_at if present).
 *  2. Read blackboard.js — defensive: missing/uninitialized blackboard yields
 *     empty arrays so checkpointing never throws on a clean tree.
 *  3. Filter blackboard entries by wave tag.
 *  4. Derive `blockers_open` from `decisions.jsonl` (single source of truth —
 *     the SDK's blocker.add/blocker.resolve verbs append there). Legacy
 *     `blackboard.recent.blockers` (from `addBlackboardNote(kind:'blocker')`)
 *     still drives the `status='blocked'` rule for back-compat.
 *  5. Derive status + frontmatter; render markdown body.
 *  6. Persist atomically via writeWaveState (SDK-routed).
 *  7. Append a SUMMARY.md delta when status transitions.
 *  8. If S4's populateBlackboardBlock is loaded, refresh AGENTS.md (advisory —
 *     silent on failure).
 *
 * @param {string} waveId
 * @param {string} projectRoot
 * @returns {Promise<{frontmatter: object, body: string}>}
 */
export async function checkpointWave(waveId, projectRoot) {
  const now = new Date().toISOString();
  const existing = await readWaveState(waveId, projectRoot);

  // readBlackboard returns synchronously per blackboard.js; uninitialized
  // blackboard yields empty arrays so the rollup is safe on a clean tree.
  let blackboard;
  try {
    blackboard = readBlackboard(projectRoot);
  } catch {
    blackboard = {
      claims: { data: { claims: [] } },
      recent: { findings: [], blockers: [], decisions: [] },
    };
  }

  const filtered = filterByWave(blackboard, waveId);
  // T7: single-writer reconciliation. `blockers_open` is now derived from
  // decisions.jsonl (the SDK's blocker.add/blocker.resolve target) — an array
  // of stable blocker ids. The legacy blackboard `blockers.jsonl` slice is
  // still used to drive `status='blocked'` so existing call sites that emit
  // blockers via `addBlackboardNote(kind:'blocker')` keep working.
  const openBlockers = deriveOpenBlockers(blackboard, waveId);
  // For deriveStatus and renderBody, merge legacy filtered blockers with the
  // SDK-derived ones so any source of an open blocker still flips status.
  const sdkBlockerEntries = openBlockers.ids.map((id, i) => ({
    blockerId: id, message: openBlockers.summaries[i], wave_id: waveId,
  }));
  // Deduplicate by message text — a legacy blocker and an SDK blocker with
  // identical text shouldn't appear twice in the body.
  const blockerMessages = new Set(filtered.blockers.map((b) => b.message ?? ''));
  const mergedBlockers = [...filtered.blockers];
  for (const b of sdkBlockerEntries) {
    if (!blockerMessages.has(b.message)) mergedBlockers.push(b);
  }
  const mergedFiltered = { ...filtered, blockers: mergedBlockers };
  const status = deriveStatus(mergedFiltered, existing);

  const next = {
    frontmatter: {
      wave_id: waveId,
      status,
      created_at: existing?.frontmatter?.created_at ?? now,
      checkpoint_at: now,
      claims_active: filtered.claims.filter((c) => c.status === 'active').length,
      findings_recent: filtered.findings.slice(-5).map((f) => quoteYamlStr(f.message ?? '')),
      // T7: canonical machine-consumed shape — array of stable blocker ids
      // sourced from decisions.jsonl. Empty when no SDK blockers are open.
      blockers_open: openBlockers.ids,
      // Human-readable summary (optional UI), populated from the same SDK
      // decisions.jsonl records that fed `blockers_open`.
      blockers_open_summary: openBlockers.summaries,
      agents: [...new Set(filtered.claims.map((c) => c.agent ?? c.owner).filter(Boolean))],
    },
    body: renderBody(mergedFiltered, existing),
  };

  await writeWaveState(waveId, next, projectRoot);

  // Append summary delta when status changes (audit log).
  const prevStatus = existing?.frontmatter?.status ?? 'new';
  if (prevStatus !== status) {
    await appendSummary(
      waveId,
      { agent_id: 'checkpointWave', surprises: `status: ${prevStatus} → ${status}` },
      projectRoot,
    );
  }

  // S4 integration: refresh AGENTS.md BLACKBOARD block. Silent on failure —
  // populating AGENTS.md is advisory and must not block checkpointing.
  const populateBlackboardBlock = await loadPopulateBlackboardBlock();
  if (populateBlackboardBlock) {
    try { await populateBlackboardBlock(waveId, projectRoot); } catch { /* advisory */ }
  }

  // Wave 5B wiring (cross-audit W1 fix): populate the DISCIPLINE block too.
  // Same advisory-failure semantics as the BLACKBOARD call above. Auto-detects
  // project type from .ijfw/memory/brief.md frontmatter or repo signals — no
  // explicit projectType passed, the detector handles it.
  const populateDisciplineBlock = await loadPopulateDisciplineBlock();
  if (populateDisciplineBlock) {
    try { await populateDisciplineBlock(projectRoot, undefined, { waveId }); } catch { /* advisory */ }
  }

  return next;
}
