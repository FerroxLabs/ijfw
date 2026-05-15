// Workflow memory safety net.
//
// Checkpoints are durable, project-local markdown + JSON snapshots. They are
// not a replacement for IJFW memory, but they make recovery possible when chat
// context or a generated memory summary goes missing.

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { writeAtomic } from '../lib/atomic-io.js';
import { appendBlackboardEvent, blackboardStatus, readBlackboard } from '../blackboard.js';
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
  const latest = readLatest(paths.latest);
  if (!latest) return { ok: false, error: 'no-checkpoint' };
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

function buildSnapshot(projectRoot, meta) {
  const blackboard = readBlackboard(projectRoot);
  const team = readTeamAssembly(projectRoot);
  const plan = buildSwarmPlan(projectRoot);
  const status = blackboardStatus(projectRoot);
  const tasks = blackboard.tasks.data.tasks || [];
  return {
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

function readLatest(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function safeName(label) {
  return String(label || 'checkpoint').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'checkpoint';
}

