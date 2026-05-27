// Artifact-aware swarm planner.
//
// Reads Team Assembly 2.0 charter/workflow plus blackboard claims and returns
// an execution plan. This module is intentionally read-only: it explains what
// can run, what is blocked, and why. Execution/worktrees come later.

import { readTeamAssembly } from '../team/generator.js';
import {
  addBlackboardNote,
  appendBlackboardEvent,
  blackboardStatus,
  claimArtifact,
  listBlackboardTasks,
  releaseClaim,
  updateBlackboardTask,
  writeBlackboardTasks,
} from '../blackboard.js';
import { deriveReviewTasks } from './review.js';

export function buildSwarmPlan(projectRoot = process.cwd(), options = {}) {
  const team = options.team || readTeamAssembly(projectRoot);
  if (!team.ok) {
    return {
      ok: false,
      error: 'missing-team-assembly',
      message: 'No complete team assembly found. Run: ijfw team init',
      validation: team.validation,
    };
  }

  const blackboard = options.blackboard || blackboardStatus(projectRoot);
  const workflow = team.workflow;
  const charter = team.charter;
  const artifactsById = new Map(workflow.artifacts.map((artifact) => [artifact.id, artifact]));
  const rolesByName = new Map(charter.roles.map((role) => [role.name, role]));
  const activeClaims = blackboard.claims.active_items || [];

  const waves = workflow.waves.map((wave) => {
    const tasks = wave.artifact_ids.map((artifactId) => {
      const artifact = artifactsById.get(artifactId);
      return buildTask(artifactId, artifact, rolesByName, activeClaims);
    });
    const blocked = tasks.filter((task) => task.blocked);
    const mode = normalizeMode(wave.mode, tasks);
    return {
      id: wave.id,
      requested_mode: wave.mode,
      mode,
      artifact_ids: wave.artifact_ids.slice(),
      tasks,
      blocked: blocked.length > 0,
      reason: explainWave(wave, tasks, mode),
    };
  });

  return {
    ok: true,
    team_name: charter.team_name,
    project_archetypes: workflow.project_archetypes,
    waves,
    summary: summarizePlan(waves),
  };
}

