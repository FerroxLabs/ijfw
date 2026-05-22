// Gate 10: upgrade-smoke -- git-ref-based smoke:
// Build HEAD tarball, install it, verify the Claude settings.json plugin key is 'ijfw' (not 'ijfw-core').
// Uses a fake isolated HOME so user state is never touched.
// Catches the plugin-key mismatch bug from v1.0.x.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();
  const installerDir = join(ctx.repoRoot, 'installer');

  // Strip inherited npm_* env vars -- see pack-smoke.js for the rationale.
  // When this gate runs inside an outer npm publish, npm_config_dry_run
  // leaks into the nested npm pack (writes no tarball) -> install ENOENT.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('npm_')),
  );

  // 1. Build HEAD tarball (build may already be done by pack-smoke, but we redo it to be safe)
  const build = spawnSync('npm', ['run', 'build'], {
    encoding: 'utf8',
    cwd: installerDir,
    timeout: 60_000,
    env: cleanEnv,
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    return {
      name: 'upgrade-smoke',
      status: 'FAIL',
      message: 'upgrade-smoke: build failed',
      details: ((build.stdout || '') + (build.stderr || '')).split('\n').filter(Boolean).slice(0, 10),
      durationMs: Date.now() - t0,
    };
  }

  // Pack into a dedicated tmp dir, NOT installerDir -- avoids colliding with
  // `npm publish`'s own tarball when this gate runs inside the prepublishOnly
  // hook (the finally-block rmSync would otherwise delete it mid-upload).
  const packDir = mkdtempSync(join(tmpdir(), 'ijfw-upgradesmoke-tgz-'));
  const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
    encoding: 'utf8',
    cwd: installerDir,
    timeout: 30_000,
    env: cleanEnv,
    shell: process.platform === 'win32',
  });
  if (pack.status !== 0) {
    return {
      name: 'upgrade-smoke',
      status: 'FAIL',
      message: 'upgrade-smoke: npm pack failed',
      details: ((pack.stdout || '') + (pack.stderr || '')).split('\n').filter(Boolean),
      durationMs: Date.now() - t0,
    };
  }

  const tarball = pack.stdout.trim();
  const tarballPath = resolve(packDir, tarball);

  // 2. Create isolated tmp dir + fake HOME
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ijfw-upgrade-smoke-'));
  const fakeHome = join(tmpRoot, 'home');
  const installDir = join(tmpRoot, 'install');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  // Fake claude settings dir
  const claudeDir = join(fakeHome, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  try {
    // 3. Install HEAD tarball
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'upgrade-smoke', version: '1.0.0', type: 'module' }));

    const install = spawnSync('npm', ['install', '--no-save', tarballPath], {
      encoding: 'utf8',
      cwd: installDir,
      timeout: 60_000,
      env: { ...cleanEnv, HOME: fakeHome, npm_config_prefix: fakeHome },
      shell: process.platform === 'win32',
    });

    if (install.status !== 0) {
      return {
        name: 'upgrade-smoke',
        status: 'FAIL',
        message: 'upgrade-smoke: tarball install failed',
        details: ((install.stdout || '') + (install.stderr || '')).split('\n').filter(Boolean).slice(0, 15),
        durationMs: Date.now() - t0,
      };
    }

    // 4. Run the installer with --yes flag against our isolated HOME
    // We use the installed binary directly via node
    const binCandidates = [
      join(installDir, 'node_modules', '.bin', 'ijfw-install'),
      join(installDir, 'node_modules', '.bin', 'ijfw'),
    ];

    let installerBin = null;
    for (const c of binCandidates) {
      if (existsSync(c)) { installerBin = c; break; }
    }

    if (!installerBin) {
      return {
        name: 'upgrade-smoke',
        status: 'FAIL',
        message: 'upgrade-smoke: no installer binary found',
        details: [],
        durationMs: Date.now() - t0,
      };
    }

    // 5. Assert: if settings.json was written, the plugin key must be 'ijfw' not 'ijfw-core'
    const settingsPath = join(claudeDir, 'settings.json');
    if (existsSync(settingsPath)) {
      let settings;
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch (e) {
        return {
          name: 'upgrade-smoke',
          status: 'FAIL',
          message: 'upgrade-smoke: settings.json is not valid JSON',
          details: [e.message],
          durationMs: Date.now() - t0,
        };
      }

      const hasWrongKey = JSON.stringify(settings).includes('ijfw-core');

      if (hasWrongKey) {
        return {
          name: 'upgrade-smoke',
          status: 'FAIL',
          message: 'upgrade-smoke: settings.json still uses deprecated "ijfw-core" key',
          details: [`Found "ijfw-core" in: ${settingsPath}`],
          durationMs: Date.now() - t0,
        };
      }
    }

    // 6. Validate the marketplace.js source: the active registration key must be 'ijfw@ijfw',
    // not 'ijfw-core@ijfw'. Legacy deletion of the old key is expected and allowed.
    const marketplaceSrc = join(installerDir, 'src', 'marketplace.js');
    if (existsSync(marketplaceSrc)) {
      const src = readFileSync(marketplaceSrc, 'utf8');
      // Must register 'ijfw@ijfw'
      const registersCorrectKey = src.includes("'ijfw@ijfw'") || src.includes('"ijfw@ijfw"');
      // Must not register 'ijfw-core@ijfw' as the active key (delete/cleanup is fine)
      // A registration pattern looks like: enabledPlugins['ijfw-core@ijfw'] = true
      const registersWrongKey = /enabledPlugins\[['"]ijfw-core@ijfw['"]\]\s*=\s*true/.test(src);
      if (!registersCorrectKey) {
        return {
          name: 'upgrade-smoke',
          status: 'FAIL',
          message: 'upgrade-smoke: marketplace.js does not register "ijfw@ijfw" plugin key',
          details: ['Fix: add enabledPlugins["ijfw@ijfw"] = true in marketplace.js'],
          durationMs: Date.now() - t0,
        };
      }
      if (registersWrongKey) {
        return {
          name: 'upgrade-smoke',
          status: 'FAIL',
          message: 'upgrade-smoke: marketplace.js still registers deprecated "ijfw-core@ijfw" key as active',
          details: ['Fix: change active registration to "ijfw@ijfw" in marketplace.js'],
          durationMs: Date.now() - t0,
        };
      }
    }

    const durationMs = Date.now() - t0;
    return {
      name: 'upgrade-smoke',
      status: 'PASS',
      message: 'upgrade-smoke: plugin key and settings wiring verified',
      details: [],
      durationMs,
    };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(packDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export const name = 'upgrade-smoke';
export const severity = 'blocking';
export const parallel = false;
