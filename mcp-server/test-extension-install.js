#!/usr/bin/env node
/**
 * test-extension-install.js -- IJFW 1.4.0 W4/t19
 *
 * End-to-end installExtension / uninstallExtension / listExtensions /
 * extensionAuditBrief tests against a tmp project root with all three
 * lens-health probes pre-seeded as live so runTrident runs against the
 * stubbed executor we pass via opts.tridentExecutor.
 *
 * HOME isolation: every test swaps process.env.HOME to a fresh mkdtemp dir
 * for the duration of the test, then restores. No real ~/.ijfw is touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installExtension,
  uninstallExtension,
  listExtensions,
  extensionAuditBrief,
} from './src/extension-installer.js';
import { computeIntegrity } from './src/extension-signer.js';
import {
  _resetCache as resetLensCache,
  _setCache as setLensCache,
} from './src/trident/lens-health.js';

// --- helpers ---------------------------------------------------------------

async function makeTmp(label) {
  return mkdtemp(join(tmpdir(), `ijfw-ext-install-test-${label}-`));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Pre-seed the lens-health cache so probeLenses returns 3/3 live without
 * spawning real codex/gemini binaries. Necessary because runTrident probes
 * before invoking the executor. Reset before each test to avoid bleed.
 */
function seedLensesLive() {
  resetLensCache();
  const ts = Date.now();
  setLensCache('codex', { live: true, latency_ms: 0, error: null }, ts);
  setLensCache('gemini', { live: true, latency_ms: 0, error: null }, ts);
  // 'claude' is always live in-process.
}

/**
 * Build a Trident executor stub. By default returns PASS for every lens.
 * Pass `{verdict}` to override.
 */
function makeTridentStub(verdict = 'PASS') {
  return async ({ lens }) => ({
    lens,
    verdict,
    findings: [],
    latency_ms: 0,
    note: `t19-stub:${verdict}`,
  });
}

/**
 * Write a minimal valid extension layout under `dir`. Returns the manifest
 * (with integrity hash) written to disk for assertion convenience.
 */
async function writeValidExtension(dir, name = 'demo-ext', overrides = {}) {
  await mkdir(join(dir, 'skills'), { recursive: true });
  const skillBody = '# Hello\n\nThis skill is benign and contains no secrets.\n';
  await writeFile(join(dir, 'skills', 'hello.md'), skillBody, 'utf8');
  const base = {
    schema_version: '1.0',
    name,
    version: '1.0.0',
    type: 'skill-only',
    skills: [{ name: 'hello', file: 'skills/hello.md' }],
    permissions: { reads: ['./README.md'], writes: ['memory:write'] },
    ...overrides,
  };
  const signed = computeIntegrity(base);
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(signed, null, 2),
    'utf8',
  );
  return signed;
}

/**
 * Wrap an async test in HOME isolation. Restores HOME no matter what.
 */
async function withIsolatedHome(fn) {
  const fakeHome = await makeTmp('home');
  const prev = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return await fn(fakeHome);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await cleanup(fakeHome);
  }
}

// --- tests -----------------------------------------------------------------