export function swarmPlanSummary(plan) {
  if (!plan.ok) return plan.message || plan.error;
  const lines = [
    `Swarm plan for ${plan.team_name}`,
    `Archetypes: ${plan.project_archetypes.join(', ')}`,
    plan.summary,
  ];
  for (const wave of plan.waves) {
    lines.push(`Wave ${wave.id}: ${wave.mode}${wave.blocked ? ' (blocked)' : ''} -- ${wave.reason}`);
    for (const task of wave.tasks) {
      const state = task.blocked ? `blocked by ${task.blocked_by.map((c) => `${c.artifact_id}:${c.agent}`).join(', ')}` : 'ready';
      lines.push(`  ${task.artifact_id} -> ${task.owner} [${state}]`);
      if (task.verification.length) lines.push(`    verify: ${task.verification.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

export function prepareSwarmTasks(projectRoot = process.cwd(), options = {}) {
  const plan = options.plan || buildSwarmPlan(projectRoot, options);
  if (!plan.ok) return { ok: false, error: plan.error, message: plan.message, plan };

  const tasks = [];
  for (const wave of plan.waves) {
    for (const task of wave.tasks) {
      tasks.push({
        id: `swarm:${wave.id}:${task.artifact_id}`,
        title: `${task.owner}: ${task.artifact_id}`,
        status: task.blocked ? 'blocked' : 'ready',
        wave_id: wave.id,
        wave_mode: wave.mode,
        artifact_ids: [task.artifact_id],
        owner: task.owner,
        reviewers: task.reviewers,
        paths: task.paths,
        refs: task.refs,
        depends_on: task.depends_on.map((id) => `swarm:${findWaveForArtifact(plan, id) || wave.id}:${id}`),
        verification: task.verification,
        blocked_by: task.blocked_by.map((claim) => ({
          artifact_id: claim.artifact_id,
          agent: claim.agent,
          paths: claim.paths || [],
        })),
      });
    }
  }

  if (options.includeReviews) {
    tasks.push(...deriveReviewTasks({
      plan,
      tasks,
      charter: (options.team || readTeamAssembly(projectRoot)).charter,
    }));
  }

  const write = writeBlackboardTasks(projectRoot, tasks, { replace: options.replace !== false });
  appendBlackboardEvent(projectRoot, {
    type: 'swarm.prepared',
    actor: 'ijfw',
    message: `Prepared ${tasks.length} swarm task(s)`,
    data: { includeReviews: Boolean(options.includeReviews), replace: options.replace !== false },
  });
  return {
    ok: write.ok,
    written: write.written || 0,
    total: write.total || 0,
    tasks,
    plan,
    error: write.error,
  };
}

export function listSwarmTasks(projectRoot = process.cwd()) {
  const listed = listBlackboardTasks(projectRoot);
  const tasks = (listed.tasks || []).filter((task) => String(task.id || '').startsWith('swarm:') || String(task.id || '').startsWith('review:'));
  return { ok: listed.ok, tasks, error: listed.error };
}

export function startSwarmTask(projectRoot, taskId, options = {}) {
  const task = findTask(projectRoot, taskId);
  if (!task.ok) return task;
  if (task.task.status !== 'ready') return { ok: false, error: 'task-not-ready', task: task.task };
  const blockedDependency = firstBlockedDependency(projectRoot, task.task);
  if (blockedDependency) return { ok: false, error: 'dependency-not-done', dependency: blockedDependency, task: task.task };

  const owner = options.owner || task.task.owner;
  const claimResults = [];
  for (const artifactId of task.task.artifact_ids || []) {
    const result = claimArtifact(projectRoot, {
      artifact: artifactId,
      owner,
      paths: task.task.paths || [],
      note: `swarm task ${taskId}`,
    });
    if (!result.ok) return { ok: false, error: 'claim-failed', claim: result, task: task.task };
    claimResults.push(result.claim);
  }

  const updated = updateBlackboardTask(projectRoot, taskId, {
    status: 'in_progress',
    started_at: new Date().toISOString(),
    active_owner: owner,
  });
  if (updated.ok) {
    appendBlackboardEvent(projectRoot, {
      type: 'task.started',
      actor: owner,
      task_id: taskId,
      artifact_ids: task.task.artifact_ids || [],
      message: `Started ${taskId}`,
    });
  }
  return { ok: updated.ok, task: updated.task, claims: claimResults, error: updated.error };
}

// V155-006 (HIGH) — completeSwarmTask used to advance status:'done' with
// nothing but the caller's word. That's the v1.5.1 hallucination signature
// encoded into the state layer: a subagent claims DONE, blackboard records
// DONE, but there is no filesystem witness (no commit, no diff). Recovery
// then trusts the false-positive and the build silently drifts.
//
// Fix: require an `evidence` envelope with at least one concrete artifact:
//   - evidence.commitSha    — 7-40 hex chars (short or full SHA)
//   - evidence.diffStats    — { filesChanged: >=1, ... }
//
// Callers that genuinely cannot produce evidence (e.g., admin overrides,
// task-tracking-only flows) MUST set `options.skipEvidence: true` AND a
// reason; the completion still writes status:'done' but the blackboard
// event is tagged `task.completed-no-evidence` so audits can spot it.
function isValidEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  const { commitSha, diffStats } = evidence;
  if (typeof commitSha === 'string' && /^[a-f0-9]{7,40}$/.test(commitSha)) {
    return true;
  }
  if (
    diffStats &&
    typeof diffStats === 'object' &&
    typeof diffStats.filesChanged === 'number' &&
    diffStats.filesChanged >= 1
  ) {
    return true;
  }
  return false;
}

export function completeSwarmTask(projectRoot, taskId, options = {}) {
  const task = findTask(projectRoot, taskId);
  if (!task.ok) return task;
  if (!['in_progress', 'review'].includes(task.task.status)) {
    return { ok: false, error: 'task-not-in-progress', task: task.task };
  }
  // V155-006 evidence gate. `skipEvidence:true` is the explicit escape
  // hatch — callers that intentionally complete without filesystem witness
  // (admin overrides, dry-run completion) opt in by name, and the event
  // log records the bypass for downstream audits.
  const evidenceOk = isValidEvidence(options.evidence);
  if (!evidenceOk && options.skipEvidence !== true) {
    return {
      ok: false,
      error: 'missing-evidence',
      message: 'completeSwarmTask requires evidence.commitSha or evidence.diffStats (or set skipEvidence:true)',
      task: task.task,
    };
  }
  const owner = options.owner || task.task.active_owner || task.task.owner;
  const releases = [];
  for (const artifactId of task.task.artifact_ids || []) {
    releases.push(releaseClaim(projectRoot, { artifact: artifactId, owner }));
  }
  const updated = updateBlackboardTask(projectRoot, taskId, {
    status: 'done',
    completed_at: new Date().toISOString(),
    completion_note: options.message || undefined,
  });
  if (updated.ok) {
    appendBlackboardEvent(projectRoot, {
      type: evidenceOk ? 'task.completed' : 'task.completed-no-evidence',
      actor: owner,
      task_id: taskId,
      artifact_ids: task.task.artifact_ids || [],
      message: options.message || `Completed ${taskId}`,
      evidence: evidenceOk ? options.evidence : undefined,
    });
  }
  return { ok: updated.ok, task: updated.task, releases, error: updated.error };
}

export function blockSwarmTask(projectRoot, taskId, options = {}) {
  const task = findTask(projectRoot, taskId);
  if (!task.ok) return task;
  const message = String(options.message || '').trim();
  if (!message) return { ok: false, error: 'message-required', task: task.task };
  const updated = updateBlackboardTask(projectRoot, taskId, {
    status: 'blocked',
    blocked_at: new Date().toISOString(),
    blocker: message,
  });
  if (updated.ok) {
    appendBlackboardEvent(projectRoot, {
      type: 'task.blocked',
      actor: options.owner || task.task.owner || 'swarm',
      task_id: taskId,
      artifact_ids: task.task.artifact_ids || [],
      message,
    });
  }
  addBlackboardNote(projectRoot, {
    kind: 'blocker',
    author: options.owner || task.task.owner || 'swarm',
    artifact: (task.task.artifact_ids || []).join(','),
    message: `${taskId}: ${message}`,
  });
  return { ok: updated.ok, task: updated.task, error: updated.error };
}

export function readySwarmTask(projectRoot, taskId) {
  const task = findTask(projectRoot, taskId);
  if (!task.ok) return task;
  if (task.task.status !== 'blocked') return { ok: false, error: 'task-not-blocked', task: task.task };
  const updated = updateBlackboardTask(projectRoot, taskId, {
    status: 'ready',
    blocker: null,
    unblocked_at: new Date().toISOString(),
  });
  if (updated.ok) {
    appendBlackboardEvent(projectRoot, {
      type: 'task.ready',
      actor: 'ijfw',
      task_id: taskId,
      artifact_ids: task.task.artifact_ids || [],
      message: `Ready ${taskId}`,
    });
  }
  return { ok: updated.ok, task: updated.task, error: updated.error };
}

function buildTask(artifactId, artifact, rolesByName, activeClaims) {
  if (!artifact) {
    return {
      artifact_id: artifactId,
      owner: null,
      reviewers: [],
      paths: [],
      refs: [],
      verification: [],
      blocked: true,
      blocked_by: [],
      reason: 'unknown-artifact',
    };
  }
  const owner = rolesByName.get(artifact.owner);
  const claimConflicts = activeClaims.filter((claim) => claimBlocksArtifact(claim, artifact));
  const allowed_paths = artifact.paths || [];
  const refs = artifact.refs || [];
  return {
    artifact_id: artifact.id,
    artifact_type: artifact.type,
    owner: artifact.owner,
    owner_role_type: owner?.role_type || null,
    reviewers: artifact.reviewers || [],
    paths: allowed_paths,
    refs,
    verification: artifact.verification || [],
    depends_on: artifact.depends_on || [],
    claim_required: owner?.coordination?.claim_required !== false,
    blocked: claimConflicts.length > 0,
    blocked_by: claimConflicts,
    reason: claimConflicts.length ? 'active-claim-conflict' : 'ready',
  };
}

function normalizeMode(requested, tasks) {
  if (tasks.some((task) => task.blocked)) return 'blocked';
  if (requested === 'review') return 'review';
  if (requested === 'parallel' && tasks.length > 1 && !tasksOverlap(tasks)) return 'parallel';
  if (requested === 'parallel' && tasks.length <= 1) return 'parallel';
  return 'sequential';
}

function explainWave(wave, tasks, mode) {
  if (mode === 'blocked') return 'one or more artifacts already have active blackboard claims';
  if (mode === 'review') return 'review wave from workflow manifest';
  if (mode === 'parallel') return 'artifacts have no dependency or path overlap inside this wave';
  if (wave.mode === 'parallel' && tasksOverlap(tasks)) return 'requested parallel, but artifact paths overlap';
  return 'workflow requested sequential execution or contains dependent artifacts';
}

function summarizePlan(waves) {
  const total = waves.reduce((n, wave) => n + wave.tasks.length, 0);
  const blocked = waves.reduce((n, wave) => n + wave.tasks.filter((task) => task.blocked).length, 0);
  const parallel = waves.filter((wave) => wave.mode === 'parallel').length;
  const review = waves.filter((wave) => wave.mode === 'review').length;
  return `${waves.length} wave(s), ${total} artifact task(s), ${parallel} parallel wave(s), ${review} review wave(s), ${blocked} blocked task(s).`;
}

function findWaveForArtifact(plan, artifactId) {
  for (const wave of plan.waves) {
    if (wave.artifact_ids.includes(artifactId)) return wave.id;
  }
  return null;
}

function findTask(projectRoot, taskId) {
  const listed = listSwarmTasks(projectRoot);
  const task = (listed.tasks || []).find((item) => item.id === taskId);
  if (!task) return { ok: false, error: 'task-not-found' };
  return { ok: true, task };
}

function firstBlockedDependency(projectRoot, task) {
  const listed = listSwarmTasks(projectRoot);
  const byId = new Map((listed.tasks || []).map((item) => [item.id, item]));
  for (const depId of task.depends_on || []) {
    const dep = byId.get(depId);
    if (dep && dep.status !== 'done') return dep;
  }
  return null;
}

function tasksOverlap(tasks) {
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      if (pathsOverlap(tasks[i].paths, tasks[j].paths)) return true;
      if ((tasks[i].depends_on || []).includes(tasks[j].artifact_id)) return true;
      if ((tasks[j].depends_on || []).includes(tasks[i].artifact_id)) return true;
    }
  }
  return false;
}

function claimBlocksArtifact(claim, artifact) {
  if (claim.agent === artifact.owner) return false;
  if (claim.artifact_id === artifact.id) return true;
  return pathsOverlap(claim.paths || [], artifact.paths || []);
}

function pathsOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  for (const left of a) {
    for (const right of b) {
      if (left === right) return true;
      const lp = prefixBeforeGlob(left);
      const rp = prefixBeforeGlob(right);
      if (lp && right.startsWith(lp)) return true;
      if (rp && left.startsWith(rp)) return true;
      if (globCouldMatch(left, right) || globCouldMatch(right, left)) return true;
    }
  }
  return false;
}

function prefixBeforeGlob(pattern) {
  const idx = pattern.search(/[*?[\]{}]/);
  return idx === -1 ? pattern : pattern.slice(0, idx);
}

function globCouldMatch(glob, literal) {
  if (!/[*?]/.test(glob)) return false;
  const re = new RegExp(`^${globToRegex(glob)}$`);
  return re.test(literal);
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^$|()[]{}\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return out;
}
