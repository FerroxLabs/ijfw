import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolveBrainPaths, brainPaths } from '../../src/brain/paths.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

test('v1 (no sentinel) → hidden paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-paths-'));
  try {
    const result = resolveBrainPaths(root);
    assert.strictEqual(result.layoutVersion, 1);
    assert.strictEqual(result.contentDir, join(root, '.ijfw'));
    assert.strictEqual(result.memoryDir, join(root, '.ijfw', 'memory'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v2 (sentinel=2) → visible paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-paths-'));
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    writeLayoutVersion(root, 2);

    const result = resolveBrainPaths(root);
    assert.strictEqual(result.layoutVersion, 2);
    assert.strictEqual(result.contentDir, join(root, 'ijfw'));
    assert.strictEqual(result.memoryDir, join(root, 'ijfw', 'memory'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('internal paths always hidden', () => {
  const root1 = mkdtempSync(join(tmpdir(), 'brain-paths-'));
  const root2 = mkdtempSync(join(tmpdir(), 'brain-paths-'));
  try {
    // Test at v1
    const resultV1 = resolveBrainPaths(root1);
    assert.strictEqual(resultV1.indexDb, join(root1, '.ijfw', 'index', 'memory.db'));
    assert.strictEqual(resultV1.stateDir, join(root1, '.ijfw', 'state'));

    // Test at v2
    mkdirSync(join(root2, '.ijfw'), { recursive: true });
    writeLayoutVersion(root2, 2);
    const resultV2 = resolveBrainPaths(root2);
    assert.strictEqual(resultV2.indexDb, join(root2, '.ijfw', 'index', 'memory.db'));
    assert.strictEqual(resultV2.stateDir, join(root2, '.ijfw', 'state'));
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test('re-reads sentinel each call', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-paths-'));
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });

    // First call: v1
    const result1 = resolveBrainPaths(root);
    assert.strictEqual(result1.layoutVersion, 1);
    assert.strictEqual(result1.contentDir, join(root, '.ijfw'));

    // Flip sentinel to v2
    writeLayoutVersion(root, 2);

    // Second call: should see v2
    const result2 = resolveBrainPaths(root);
    assert.strictEqual(result2.layoutVersion, 2);
    assert.strictEqual(result2.contentDir, join(root, 'ijfw'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('brainPaths alias exports resolveBrainPaths', () => {
  assert.strictEqual(brainPaths, resolveBrainPaths);
});
