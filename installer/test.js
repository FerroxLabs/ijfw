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
  // Reproduces the regression that broke /Users/seandonahoe's install:
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
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'canary.md'), 'keep-me');
  mkdirSync(join(dir, 'claude'), { recursive: true });
  writeFileSync(join(dir, 'claude', 'fake.txt'), 'remove-me');

  // Point HOME elsewhere so we don't touch the real settings.json.
  const tmpHome = mkdtempSync(join(tmpdir(), 'ijfw-fakehome-'));
  const res = spawnSync(process.execPath, [
    join(HERE, 'src', 'uninstall.js'), '--dir', dir, '--no-marketplace',
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
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'canary.md'), 'bye');

  const tmpHome = mkdtempSync(join(tmpdir(), 'ijfw-fakehome-'));
  const res = spawnSync(process.execPath, [
    join(HERE, 'src', 'uninstall.js'), '--dir', dir, '--purge', '--no-marketplace',
  ], { encoding: 'utf8', env: { ...process.env, HOME: tmpHome } });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(dir), 'dir fully removed');

  rmSync(tmpHome, { recursive: true, force: true });
});
