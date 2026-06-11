// @ijfw/install -- one-command IJFW installer.
// Flow: preflight → resolve target → clone/pull → scripts/install.sh → merge marketplace → summary.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, realpathSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
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
    else if (a === '--dir') out.dir = requireFlagValue('--dir', 'a path', argv[++i]);
    else if (a === '--no-marketplace') out.noMarketplace = true;
    else if (a === '--branch') { out.branch = requireFlagValue('--branch', 'a name', argv[++i]); out.branchExplicit = true; }
    else if (a === '--purge') out.purge = true;
    else if (a === '--dry-run' || a === '--print-plan') out.dryRun = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

// A forgotten flag value would otherwise consume the NEXT flag (or undefined)
// as the value -- e.g. `--dir --yes` would create ./--yes and drop --yes, and
// a bare `--dir` would silently fall through to the canonical ~/.ijfw install.
function requireFlagValue(flag, what, value) {
  if (value == null || value.startsWith('-')) {
    console.error(`${flag} requires ${what} argument`);
    process.exit(1);
  }
  return value;
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

// Markers identifying a directory as an IJFW install or repo checkout.
// cloneOrPull's upgrade paths run destructive operations (git checkout -f,
// rename + re-clone) against whatever --dir / IJFW_HOME resolves to; this is
// the install-side analogue of uninstall.js's assertSafePurgeTarget so a
// stray `IJFW_HOME=$HOME` or `--dir ~/Documents` is refused instead of
// renamed/force-checked-out. Markers are deliberately IJFW-specific: the
// canonical basename, ledger/method files only IJFW writes, or the shape of
// an IJFW repo checkout (mcp-server/src/server.js next to claude/).
export function looksLikeIjfwInstall(dir) {
  try {
    if (basename(resolve(dir)) === '.ijfw') return true;
    if (existsSync(join(dir, 'install-ledger.json'))) return true;
    if (existsSync(join(dir, 'install-method'))) return true;
    if (existsSync(join(dir, 'mcp-server', 'src', 'server.js')) && existsSync(join(dir, 'claude'))) return true;
  } catch { /* unreadable target: treat as not-IJFW (refuse destructive ops) */ }
  return false;
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
      // Guard: `git checkout -f FETCH_HEAD` discards uncommitted work in
      // whatever repo `dir` is. Only proceed when the origin is the IJFW
      // repo (canonical or known-stale) or the tree carries IJFW markers --
      // never force-checkout an unrelated repository a stray --dir or
      // IJFW_HOME happened to point at.
      const CANONICAL_PATTERN = /^https:\/\/github\.com\/ferroxlabs\/ijfw(\.git)?\/?$/i;
      const isIjfwOrigin = CANONICAL_PATTERN.test(currentOrigin) || STALE_PATTERNS.some((re) => re.test(currentOrigin));
      if (!isIjfwOrigin && !looksLikeIjfwInstall(dir)) {
        throw new Error(
          `Refusing to update ${dir}: it is a git checkout of "${currentOrigin}", not an IJFW install. ` +
          `Check your --dir / IJFW_HOME setting, or remove the directory and retry.`,
        );
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
  // Guard: this path renames `dir` aside and re-clones IJFW into its place.
  // Without a marker check, `IJFW_HOME=$HOME` or `--dir ~/Documents` would
  // rename the user's entire home/project directory out from under them.
  // An empty existing dir is harmless -- clone straight into it.
  if (!looksLikeIjfwInstall(dir)) {
    let entries = null;
    try { entries = readdirSync(dir); } catch { /* unreadable: refuse below */ }
    if (entries && entries.length === 0) {
      const r = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, DEFAULT_REPO, dir], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`IJFW repo fetch did not complete (exit ${r.status}) -- check network access and retry.`);
      return 'cloned';
    }
    throw new Error(
      `Refusing to replace ${dir}: it exists but does not look like an IJFW install ` +
      `(no install ledger, install-method file, or IJFW checkout markers). ` +
      `Check your --dir / IJFW_HOME setting, or move the directory aside and retry.`,
    );
  }
  const backupDir = dir + '.bak.' + Date.now();
  renameSync(dir, backupDir);
  try {
    const r = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, DEFAULT_REPO, dir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`IJFW repo fetch did not complete (exit ${r.status}) -- check network access and retry.`);
    // TR-005 (v1.5.5 Trident): cpSync (copy semantics — works across
    // filesystems) instead of renameSync, which throws EXDEV across mounts.
    // Transactional restore (audit): the backup sources are NOT deleted
    // inside the copy loop. If they were, a later item's cpSync failure
    // would leave earlier items existing ONLY inside `dir`, which the outer
    // catch then rmSync's — permanently destroying already-restored data
    // (memory/ is item one). Instead: copy everything first, and only after
    // ALL copies succeed delete the copied sources from the backup. On any
    // failure the backup tree is still complete and the rollback is lossless.
    const restoredItems = [];
    for (const item of RESTORE_ALLOWLIST) {
      const src = join(backupDir, item);
      if (existsSync(src)) {
        const dst = join(dir, item);
        try {
          if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
          cpSync(src, dst, { recursive: true, dereference: false });
          restoredItems.push(item);
        } catch (cpErr) {
          // Surface the backup location verbatim so the operator can recover.
          // Throw upward; the outer try/catch handles overall restoration.
          const msg = cpErr && cpErr.message ? cpErr.message : String(cpErr);
          throw new Error(
            `IJFW restore: copy failed for "${item}" (${msg}). ` +
            `Your data is still intact under: ${backupDir}. ` +
            `The previous state of ${dir} will be restored from it.`,
          );
        }
      }
    }
    const restoredCount = restoredItems.length;
    // Every copy succeeded -- now (and only now) drop the copied sources so
    // the residual check below sees only data we did NOT know how to restore.
    for (const item of restoredItems) {
      try {
        rmSync(join(backupDir, item), { recursive: true, force: true });
      } catch { /* leftover source is covered by the residual warning below */ }
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
    // Rollback: the backup tree is complete at this point (sources are only
    // deleted after every copy succeeded), so this restores the exact prior
    // state. If the rollback itself fails, NEVER delete the backup -- tell
    // the operator where their data lives instead.
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      renameSync(backupDir, dir);
    } catch (rollbackErr) {
      const msg = rollbackErr && rollbackErr.message ? rollbackErr.message : String(rollbackErr);
      console.error(
        `  [!] rollback failed (${msg}). Your original data is preserved at: ${backupDir}. ` +
        `Move it back to ${dir} manually.`,
      );
    }
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

  // Once runInstallScript starts merging MCP entries into platform configs
  // (~/.codex/config.toml, ~/.gemini/settings.json, ...), deleting the target
  // dir on Ctrl-C would leave every already-configured platform pointing at a
  // server path that no longer exists. After that point, keep the partial
  // install and tell the user how to finish or revert it instead.
  let platformConfigPhase = false;

  const sigint = () => {
    if (platformConfigPhase) {
      console.warn(
        `\n  [!] install interrupted while platform configs were being written. ` +
        `Some platform configs may already reference ${target} -- the partial install was kept so they keep working. ` +
        `Rerun \`npx -p @ijfw/install ijfw-install\` to complete it, or \`ijfw-uninstall\` to remove IJFW from all platform configs.`,
      );
      process.exit(130);
    }
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

  platformConfigPhase = true;
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
