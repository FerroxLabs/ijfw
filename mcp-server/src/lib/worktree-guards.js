/**
 * worktree-guards.js — v1.5.0-major S08: incident-driven worktree safety guards.
 *
 * Lifted from GSD executor (battle-tested across many incidents):
 *   #3097 — cwd-drift assertion
 *   #3099 — absolute-path containment check
 *   #2924 — protected-ref deny-list (refuse commit to main/master/develop/trunk/release/*)
 *
 * We hit ALL THREE during v1.5.0-major dispatch (multiple subagents drifted
 * cwd into other worktrees; W11-A0 accidentally committed to main because
 * branch creation failed). Three small functions, large blast-radius reduction.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, isAbsolute, relative } from 'node:path';

// r15-H2: resolve symlinks before containment check. Without this, a path like
// <toplevel>/escape-link/foo (where escape-link → /etc) trivially escapes the
// toplevel even though `relative(toplevel, path)` reports a non-`..` result for
// the lexical path. realpathSync resolves the link first. If the path does not
// exist yet (e.g. a not-yet-created file we're about to write), realpathSync
// throws ENOENT — we fall back to the input path since a not-yet-existing
// target is still a valid containment surface to check lexically.
function safeRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

const PROTECTED_REF_PATTERNS = [
  /^main$/, /^master$/, /^develop$/, /^trunk$/,
  /^release\//, /^prod$/, /^production$/,
];

/**
 * #3097 — Assert that current working directory matches the captured spawn-time
 * git toplevel. Returns the captured toplevel for later use. Throws if drift detected.
 *
 * @param {string} capturedToplevel - what was `git rev-parse --show-toplevel` at spawn
 * @param {string} cwd - current working directory (default: process.cwd())
 * @returns {string} the captured toplevel (passthrough on success)
 * @throws Error if cwd drifted off the captured toplevel
 */
export function assertNoCwdDrift(capturedToplevel, cwd = process.cwd()) {
  if (!capturedToplevel) throw new Error('worktree-guards: capturedToplevel required (call captureSpawnToplevel() at spawn)');
  let currentTop;
  try {
    currentTop = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`worktree-guards: cwd is not a git tree: ${cwd}`);
  }
  if (currentTop !== capturedToplevel) {
    throw new Error(`worktree-guards: cwd drift detected! spawn=${capturedToplevel}, now=${currentTop}`);
  }
  return capturedToplevel;
}

/**
 * Capture the spawn-time toplevel for later drift assertion.
 */
export function captureSpawnToplevel(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

/**
 * #3099 — Assert that an absolute file path is contained within the toplevel.
 * Refuses operations that would read/write outside the expected worktree.
 *
 * @param {string} absolutePath - path to check
 * @param {string} toplevel - git toplevel (from captureSpawnToplevel)
 * @returns {string} the path (passthrough on success)
 * @throws if path escapes toplevel
 */
export function assertPathWithinToplevel(absolutePath, toplevel) {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`worktree-guards: path must be absolute (got: ${absolutePath})`);
  }
  // r15-H2: resolve symlinks on BOTH path AND toplevel before comparing.
  // A path that lexically starts with toplevel can still escape via a symlink
  // (e.g. <toplevel>/escape-link/foo where escape-link → /etc). Resolving
  // both ends through realpath catches the real-fs destination.
  const resolvedPath = safeRealpath(absolutePath);
  const resolvedTop  = safeRealpath(toplevel);
  const rel = relative(resolvedTop, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`worktree-guards: path escapes toplevel! path=${absolutePath} (resolved: ${resolvedPath}), toplevel=${toplevel} (resolved: ${resolvedTop})`);
  }
  return absolutePath;
}

/**
 * #2924 — Assert the current HEAD is NOT pointing at a protected ref before commit.
 * Subagents must commit to a wave branch (wave/W*-*), never directly to main/master/etc.
 *
 * @param {string} cwd
 * @returns {string} the current branch name (passthrough on success)
 * @throws if HEAD is on a protected ref
 */
export function assertNotProtectedRef(cwd = process.cwd()) {
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim();
  if (!branch) {
    throw new Error('worktree-guards: detached HEAD — cannot commit safely');
  }
  for (const pattern of PROTECTED_REF_PATTERNS) {
    if (pattern.test(branch)) {
      throw new Error(`worktree-guards: refuse to commit to protected ref: ${branch}. Switch to a wave/feature branch first.`);
    }
  }
  return branch;
}

/**
 * Convenience: run all 3 guards in sequence before a commit. Returns the verified branch.
 */
export function preCommitGuards(capturedToplevel, paths = []) {
  assertNoCwdDrift(capturedToplevel);
  for (const p of paths) assertPathWithinToplevel(resolve(p), capturedToplevel);
  return assertNotProtectedRef();
}
