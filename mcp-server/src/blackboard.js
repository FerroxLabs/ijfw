// Project-local blackboard coordination for IJFW swarm work.
//
// Runtime state lives under <project>/.ijfw/blackboard/. It is deliberately
// small and dependency-free: tasks/claims are atomic JSON, notes are append-only
// JSONL, and handoff is plain markdown.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomic, readSafe, withLock } from './lib/atomic-io.js';

export const BLACKBOARD_VERSION = 1;

// F-REL-1 (H5.3): default claim TTL = 30 minutes. Subagents that go silent
// (the wayland 5/8-subagent failure mode) leave their claims forever
// without this. Configurable via the `ttlMs` option on evictOrphanedClaims
// and via the `--ttl-min N` CLI flag on `ijfw swarm evict-orphans`.
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;

export function blackboardPaths(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const dir = join(root, '.ijfw', 'blackboard');
  return {
    root,
    dir,
    lock: join(dir, '.lock'),
    tasks: join(dir, 'tasks.json'),
    claims: join(dir, 'claims.json'),
    findings: join(dir, 'findings.jsonl'),
    decisions: join(dir, 'decisions.jsonl'),
    blockers: join(dir, 'blockers.jsonl'),
    notes: join(dir, 'notes.jsonl'),
    events: join(dir, 'events.jsonl'),
    handoff: join(dir, 'handoff.md'),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(paths) {
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
}

function defaultTasks() {
  return { version: BLACKBOARD_VERSION, tasks: [], updated_at: nowIso() };
}

function defaultClaims() {
  return { version: BLACKBOARD_VERSION, claims: [], updated_at: nowIso() };
}

function validTasks(data) {
  return data && data.version === BLACKBOARD_VERSION && Array.isArray(data.tasks);
}

function validClaims(data) {
  return data && data.version === BLACKBOARD_VERSION && Array.isArray(data.claims);
}

function readJson(path, fallback, validator) {
  const res = readSafe(path, validator);
  if (res.ok) return { ok: true, data: res.data };
  return { ok: false, data: fallback(), error: res.error, message: res.message };
}

function writeJson(path, data) {
  data.updated_at = nowIso();
  return writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function readJsonl(path, limit = 5) {
  try {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { malformed: true, raw: line }; }
    });
  } catch {
    return [];
  }
}

function appendJsonlUnlocked(path, entry) {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  return entry;
}

function appendJsonl(paths, path, entry) {
  return withLock(paths.lock, () => appendJsonlUnlocked(path, entry)).result ?? null;
}

function blackboardEventEntry(input) {
  return {
    ts: nowIso(),
    type: String(input.type || 'event'),
    actor: input.actor || input.owner || 'ijfw',
    task_id: input.task_id || null,
    artifact_ids: Array.isArray(input.artifact_ids) ? input.artifact_ids : [],
    message: input.message || null,
    data: input.data || {},
  };
}

export function initBlackboard(projectRoot = process.cwd()) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  if (!existsSync(paths.tasks)) writeJson(paths.tasks, defaultTasks());
  if (!existsSync(paths.claims)) writeJson(paths.claims, defaultClaims());
  for (const p of [paths.findings, paths.decisions, paths.blockers, paths.notes, paths.events]) {
    if (!existsSync(p)) writeFileSync(p, '', { encoding: 'utf8', mode: 0o600 });
  }
  if (!existsSync(paths.handoff)) {
    writeFileSync(paths.handoff, '# IJFW Blackboard Handoff\n\nNo active handoff.\n', { encoding: 'utf8', mode: 0o600 });
  }
  return { ok: true, dir: paths.dir };
}

export function readBlackboard(projectRoot = process.cwd()) {
  const paths = blackboardPaths(projectRoot);
  const tasks = readJson(paths.tasks, defaultTasks, validTasks);
  const claims = readJson(paths.claims, defaultClaims, validClaims);
  return {
    paths,
    tasks,
    claims,
    recent: {
      findings: readJsonl(paths.findings),
      decisions: readJsonl(paths.decisions),
      blockers: readJsonl(paths.blockers),
      notes: readJsonl(paths.notes),
      events: readJsonl(paths.events),
    },
  };
}

