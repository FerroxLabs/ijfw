// Smoke tests for @ijfw/install (node --test).
// Do NOT spawn real network clones; use a local --branch=HEAD + local repo
// override where needed. These tests exercise flag parsing, marketplace
// merge/unmerge, memory preservation logic, and package layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Test 1: package layout ---
test('package.json declares both bin entries', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
  assert.ok(pkg.bin['ijfw-install'].includes('dist/install.js'), 'ijfw-install bin declared');
  assert.ok(pkg.bin['ijfw-uninstall'].includes('dist/uninstall.js'), 'ijfw-uninstall bin declared');
  // Zero runtime deps is the contract; the field may be omitted OR explicitly {}.
  // Both forms are valid in package.json, so accept either.
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.ok(pkg.engines.node.startsWith('>='));
});

// --- Test 2: marketplace merge + unmerge is non-destructive ---
test('marketplace merge preserves unrelated keys and unmerge reverses', async () => {
  const { mergeMarketplace, unmergeMarketplace } = await import('./src/marketplace.js');
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-settings-'));
  const settingsPath = join(dir, 'settings.json');
  const original = {
    theme: 'dark',
    extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'x/y' } } },
    enabledPlugins: { 'other@other': true },
    custom: { keep: 'me' },
  };
  writeFileSync(settingsPath, JSON.stringify(original));

  const fakeRoot = join(dir, 'fake-ijfw-home');
  const merged = mergeMarketplace(settingsPath, { rootDir: fakeRoot });
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.custom.keep, 'me');
  assert.ok(merged.extraKnownMarketplaces.other, 'unrelated marketplace preserved');
  assert.ok(merged.extraKnownMarketplaces.ijfw, 'ijfw marketplace added');
  // v1.2.7+: writer must use directory source matching the actual install path,
  // not the github shape that left "Marketplace file not found" stale entries
  // in <= 1.2.6 installs.
  assert.equal(merged.extraKnownMarketplaces.ijfw.source.source, 'directory',
    'marketplace source is directory (not github)');
  assert.equal(merged.extraKnownMarketplaces.ijfw.source.path, join(fakeRoot, 'claude'),
    'marketplace path tracks rootDir');
  // v1.0.3+: plugin key is ijfw@ijfw (not legacy ijfw-core@ijfw)
  assert.equal(merged.enabledPlugins['ijfw@ijfw'], true);
  assert.equal(merged.enabledPlugins['other@other'], true);

  const unmerged = unmergeMarketplace(settingsPath);
  assert.equal(unmerged.extraKnownMarketplaces.ijfw, undefined);
  assert.equal(unmerged.enabledPlugins['ijfw@ijfw'], undefined);
  assert.ok(unmerged.extraKnownMarketplaces.other, 'other marketplace still there after unmerge');
  assert.equal(unmerged.custom.keep, 'me');

  rmSync(dir, { recursive: true, force: true });
});

// --- Test 3: marketplace merge creates file if missing ---
test('marketplace merge creates settings.json when absent', async () => {
  const { mergeMarketplace } = await import('./src/marketplace.js');
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-settings-'));
  const settingsPath = join(dir, 'nested', 'settings.json');
  mergeMarketplace(settingsPath, { rootDir: join(dir, 'home') });
  assert.ok(existsSync(settingsPath));
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(s.extraKnownMarketplaces.ijfw);
  assert.equal(s.extraKnownMarketplaces.ijfw.source.source, 'directory');
  rmSync(dir, { recursive: true, force: true });
});

// --- Test 3b: heal stale github source from <= 1.2.6 ---
test('marketplace merge heals stale github source written by <= 1.2.6', async () => {
  // Reproduces the regression that broke a real user's install:
  // an existing settings.json carried `source: github, repo: TheRealSeanDonahoe/
  // ijfw`, which Claude Code resolved to a missing marketplace.json. Re-running
  // the installer must overwrite that block with the correct directory source,
  // not append or preserve the broken shape.
  const { mergeMarketplace } = await import('./src/marketplace.js');
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-heal-'));
  const settingsPath = join(dir, 'settings.json');
  const fakeRoot = join(dir, 'home');
  // Pre-seed the bad shape exactly as <= 1.2.6 wrote it.
  writeFileSync(settingsPath, JSON.stringify({
    extraKnownMarketplaces: {
      ijfw: { source: { source: 'github', repo: 'TheRealSeanDonahoe/ijfw' } },
      other: { source: { source: 'github', repo: 'x/y' } },
    },
  }));
  const merged = mergeMarketplace(settingsPath, { rootDir: fakeRoot });
  assert.equal(merged.extraKnownMarketplaces.ijfw.source.source, 'directory',
    'broken github source replaced with directory');
  assert.equal(merged.extraKnownMarketplaces.ijfw.source.path, join(fakeRoot, 'claude'));
  assert.equal(merged.extraKnownMarketplaces.ijfw.source.repo, undefined,
    'stale repo field gone');
  assert.ok(merged.extraKnownMarketplaces.other, 'unrelated marketplaces still preserved during heal');
  rmSync(dir, { recursive: true, force: true });
});

