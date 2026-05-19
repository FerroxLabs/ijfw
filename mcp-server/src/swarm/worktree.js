// Conservative git worktree support for prepared swarm tasks.
//
// This module never dispatches agents and never auto-resolves merge conflicts.
// It creates isolated worktrees for code-heavy tasks after the task lifecycle
// has prepared/started them.

import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendBlackboardEvent, listBlackboardTasks, updateBlackboardTask } from '../blackboard.js';
import { createCheckpoint } from '../recovery/checkpoint.js';

export function createTaskWorktree(projectRoot, taskId, options = {}) {
  const root = resolve(projectRoot);
  const task = findTask(root, taskId);
  if (!task.ok) return task;
  if (task.task.status !== 'in_progress' && !options.allowReady) {
    return { ok: false, error: 'task-not-in-progress', task: task.task };
  }
  if (!options.force && !isCodeHeavyTask(task.task)) return { ok: false, error: 'non-code-task', task: task.task };
  if (!isGitRepo(root)) return { ok: false, error: 'not-git-repo' };

  const dirty = git(root, ['status', '--porcelain']);
  if (dirty.status !== 0) return { ok: false, error: 'git-status-unavailable', stderr: dirty.stderr };
  const dirtyUserFiles = dirtyLines(dirty.stdout);
  if (dirtyUserFiles.length && !options.allowDirty) {
    return { ok: false, error: 'dirty-worktree', detail: dirtyUserFiles };
  }

  const baseRef = options.baseRef || 'HEAD';
  const worktreeDir = join(root, '.ijfw', 'worktrees');
  mkdirSync(worktreeDir, { recursive: true, mode: 0o700 });

  // v1.5.0 audit-LOW-teams-#15: safeTaskId collision detection.
  // Two distinct taskIds that normalize to the same safe id (e.g. `task:1`
  // and `task/1` both become `task-1`) would otherwise collide on the same
  // worktree path AND the same branch name. Detect the collision by checking
  // BOTH the worktree dir AND the existing branch list; if either is taken,
  // suffix the safe id with a short content hash of the original taskId so
  // distinct tasks get distinct worktrees + branches.
  const baseSafeId = safeTaskId(taskId);
  let safeId = baseSafeId;
  let candidatePath = join(worktreeDir, safeId);
  let candidateBranch = options.branch || `ijfw/${safeId}`;
  const branchExists = (name) => git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
  if (!options.branch && (existsSync(candidatePath) || branchExists(candidateBranch))) {
    const suffix = createHash('sha256').update(String(taskId)).digest('hex').slice(0, 7);
    safeId = `${baseSafeId}-${suffix}`;
    candidatePath = join(worktreeDir, safeId);
    candidateBranch = `ijfw/${safeId}`;
  }
  const worktreePath = candidatePath;
  if (existsSync(worktreePath)) return { ok: false, error: 'worktree-exists', path: worktreePath };

  createCheckpoint(root, 'before-worktree-create', { actor: 'ijfw', message: taskId });
  const branch = options.branch || candidateBranch;
  const result = git(root, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  if (result.status !== 0) return { ok: false, error: 'worktree-add-failed', stderr: result.stderr, stdout: result.stdout };

  const updated = updateBlackboardTask(root, taskId, {
    worktree: { path: worktreePath, branch, base_ref: baseRef, status: 'created' },
  });
  appendBlackboardEvent(root, {
    type: 'worktree.created',
    actor: 'ijfw',
    task_id: taskId,
    artifact_ids: task.task.artifact_ids || [],
    message: worktreePath,
    data: { branch, baseRef },
  });
  return { ok: true, task: updated.task, path: worktreePath, branch };
}

export function listTaskWorktrees(projectRoot) {
  const root = resolve(projectRoot);
  const tasks = (listBlackboardTasks(root).tasks || []).filter((task) => task.worktree);
  return {
    ok: true,
    worktrees: tasks.map((task) => ({
      task_id: task.id,
      path: task.worktree.path,
      branch: task.worktree.branch,
      status: task.worktree.status,
    })),
  };
}

export function integrateTaskWorktree(projectRoot, taskId, options = {}) {
  const root = resolve(projectRoot);
  const task = findTask(root, taskId);
  if (!task.ok) return task;
  const wt = task.task.worktree;
  if (!wt?.path) return { ok: false, error: 'no-worktree', task: task.task };
  const validation = validateTaskWorktree(root, wt);
  if (!validation.ok) return validation;
  if (!existsSync(validation.path)) return { ok: false, error: 'worktree-missing', path: validation.path };

  const wtDirty = git(validation.path, ['status', '--porcelain']);
  if (wtDirty.status !== 0) return { ok: false, error: 'worktree-status-unavailable', stderr: wtDirty.stderr };
  if (wtDirty.stdout.trim()) return { ok: false, error: 'worktree-has-uncommitted-changes', detail: wtDirty.stdout.trim().split('\n') };

  createCheckpoint(root, 'before-worktree-integrate', { actor: 'ijfw', message: taskId });
  // v1.5.0 audit-LOW-teams-#14: tag merge commits with task-id so
  // `git log --grep="ijfw merge: <task-id>"` recovers the merge boundary
  // even after history rewrites lose the branch label.
  const merge = git(root, ['merge', '--no-ff', '-m', `ijfw merge: ${taskId}`, validation.branch]);
  if (merge.status !== 0) {
    updateBlackboardTask(root, taskId, {
      worktree: { ...wt, status: 'merge-blocked', last_error: merge.stderr || merge.stdout },
    });
    appendBlackboardEvent(root, {
      type: 'worktree.integrate.blocked',
      actor: 'ijfw',
      task_id: taskId,
      artifact_ids: task.task.artifact_ids || [],
      message: 'Merge blocked; preserve worktree for inspection',
      data: { stderr: merge.stderr, stdout: merge.stdout },
    });
    return { ok: false, error: 'merge-blocked', stderr: merge.stderr, stdout: merge.stdout };
  }

  const updated = updateBlackboardTask(root, taskId, {
    worktree: { ...wt, path: validation.path, branch: validation.branch, status: 'integrated', integrated_at: new Date().toISOString() },
  });
  appendBlackboardEvent(root, {
    type: 'worktree.integrated',
    actor: 'ijfw',
    task_id: taskId,
    artifact_ids: task.task.artifact_ids || [],
    message: validation.path,
  });
  if (options.cleanup) cleanupTaskWorktree(root, taskId, { force: true });
  return { ok: true, task: updated.task };
}

export function cleanupTaskWorktree(projectRoot, taskId, options = {}) {
  const root = resolve(projectRoot);
  const task = findTask(root, taskId);
  if (!task.ok) return task;
  const wt = task.task.worktree;
  if (!wt?.path) return { ok: false, error: 'no-worktree', task: task.task };
  const validation = validateTaskWorktree(root, wt);
  if (!validation.ok) return validation;
  if (wt.status !== 'integrated' && !options.force) {
    return { ok: false, error: 'worktree-not-cleanup-ready', status: wt.status };
  }

  const remove = git(root, ['worktree', 'remove', options.force ? '--force' : '', validation.path].filter(Boolean));
  if (remove.status !== 0 && existsSync(validation.path)) return { ok: false, error: 'worktree-remove-failed', stderr: remove.stderr, stdout: remove.stdout };
  if (existsSync(validation.path) && options.force) rmSync(validation.path, { recursive: true, force: true });
  const updated = updateBlackboardTask(root, taskId, {
    worktree: { ...wt, path: validation.path, branch: validation.branch, status: 'cleaned', cleaned_at: new Date().toISOString() },
  });
  appendBlackboardEvent(root, {
    type: 'worktree.cleaned',
    actor: 'ijfw',
    task_id: taskId,
    artifact_ids: task.task.artifact_ids || [],
    message: validation.path,
  });
  return { ok: true, task: updated.task };
}

function findTask(projectRoot, taskId) {
  const tasks = listBlackboardTasks(projectRoot).tasks || [];
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return { ok: false, error: 'task-not-found' };
  return { ok: true, task };
}

function isGitRepo(projectRoot) {
  return git(projectRoot, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

function isCodeHeavyTask(task) {
  const text = [
    ...(task.paths || []),
    ...(task.artifact_ids || []),
    task.owner || '',
    task.title || '',
  ].join(' ').toLowerCase();
  return /\.(js|jsx|ts|tsx|py|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|mjs|cjs)\b/.test(text)
    || /\b(app|api|module|test|runtime|src|code|software|engineer)\b/.test(text);
}

function validateTaskWorktree(projectRoot, wt) {
  const root = resolve(projectRoot);
  const worktreesRoot = resolve(root, '.ijfw', 'worktrees');
  const worktreePath = resolve(root, String(wt.path || ''));
  const pathRel = relative(worktreesRoot, worktreePath);
  if (!pathRel || pathRel.startsWith('..') || isAbsolute(pathRel)) {
    return { ok: false, error: 'invalid-worktree-path', path: wt.path };
  }

  const branch = String(wt.branch || '').trim();
  if (!branch.startsWith('ijfw/')) {
    return { ok: false, error: 'invalid-worktree-branch', branch: wt.branch };
  }

  const listed = git(root, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) {
    return { ok: true, path: worktreePath, branch, warning: 'worktree-list-unavailable' };
  }
  const worktrees = parseWorktreeList(listed.stdout);
  const canonicalWorktreePath = canonicalPath(worktreePath);
  const match = worktrees.some((item) => item.path === canonicalWorktreePath && item.branch === branch);
  if (!match) {
    return { ok: false, error: 'worktree-metadata-mismatch', path: worktreePath, branch };
  }
  return { ok: true, path: worktreePath, branch };
}

function parseWorktreeList(stdout) {
  const items = [];
  let current = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) items.push(current);
      current = { path: canonicalPath(line.slice('worktree '.length).trim()), branch: null };
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === '' && current) {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);
  return items;
}

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function safeTaskId(taskId) {
  return String(taskId).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'task';
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || (res.error ? res.error.message : ''),
  };
}

function dirtyLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).trim();
      return !(path === '.ijfw' || path.startsWith('.ijfw/'));
    });
}
