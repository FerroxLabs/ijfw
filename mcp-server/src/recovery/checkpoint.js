// Workflow memory safety net.
//
// Checkpoints are durable, project-local markdown + JSON snapshots. They are
// not a replacement for IJFW memory, but they make recovery possible when chat
// context or a generated memory summary goes missing.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeAtomic } from '../lib/atomic-io.js';
import {
  appendBlackboardEvent,
  blackboardPaths,
  blackboardStatus,
  readBlackboard,
} from '../blackboard.js';
import { readTeamAssembly } from '../team/generator.js';
import { buildSwarmPlan } from '../swarm/planner.js';

export function checkpointPaths(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const dir = join(root, '.ijfw', 'checkpoints');
  return { root, dir, latest: join(dir, 'latest.json') };
}

export function createCheckpoint(projectRoot = process.cwd(), label = 'checkpoint', options = {}) {
  const paths = checkpointPaths(projectRoot);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const ts = new Date().toISOString();
  const safeLabel = safeName(label);
  const id = `${ts.replace(/[:.]/g, '-')}-${safeLabel}`;
  const jsonPath = join(paths.dir, `${id}.json`);
  const mdPath = join(paths.dir, `${id}.md`);
  const snapshot = buildSnapshot(projectRoot, { id, label, ts, message: options.message });

  writeAtomic(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  writeAtomic(mdPath, renderCheckpoint(snapshot), { mode: 0o600 });
  writeAtomic(paths.latest, `${JSON.stringify({ id, label, ts, jsonPath, mdPath }, null, 2)}\n`, { mode: 0o600 });
  appendBlackboardEvent(projectRoot, {
    type: 'checkpoint.created',
    actor: options.actor || 'ijfw',
    message: label,
    data: { id, jsonPath, mdPath },
  });
  return { ok: true, id, label, jsonPath, mdPath, snapshot };
}

export function recoveryStatus(projectRoot = process.cwd()) {
  const paths = checkpointPaths(projectRoot);
  const blackboard = readBlackboard(projectRoot);
  const team = readTeamAssembly(projectRoot);
  const plan = buildSwarmPlan(projectRoot);
  const tasks = blackboard.tasks.data.tasks || [];
  const latest = readLatest(paths.latest);
  return {
    ok: true,
    latest,
    team: {
      ok: team.ok,
      name: team.charter?.team_name || null,
    },
    swarm: plan.ok ? {
      ok: true,
      summary: plan.summary,
    } : {
      ok: false,
      message: plan.message,
    },
    tasks: summarizeTasks(tasks),
    claims: blackboardStatus(projectRoot).claims,
    recent: {
      events: blackboard.recent.events,
      blockers: blackboard.recent.blockers,
      decisions: blackboard.recent.decisions,
    },
    next: recommendedNext(team, plan, tasks),
  };
}

export function latestCheckpoint(projectRoot = process.cwd()) {
  const paths = checkpointPaths(projectRoot);
  const r = readLatest(paths.latest);
  if (!r || r.code === 'enoent') {
    return { ok: false, error: 'no-checkpoint' };
  }
  if (r.code === 'parse-fail') {
    // V155-027 (v1.5.5): distinguish "no checkpoint" from "corrupt checkpoint".
    // Previously both returned ok:false error:'no-checkpoint'; in-progress
    // recovery work was silently abandoned on partial-write corruption.
    return {
      ok: false,
      error: 'checkpoint-corrupt',
      message: r.message,
      path: paths.latest,
      hint: `inspect ${paths.dir} for numbered checkpoints to recover from`,
    };
  }
  const latest = r.data;
  let markdown = '';
  try { markdown = readFileSync(latest.mdPath, 'utf8'); } catch { /* optional */ }
  return { ok: true, ...latest, markdown };
}

export function listCheckpoints(projectRoot = process.cwd()) {
  const paths = checkpointPaths(projectRoot);
  if (!existsSync(paths.dir)) return [];
  return readdirSync(paths.dir)
    .filter((file) => file.endsWith('.json') && file !== 'latest.json')
    .sort()
    .map((file) => join(paths.dir, file));
}

// v1.5.0 audit-LOW-work-L2: memoise buildSnapshot per (projectRoot, ms).
// Snapshot construction reads team + plan + blackboard, which are themselves
// I/O-heavy reads. The bb mtime cache already shortcuts the inner reads, but
// when a caller does back-to-back createCheckpoint() calls (e.g. on a wave
// boundary) we still re-build the wrapper N times. Memo is keyed on the
// project root + blackboard mtimes + ts so any state change invalidates;
// hot-path cache size is capped at 8 entries to stay tiny.
const SNAPSHOT_CACHE = new Map();
const SNAPSHOT_CACHE_MAX = 8;

function snapshotCacheKey(projectRoot, ts) {
  const paths = blackboardPaths(projectRoot);
  let tasksMtime = 0, claimsMtime = 0;
  try { tasksMtime = statSync(paths.tasks).mtimeMs; } catch { /* default 0 */ }
  try { claimsMtime = statSync(paths.claims).mtimeMs; } catch { /* default 0 */ }
  return `${paths.root}::${ts}::${tasksMtime}::${claimsMtime}`;
}

function buildSnapshot(projectRoot, meta) {
  const cacheKey = snapshotCacheKey(projectRoot, meta.ts);
  const cached = SNAPSHOT_CACHE.get(cacheKey);
  if (cached) {
    // Cached body is independent of meta.id / meta.label / meta.message;
    // those are reapplied from the current call.
    return {
      ...cached,
      id: meta.id,
      label: meta.label,
      message: meta.message || null,
    };
  }
  const blackboard = readBlackboard(projectRoot);
  const team = readTeamAssembly(projectRoot);
  const plan = buildSwarmPlan(projectRoot);
  const status = blackboardStatus(projectRoot);
  const tasks = blackboard.tasks.data.tasks || [];
  const snapshot = {
    schema_version: 'ijfw-checkpoint/v1',
    id: meta.id,
    label: meta.label,
    message: meta.message || null,
    created_at: meta.ts,
    project: basename(resolve(projectRoot)),
    team: team.ok ? {
      name: team.charter.team_name,
      archetypes: team.charter.project_archetypes,
      roles: team.charter.roles.map((role) => role.name),
    } : { ok: false },
    swarm: plan.ok ? {
      summary: plan.summary,
      waves: plan.waves.map((wave) => ({
        id: wave.id,
        mode: wave.mode,
        blocked: wave.blocked,
        artifact_ids: wave.artifact_ids,
      })),
    } : { ok: false, message: plan.message },
    tasks: summarizeTasks(tasks),
    active_tasks: tasks.filter((task) => ['ready', 'in_progress', 'blocked'].includes(task.status)),
    claims: status.claims,
    recent: blackboard.recent,
    next: recommendedNext(team, plan, tasks),
  };
  // Stash a meta-agnostic copy in the cache (id/label/message reapplied on hit).
  SNAPSHOT_CACHE.set(cacheKey, {
    ...snapshot,
    id: null,
    label: null,
    message: null,
  });
  // Narrow LRU: cap the cache size and drop the oldest insertion when over.
  if (SNAPSHOT_CACHE.size > SNAPSHOT_CACHE_MAX) {
    const firstKey = SNAPSHOT_CACHE.keys().next().value;
    if (firstKey !== undefined) SNAPSHOT_CACHE.delete(firstKey);
  }
  return snapshot;
}

// Exposed for tests / cache invalidation hooks.
export function _resetSnapshotCache() {
  SNAPSHOT_CACHE.clear();
}

function renderCheckpoint(snapshot) {
  const lines = [
    `# IJFW Checkpoint: ${snapshot.label}`,
    '',
    `Created: ${snapshot.created_at}`,
    `Project: ${snapshot.project}`,
    `Next: ${snapshot.next}`,
    '',
    '## Team',
    snapshot.team.ok === false ? 'No complete team assembly.' : `Team ${snapshot.team.name} (${snapshot.team.archetypes.join(', ')})`,
    '',
    '## Swarm',
    snapshot.swarm.ok === false ? snapshot.swarm.message : snapshot.swarm.summary,
    '',
    '## Tasks',
    `Ready: ${snapshot.tasks.ready}`,
    `In progress: ${snapshot.tasks.in_progress}`,
    `Blocked: ${snapshot.tasks.blocked}`,
    `Done: ${snapshot.tasks.done}`,
    '',
    '## Active Tasks',
  ];
  for (const task of snapshot.active_tasks) lines.push(`- ${task.id} [${task.status}] ${task.owner || 'unowned'}`);
  if (!snapshot.active_tasks.length) lines.push('- none');
  lines.push('', '## Active Claims');
  for (const claim of snapshot.claims.active_items || []) lines.push(`- ${claim.artifact_id} -> ${claim.agent}`);
  if (!snapshot.claims.active_items?.length) lines.push('- none');
  return `${lines.join('\n')}\n`;
}

function summarizeTasks(tasks) {
  const counts = { total: tasks.length, ready: 0, in_progress: 0, blocked: 0, done: 0, other: 0 };
  for (const task of tasks) {
    if (task.status in counts) counts[task.status] += 1;
    else counts.other += 1;
  }
  return counts;
}

function recommendedNext(team, plan, tasks) {
  if (!team.ok) return 'Run: ijfw team init';
  if (!plan.ok) return 'Run: ijfw swarm plan';
  if (!tasks.length) return 'Run: ijfw swarm prepare';
  const blocked = tasks.filter((task) => task.status === 'blocked');
  if (blocked.length) return `Resolve blocked task: ${blocked[0].id}`;
  const inProgress = tasks.find((task) => task.status === 'in_progress');
  if (inProgress) return `Continue task: ${inProgress.id}`;
  const ready = tasks.find((task) => task.status === 'ready');
  if (ready) return `Start task: ${ready.id}`;
  return 'Verify completed work or prepare next wave';
}

/**
 * V155-027 (v1.5.5): tagged return so callers can distinguish "missing" from
 * "corrupt". Three shapes:
 *   - { code: 'enoent' }                — file does not exist
 *   - { code: 'parse-fail', message }   — file exists but JSON.parse threw
 *   - { code: 'ok', data }              — clean read
 * `null` is no longer returned. The legacy caller checked `!latest` against
 * the prior null — `latestCheckpoint` now switches on `.code`.
 */
function readLatest(path) {
  if (!existsSync(path)) return { code: 'enoent' };
  try {
    return { code: 'ok', data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { code: 'parse-fail', message: e?.message || String(e) };
  }
}

function safeName(label) {
  return String(label || 'checkpoint').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'checkpoint';
}

