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
 * Lock-acquisition seam (T3 — IMPLEMENTED). `lockTargets` is the subset of
 * physical files a verb mutates. The verb core passes its §3-ordered list, but
 * `_withLocks` does NOT trust it: it routes the list through
 * `canonicalLockOrder` (defense in depth) so the acquire-order is always the
 * STATE-SDK-CONTRACT §3 coarse-to-fine order regardless of caller input.
 *
 * It then acquires every lock coarse-to-fine and releases in reverse by
 * NESTING `withFsLock` calls — the innermost call runs `fn`, and the `finally`
 * unwind of each `withFsLock` releases in exact reverse order. Because the
 * acquire-order is total and deterministic, two verbs touching an overlapping
 * file set can never form a lock-ordering cycle → the SDK is deadlock-free by
 * construction.
 *
 * Locks are heartbeat-refreshed (`LOCK_OPTS.heartbeatMs`) so a long-running
 * verb is never wrongly reclaimed; a crashed holder still ages out at
 * `LOCK_OPTS.staleMs`. No subprocess is spawned anywhere inside the lock
 * (the verb core does no spawning — confirmed for T3).
 *
 * @param {string[]} lockTargets  physical paths the verb mutates (any order)
 * @param {() => Promise<T>} fn   the verb's critical section
 * @returns {Promise<T>}
 * @template T
 */
async function _withLocks(lockTargets, fn) {
  const ordered = canonicalLockOrder(
    Array.isArray(lockTargets) ? lockTargets : [],
  );
  if (ordered.length === 0) return fn();

  // Recursively nest withFsLock: acquire ordered[0] coarse-to-fine; the
  // innermost frame runs `fn`. Each withFsLock's release fires on unwind, so
  // locks release in exact reverse order automatically.
  const acquireFrom = (index) => {
    if (index >= ordered.length) return fn();
    return withFsLock(
      lockPathFor(ordered[index]),
      () => acquireFrom(index + 1),
      LOCK_OPTS,
    );
  };
  return acquireFrom(0);
}

/**
 * Intent-journal `begin` seam (T4). Returns a per-invocation handle the
 * matching `_journalCommit` consumes. Today: no-op handle.
 *
 * @param {{verb:string, verbId:string, dedupKey?:string, targets:string[], payloadDigest:string}} _record
 * @returns {object} journal handle
 */
function _journalBegin(_record) {
  // T4 replaces this with a write-ahead `begin` line to intent-journal.jsonl
  // plus a pre-write snapshot of the targets for rollback.
  return { begun: false };
}

/**
 * Intent-journal `commit` seam (T4). Marks the invocation durably applied.
 * Today: no-op.
 *
 * @param {object} _handle  the handle returned by `_journalBegin`
 */
function _journalCommit(_handle) {
  // T4 replaces this with a `commit` line to intent-journal.jsonl.
}

/**
 * Event-emit seam (T5). Fire-and-forget, AFTER lock release (Model 3).
 * Today: no-op. NOTE: distinct from the `event.emit` *verb* — the verb is a
 * caller-facing append; this seam is the implicit per-query observability tap.
 *
 * @param {object} _event  { verb, subagentId, ts, verbId, outcome, payloadDigest }
 */
