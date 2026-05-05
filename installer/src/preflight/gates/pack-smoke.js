// Gate 9: pack-smoke -- npm pack -> install tarball in tmp dir -> run ijfw --help -> assert exit 0.
// Runs in a fully isolated tmp dir with a separate HOME so user state is never touched.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** @param {import('../types.js').PreflightCtx} ctx */
export async function run(ctx) {
  const t0 = Date.now();
  const installerDir = join(ctx.repoRoot, 'installer');

  // 1. Build the package first
  const build = spawnSync('npm', ['run', 'build'], {
    encoding: 'utf8',
    cwd: installerDir,
    timeout: 60_000,
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    return {
      name: 'pack-smoke',
      status: 'FAIL',
      message: 'pack-smoke: build failed before pack',
      details: ((build.stdout || '') + (build.stderr || '')).split('\n').filter(Boolean).slice(0, 10),
      durationMs: Date.now() - t0,
    };
  }

  // 2. npm pack
  const pack = spawnSync('npm', ['pack', '--silent'], {
    encoding: 'utf8',
    cwd: installerDir,
    timeout: 30_000,
    shell: process.platform === 'win32',
  });
  if (pack.status !== 0) {
    return {
      name: 'pack-smoke',
      status: 'FAIL',
      message: 'pack-smoke: npm pack failed',
      details: ((pack.stdout || '') + (pack.stderr || '')).split('\n').filter(Boolean),
      durationMs: Date.now() - t0,
    };
  }

  const tarball = pack.stdout.trim();
  if (!tarball) {
    return {
      name: 'pack-smoke',
      status: 'FAIL',
      message: 'pack-smoke: npm pack produced no output',
      details: [],
      durationMs: Date.now() - t0,
    };
  }

  const tarballPath = resolve(installerDir, tarball);

  // 3. Create isolated tmp dir + HOME
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ijfw-pack-smoke-'));
  const fakeHome = join(tmpRoot, 'home');
  const installDir = join(tmpRoot, 'install');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  try {
    // 4. npm init + install tarball
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'smoke-test', version: '1.0.0', type: 'module' }));

    const install = spawnSync('npm', ['install', '--no-save', tarballPath], {
      encoding: 'utf8',
      cwd: installDir,
      timeout: 60_000,
      env: { ...process.env, HOME: fakeHome, npm_config_prefix: fakeHome },
      shell: process.platform === 'win32',
    });

    if (install.status !== 0) {
      return {
        name: 'pack-smoke',
        status: 'FAIL',
        message: 'pack-smoke: tarball install failed',
        details: ((install.stdout || '') + (install.stderr || '')).split('\n').filter(Boolean).slice(0, 15),
        durationMs: Date.now() - t0,
      };
    }

    // 5. Find the ijfw binary (try bin/ijfw first, then dist/install.js)
    const binCandidates = [
      join(installDir, 'node_modules', '.bin', 'ijfw'),
      join(installDir, 'node_modules', '.bin', 'ijfw-install'),
    ];

    // Use the first existing bin
    let binPath = null;
    for (const c of binCandidates) {
      try {
        const r = spawnSync('ls', [c], { encoding: 'utf8' });
        if (r.status === 0) { binPath = c; break; }
      } catch { /* next */ }
    }

    if (!binPath) {
      // Fall back: find any ijfw* in .bin
      const binDir = join(installDir, 'node_modules', '.bin');
      let entries = [];
      try { entries = readdirSync(binDir); } catch { /* ignore */ }
      const found = entries.find(e => e.startsWith('ijfw'));
      if (found) binPath = join(binDir, found);
    }

    if (!binPath) {
      return {
        name: 'pack-smoke',
        status: 'FAIL',
        message: 'pack-smoke: no ijfw* binary found in installed tarball',
        details: [],
        durationMs: Date.now() - t0,
      };
    }

    // 6. Run --help and assert exit 0
    const helpRun = spawnSync('node', [binPath, '--help'], {
      encoding: 'utf8',
      cwd: installDir,
      timeout: 15_000,
      env: { ...process.env, HOME: fakeHome },
    });

    const durationMs = Date.now() - t0;

    if (helpRun.status === 0) {
      return {
        name: 'pack-smoke',
        status: 'PASS',
        message: `pack-smoke: tarball installs and binary responds to --help`,
        details: [],
        durationMs,
      };
    }

    return {
      name: 'pack-smoke',
      status: 'FAIL',
      message: 'pack-smoke: binary --help exited non-zero',
      details: ((helpRun.stdout || '') + (helpRun.stderr || '')).split('\n').filter(Boolean).slice(0, 15),
      durationMs,
    };
  } finally {
    // Clean up tmp dir
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    // Clean up tarball
    try { rmSync(tarballPath, { force: true }); } catch { /* best effort */ }
  }
}

export const name = 'pack-smoke';
export const severity = 'blocking';
export const parallel = false;
