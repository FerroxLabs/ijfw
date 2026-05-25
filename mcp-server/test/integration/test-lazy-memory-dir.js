import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrainPaths } from '../../src/brain/paths.js';
import { writeLayoutVersion } from '../../src/brain/layout-sentinel.js';

test('paths() re-reads layout sentinel each call (no module-load caching)', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-lazy-'));
  try {
    mkdirSync(join(root, '.ijfw'), { recursive: true });

    // Call 1: sentinel missing → v1 paths (hidden)
    const p1 = resolveBrainPaths(root);
    assert.equal(p1.layoutVersion, 1);
    assert.equal(p1.memoryDir, join(root, '.ijfw', 'memory'));

    // Flip the sentinel mid-execution
    writeLayoutVersion(root, 2);

    // Call 2: same process, same root → v2 paths (visible)
    const p2 = resolveBrainPaths(root);
    assert.equal(p2.layoutVersion, 2);
    assert.equal(p2.memoryDir, join(root, 'ijfw', 'memory'));

    // Internal paths must remain under .ijfw/ at BOTH versions
    assert.equal(p1.indexDb, p2.indexDb);
    assert.equal(p1.stateDir, p2.stateDir);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
