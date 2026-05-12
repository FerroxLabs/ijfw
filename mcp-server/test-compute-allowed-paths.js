import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __test } from './src/compute/runner.js';

test('compute allowedPaths resolves symlinks before write allow-listing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-allow-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ijfw-allow-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const projectRoot = join(root, 'project');
  const cwd = join(root, 'cwd');
  mkdirSync(projectRoot);
  mkdirSync(cwd);

  const link = join(projectRoot, 'link-out');
  try {
    symlinkSync(outside, link, 'dir');
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'ENOTSUP')) {
      return;
    }
    throw err;
  }
  assert.ok(existsSync(link), 'symlink fixture should exist');

  const result = __test.normalizeAllowedPaths({
    projectRoot,
    cwd,
    allowedPaths: [link],
  });

  assert.deepEqual(result.allowedPaths, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /resolves outside cwd and projectRoot/);
});

test('compute allowedPaths keeps canonical in-project directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-allow-root-'));
  try {
    const projectRoot = join(root, 'project');
    const cwd = join(root, 'cwd');
    const outputDir = join(projectRoot, 'out');
    mkdirSync(projectRoot);
    mkdirSync(cwd);
    mkdirSync(outputDir);

    const result = __test.normalizeAllowedPaths({
      projectRoot,
      cwd,
      allowedPaths: [outputDir, 'relative/path'],
    });

    assert.deepEqual(result.allowedPaths, [realpathSync(outputDir)]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /not absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
