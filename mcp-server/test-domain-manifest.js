/**
 * test-domain-manifest.js
 *
 * IJFW v1.4.0 Wave 4 / t20 — Test suite for domain-manifest auto-load
 * dispatch (src/dispatch/domain-manifest.js).
 *
 * Coverage:
 *   1. project_type book   -> preset book loaded
 *   2. project_type software -> no-op (no preset)
 *   3. project_type unknown -> no-op (no preset)
 *   4. idempotence: second load returns loaded:[]
 *   5. domainManifestStatus reflects cached state
 *   6. never throws on bad input
 *   7. TYPE_TO_PRESET map covers expected keys
 *
 * Isolation: each test swaps process.env.HOME to a fresh mkdtemp so the
 * active-overrides.json side-effect from recordActiveOverride never bleeds
 * across cases. Project roots are also unique tmp dirs.
 *
 * Built-ins only (node:test + node:assert/strict + node:fs/promises).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  domainManifestLoad,
  domainManifestStatus,
  domainManifestDispatch,
  __test,
} from './src/dispatch/domain-manifest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkTmpHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-domain-home-'));
  return home;
}

async function mkProjectRoot(type) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-domain-proj-'));
  if (type) {
    // AGENTS.md frontmatter `type:` is the detector's 0.9-weight signal
    // and is what the brief calls out as the safer dual-write target.
    await fs.writeFile(
      path.join(root, 'AGENTS.md'),
      `---\ntype: ${type}\n---\n\n# project\n`,
      'utf8',
    );
    // Belt-and-braces: also drop .ijfw/project.type (the cached A3 result).
    const ijfwDir = path.join(root, '.ijfw');
    await fs.mkdir(ijfwDir, { recursive: true });
    await fs.writeFile(
      path.join(ijfwDir, 'project.type'),
      JSON.stringify({ type, primary_type: type, confidence: 1.0 }, null, 2),
      'utf8',
    );
  }
  return root;
}

function withHome(home, fn) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('domainManifestLoad: project_type=book maps to preset book', async () => {
  const home = await mkTmpHome();
  const root = await mkProjectRoot('book');
  await withHome(home, async () => {
    const r = await domainManifestLoad(root);
    assert.equal(r.project_type, 'book', 'detect should classify book');
    assert.deepEqual(r.loaded, ['book'], 'preset book should be newly loaded');
    assert.equal(typeof r.duration_ms, 'number');
    assert.ok(!r.error, 'no error on happy path');
  });
});

test('domainManifestLoad: project_type=software is a no-op', async () => {
  const home = await mkTmpHome();
  const root = await mkProjectRoot('software');
  await withHome(home, async () => {
    const r = await domainManifestLoad(root);
    assert.equal(r.project_type, 'software');
    assert.deepEqual(r.loaded, [], 'software has no preset mapping');
  });
});

test('domainManifestLoad: unknown project type is a no-op', async () => {
  const home = await mkTmpHome();
  const root = await mkProjectRoot(null); // no AGENTS.md, no .ijfw
  await withHome(home, async () => {
    const r = await domainManifestLoad(root);
    // Empty tmp dir classifies as unknown (confidence 0).
    assert.equal(r.project_type, 'unknown');
    assert.deepEqual(r.loaded, []);
  });
});

test('domainManifestLoad: idempotent on repeat invocation', async () => {
  const home = await mkTmpHome();
  const root = await mkProjectRoot('book');
  await withHome(home, async () => {
    const first = await domainManifestLoad(root);
    assert.deepEqual(first.loaded, ['book'], 'first call loads book');

    const second = await domainManifestLoad(root);
    assert.deepEqual(
      second.loaded,
      [],
      'second call short-circuits — preset already in active_overrides',
    );
    assert.equal(second.project_type, 'book');
  });
});

test('domainManifestStatus reflects cached state after load', async () => {
  const home = await mkTmpHome();
  const root = await mkProjectRoot('book');
  await withHome(home, async () => {
    const before = await domainManifestStatus(root);
    assert.deepEqual(before.active_presets, [], 'no presets active pre-load');
    assert.equal(before.cached, false);

    await domainManifestLoad(root);

    const after = await domainManifestStatus(root);
    assert.equal(after.project_type, 'book');
    assert.deepEqual(after.active_presets, ['book']);
    assert.equal(after.cached, true);
  });
});

test('domainManifestLoad: never throws on a fake project root', async () => {
  const home = await mkTmpHome();
  const fakePath = `/totally/fake/path/${Date.now()}-${Math.random()}`;
  await withHome(home, async () => {
    const r = await domainManifestLoad(fakePath);
    assert.ok(Array.isArray(r.loaded), 'loaded is array even on bad input');
    assert.equal(typeof r.project_type, 'string', 'project_type is string');
    // Fake path -> detect returns 'unknown' or swallows -> 'unknown'.
    assert.equal(r.project_type, 'unknown');
    assert.deepEqual(r.loaded, []);
  });
});

test('__test.TYPE_TO_PRESET maps expected keys', () => {
  const map = __test.TYPE_TO_PRESET;
  assert.equal(map.book, 'book', 'book -> book');
  assert.equal(map.content, 'book', 'content -> book (closest narrative)');
  assert.equal(map.business, 'campaign', 'business -> campaign');
  assert.equal(map.design, 'campaign', 'design -> campaign');
  assert.equal(map.software, null, 'software is a no-op');
  assert.equal(map.mixed, null, 'mixed requires user choice');
  assert.equal(map.unknown, null, 'unknown is a no-op');
});

test('__test surface: resolveProjectType + activePresetsForProject exported', () => {
  assert.equal(typeof __test.resolveProjectType, 'function');
  assert.equal(typeof __test.activePresetsForProject, 'function');
  // activePresetsForProject empty-state contract.
  assert.deepEqual(__test.activePresetsForProject({ projects: {} }, '/x'), []);
  assert.deepEqual(__test.activePresetsForProject(null, '/x'), []);
});

test('domainManifestDispatch routes load + status + rejects unknown', async () => {
  const home = await mkTmpHome();
  const root = await mkProjectRoot('book');
  await withHome(home, async () => {
    const loadRes = await domainManifestDispatch({ command: 'load', projectRoot: root });
    assert.equal(loadRes.ok, true);
    assert.equal(loadRes.command, 'load');
    assert.deepEqual(loadRes.result.loaded, ['book']);

    const statusRes = await domainManifestDispatch({ command: 'status', projectRoot: root });
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.result.cached, true);

    const bogus = await domainManifestDispatch({ command: 'wat', projectRoot: root });
    assert.equal(bogus.ok, false);
    assert.match(bogus.error, /unknown domain-manifest command/);
  });
});
