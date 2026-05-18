/**
 * test-lib-worktree-guards.js — v1.5.0-major W12-A S08
 *
 * 10 tests for mcp-server/src/lib/worktree-guards.js
 * Covers 3 incident-driven guards: cwd-drift (#3097), abs-path containment (#3099),
 * protected-ref deny-list (#2924), plus preCommitGuards integration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureSpawnToplevel,
  assertNoCwdDrift,
  assertPathWithinToplevel,
  assertNotProtectedRef,
  preCommitGuards,
} from './src/lib/worktree-guards.js';

/** Create a throwaway git repo on a given branch. Returns its toplevel path. */
function makeRepo(branch = 'wave/W12-A/test') {
  const dir = mkdtempSync(join(tmpdir(), 'wt-guards-'));
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  // git init resolves the toplevel through realpath (macOS /var -> /private/var)
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim();
  return { dir: top, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('1. captureSpawnToplevel + assertNoCwdDrift happy path (same dir)', () => {
  const { dir, cleanup } = makeRepo();
  try {
    const top = captureSpawnToplevel(dir);
    assert.equal(top, dir);
    const result = assertNoCwdDrift(top, dir);
    assert.equal(result, top);
  } finally {
    cleanup();
  }
});

test('2. assertNoCwdDrift throws when cwd is a different worktree', () => {
  const a = makeRepo();
  const b = makeRepo();
  try {
    const topA = captureSpawnToplevel(a.dir);
    assert.throws(
      () => assertNoCwdDrift(topA, b.dir),
      /cwd drift detected/,
    );
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('3. assertNoCwdDrift throws when cwd is not a git tree', () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'wt-guards-nogit-'));
  try {
    assert.throws(
      () => assertNoCwdDrift('/some/captured/toplevel', nonGit),
      /cwd is not a git tree/,
    );
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test('4. assertPathWithinToplevel happy path — file under toplevel', () => {
  const { dir, cleanup } = makeRepo();
  try {
    const p = join(dir, 'src', 'foo.js');
    const result = assertPathWithinToplevel(p, dir);
    assert.equal(result, p);
  } finally {
    cleanup();
  }
});

test('5. assertPathWithinToplevel throws on `..` escape', () => {
  const { dir, cleanup } = makeRepo();
  try {
    // resolve manually: dir is /tmp/wt-guards-XYZ ; escape to /tmp
    const parent = join(dir, '..');
    assert.throws(
      () => assertPathWithinToplevel(parent, dir),
      /path escapes toplevel/,
    );
  } finally {
    cleanup();
  }
});

test('6. assertPathWithinToplevel throws on absolute path outside toplevel', () => {
  const { dir, cleanup } = makeRepo();
  try {
    assert.throws(
      () => assertPathWithinToplevel('/etc/passwd', dir),
      /path escapes toplevel/,
    );
  } finally {
    cleanup();
  }
});

test('7. assertNotProtectedRef throws on `main`', () => {
  const { dir, cleanup } = makeRepo('main');
  try {
    assert.throws(
      () => assertNotProtectedRef(dir),
      /refuse to commit to protected ref: main/,
    );
  } finally {
    cleanup();
  }
});

test('8. assertNotProtectedRef throws on `release/v1.0`', () => {
  const { dir, cleanup } = makeRepo('release/v1.0');
  try {
    assert.throws(
      () => assertNotProtectedRef(dir),
      /refuse to commit to protected ref: release\/v1\.0/,
    );
  } finally {
    cleanup();
  }
});

test('9. assertNotProtectedRef passes on `wave/W12-A/test`', () => {
  const { dir, cleanup } = makeRepo('wave/W12-A/test');
  try {
    const branch = assertNotProtectedRef(dir);
    assert.equal(branch, 'wave/W12-A/test');
  } finally {
    cleanup();
  }
});

// r15-H2: regression for the symlink-escape bug. Without realpathSync,
// `/worktree/escape-link/foo` (where escape-link → /etc) lexically appears
// inside the toplevel and passes containment — but in reality it escapes
// to /etc. assertPathWithinToplevel must resolve symlinks first.
test('11. r15-H2: assertPathWithinToplevel throws when path escapes via symlink', () => {
  const { dir, cleanup } = makeRepo();
  const escapeTarget = mkdtempSync(join(tmpdir(), 'wt-escape-target-'));
  try {
    writeFileSync(join(escapeTarget, 'secret.txt'), 'secret\n');
    // Create a symlink INSIDE the worktree that points OUTSIDE it.
    const linkInside = join(dir, 'escape-link');
    symlinkSync(escapeTarget, linkInside);
    const lexicallyInside = join(linkInside, 'secret.txt');
    // Without realpath: relative(dir, lexicallyInside) is "escape-link/secret.txt"
    // which does NOT start with ".." — false-pass. WITH realpath, the link
    // resolves to escapeTarget which is outside dir → must throw.
    assert.throws(
      () => assertPathWithinToplevel(lexicallyInside, dir),
      /path escapes toplevel/,
      'symlink that escapes toplevel must be rejected by realpath resolution',
    );
  } finally {
    cleanup();
    rmSync(escapeTarget, { recursive: true, force: true });
  }
});

test('10. preCommitGuards integration — all 3 guards pass in concert', () => {
  const { dir, cleanup } = makeRepo('wave/W12-A/test');
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    const top = captureSpawnToplevel();
    const branch = preCommitGuards(top, [join(dir, 'README.md')]);
    assert.equal(branch, 'wave/W12-A/test');
  } finally {
    process.chdir(origCwd);
    cleanup();
  }
});