// --- Test 3c: pluginInstallPath honors --dir / IJFW_HOME / default ---
test('pluginInstallPath resolves rootDir, IJFW_HOME, and falls back to ~/.ijfw', async () => {
  const { pluginInstallPath } = await import('./src/marketplace.js');
  // Explicit rootDir wins.
  assert.equal(pluginInstallPath('/tmp/explicit'), join('/tmp/explicit', 'claude'));
  // IJFW_HOME picked up when no rootDir.
  const prev = process.env.IJFW_HOME;
  process.env.IJFW_HOME = '/tmp/from-env';
  try {
    assert.equal(pluginInstallPath(), join('/tmp/from-env', 'claude'));
  } finally {
    if (prev === undefined) delete process.env.IJFW_HOME; else process.env.IJFW_HOME = prev;
  }
  // No rootDir, no IJFW_HOME: ~/.ijfw/claude.
  delete process.env.IJFW_HOME;
  const { homedir } = await import('node:os');
  assert.equal(pluginInstallPath(), join(homedir(), '.ijfw', 'claude'));
  if (prev !== undefined) process.env.IJFW_HOME = prev;
});

// --- Test 4: install.js --help exits 0 ---
test('install.js --help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, [join(HERE, 'src', 'install.js'), '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /ijfw-install/);
  assert.match(res.stdout, /--no-marketplace/);
});

// --- Test 5: uninstall preserves memory dir (logic test via direct invocation) ---
test('uninstall preserves memory/ without --purge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-home-'));
  // The real installer writes install-method; the uninstall safety guard
  // refuses dirs without an IJFW marker, so the fixture must carry one.
  writeFileSync(join(dir, 'install-method'), 'git\n');
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'canary.md'), 'keep-me');
  mkdirSync(join(dir, 'claude'), { recursive: true });
  writeFileSync(join(dir, 'claude', 'fake.txt'), 'remove-me');

  // Point HOME elsewhere so we don't touch the real settings.json.
  const tmpHome = mkdtempSync(join(tmpdir(), 'ijfw-fakehome-'));
  const res = spawnSync(process.execPath, [
    join(HERE, 'src', 'uninstall.js'), '--dir', dir, '--no-marketplace', '--yes',
  ], { encoding: 'utf8', env: { ...process.env, HOME: tmpHome } });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(join(dir, 'memory', 'canary.md')), 'memory preserved');
  assert.ok(!existsSync(join(dir, 'claude', 'fake.txt')), 'other files removed');

  rmSync(dir, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
});

// --- Test 6: uninstall --purge removes memory ---
test('uninstall --purge removes memory/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-home-'));
  writeFileSync(join(dir, 'install-method'), 'git\n');
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'canary.md'), 'bye');

  const tmpHome = mkdtempSync(join(tmpdir(), 'ijfw-fakehome-'));
  const res = spawnSync(process.execPath, [
    join(HERE, 'src', 'uninstall.js'), '--dir', dir, '--purge', '--no-marketplace', '--yes',
  ], { encoding: 'utf8', env: { ...process.env, HOME: tmpHome } });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(dir), 'dir fully removed');

  rmSync(tmpHome, { recursive: true, force: true });
});

