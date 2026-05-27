// Gate 10: upgrade-smoke -- git-ref-based smoke:
// Build HEAD tarball, install it, verify the Claude settings.json plugin key is 'ijfw' (not 'ijfw-core').
// Uses a fake isolated HOME so user state is never touched.
// Catches the plugin-key mismatch bug from v1.0.x.
//
// TR-001 (v1.5.5 Trident reliability): the gate now sets up the install
// target as a pre-seeded mock tree so the installer can run hermetically
// without `git clone` or `git fetch`. It then spawns the installer with
// IJFW_SKIP_NETWORK=1 (honored by install.js as of v1.5.5 — see
// `skipNetwork()` there) and ASSERTS that ~/.claude/settings.json was
// actually written. Previously the gate set the env var but install.js
// ignored it; the gate would either fail offline (cloneOrPull tried
// network) or silently pass on hosted CI because the settings.json check
// was gated by `if (existsSync(settingsPath))` — file missing = silently
// PASS. Both shapes are now closed.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
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

    // V155-007 / TR-001: actually SPAWN the installer binary against the
    // isolated HOME — hermetically. The previous shape (pre-TR-001) set
    // IJFW_SKIP_NETWORK=1 but install.js ignored it, so the gate either
    // failed offline (cloneOrPull tried network) or silently passed when
    // the installer exited 0 without writing settings.json. The fix pairs:
    //   (a) install.js now honors IJFW_SKIP_NETWORK and throws fail-fast
    //       from cloneOrPull when set,
    //   (b) we pre-seed `targetIjfwHome` with the in-tree contents so
    //       cloneOrPull's directory-exists branch is taken and the network
    //       throw doesn't fire,
    //   (c) we ASSERT that settings.json was written (post-condition).
    const targetIjfwHome = join(fakeHome, '.ijfw');
    mkdirSync(targetIjfwHome, { recursive: true });
    // Seed the install target with the in-tree claude/ + mcp-server/
    // payloads so the installer's runInstallScript step finds every
    // source tree it needs to copy into platform homes. install-flow's
    // preflight asserts mcp-server/src/server.js exists; the marketplace
    // merge then writes the real settings.json under fakeHome/.claude/.
    for (const sub of ['claude', 'mcp-server']) {
      const src = join(ctx.repoRoot, sub);
      if (existsSync(src)) {
        cpSync(src, join(targetIjfwHome, sub), { recursive: true });
      }
    }
    // installer/package.json is also probed by install-flow when it tries
    // to read the bundled installer version; seed just the manifest, not
    // the whole installer tree, to keep the seed small + hermetic.
    const installerPkgSrc = join(ctx.repoRoot, 'installer', 'package.json');
    if (existsSync(installerPkgSrc)) {
      mkdirSync(join(targetIjfwHome, 'installer'), { recursive: true });
      cpSync(installerPkgSrc, join(targetIjfwHome, 'installer', 'package.json'));
    }
    // cloneOrPull (in install.js) sees `existsSync(targetIjfwHome)` is true
    // AND IJFW_SKIP_NETWORK=1 and returns 'skipped-network' without trying
    // `git remote get-url`, `git fetch`, or the no-origin reclone branch.
    // The marketplace merge then runs against the seeded tree and writes
    // settings.json under fakeHome/.claude/ — which we assert below.
    const runInstaller = spawnSync(installerBin, ['--yes'], {
      encoding: 'utf8',
      cwd: installDir,
      timeout: 120_000,
      env: {
        ...cleanEnv,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        IJFW_HOME: targetIjfwHome,
        // Hermetic: install.js refuses any network attempt under this flag
        // (TR-001). The gate's contract is "the installer either completes
        // without network or fails clearly". The marketplace merge step
        // (which is what we actually want to verify) does NOT need network.
        CI: '1',
        IJFW_SKIP_NETWORK: '1',
      },
      shell: process.platform === 'win32',
    });

    if (runInstaller.status !== 0 || runInstaller.signal) {
      // TP-001 (v1.5.5 Trident): categorize the failure shape so the operator
      // doesn't have to mentally diff "killed by SIGKILL" vs "real exit 1"
      // vs "timed out". Each shape gets a distinct phrase + (where useful)
      // the last stderr line so the cause is visible in the message field
      // before the 15-line details[] gets scanned.
      const stderrLines = (runInstaller.stderr || '').split('\n').filter(Boolean);
      const lastStderrLine = stderrLines.length > 0
        ? stderrLines[stderrLines.length - 1].slice(0, 200)
        : '(no stderr)';
      let cat;
      if (runInstaller.signal) {
        cat = `killed by ${runInstaller.signal}`;
      } else if (runInstaller.status === 137 || runInstaller.status === 124) {
        cat = `timed out (exit ${runInstaller.status})`;
      } else if (runInstaller.status === null) {
        cat = 'timed out (status null)';
      } else {
        cat = `exited ${runInstaller.status}`;
      }
      return {
        name: 'upgrade-smoke',
        status: 'FAIL',
        message: `upgrade-smoke: installer ${cat}. Last stderr line: ${lastStderrLine}`,
        details: ((runInstaller.stdout || '') + (runInstaller.stderr || ''))
          .split('\n').filter(Boolean).slice(0, 15),
        durationMs: Date.now() - t0,
      };
    }

    // 5. Post-condition: settings.json MUST have been written. Previously
    // this check was wrapped in `if (existsSync(settingsPath))` which
    // silently passed when the file was missing — the same false-pass
    // shape the gate was supposed to retire. TR-001 asserts presence.
    const settingsPath = join(claudeDir, 'settings.json');
    if (!existsSync(settingsPath)) {
      return {
        name: 'upgrade-smoke',
        status: 'FAIL',
        message: 'upgrade-smoke: installer did not write ~/.claude/settings.json',
        details: [
          `expected: ${settingsPath}`,
          'The installer ran (exit 0) but the marketplace merge never produced settings.json.',
          'This is the false-pass shape TR-001 retired — the gate must observe the write.',
          ...((runInstaller.stdout || '') + (runInstaller.stderr || '')).split('\n').filter(Boolean).slice(0, 8),
        ],
        durationMs: Date.now() - t0,
      };
    }
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