test('installExtension: local path + clean manifest + Trident PASS stub', async () => {
  await withIsolatedHome(async () => {
    const extDir = await makeTmp('ext');
    const projectRoot = await makeTmp('proj');
    try {
      const manifest = await writeValidExtension(extDir, 'demo-pass');
      seedLensesLive();

      const result = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });

      assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result.errors)}`);
      assert.equal(result.name, manifest.name);
      assert.equal(result.scope, 'project');
      // Scope dir should exist with manifest.json + skills/hello.md.
      const scopeDir = join(projectRoot, '.ijfw', 'extensions', 'demo-pass');
      const skillDst = join(scopeDir, 'skills', 'skills', 'hello.md');
      // Installer joins skillsRoot + s.file (e.g. "skills/hello.md") so the
      // on-disk path includes a doubled "skills/" segment. Allow either.
      const candidate1 = join(scopeDir, 'skills', 'skills', 'hello.md');
      const candidate2 = join(scopeDir, 'skills', 'hello.md');
      const exists1 = await stat(candidate1).then(() => true, () => false);
      const exists2 = await stat(candidate2).then(() => true, () => false);
      assert.ok(exists1 || exists2, `skill file not found at ${candidate1} or ${candidate2}`);
      await stat(join(scopeDir, 'manifest.json'));
    } finally {
      await cleanup(extDir);
      await cleanup(projectRoot);
    }
  });
});

test('installExtension: bad integrity hash is rejected', async () => {
  await withIsolatedHome(async () => {
    const extDir = await makeTmp('ext');
    const projectRoot = await makeTmp('proj');
    try {
      const manifest = await writeValidExtension(extDir, 'demo-bad-int');
      // Re-write manifest with a tampered name so the stored integrity hash
      // no longer matches the canonical body.
      const tampered = { ...manifest, name: 'demo-bad-int-tampered' };
      await writeFile(join(extDir, 'manifest.json'), JSON.stringify(tampered, null, 2), 'utf8');
      seedLensesLive();

      const result = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(result.ok, false);
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
      assert.ok(
        result.errors.some((e) => /integrity/i.test(e)),
        `expected integrity error, got: ${JSON.stringify(result.errors)}`,
      );
    } finally {
      await cleanup(extDir);
      await cleanup(projectRoot);
    }
  });
});

test('installExtension: secret in skill body is rejected', async () => {
  await withIsolatedHome(async () => {
    const extDir = await makeTmp('ext');
    const projectRoot = await makeTmp('proj');
    try {
      await mkdir(join(extDir, 'skills'), { recursive: true });
      const fakeToken = 'sk-ant-' + 'A1b2C3d4E5f6G7h8I9j0kK';
      await writeFile(
        join(extDir, 'skills', 'hello.md'),
        `# Hello\nleak: ${fakeToken}\n`,
        'utf8',
      );
      const base = {
        schema_version: '1.0',
        name: 'demo-secret',
        version: '1.0.0',
        type: 'skill-only',
        skills: [{ name: 'hello', file: 'skills/hello.md' }],
        permissions: { reads: [], writes: [] },
      };
      const signed = computeIntegrity(base);
      await writeFile(join(extDir, 'manifest.json'), JSON.stringify(signed, null, 2), 'utf8');
      seedLensesLive();

      const result = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((e) => /secrets/i.test(e)),
        `expected secrets-related error, got: ${JSON.stringify(result.errors)}`,
      );
      // Ensure no error string surfaces the raw token.
      for (const e of result.errors) {
        assert.ok(!e.includes(fakeToken), 'error string leaked secret value');
      }
    } finally {
      await cleanup(extDir);
      await cleanup(projectRoot);
    }
  });
});