// --- Test 7: installWayland writes a Wayland-loadable declarative plugin.toml ---
// Wayland Core only loads a declarative ~/.wayland/plugins/<name>/plugin.toml
// (TOML, NO executable entry). The legacy config.yaml + Python plugin tree it
// used to write were dead weight Wayland could never load. Drive installWayland
// against a scratch home + the real repoRoot (so WAYLAND.md / skills resolve)
// and assert the new outputs and the absence of the old ones.
test('installWayland writes declarative plugin.toml, not config.yaml / Python tree', async () => {
  const { installWayland } = await import('./src/install-targets-1-7.js');
  const home = mkdtempSync(join(tmpdir(), 'ijfw-wayland-home-'));
  try {
    const serverJsNative = join('/abs', 'path', 'mcp-server', 'src', 'server.js');
    const logged = [];
    const ctx = {
      home,
      homeReal: home,
      ijfwCustomDir: false,
      repoRoot: join(HERE, '..'),
      serverJsNative,
      ts: '20260610T000000',
      log: {
        ok: (m) => logged.push(m),
        note: () => {},
        info: () => {},
        warn: () => {},
      },
    };

    const outcome = await installWayland(ctx);
    assert.equal(outcome.status, 'ok');

    // plugin.toml exists with the exact Wayland PluginManifest schema.
    const pluginToml = join(home, '.wayland', 'plugins', 'ijfw', 'plugin.toml');
    assert.ok(existsSync(pluginToml), 'declarative plugin.toml written');
    const toml = readFileSync(pluginToml, 'utf8');
    assert.match(toml, /^name = "wayland-ijfw"$/m);
    assert.match(toml, /^license = "MIT"$/m);
    assert.match(toml, /^\[permissions\]$/m);
    assert.match(toml, /^register_hooks = true$/m);
    assert.match(toml, /^register_mcp_server = true$/m);
    assert.match(toml, /^\[runtime\]\nkind = "declarative"$/m);
    assert.match(toml, /^\[mcp_server\]\nname = "ijfw-memory"$/m);
    assert.match(toml, /^\[mcp_server\.transport\]$/m);
    assert.match(toml, /^kind = "stdio"$/m);
    assert.match(toml, /^command = "node"$/m);
    // serverJsNative is emitted as a TOML basic string (the args entry).
    assert.ok(
      toml.includes(`args = ["${serverJsNative}"]`),
      'serverJsNative interpolated into args',
    );
    // Version pulled from installer/package.json — a non-empty quoted string.
    assert.match(toml, /^version = "\d+\.\d+\.\d+/m, 'real version interpolated');
    // The two hooks Wayland actually dispatches today.
    assert.match(toml, /phase = "session_start"\ntool = "ijfw_memory_prelude"/);
    assert.match(toml, /phase = "pre_prompt"\ntool = "ijfw_memory_recall"/);
    // Log-only phases stay OUT until Wayland wires them.
    assert.ok(!toml.includes('post_tool_use'), 'no unsupported phases');
    assert.ok(!toml.includes('session_end'), 'no unsupported phases');
    // The old, broken Python hook name must not survive.
    assert.ok(!toml.includes('ijfw_pre_prompt_recall'), 'old phantom tool name gone');

    // The dead legacy outputs are NO LONGER written.
    assert.ok(!existsSync(join(home, '.wayland', 'config.yaml')), 'no config.yaml');
    assert.ok(
      !existsSync(join(home, '.wayland', 'plugins', 'ijfw', '_manifest.py')),
      'no Python plugin tree',
    );

    // The still-useful surfaces survive: WAYLAND.md + at least one skill.
    assert.ok(existsSync(join(home, '.wayland', 'WAYLAND.md')), 'WAYLAND.md copied');
    assert.ok(
      existsSync(join(home, '.wayland', 'skills')) &&
        readFileSync(pluginToml, 'utf8').length > 0,
      'skills dir created',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Test 8: installWayland escapes a Windows-style serverJsNative path ---
// serverJsNative can be a Windows absolute path with backslashes; it must be
// emitted as a valid TOML basic string (backslashes doubled) or the manifest
// fails to parse on Wayland.
test('installWayland escapes backslashes in serverJsNative for TOML', async () => {
  const { installWayland } = await import('./src/install-targets-1-7.js');
  const home = mkdtempSync(join(tmpdir(), 'ijfw-wayland-win-'));
  try {
    const winPath = 'C:\\Users\\me\\.ijfw\\mcp-server\\src\\server.js';
    const ctx = {
      home,
      ijfwCustomDir: false,
      repoRoot: join(HERE, '..'),
      serverJsNative: winPath,
      ts: '20260610T000000',
      log: { ok: () => {}, note: () => {}, info: () => {}, warn: () => {} },
    };
    await installWayland(ctx);
    const toml = readFileSync(join(home, '.wayland', 'plugins', 'ijfw', 'plugin.toml'), 'utf8');
    // Each backslash doubled in the basic string.
    assert.ok(
      toml.includes('args = ["C:\\\\Users\\\\me\\\\.ijfw\\\\mcp-server\\\\src\\\\server.js"]'),
      'backslashes escaped for TOML',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
