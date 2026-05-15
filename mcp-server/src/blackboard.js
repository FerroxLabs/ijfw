// Project-local blackboard coordination for IJFW swarm work.
//
// Runtime state lives under <project>/.ijfw/blackboard/. It is deliberately
// small and dependency-free: tasks/claims are atomic JSON, notes are append-only
// JSONL, and handoff is plain markdown.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAtomic, readSafe, withLock } from './lib/atomic-io.js';

export const BLACKBOARD_VERSION = 1;

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
    const next = {
      id: input.id || `${artifactId}:${agent}`,
      artifact_id: artifactId,
      agent,
      paths: normalizePaths(input.paths),
      status: 'active',
      claimed_at: nowIso(),
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