export function appendBlackboardEvent(projectRoot, input) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  const entry = blackboardEventEntry(input);
  const written = appendJsonl(paths, paths.events, entry);
  if (!written) return { ok: false, error: 'locked' };
  return { ok: true, entry: written };
}

export function writeBlackboardTasks(projectRoot, tasks, options = {}) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  return withLock(paths.lock, () => {
    const current = readJson(paths.tasks, defaultTasks, validTasks).data;
    const next = {
      version: BLACKBOARD_VERSION,
      tasks: options.replace ? [] : current.tasks.slice(),
      updated_at: nowIso(),
    };
    const incoming = tasks.map((task) => ({
      ...task,
      updated_at: task.updated_at || nowIso(),
    }));
    const incomingIds = new Set(incoming.map((task) => task.id));
    next.tasks = next.tasks.filter((task) => !incomingIds.has(task.id));
    next.tasks.push(...incoming);
    writeJson(paths.tasks, next);
    return { ok: true, written: incoming.length, total: next.tasks.length };
  }).result ?? { ok: false, error: 'locked' };
}

export function listBlackboardTasks(projectRoot = process.cwd()) {
  const state = readBlackboard(projectRoot);
  const tasks = state.tasks.data.tasks || [];
  return { ok: state.tasks.ok, tasks, error: state.tasks.error };
}

export function updateBlackboardTask(projectRoot, taskId, patch) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  return withLock(paths.lock, () => {
    const current = readJson(paths.tasks, defaultTasks, validTasks).data;
    const index = current.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) return { ok: false, error: 'task-not-found' };
    const before = current.tasks[index];
    const next = {
      ...before,
      ...patch,
      updated_at: nowIso(),
    };
    current.tasks[index] = next;
    writeJson(paths.tasks, current);
    return { ok: true, task: next, previous: before };
  }).result ?? { ok: false, error: 'locked' };
}

function activeClaims(claimsData) {
  return claimsData.claims.filter((claim) => claim.status === 'active');
}

function claimArtifactId(claim) {
  return claim.artifact_id || claim.artifact;
}

function claimAgent(claim) {
  return claim.agent || claim.owner;
}

function normalizePaths(paths) {
  if (!paths) return [];
  if (Array.isArray(paths)) return paths.map(String).filter(Boolean);
  return String(paths).split(',').map((p) => p.trim()).filter(Boolean);
}

function commonPrefixBeforeGlob(pattern) {
  const idx = pattern.search(/[*?[\]{}]/);
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

function pathsOverlap(a, b) {
  if (!a.length || !b.length) return false;
  for (const left of a) {
    for (const right of b) {
      if (left === right) return true;
      const lp = commonPrefixBeforeGlob(left);
      const rp = commonPrefixBeforeGlob(right);
      if (lp && right.startsWith(lp)) return true;
      if (rp && left.startsWith(rp)) return true;
    }
  }
  return false;
}

function claimConflicts(existing, next) {
  return activeClaims(existing).filter((claim) => {
    if (claimAgent(claim) === next.agent) return false;
    if (claimArtifactId(claim) === next.artifact_id) return true;
    return pathsOverlap(claim.paths || [], next.paths || []);
  });
}

export function claimArtifact(projectRoot, input) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  return withLock(paths.lock, () => {
    const current = readJson(paths.claims, defaultClaims, validClaims).data;
    const artifactId = String(input.artifact_id || input.artifact || '').trim();
    const agent = String(input.agent || input.owner || '').trim();
    const ttlMs = Number.isFinite(input.ttlMs) && input.ttlMs > 0
      ? Math.floor(input.ttlMs)
      : DEFAULT_CLAIM_TTL_MS;
    const next = {
      id: input.id || `${artifactId}:${agent}`,
      artifact_id: artifactId,
      agent,
      paths: normalizePaths(input.paths),
      status: 'active',
      claimed_at: nowIso(),
      // F-REL-1: TTL is stored on the claim so per-claim overrides survive
      // a config reload and the evictor doesn't need the original config.
      ttl_ms: ttlMs,
      // heartbeat_at is OPTIONAL -- subagents that don't ping fall back to
      // claimed_at as the freshness anchor. Initialised null so the field
      // always exists in the JSON shape (no schema migration needed).
      heartbeat_at: null,
      note: input.note ? String(input.note) : undefined,
    };
    if (!next.artifact_id) return { ok: false, error: 'artifact-required' };
    if (!next.agent) return { ok: false, error: 'owner-required' };

    const conflicts = claimConflicts(current, next);
    if (conflicts.length) return { ok: false, error: 'conflict', conflicts };

    current.claims = current.claims.filter((claim) => !(claimArtifactId(claim) === next.artifact_id && claimAgent(claim) === next.agent));
    current.claims.push(next);
    writeJson(paths.claims, current);
    appendJsonlUnlocked(paths.events, blackboardEventEntry({
      type: 'claim.acquired',
      actor: next.agent,
      artifact_ids: [next.artifact_id],
      message: `Claimed ${next.artifact_id}`,
      data: { paths: next.paths },
    }));
    return { ok: true, claim: next };
  }).result ?? { ok: false, error: 'locked' };
}