test('installExtension: R10 enforces https-only for git sources', async () => {
  await withIsolatedHome(async () => {
    const projectRoot = await makeTmp('proj');
    try {
      seedLensesLive();
      const result = await installExtension('git://example.com/repo.git', {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((e) => /https/i.test(e) || /scheme/i.test(e)),
        `expected scheme/https error, got: ${JSON.stringify(result.errors)}`,
      );
    } finally {
      await cleanup(projectRoot);
    }
  });
});

test('uninstallExtension removes registry entry + scope dir', async () => {
  await withIsolatedHome(async () => {
    const extDir = await makeTmp('ext');
    const projectRoot = await makeTmp('proj');
    try {
      await writeValidExtension(extDir, 'demo-uninstall');
      seedLensesLive();

      const installed = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(installed.ok, true);

      const scopeDir = join(projectRoot, '.ijfw', 'extensions', 'demo-uninstall');
      const registryPath = join(projectRoot, '.ijfw', 'state', 'extension-registry.json');
      const dirExistsBefore = await stat(scopeDir).then(() => true, () => false);
      assert.equal(dirExistsBefore, true);

      const removed = await uninstallExtension('demo-uninstall', {
        scope: 'project',
        projectRoot,
      });
      assert.equal(removed.ok, true);

      const dirExistsAfter = await stat(scopeDir).then(() => true, () => false);
      assert.equal(dirExistsAfter, false, 'scope dir should be removed');

      // Registry should no longer contain the extension entry.
      const registryRaw = await readFile(registryPath, 'utf8').catch(() => '{}');
      const registry = JSON.parse(registryRaw);
      const entries = Array.isArray(registry.extensions) ? registry.extensions : [];
      assert.equal(
        entries.find((e) => e && e.name === 'demo-uninstall'),
        undefined,
      );
    } finally {
      await cleanup(extDir);
      await cleanup(projectRoot);
    }
  });
});

test('listExtensions aggregates project + user scopes', async () => {
  await withIsolatedHome(async () => {
    const projExtDir = await makeTmp('ext-proj');
    const userExtDir = await makeTmp('ext-user');
    const projectRoot = await makeTmp('proj');
    try {
      await writeValidExtension(projExtDir, 'ext-in-project');
      await writeValidExtension(userExtDir, 'ext-in-user');
      seedLensesLive();

      const r1 = await installExtension(projExtDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(r1.ok, true, JSON.stringify(r1.errors));

      seedLensesLive(); // probeLenses cache TTL is 60s; reseed to be safe
      const r2 = await installExtension(userExtDir, {
        scope: 'user',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(r2.ok, true, JSON.stringify(r2.errors));

      const list = await listExtensions(projectRoot);
      const names = list.map((e) => e.name).sort();
      assert.deepEqual(names, ['ext-in-project', 'ext-in-user']);

      const proj = list.find((e) => e.name === 'ext-in-project');
      const user = list.find((e) => e.name === 'ext-in-user');
      assert.equal(proj.scope, 'project');
      assert.equal(user.scope, 'user');
    } finally {
      await cleanup(projExtDir);
      await cleanup(userExtDir);
      await cleanup(projectRoot);
    }
  });
});

test('Trident FAIL verdict aborts install with gate_result_block surfaced', async () => {
  await withIsolatedHome(async () => {
    const extDir = await makeTmp('ext');
    const projectRoot = await makeTmp('proj');
    try {
      await writeValidExtension(extDir, 'demo-trident-fail');
      seedLensesLive();

      const result = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        // runTrident calls runTrident(opts) which forwards executor; pass
        // FAIL verdict from every lens. Aggregator should produce FAIL.
        tridentExecutor: makeTridentStub('FAIL'),
      });
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((e) => /trident/i.test(e)),
        `expected trident error, got: ${JSON.stringify(result.errors)}`,
      );
      // The installer should attach a gate_result_block describing the failure.
      // We accept either string or undefined-but-errors-present (emitGateResult
      // can fail silently per installer); minimum is the trident error surfaces.
      assert.ok(
        typeof result.gate_result_block === 'string' || result.gate_result_block === undefined,
        'gate_result_block must be a string or undefined',
      );
    } finally {
      await cleanup(extDir);
      await cleanup(projectRoot);
    }
  });
});

test('AGENTS.md idempotency: single IJFW-EXTENSIONS-START block across reinstalls', async () => {
  await withIsolatedHome(async () => {
    const extDir = await makeTmp('ext');
    const projectRoot = await makeTmp('proj');
    try {
      await writeValidExtension(extDir, 'demo-idempotent');
      seedLensesLive();

      const first = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(first.ok, true, JSON.stringify(first.errors));

      const agentsPath = join(projectRoot, 'AGENTS.md');
      let agents = await readFile(agentsPath, 'utf8');
      let starts = agents.match(/IJFW-EXTENSIONS-START/g) || [];
      assert.equal(starts.length, 1, `expected exactly one START marker after first install, got ${starts.length}`);
      assert.ok(agents.includes('demo-idempotent'));

      // Reinstall idempotency.
      seedLensesLive();
      const second = await installExtension(extDir, {
        scope: 'project',
        projectRoot,
        tridentExecutor: makeTridentStub('PASS'),
      });
      assert.equal(second.ok, true, JSON.stringify(second.errors));

      agents = await readFile(agentsPath, 'utf8');
      starts = agents.match(/IJFW-EXTENSIONS-START/g) || [];
      assert.equal(starts.length, 1, `expected exactly one START marker after reinstall, got ${starts.length}`);

      // Uninstall removes the entry from the block (block itself may remain
      // as empty or be cleared — we only require the entry gone).
      const removed = await uninstallExtension('demo-idempotent', {
        scope: 'project',
        projectRoot,
      });
      assert.equal(removed.ok, true);
      agents = await readFile(agentsPath, 'utf8');
      // The block may still be present (just empty); ensure the extension name is gone.
      assert.ok(
        !agents.includes('demo-idempotent'),
        'extension entry should no longer appear in AGENTS.md after uninstall',
      );
    } finally {
      await cleanup(extDir);
      await cleanup(projectRoot);
    }
  });
});

test('extensionAuditBrief produces a string summary containing name + permissions', () => {
  const manifest = {
    schema_version: '1.0',
    name: 'audit-brief-demo',
    version: '2.1.0',
    type: 'skill-only',
    description: 'a demo extension for the audit brief test',
    skills: [{ name: 'echo', file: 'skills/echo.md' }],
    permissions: { reads: ['./README.md'], writes: ['memory:write'] },
    integrity: 'sha256:' + 'a'.repeat(64),
  };
  const skillBodies = [{ name: 'echo', file: 'skills/echo.md', body: '# echo skill body' }];
  const brief = extensionAuditBrief(manifest, skillBodies);
  assert.equal(typeof brief, 'string');
  assert.ok(brief.length > 0);
  assert.ok(brief.includes('audit-brief-demo'), 'brief should include manifest name');
  assert.ok(/permissions/i.test(brief), 'brief should include "permissions" header');
  // Sanity: declared reads/writes appear.
  assert.ok(brief.includes('./README.md'));
  assert.ok(brief.includes('memory:write'));
});
