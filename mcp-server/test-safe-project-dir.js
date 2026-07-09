/**
 * test-safe-project-dir.js -- bundle-internal project-root rejection.
 *
 * Hardens against FerroxLabs/wayland#755: Wayland spawned the installed
 * mcp-server with cwd inside its own signed bundle
 * (Wayland.app/Contents/Resources/app.asar.unpacked/...). The old
 * safeProjectDir() accepted any WRITABLE cwd, so the layout migration wrote
 * .ijfw/.layout-version inside the bundle, broke the codesign seal, and
 * macOS then blocked every child process the app spawned.
 *
 * Contract under test:
 *   1. isBundleInternalPath(): segment-match rejection of *.asar,
 *      *.asar.unpacked, and *.app/Contents (case-insensitive) at any depth.
 *   2. safeProjectDir(): every candidate (IJFW_PROJECT_DIR,
 *      CLAUDE_PROJECT_DIR, cwd) passes the bundle gate; rejection falls
 *      through to the next-safest option and never throws; HOME is the
 *      terminal fallback.
 *   3. Rejection happens BEFORE the writability probe, so a rejected
 *      candidate directory is never created as a side-effect.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { isBundleInternalPath, safeProjectDir } from './src/server.js';

// --- env/cwd isolation ------------------------------------------------------

const ORIG_CWD = process.cwd();
const SAVED = {};
const ENV_KEYS = ['IJFW_PROJECT_DIR', 'CLAUDE_PROJECT_DIR'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  process.chdir(ORIG_CWD);
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

function mkTmp() {
  return mkdtempSync(join(os.tmpdir(), 'ijfw-spd-'));
}

// --- isBundleInternalPath: rejections ----------------------------------------

test('rejects the exact wayland#755 spawn cwd (app.asar.unpacked)', () => {
  assert.equal(
    isBundleInternalPath(
      '/Applications/Wayland.app/Contents/Resources/app.asar.unpacked/node_modules/@ijfw/memory-server',
    ),
    true,
  );
});

test('rejects an app.asar segment at any depth', () => {
  assert.equal(isBundleInternalPath('/opt/foo/app.asar/inner'), true);
  assert.equal(isBundleInternalPath('/opt/foo/bar/baz/app.asar'), true);
});

test('rejects non-"app" asar archive names too (electron.asar)', () => {
  assert.equal(isBundleInternalPath('/opt/x/electron.asar/lib'), true);
  assert.equal(isBundleInternalPath('/opt/x/custom.asar.unpacked/lib'), true);
});

test('rejects *.app/Contents case-insensitively', () => {
  assert.equal(isBundleInternalPath('/Applications/Wayland.APP/contents/MacOS'), true);
  assert.equal(isBundleInternalPath('/Applications/wayland.app/Contents'), true);
});

test('rejects Windows-style separators', () => {
  assert.equal(
    isBundleInternalPath('C:\\Program Files\\Wayland\\resources\\app.asar.unpacked\\srv'),
    true,
  );
});

// --- isBundleInternalPath: non-rejections (no false positives) ---------------

test('accepts a normal project path', () => {
  assert.equal(isBundleInternalPath('/Users/sean/dev/ijfw'), false);
});

test('accepts a directory merely NAMED *.app when not followed by Contents', () => {
  assert.equal(isBundleInternalPath('/Users/sean/dev/my.app'), false);
  assert.equal(isBundleInternalPath('/Users/sean/dev/my.app/src'), false);
});

test('accepts paths containing "Contents" without a *.app parent', () => {
  assert.equal(isBundleInternalPath('/data/Contents/project'), false);
});

test('accepts asar-adjacent names that are not asar segments', () => {
  assert.equal(isBundleInternalPath('/dev/asar-tools'), false);
  assert.equal(isBundleInternalPath('/dev/app.asar-notes'), false);
});

test('null/empty/non-string input is safely false, never a throw', () => {
  assert.equal(isBundleInternalPath(null), false);
  assert.equal(isBundleInternalPath(''), false);
  assert.equal(isBundleInternalPath(undefined), false);
  assert.equal(isBundleInternalPath(42), false);
});

// --- safeProjectDir: candidate chain ------------------------------------------

test('IJFW_PROJECT_DIR is the highest-priority signal when valid', () => {
  const dir = mkTmp();
  try {
    process.env.IJFW_PROJECT_DIR = dir;
    process.env.CLAUDE_PROJECT_DIR = mkTmp(); // present but must lose
    assert.equal(safeProjectDir(), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle-internal IJFW_PROJECT_DIR is rejected and falls through to CLAUDE_PROJECT_DIR', () => {
  const claudeDir = mkTmp();
  try {
    process.env.IJFW_PROJECT_DIR =
      '/Applications/Wayland.app/Contents/Resources/app.asar.unpacked/srv';
    process.env.CLAUDE_PROJECT_DIR = claudeDir;
    assert.equal(safeProjectDir(), claudeDir);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('rejection happens before the writability probe: rejected dir is never created', () => {
  const tmp = mkTmp();
  try {
    const bundleDir = join(tmp, 'Fake.app', 'Contents', 'Resources', 'app.asar.unpacked');
    process.env.IJFW_PROJECT_DIR = bundleDir;
    safeProjectDir();
    assert.equal(
      existsSync(bundleDir),
      false,
      'safeProjectDir must not mkdir a rejected bundle-internal candidate',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('wayland#755 scenario: writable bundle-internal cwd is skipped, never crashes', () => {
  const tmp = mkTmp();
  try {
    // A real, WRITABLE directory shaped like a signed bundle interior --
    // exactly what Wayland used as spawn cwd. Old code returned it.
    const bundleCwd = join(tmp, 'Wayland.app', 'Contents', 'Resources', 'app.asar.unpacked');
    mkdirSync(bundleCwd, { recursive: true });
    process.chdir(bundleCwd);
    let result;
    assert.doesNotThrow(() => { result = safeProjectDir(); });
    assert.equal(
      isBundleInternalPath(result),
      false,
      `resolved root must not be bundle-internal, got: ${result}`,
    );
    assert.notEqual(result, bundleCwd, 'must not adopt the bundle-internal cwd');
    // With no env candidates and a rejected cwd, HOME is the fallback.
    assert.equal(result, os.homedir());
  } finally {
    process.chdir(ORIG_CWD);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('normal writable cwd is still accepted when no env candidates exist', () => {
  const dir = mkTmp();
  try {
    process.chdir(dir);
    // macOS tmpdir may resolve through /private symlink; compare realpaths
    // via the value safeProjectDir derives from process.cwd() itself.
    assert.equal(safeProjectDir(), process.cwd());
  } finally {
    process.chdir(ORIG_CWD);
    rmSync(dir, { recursive: true, force: true });
  }
});
