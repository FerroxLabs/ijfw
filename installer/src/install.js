// @ijfw/install -- one-command IJFW installer.
// Flow: preflight → resolve target → clone/pull → scripts/install.sh → merge marketplace → summary.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, realpathSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mergeMarketplace, claudeSettingsPath } from './marketplace.js';
import { triggerColdScan } from './post-install/cold-scan.js';

// V155 rebrand: canonical source moved from GitLab to GitHub under the
// Ferrox Labs org. Until the FerroxLabs/ijfw repo is populated with the
// v1.5.5 tag (Phase B), `--branch v1.5.5` installs will 404 against the
// new URL -- intentional: any other behavior would silently keep users
// pinned to the old canonical home.
const DEFAULT_REPO = 'https://github.com/FerroxLabs/ijfw.git';
const DEFAULT_BRANCH = 'main';

function parseArgs(argv) {
  const out = { yes: false, dir: null, noMarketplace: false, branch: DEFAULT_BRANCH, branchExplicit: false, purge: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--no-marketplace') out.noMarketplace = true;
    else if (a === '--branch') { out.branch = argv[++i]; out.branchExplicit = true; }
    else if (a === '--purge') out.purge = true;
    else if (a === '--dry-run' || a === '--print-plan') out.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

// IJFW_SKIP_NETWORK=1 is the contract the upgrade-smoke preflight gate sets
// when it spawns this installer inside a hermetic tmpdir. Honoring it is
// what lets the gate actually verify the install (the gate spawns the
// binary against a fake $HOME, expects it to complete or fail-clearly, and
// then asserts on settings.json). Before this wiring the env var was a
// no-op — `cloneOrPull` did `git clone --depth 1` unconditionally, so the
// gate either silently passed without writing settings.json (the original
// false-pass we were trying to retire) or silently failed on offline CI.
// TR-001 fix: surface "skip network" as an early-return that aborts with a
// clear reason rather than attempting and failing the network call.
function skipNetwork() {
  return process.env.IJFW_SKIP_NETWORK === '1';
}

function latestTagFromGithub() {
  if (skipNetwork()) return null;
  try {
    const res = spawnSync('git', ['ls-remote', '--tags', '--refs', '--sort=-v:refname', DEFAULT_REPO], {
      encoding: 'utf8', timeout: 10_000,
    });
    if (res.status !== 0) return null;
    const first = (res.stdout || '').split('\n')[0] || '';
    const m = first.match(/refs\/tags\/(v[0-9][^\s]*)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Pinning to latest tag is the default (audit R2); --branch escape hatch
// stays available for bleeding-edge users and CI. Any lookup failure
// (network down, no tags yet, ls-remote rate-limited) falls back to the
// branch/DEFAULT_BRANCH rather than exploding the install — but the
// fallback is now VISIBLE so users don't think they're on a pinned tag.
// (V155-032)
export function resolveBranchOrTag({ branch, branchExplicit, _tagLookup, _logger } = {}) {
  if (branchExplicit) return branch;
  const lookup = _tagLookup || latestTagFromGithub;
  let tag = null;
  try { tag = lookup(); } catch { tag = null; }
  if (!tag) {
    const log = _logger || console.warn;
    const eff = branch || DEFAULT_BRANCH;
    log(
      `  note: could not resolve latest tag from upstream (network or rate-limit?). ` +
      `Using branch "${eff}" instead. Pin a specific version with --branch vX.Y.Z if needed.`,
    );
    return eff;
  }
  return tag;
}

function printHelp() {
  console.log(`ijfw-install -- IJFW installer
Usage: npx @ijfw/install [--dir <path>] [--branch <name>] [--no-marketplace] [--yes] [--dry-run]
  --dir             install location (default: $IJFW_HOME or ~/.ijfw)
  --branch          git branch or tag (default: latest released tag)
  --no-marketplace  skip merging ~/.claude/settings.json
  --dry-run         print every file/dir the install would touch, write nothing
  --yes             non-interactive
`);
}

function preflight() {
  const issues = [];
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) issues.push(`IJFW needs Node >=18 -- current: ${process.versions.node}. Upgrade Node, then retry.`);
  if (!hasBin('git')) {
    if (platform() === 'win32') {
      issues.push(
        'IJFW needs Git for Windows (it bundles git + bash). One command:\n' +
        '    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements\n' +
        '  Then close this PowerShell window, open a fresh one, and rerun:\n' +
        '    npx -p @ijfw/install ijfw-install'
      );
    } else {
      issues.push('IJFW needs git on PATH -- install git (https://git-scm.com), then retry.');
    }
  }
  // bash is no longer required -- the installer is now Node-native.
  // findBash() is kept exported for compatibility with any external caller
  // but the preflight no longer gates on it.
  return issues;
}

function hasBin(bin) {
  const res = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
  if (res.error && res.error.code === 'ENOENT') return false; // truly missing
  if (res.status === 0) return true; // ran cleanly
  // Signal-killed or non-zero exit: treat as present-but-flaky, not missing.
  return res.error == null;
}

// Resolve a usable bash. Returns an absolute path (Windows) or "bash" (POSIX
// where PATH is reliable). Returns null if nothing works.
// On Windows, Git for Windows ships bash.exe alongside git.exe -- we walk
// from `where git` to find it, then fall back to the Program Files defaults.
// This mirrors install.ps1's Resolve-GitBash so both entry points agree.
export function findBash() {
  if (hasBin('bash') && platform() !== 'win32') return 'bash';
  if (platform() !== 'win32') return hasBin('bash') ? 'bash' : null;

  // Windows: derive bash.exe from git.exe's install root.
  const whereGit = spawnSync('where', ['git'], { encoding: 'utf8' });
  if (whereGit.status === 0) {
    const gitPath = (whereGit.stdout || '').split(/\r?\n/)[0].trim();
    if (gitPath && existsSync(gitPath)) {
      const gitDir = dirname(gitPath);           // ...\Git\cmd  or  ...\Git\bin
      const gitRoot = dirname(gitDir);           // ...\Git
      const candidates = [
        join(gitDir, 'bash.exe'),
        join(gitRoot, 'bin', 'bash.exe'),
        join(gitRoot, 'usr', 'bin', 'bash.exe'),
      ];
      for (const c of candidates) if (existsSync(c)) return c;
    }
  }
  // Well-known Program Files paths (covers installs where git isn't on PATH
  // either, so `where git` returns nothing -- rare but real, happens with
  // per-user installs invoked from a shell that didn't pick up the update).
  for (const c of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ]) if (existsSync(c)) return c;

  // Last resort: bare "bash" on PATH (works if the user added Git\bin
  // manually, or on Windows boxes with bash shipping via other means).
  if (hasBin('bash')) return 'bash';
  return null;
}

function resolveTarget(opt) {
  if (opt.dir) return resolve(opt.dir);
  if (process.env.IJFW_HOME) return resolve(process.env.IJFW_HOME);
  return join(homedir(), '.ijfw');
}

function runCheck(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', spawnError: r.error?.code, signal: r.signal };
}

function cloneOrPull(dir, branch) {
  // TR-001: honor IJFW_SKIP_NETWORK=1. The upgrade-smoke preflight gate
  // spawns this installer with that env var set, expecting the network
  // calls below (git clone, git fetch, ls-remote) to be inert so the gate
  // can verify the marketplace merge hermetically. Contract:
  //   * if dir already exists AND looks like a usable seed (we don't try
  //     to verify a checkout — the caller is responsible for pre-seeding),
  //     report 'skipped-network' and let runInstallScript proceed.
  //   * if dir is missing or empty, network would be required to populate
  //     it — refuse loudly rather than silently no-op (the silent shape
  //     was the original false-pass we're trying to retire).
  if (skipNetwork()) {
    if (existsSync(dir)) {
      return 'skipped-network';
    }
    throw new Error(
      'IJFW_SKIP_NETWORK=1 set but cloneOrPull needs network: ' +
      `target directory ${dir} does not exist. ` +
      'Pre-seed the directory before setting IJFW_SKIP_NETWORK, or unset the env var.',
    );
  }
  if (!existsSync(dir)) {
    // Fresh install.
    mkdirSync(dir, { recursive: true });
    const r = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, DEFAULT_REPO, dir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`IJFW repo fetch did not complete (exit ${r.status}) -- check network access and retry.`);
    return 'cloned';
  }

  // Upgrade path.
  const hasGit = existsSync(join(dir, '.git'));
  if (hasGit) {
    const { status: remoteStatus, stdout, stderr: remoteStderr, spawnError: remoteSpawnError, signal: remoteSignal } = runCheck('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    if (remoteSpawnError) console.warn(`  git spawn error (${remoteSpawnError}) -- check git is on PATH`);
    else if (remoteSignal) console.warn(`  git exited on signal ${remoteSignal}`);
    else if (remoteStatus !== 0 && remoteStderr) console.warn(`  git remote get-url: ${remoteStderr.slice(0, 120).trim()}`);
    if (remoteStatus === 0) {
      // Re-point origin if a host migration moved the canonical home.
      // Without this, users from a prior canonical host see fetch 404s and abort.
      // Only migrate known stale canonical HTTPS URLs -- never clobber SSH remotes,
      // forks, or user-customized origins. Match is case-insensitive on the
      // username segment because GitHub user URLs can be mixed-case
      // (e.g. TheRealSeanDonahoe vs seandonahoe) and a strict case-sensitive
      // list misses those checkouts.
      const STALE_PATTERNS = [
        /^https:\/\/github\.com\/seandonahoe\/ijfw(\.git)?\/?$/i,
        /^https:\/\/github\.com\/therealseandonahoe\/ijfw(\.git)?\/?$/i,
        // V155 rebrand: GitLab was the canonical source through v1.5.4;
        // users who installed from gitlab.com need their origin migrated
        // forward to FerroxLabs/ijfw on GitHub on next `ijfw-install`.
        /^https:\/\/gitlab\.com\/therealseandonahoe\/ijfw(\.git)?\/?$/i,
      ];
      const currentOrigin = (stdout || '').trim();
      if (STALE_PATTERNS.some((re) => re.test(currentOrigin))) {
        const setUrl = spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', DEFAULT_REPO], { stdio: 'inherit' });
        if (setUrl.status !== 0) {
          console.warn(`  [!] origin migration failed -- could not repoint ${currentOrigin} to ${DEFAULT_REPO}`);
        } else {
          console.log(`  origin migration: ${currentOrigin} -> ${DEFAULT_REPO}`);
        }
      }
      // fetch + hard checkout avoids ff-only failures from local divergence.
      const fetch = spawnSync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', branch], { stdio: 'inherit' });
      if (fetch.status !== 0) throw new Error(`IJFW fetch did not complete (exit ${fetch.status}) -- check network access and retry.`);
      const co = spawnSync('git', ['-C', dir, 'checkout', '-f', 'FETCH_HEAD'], { stdio: 'inherit' });
      if (co.status !== 0) throw new Error(`IJFW checkout did not complete (exit ${co.status}) -- run ijfw doctor to check prerequisites.`);
      return 'updated';
    }
  }

  // Broken repo or no origin: backup user data, re-clone, restore.
  // V155-013: the restore allowlist must cover every user-data directory the
  // installer has accumulated since v1.4.x — previously only 4 items were
  // copied back and the rest (state/, ijfw/ brain, .ijfw/, cache/, run/,
  // logs/) were silently deleted along with the .bak tree. We also DO NOT
  // delete the .bak directory until after restore succeeds, so a restore
  // failure leaves the operator with a recoverable snapshot.
  const RESTORE_ALLOWLIST = [
    'memory',
    'sessions',
    'install.log',
    '.session-counter',
    // v1.5.x additions:
    'ijfw',          // visible brain layer (wiki + facts)
    'state',         // state.json, deploy-failures.jsonl, .dream-state-v2.json
    'cache',         // npm-view-cache and friends
    'logs',          // post-tool-use logs, jsonl observations
    'run',           // runtime lock files / pid markers
    '.ijfw',         // internal — recall counter, indexes, layout version
  ];
  const backupDir = dir + '.bak.' + Date.now();
  renameSync(dir, backupDir);
  try {
    const r = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, DEFAULT_REPO, dir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`IJFW repo fetch did not complete (exit ${r.status}) -- check network access and retry.`);
    let restoredCount = 0;
    for (const item of RESTORE_ALLOWLIST) {
      const src = join(backupDir, item);
      if (existsSync(src)) {
        const dst = join(dir, item);
        // TR-005 (v1.5.5 Trident): the prior shape was `rmSync(dst); renameSync(src, dst)`.
        // renameSync across filesystems throws EXDEV; on that throw the dst is
        // ALREADY gone AND src is still under .bak — net data loss for the
        // operator, and (because the outer catch then rmSync's `dir`) any
        // already-restored allowlist entries are gone too. Switch to
        // cpSync (copy semantics — works across filesystems) followed by an
        // explicit rmSync of the .bak source AFTER copy succeeds. If cpSync
        // throws, the backup tree is fully intact and recoverable: we surface
        // the path on the way up to the outer catch (line below) so the
        // operator sees where their data still lives.
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
        try {
          cpSync(src, dst, { recursive: true, dereference: false });
          rmSync(src, { recursive: true, force: true });
          restoredCount++;
        } catch (cpErr) {
          // Surface the backup location verbatim so the operator can recover.
          // Throw upward; the outer try/catch handles overall restoration.
          const msg = cpErr && cpErr.message ? cpErr.message : String(cpErr);
          throw new Error(
            `IJFW restore: cpSync failed for "${item}" (${msg}). ` +
            `Your data is still intact under: ${backupDir}. ` +
            `Move it back into ${dir} manually after diagnosing the copy failure.`,
          );
        }
      }
    }
    // Only delete the backup AFTER restore has completed.
    // Leave .bak directory in place if anything still exists inside it — that's
    // user data we don't know about; tell the operator where to find it.
    let backupResidual = [];
    try {
      backupResidual = readdirSync(backupDir);
    } catch { /* missing or already-empty — fall through */ }
    if (backupResidual.length === 0) {
      rmSync(backupDir, { recursive: true, force: true });
    } else {
      console.warn(
        `  [!] restored ${restoredCount} known dirs; backup retained at ${backupDir} ` +
        `(contains: ${backupResidual.slice(0, 8).join(', ')}${backupResidual.length > 8 ? ', ...' : ''}). ` +
        `Remove manually after verifying.`,
      );
    }
    return 'updated';
  } catch (err) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    renameSync(backupDir, dir);
    throw err;
  }
}

async function runInstallScript(dir) {
  // Node-native installer (replaces bash scripts/install.sh dependency).
  // Eliminates the Git-for-Windows requirement on Windows -- install.js
  // now runs identically on every platform with just Node 18+.
  const canonicalDir = join(homedir(), '.ijfw');
  const isCustomDir = resolve(dir) !== canonicalDir;
  const { runInstall } = await import('./install-flow.js');
  await runInstall({
    targets: undefined,            // undefined = canonical 14
    ijfwHome: dir,
    ijfwCustomDir: isCustomDir,
    repoRoot: dir,
    noninteractive: !!process.env.CI || process.env.IJFW_NONINTERACTIVE === '1',
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const issues = preflight();
  if (issues.length) {
    console.error('IJFW needs a couple of things first -- fix these and re-run:');
    for (const i of issues) console.error('  - ' + i);
    process.exit(1);
  }

  const target = resolveTarget(opts);

  // --dry-run / --print-plan: show every path the installer would touch, then
  // exit without writing anything (issue: a true plan-preview mode).
  if (opts.dryRun) {
    const { CANONICAL_ORDER } = await import('./install-flow.js');
    const { renderPlan } = await import('./install-ledger.js');
    console.log(`IJFW install target: ${target}`);
    console.log('');
    console.log(renderPlan(CANONICAL_ORDER));
    process.exit(0);
  }

  const createdThisRun = !existsSync(target);

  const sigint = () => {
    if (createdThisRun && existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (err) {
        // V155-053: surface the cleanup failure so the user knows they
        // need to manually rm the partial install before retrying. Common
        // on Windows when AV scanners still hold a handle on the freshly
        // written file (EBUSY/EPERM).
        const msg = err && err.message ? err.message : String(err);
        console.warn(
          `\n  [!] partial install at ${target} could not be cleaned (${msg}) — ` +
          `run \`rm -rf "${target}"\` (or Remove-Item -Recurse -Force on Windows) before retrying.`,
        );
      }
    }
    process.exit(130);
  };
  process.on('SIGINT', sigint);

  const ref = resolveBranchOrTag({ branch: opts.branch, branchExplicit: opts.branchExplicit });
  console.log(`IJFW install target: ${target}`);
  console.log(`  version: ${ref}`);
  const action = cloneOrPull(target, ref);
  console.log(`  repo ${action}`);

  await runInstallScript(target);
  console.log('  platform configs applied');

  // v1.5.2.1 -- scope-leak fix. The marketplace merge writes
  // `~/.claude/settings.json` (the REAL user's settings, via
  // `claudeSettingsPath()` -> `homedir() + .claude/settings.json`). Without
  // a customDir guard, that write happens even when the operator passed
  // `--dir /tmp/scratch` or set `IJFW_CUSTOM_DIR=1` -- i.e., the installer
  // was supposed to stay inside the scratch dir but still leaks into the
  // real $HOME. e2e-smoke.sh Mode 1 catches this as a scope leak:
  //   "Bug A regressed, installer is leaking into real $HOME"
  // Two conditions mean "do not touch the real settings":
  //   (a) IJFW_CUSTOM_DIR=1 env var (e2e-smoke + CI smoke harnesses)
  //   (b) --dir or IJFW_HOME points at a non-canonical install root
  // Either one is sufficient to skip the merge.
  const canonicalDir = join(homedir(), '.ijfw');
  const isCustomDir =
    process.env.IJFW_CUSTOM_DIR === '1' ||
    resolve(target) !== canonicalDir;

  if (!opts.noMarketplace && !isCustomDir) {
    const settingsPath = claudeSettingsPath();
    // Pass the resolved install root so the marketplace entry's directory
    // path matches the actual install -- including --dir and IJFW_HOME paths.
    // Without this, custom-dir installs would write the canonical ~/.ijfw
    // path that doesn't exist on that machine.
    mergeMarketplace(settingsPath, { rootDir: target });
    console.log(`  marketplace registered in ${settingsPath}`);
  } else if (isCustomDir) {
    console.log('  marketplace merge skipped (custom-dir install)');
  }

  // V3-F3 cold-scan -- fire-and-forget detached child that populates
  // <cwd>/.ijfw/project.type so the next session-start hook hits a cached
  // file under the 50ms budget. Never blocks the installer; any spawn
  // failure degrades to a silent skip (the next session-start trigger will
  // retry on its own via cold-scan-trigger.sh).
  try {
    const coldScanRoot = process.env.IJFW_PROJECT_DIR || process.cwd();
    triggerColdScan(coldScanRoot, { ijfwHome: target });
  } catch { /* best-effort; never block install */ }

  console.log('');
  console.log('IJFW now active across 15 platforms -- one memory layer, all your models, zero config.');
  console.log('  Run `ijfw demo` to see the Trident in action.');
  console.log('  Run `ijfw doctor` to confirm which auditors are reachable.');
  console.log('  Privacy: everything stays local. See NO_TELEMETRY.md.');
  process.exit(0);
}

function isDirectRun() {
  try {
    const entry = process.argv[1] && realpathSync(process.argv[1]);
    const self = fileURLToPath(import.meta.url);
    return entry === self;
  } catch { return false; }
}

if (isDirectRun()) {
  main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
}
