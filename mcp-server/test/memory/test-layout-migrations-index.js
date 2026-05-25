import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT_MIGRATIONS, runLayoutMigrations } from '../../src/memory/layout-migrations/index.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('LAYOUT_MIGRATIONS registry is non-empty and well-formed', () => {
  assert.ok(Array.isArray(LAYOUT_MIGRATIONS));
  assert.ok(LAYOUT_MIGRATIONS.length >= 1);
  for (const m of LAYOUT_MIGRATIONS) {
    assert.equal(typeof m.up, 'function');
    assert.equal(typeof m.DESCRIPTION, 'string');
  }
});

test('runLayoutMigrations invokes every registered up()', async () => {
  const root = mkdtempSync(join(tmpdir(), 'layout-mig-'));
  try {
    // visible-layer migration requires .ijfw/ to exist for the lock file.
    mkdirSync(join(root, '.ijfw'), { recursive: true });
    const results = await runLayoutMigrations(root);
    assert.equal(results.length, LAYOUT_MIGRATIONS.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