function _emitEvent(_event) {
  // T5 replaces this with an append to the rotated per-subagent event log.
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

/** sha256-<hex> digest of a canonical-JSON payload (intent/event records). */
function payloadDigest(payload) {
  const canon = JSON.stringify(payload ?? null);
  return `sha256-${createHash('sha256').update(canon).digest('hex')}`;
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
  async 'workflow.set-phase'(payload, ctx) {
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
    });
  },

  // --- wave.get — read, Day-1 no-op ----------------------------------------
  async 'wave.get'(payload, ctx) {
    const root = requireRoot(ctx);
    const waveId = requireId(payload?.waveId, 'waveId');
    return { ok: true, wave: readWaveStateFile(root, waveId) };
  },

  // --- wave.advance — write, Day-1 create ----------------------------------
  async 'wave.advance'(payload, ctx) {
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
    });
  },

  // --- wave.record-task — append, Day-1 create, dedupKey -------------------
  async 'wave.record-task'(payload, ctx) {
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
    });
  },

  // --- phase.plan-check — write, Day-1 refuse, gate=validatePlan -----------
  async 'phase.plan-check'(payload, ctx) {
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
    });
  },

  // --- phase.complete — write, Day-1 create, gate=verification ------------
  async 'phase.complete'(payload, ctx) {
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
    });
  },

  // --- subagent.dispatch — write, Day-1 create -----------------------------
  async 'subagent.dispatch'(payload, ctx) {
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
    });
  },

  // --- subagent.checkpoint — append, Day-1 create, dedupKey ---------------
  async 'subagent.checkpoint'(payload, ctx) {
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
    });
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

  // --- event.emit — append, Day-1 create, no §3 lock ----------------------
  // T5 fleshes out rotation + the post-lock fire-and-forget envelope. The
  // verb-core handler keeps it minimal: assign a monotonic seq + append.
  async 'event.emit'(payload, ctx) {
    const root = requireRoot(ctx);
    const subagentId = requireId(payload?.subagentId, 'subagentId');
    const waveId = requireId(payload?.waveId, 'waveId');
    const eventType = requireStr(payload?.eventType, 'eventType');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    if (!payload?.data || typeof payload.data !== 'object') {
      throw new Error('state-sdk: event.emit needs a data object');
    }
    const log = paths.eventLog(root, waveId, subagentId);
    const existing = readJsonl(log);
    const dup = existing.find((e) => e && e.dedupKey === dedupKey);
    if (dup) return { ok: true, seq: dup.seq, deduped: true };
    const seq = existing.length
      ? (existing[existing.length - 1].seq || existing.length) + 1
      : 1;
    appendJsonl(log, {
      seq, eventType, subagentId, waveId,
      ts: nowIso(), dedupKey, data: payload.data,
    });
    return { ok: true, seq, deduped: false };
  },

  // --- telemetry.record — append, Day-1 create, dedupKey -----------------
  async 'telemetry.record'(payload, ctx) {
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
    });
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
  async 'roster.record'(payload, ctx) {
    const root = requireRoot(ctx);
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const roster = payload?.roster;
    if (!roster || typeof roster !== 'object' || !Array.isArray(roster.agents)) {
      throw new Error('state-sdk: roster.record needs a roster { domain, agents }');
    }
    const file = paths.teamWorkflow(root);
    const targets = [paths.intentJournal(root), file];
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
    });
  },

  // --- extension.set-active — write, Day-1 create, homedir file ----------
  async 'extension.set-active'(payload, ctx) {
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
    });
  },

  // --- decision.add — append, Day-1 create, dedupKey --------------------
  async 'decision.add'(payload, ctx) {
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
    });
  },

  // --- blocker.add — append, Day-1 create, dedupKey --------------------
  async 'blocker.add'(payload, ctx) {
    const root = requireRoot(ctx);
    const id = requireStr(payload?.id, 'id');
    const text = requireStr(payload?.text, 'text');
    const dedupKey = requireStr(payload?.dedupKey, 'dedupKey');
    const waveId = payload?.waveId === undefined
      ? undefined : requireId(payload.waveId, 'waveId');
    const log = paths.decisions(root);
    const targets = [paths.intentJournal(root), log];
    if (waveId) targets.push(paths.waveState(root, waveId));
    return _withLocks(targets, async () => {
      if (jsonlHasDedupKey(log, dedupKey)) {
        return { ok: true, blockerId: id, deduped: true };
      }
      appendJsonl(log, {
        kind: 'blocker', blockerId: id, text, dedupKey,
        waveId: waveId ?? null, resolved: false, ts: nowIso(),
      });
      return { ok: true, blockerId: id, deduped: false };
    });
  },

  // --- blocker.resolve — append, Day-1 refuse, dedupKey ---------------
  async 'blocker.resolve'(payload, ctx) {
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
    if (waveId) targets.push(paths.waveState(root, waveId));
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
    });
  },

  // --- state.replay — read, Day-1 no-op ------------------------------
  // T4 owns the intent journal; T20 owns the full rollback walk. The verb-core
  // handler reads the journal and classifies begin/commit pairs — it does NOT
  // perform rollback (no journal records exist until T4 writes them, so on a
  // T2-only tree this is always the empty result).
  async 'state.replay'(payload, ctx) {
    const root = requireRoot(ctx);
    const journal = paths.intentJournal(root);
    if (!existsSync(journal)) {
      return { ok: true, replayed: [], skipped: [], rolledBack: [] };
    }
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
    for (const [verbId] of begins) {
      if (commits.has(verbId)) skipped.push(verbId);
      else rolledBack.push(verbId); // partial — T20 performs the actual restore
    }
    return { ok: true, replayed: [], skipped, rolledBack };
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

/** Verbs that mutate state (write a journal record under T4). */
const MUTATING = new Set([
  'workflow.set-phase', 'wave.advance', 'wave.record-task', 'phase.plan-check',
  'phase.complete', 'subagent.dispatch', 'subagent.checkpoint',
  'subagent.post-done', 'event.emit', 'telemetry.record', 'roster.record',
  'extension.set-active', 'decision.add', 'blocker.add', 'blocker.resolve',
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
  const env = { verbId };
  const digest = payloadDigest(payload);
  const isMutating = MUTATING.has(verb);

  // T4 SEAM — write-ahead intent `begin` record. No-op until T4 lands.
  let journalHandle = null;
  if (isMutating) {
    journalHandle = _journalBegin({
      verb, verbId, dedupKey: payload?.dedupKey, targets: [], payloadDigest: digest,
    });
  }

  let result;
  let outcome = 'ok';
  try {
    result = await handler(payload, ctx, env);
    if (result && result.refused) outcome = 'refused';
    else if (result && result.advisory) outcome = 'advisory';
  } catch (err) {
    outcome = 'error';
    // T5 SEAM — emit the failure event before re-throwing. No-op until T5.
    _emitEvent({
      verb, subagentId: ctx?.subagentId ?? 'parent', ts: nowIso(),
      verbId, outcome, payloadDigest: digest,
    });
    throw err;
  }

  // T4 SEAM — `commit` marker after the write(s) succeeded. No-op until T4.
  if (isMutating && (result?.ok !== false)) {
    _journalCommit(journalHandle);
  }

  // T5 SEAM — fire-and-forget event AFTER the critical section. No-op until T5.
  _emitEvent({
    verb, subagentId: ctx?.subagentId ?? 'parent', ts: nowIso(),
    verbId, outcome, payloadDigest: digest,
  });

  // Every query() result carries `verbId` + `ok` (contract §7).
  return { ok: result?.ok !== false, verbId, ...result };
}

export default { query, VERBS };
