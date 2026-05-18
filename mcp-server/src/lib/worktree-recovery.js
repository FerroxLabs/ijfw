/**
 * worktree-recovery.js — v1.5.0-major S10: transactional cleanup tail for worktrees.
 *
 * Pattern lifted from GSD code-fixer (crash-safe recovery on next run):
 *   1. BEFORE opening the crash window (git worktree remove), write a sentinel
 *      file at .planning/<phase>/.worktree-recovery-pending.json with:
 *        { worktreePath, branch, phase, ts, op: 'remove' }
 *   2. Run the destructive op.
 *   3. On success, DELETE the sentinel.
 *
 * Next run scans for orphan sentinels and offers/runs cleanup. Survives:
 *   - Process SIGKILL between steps 1+2
 *   - Power loss / OOM between steps 2+3
 *   - Network filesystem partition during step 2
 *
 * Use this for ANY destructive op where a partial state on disk is worse
 * than a fully-committed or fully-rolled-back state.
 */

import { writeFile, readFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const SENTINEL_PREFIX = '.worktree-recovery-pending.';

/**
 * Write a recovery sentinel, run the op, delete on success.
 * @param {object} sentinelData - serialised into JSON; should include worktreePath + op
 * @param {function} op - async function to execute; if it throws, sentinel remains
 * @param {string} projectRoot - parent project root
 * @returns the op's return value
 */
export async function withRecoverySentinel(sentinelData, op, projectRoot) {
  const sentinelDir = join(projectRoot, '.planning', 'worktree-recovery');
  await mkdir(sentinelDir, { recursive: true });
  const sentinelId = randomBytes(6).toString('hex');
  const sentinelPath = join(sentinelDir, `${SENTINEL_PREFIX}${sentinelId}.json`);
  const payload = { ...sentinelData, sentinel_id: sentinelId, ts: new Date().toISOString() };

  await writeFile(sentinelPath, JSON.stringify(payload, null, 2), 'utf8');
  try {
    const result = await op();
    try { await unlink(sentinelPath); } catch { /* missing → ok */ }
    return result;
  } catch (err) {
    // Leave sentinel in place for next run to recover.
    err.sentinelPath = sentinelPath;
    throw err;
  }
}

/**
 * Scan for orphan sentinels (op didn't complete on previous run).
 * @returns array of sentinel objects with full payload + path
 */
export async function listPendingRecoveries(projectRoot) {
  const sentinelDir = join(projectRoot, '.planning', 'worktree-recovery');
  try {
    const entries = await readdir(sentinelDir);
    const pending = [];
    for (const name of entries) {
      if (!name.startsWith(SENTINEL_PREFIX)) continue;
      const fullPath = join(sentinelDir, name);
      try {
        const raw = await readFile(fullPath, 'utf8');
        pending.push({ ...JSON.parse(raw), path: fullPath });
      } catch { /* malformed, skip */ }
    }
    return pending;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Attempt to complete a pending recovery. Currently handles op:'remove' for worktrees.
 * Returns { ok, action, details? }.
 */
export async function recoverPending(sentinel, projectRoot) {
  if (sentinel.op === 'remove' && sentinel.worktreePath) {
    try {
      // Best-effort: if the worktree dir still exists, finish the remove.
      if (existsSync(sentinel.worktreePath)) {
        execFileSync('git', ['worktree', 'remove', '--force', sentinel.worktreePath], {
          cwd: projectRoot, encoding: 'utf8',
        });
      }
      // Always prune to clean up dangling .git/worktrees/ refs.
      execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot, encoding: 'utf8' });
      await unlink(sentinel.path);
      return { ok: true, action: 'completed-remove', worktreePath: sentinel.worktreePath };
    } catch (err) {
      return { ok: false, action: 'remove-failed', error: err.message };
    }
  }
  return { ok: false, action: 'unknown-op', op: sentinel.op };
}
