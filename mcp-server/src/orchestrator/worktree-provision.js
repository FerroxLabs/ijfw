/**
 * worktree-provision.js — v1.5.0 S2: auto-detect + install deps in a fresh worktree.
 *
 * Closes the Step 0 briefing gap: subagents in isolation:worktree get a clean
 * git checkout but no node_modules/. Without this, every Node-touching subagent
 * burns its first ~30s npm install-ing.
 *
 * Security: uses node:child_process execFile (NO shell, no string concat).
 * Detector commands + args are frozen literals; cwd is the only per-call
 * variable and is validated via lstat before invocation. `--ignore-scripts`
 * is non-negotiable on npm install. A subagent worktree with malicious
 * package.json {scripts:{preinstall:"..."}} must not execute arbitrary code.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileP = promisify(execFile);

export const DETECTORS = Object.freeze([
  { name: 'node',   file: 'package.json',   cmd: 'npm',   args: ['install', '--no-audit', '--no-fund', '--ignore-scripts'] },
  { name: 'python', file: 'pyproject.toml', cmd: 'pip',   args: ['install', '--quiet', '-e', '.'] },
  { name: 'rust',   file: 'Cargo.toml',     cmd: 'cargo', args: ['fetch'] },
  { name: 'go',     file: 'go.mod',         cmd: 'go',    args: ['mod', 'download'] },
]);

export const DEFAULT_PER_INSTALL_MS = 2 * 60 * 1000;
export const DEFAULT_WALL_MS = 5 * 60 * 1000;

async function firstLevelDirs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => join(root, e.name));
  } catch { return []; }
}

export async function provisionWorktree(worktreePath, opts = {}) {
  const detectors = opts.detectors ?? DETECTORS;
  const perInstallMs = opts.perInstallMs ?? DEFAULT_PER_INSTALL_MS;
  const wallMs = opts.wallMs ?? DEFAULT_WALL_MS;
  const deadline = Date.now() + wallMs;
  const result = { installed: [], skipped: [], failed: [] };

  const candidateDirs = [worktreePath, ...(await firstLevelDirs(worktreePath))];

  for (const det of detectors) {
    if (Date.now() >= deadline) {
      result.skipped.push({ name: det.name, reason: 'wall-deadline' });
      continue;
    }
    for (const dir of candidateDirs) {
      const manifest = join(dir, det.file);
      if (!existsSync(manifest)) continue;
      try {
        const st = await lstat(manifest);
        if (!st.isFile()) { result.skipped.push({ name: det.name, path: dir, reason: 'not-regular-file' }); continue; }
      } catch { result.skipped.push({ name: det.name, path: dir, reason: 'lstat-failed' }); continue; }

      const t0 = Date.now();
      try {
        await execFileP(det.cmd, det.args, { cwd: dir, timeout: perInstallMs, maxBuffer: 16 * 1024 * 1024 });
        result.installed.push({ name: det.name, path: dir, ms: Date.now() - t0 });
      } catch (err) {
        // execFile timeout surfaces as either err.code === 'ETIMEDOUT' OR
        // (err.killed && err.signal === 'SIGTERM'/'SIGKILL') depending on
        // platform/Node version. Detect both to give callers a stable signal.
        const timedOut = err.code === 'ETIMEDOUT'
          || (err.killed && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL'));
        result.failed.push({ name: det.name, path: dir, reason: timedOut ? 'timeout' : (err.code || err.message) });
      }
    }
  }
  return result;
}