export function releaseClaim(projectRoot, input) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  return withLock(paths.lock, () => {
    const current = readJson(paths.claims, defaultClaims, validClaims).data;
    const artifactId = String(input.artifact_id || input.artifact || '').trim();
    const agent = input.agent || input.owner ? String(input.agent || input.owner).trim() : null;
    if (!artifactId) return { ok: false, error: 'artifact-required' };

    let released = 0;
    current.claims = current.claims.map((claim) => {
      if (claimArtifactId(claim) !== artifactId) return claim;
      if (agent && claimAgent(claim) !== agent) return claim;
      if (claim.status !== 'active') return claim;
      released += 1;
      return { ...claim, status: 'released', released_at: nowIso() };
    });
    writeJson(paths.claims, current);
    if (released > 0) {
      appendJsonlUnlocked(paths.events, blackboardEventEntry({
        type: 'claim.released',
        actor: agent || 'ijfw',
        artifact_ids: [artifactId],
        message: `Released ${released} claim(s) for ${artifactId}`,
      }));
    }
    return { ok: true, released };
  }).result ?? { ok: false, error: 'locked' };
}

/**
 * F-REL-1 (H5.3): heartbeat ping. Subagents call this to extend their claim
 * TTL without releasing + reclaiming. Heartbeat is matched by claim id
 * (preferred) or by (artifact_id, agent) tuple. Returns the updated claim
 * so the caller can verify the new heartbeat_at.
 */
export function updateClaimHeartbeat(projectRoot, input) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  return withLock(paths.lock, () => {
    const current = readJson(paths.claims, defaultClaims, validClaims).data;
    const claimId = input.claim_id || input.id ? String(input.claim_id || input.id).trim() : null;
    const artifactId = input.artifact_id || input.artifact ? String(input.artifact_id || input.artifact).trim() : null;
    const agent = input.agent || input.owner ? String(input.agent || input.owner).trim() : null;
    if (!claimId && !(artifactId && agent)) {
      return { ok: false, error: 'claim-or-tuple-required' };
    }
    let updated = null;
    current.claims = current.claims.map((claim) => {
      if (claim.status !== 'active') return claim;
      const matchesById = claimId && claim.id === claimId;
      const matchesByTuple = !claimId && claimArtifactId(claim) === artifactId && claimAgent(claim) === agent;
      if (!matchesById && !matchesByTuple) return claim;
      updated = { ...claim, heartbeat_at: nowIso() };
      return updated;
    });
    if (!updated) return { ok: false, error: 'claim-not-found' };
    writeJson(paths.claims, current);
    return { ok: true, claim: updated };
  }).result ?? { ok: false, error: 'locked' };
}

/**
 * F-REL-1 (H5.3): orphan evictor. Walks active claims, releases any whose
 * freshness anchor (max(claimed_at, heartbeat_at)) is older than ttlMs.
 * Returns evicted claim IDs so the caller can log + report. Default TTL is
 * 30 minutes, matching DEFAULT_CLAIM_TTL_MS.
 *
 * Per-claim ttl_ms (recorded at claim time) is honoured when present; the
 * options.ttlMs is a fallback for legacy claims written before the TTL
 * field existed.
 */
