/**
 * test-cross-project-tenant.js
 *
 * P4 tenant isolation for cross-project search.
 *
 * Bug: ijfw_cross_project_search at scope:'all' read EVERY registered project's
 * memory with no tenant filter -- so a "search all my projects" in Company A's
 * repo could surface Company B's memory (the exact "separate companies separate
 * brains" concern). Fix: opt-in `.ijfw/tenant` per project; cross-project search
 * only surfaces projects in the caller's tenant. Default tenant == default, so
 * single-tenant users see no behavior change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { crossProjectSearch, resolveProjectTenant, DEFAULT_TENANT, _resetCorpusCache } from './src/cross-project-search.js';

async function mkProject(tenant, token) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-tenant-'));
  await fs.mkdir(path.join(dir, '.ijfw', 'memory'), { recursive: true });
  if (tenant !== null) {
    await fs.writeFile(path.join(dir, '.ijfw', 'tenant'), tenant + '\n');
  }
  await fs.writeFile(path.join(dir, '.ijfw', 'memory', 'knowledge.md'), `SHAREDTOKEN appears here. unique ${token}.\n`);
  return dir;
}

// Inject a memory reader so the test doesn't depend on server.js's file layout.
function readerFor(map) {
  return (canonical) => map.get(realpathSync(canonical)) || {};
}

test('resolveProjectTenant: declared tenant wins, absent => default', async () => {
  const withTenant = await mkProject('alpha', 'a');
  const without = await mkProject(null, 'n');
  assert.equal(resolveProjectTenant(realpathSync(withTenant)), 'alpha');
  assert.equal(resolveProjectTenant(realpathSync(without)), DEFAULT_TENANT);
});

test('cross-project search isolates by tenant', async () => {
  _resetCorpusCache();
  const projA = await mkProject('alpha', 'AAA');
  const projB = await mkProject('beta', 'BBB');
  const allowedRoots = [realpathSync(os.tmpdir())];
  const mem = new Map([
    [realpathSync(projA), { knowledge: 'SHAREDTOKEN AAA-content' }],
    [realpathSync(projB), { knowledge: 'SHAREDTOKEN BBB-content' }],
  ]);
  const projects = [{ path: projA }, { path: projB }];

  // Caller in tenant 'alpha' must NOT see projB (tenant 'beta').
  const hitsA = crossProjectSearch('SHAREDTOKEN', projects, readerFor(mem), {
    tenant: 'alpha', allowedRoots, useCache: false,
  });
  assert.ok(hitsA.length > 0, 'should find SHAREDTOKEN in the caller-tenant project');
  assert.ok(hitsA.every((h) => h.project === path.basename(projA)), 'all hits must be from the alpha project');
  assert.ok(!hitsA.some((h) => h.project === path.basename(projB)), 'beta project must NOT leak into alpha search');
});

test('default tenant: backward-compatible (no .ijfw/tenant => everything visible)', async () => {
  _resetCorpusCache();
  const projA = await mkProject(null, 'AAA'); // no tenant declared
  const projB = await mkProject(null, 'BBB');
  const allowedRoots = [realpathSync(os.tmpdir())];
  const mem = new Map([
    [realpathSync(projA), { knowledge: 'SHAREDTOKEN AAA' }],
    [realpathSync(projB), { knowledge: 'SHAREDTOKEN BBB' }],
  ]);
  const projects = [{ path: projA }, { path: projB }];
  // No tenant passed by caller => 'default'; both projects default => both visible.
  const hits = crossProjectSearch('SHAREDTOKEN', projects, readerFor(mem), { allowedRoots, useCache: false });
  const seen = new Set(hits.map((h) => h.project));
  assert.ok(seen.has(path.basename(projA)) && seen.has(path.basename(projB)), 'both default-tenant projects must be searchable (no regression)');
});
