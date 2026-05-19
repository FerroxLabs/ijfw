#!/usr/bin/env node
/**
 * test-deploy-alerts.js -- v1.5.0 wire-W2.design-misc.
 *
 * Regression for the null-entry NPE in recordDeployFailure. The original
 * code on line 71 was:
 *
 *   platform: typeof f && f.platform ? String(f.platform) : 'unknown'
 *
 * `typeof f` is always a non-empty string (even for null/undefined: "object"
 * and "undefined" respectively), so the `&&` short-circuit never fires and
 * the expression evaluates as `f.platform`. A null `f` in record.failures
 * therefore threw TypeError mid-map instead of falling back to 'unknown'.
 * Adjacent fields `skillName` + `error` already used the correct
 * `f && f.platform` guard. W2 normalises platform to match.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordDeployFailure } from './src/deploy-alerts.js';

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ijfw-w2-deploy-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve(fn(home)).finally(() => {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
}

test('wire-W2.design-misc: null entry in failures array does not throw', async () => {
  await withTempHome(async () => {
    const r = await recordDeployFailure({
      extension: 'demo',
      failures: [
        null,                                  // <-- before W2, this threw
        undefined,                             // <-- same
        { platform: 'codex', error: 'boom' },  // valid entry
      ],
    });
    assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
    // The null entries should be normalised to 'unknown' rather than throw.
  });
});

test('wire-W2.design-misc: valid entries round-trip with platform + error', async () => {
  await withTempHome(async (home) => {
    const r = await recordDeployFailure({
      extension: 'demo',
      failures: [{ platform: 'codex', skillName: 's', error: 'boom' }],
    });
    assert.equal(r.ok, true);
    // The failures file should contain the entry.
    const path = join(home, '.ijfw', 'state', 'deploy-failures.jsonl');
    assert.ok(existsSync(path), 'deploy-failures.jsonl must be written');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.extension, 'demo');
    assert.equal(last.failures[0].platform, 'codex');
    assert.equal(last.failures[0].error, 'boom');
  });
});

test('wire-W2.design-misc: invalid record inputs reject cleanly', async () => {
  await withTempHome(async () => {
    const a = await recordDeployFailure(null);
    assert.equal(a.ok, false);
    assert.match(a.error, /record/);
    const b = await recordDeployFailure({ extension: '', failures: [] });
    assert.equal(b.ok, false);
    assert.match(b.error, /extension/);
    const c = await recordDeployFailure({ extension: 'x', failures: 'nope' });
    assert.equal(c.ok, false);
    assert.match(c.error, /failures/);
  });
});