export function evictOrphanedClaims(projectRoot, options = {}) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  const fallbackTtl = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? Math.floor(options.ttlMs)
    : DEFAULT_CLAIM_TTL_MS;
  const now = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  return withLock(paths.lock, () => {
    const current = readJson(paths.claims, defaultClaims, validClaims).data;
    const evicted = [];
    current.claims = current.claims.map((claim) => {
      if (claim.status !== 'active') return claim;
      const claimedAt = parseIso(claim.claimed_at);
      const heartbeatAt = parseIso(claim.heartbeat_at);
      const anchor = Math.max(claimedAt || 0, heartbeatAt || 0);
      if (!anchor) return claim; // unparseable timestamps -- leave alone, don't false-evict
      const ttl = Number.isFinite(claim.ttl_ms) && claim.ttl_ms > 0 ? claim.ttl_ms : fallbackTtl;
      if (now - anchor <= ttl) return claim;
      evicted.push({
        id: claim.id,
        artifact_id: claimArtifactId(claim),
        agent: claimAgent(claim),
        age_ms: now - anchor,
        ttl_ms: ttl,
      });
      return { ...claim, status: 'expired', expired_at: nowIso(), eviction_reason: 'ttl-exceeded' };
    });
    if (evicted.length > 0) {
      writeJson(paths.claims, current);
      for (const item of evicted) {
        appendJsonlUnlocked(paths.events, blackboardEventEntry({
          type: 'claim.evicted',
          actor: 'ijfw',
          artifact_ids: [item.artifact_id],
          message: `Evicted orphan claim ${item.id} (age ${Math.round(item.age_ms / 1000)}s > ttl ${Math.round(item.ttl_ms / 1000)}s)`,
          data: { id: item.id, agent: item.agent, age_ms: item.age_ms, ttl_ms: item.ttl_ms },
        }));
      }
    }
    return { ok: true, evicted, evicted_ids: evicted.map((item) => item.id), count: evicted.length };
  }).result ?? { ok: false, error: 'locked' };
}

function parseIso(value) {
  if (!value || typeof value !== 'string') return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function addBlackboardNote(projectRoot, input) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  const kind = input.kind || 'note';
  const targets = {
    note: paths.notes,
    finding: paths.findings,
    decision: paths.decisions,
    blocker: paths.blockers,
  };
  const target = targets[kind];
  if (!target) return { ok: false, error: 'unknown-kind' };
  const entry = {
    kind,
    author: input.author || input.owner || 'unknown',
    artifact: input.artifact || null,
    message: String(input.message || '').trim(),
    ts: nowIso(),
  };
  if (!entry.message) return { ok: false, error: 'message-required' };
  const written = appendJsonl(paths, target, entry);
  if (!written) return { ok: false, error: 'locked' };
  return { ok: true, entry: written };
}

export function writeHandoff(projectRoot, body) {
  const paths = blackboardPaths(projectRoot);
  ensureDir(paths);
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'handoff-required' };
  writeAtomic(paths.handoff, `${text}\n`, { mode: 0o600 });
  return { ok: true, path: paths.handoff };
}

export function blackboardStatus(projectRoot = process.cwd()) {
  const paths = blackboardPaths(projectRoot);
  const state = readBlackboard(projectRoot);
  const claims = state.claims.data.claims || [];
  const tasks = state.tasks.data.tasks || [];
  return {
    ok: true,
    dir: paths.dir,
    initialized: existsSync(paths.dir),
    tasks: {
      total: tasks.length,
      open: tasks.filter((task) => !['done', 'cancelled'].includes(task.status)).length,
    },
    claims: {
      total: claims.length,
      active: activeClaims({ claims }).length,
      active_items: activeClaims({ claims }).map((claim) => ({
        artifact_id: claimArtifactId(claim),
        agent: claimAgent(claim),
        paths: claim.paths || [],
      })),
    },
    recent: state.recent,
    health: {
      tasks: state.tasks.ok ? 'ok' : state.tasks.error,
      claims: state.claims.ok ? 'ok' : state.claims.error,
    },
  };
}
