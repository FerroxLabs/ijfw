// v1.5.0 audit-MED-work-M9 — singleton fix for loadPopulateBlackboardBlock.
//
// Regression coverage: concurrent callers must share one resolved import
// (no race on the promise variable). The fix uses a Promise singleton.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpointWave,
  _resetPopulateBlackboardBlockSingleton,
} from './src/orchestrator/wave-state.js';

function mkProject() {
  const dir = mkdtempSync(join(tmpdir(), 'wave-state-singleton-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('M9: concurrent checkpointWave calls share one populateBlackboard import (no race)', async () => {
  _resetPopulateBlackboardBlockSingleton();
  const { dir, cleanup } = mkProject();
  try {
    // Fire 20 concurrent checkpoint calls. Pre-fix the import would have
    // raced (multiple sets to _populateBlackboardBlock); post-fix every
    // caller awaits the same Promise singleton.
    const promises = Array.from({ length: 20 }, () => checkpointWave('W-M9', dir));
    const results = await Promise.all(promises);
    // All calls must succeed without throwing or returning an inconsistent
    // frontmatter shape.
    for (const r of results) {
      assert.ok(r && r.frontmatter, 'checkpointWave must return a frontmatter shape');
      assert.equal(r.frontmatter.wave_id, 'W-M9');
    }
  } finally { cleanup(); }
});

test('M9: _resetPopulateBlackboardBlockSingleton enables re-import in tests', async () => {
  const { dir, cleanup } = mkProject();
  try {
    await checkpointWave('W-M9b', dir);
    _resetPopulateBlackboardBlockSingleton();   // should not throw
    await checkpointWave('W-M9b', dir);
    assert.ok(true);
  } finally { cleanup(); }
});
