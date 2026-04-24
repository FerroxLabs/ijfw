// @ijfw/install -- one-command IJFW installer.
// Flow: preflight → resolve target → clone/pull → scripts/install.sh → merge marketplace → summary.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, realpathSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mergeMarketplace, claudeSettingsPath } from './marketplace.js';

const DEFAULT_REPO = 'https://github.com/TheRealSeanDonahoe/ijfw.git';
const DEFAULT_BRANCH = 'main';

function parseArgs(argv) {
  const out = { yes: false, dir: null, noMarketplace: false, branch: DEFAULT_BRANCH, branchExplicit: false, purge: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--no-marketplace') out.noMarketplace = true;
    else if (a === '--branch') { out.branch = argv[++i]; out.branchExplicit = true; }
    else if (a === '--purge') out.purge = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function latestTagFromGithub() {
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
// (network down, no tags yet, ls-remote rate-limited) falls back silently
// to the branch/DEFAULT_BRANCH rather than exploding the install.
export function resolveBranchOrTag({ branch, branchExplicit, _tagLookup } = {}) {
  if (branchExplicit) return branch;
  const lookup = _tagLookup || latestTagFromGithub;
  let tag = null;
  try { tag = lookup(); } catch { tag = null; }
  return tag || branch || DEFAULT_BRANCH;
}

function printHelp() {
  console.log(`ijfw-install -- IJFW installer
Usage: npx @ijfw/install [--dir <path>] [--branch <name>] [--no-marketplace] [--yes]
  --dir             install location (default: $IJFW_HOME or ~/.ijfw)
  --branch          git branch or tag (default: latest released tag)
  --no-marketplace  skip merging ~/.claude/settings.json
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
  // Resolve bash (Git for Windows ships bash.exe but often does not add it to
  // PATH, so hasBin('bash') returns false on a perfectly-functional install).
  // findBash() walks git.exe's siblings to find it -- matches install.ps1's
  // Resolve-GitBash logic so both entry points agree on what "installed" means.
  if (!findBash()) {
    if (platform() === 'win32') {
      issues.push(
        'IJFW could not locate bash.exe. Git for Windows installs it at\n' +
        '    C:\\Program Files\\Git\\bin\\bash.exe\n' +
        '  If you installed Git elsewhere, add its bin\\ to PATH and rerun.\n' +
        '  Missing Git entirely? winget install --id Git.Git -e --source winget'
      );
    } else {
      issues.push('IJFW needs bash on PATH -- install bash, then retry.');
    }
  }
  return issues;
}

function hasBin(bin) {
  const res = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return res.status === 0 || res.status === null ? (res.error ? false : true) : false;
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
  return { status: r.status, stdout: r.stdout || '' };
}

function cloneOrPull(dir, branch) {
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
    const { status: remoteStatus } = runCheck('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    if (remoteStatus === 0) {
      // fetch + hard checkout avoids ff-only failures from local divergence.
      const fetch = spawnSync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', branch], { stdio: 'inherit' });
      if (fetch.status !== 0) throw new Error(`IJFW fetch did not complete (exit ${fetch.status}) -- check network access and retry.`);
      const co = spawnSync('git', ['-C', dir, 'checkout', '-f', 'FETCH_HEAD'], { stdio: 'inherit' });
      if (co.status !== 0) throw new Error(`IJFW checkout did not complete (exit ${co.status}) -- run ijfw doctor to check prerequisites.`);
      return 'updated';
    }
  }

  // Broken repo or no origin: backup user data, re-clone, restore.
  const backupDir = dir + '.bak.' + Date.now();
  renameSync(dir, backupDir);
  try {
    const r = spawnSync('git', ['clone', '--depth', '1', '--branch', branch, DEFAULT_REPO, dir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`IJFW repo fetch did not complete (exit ${r.status}) -- check network access and retry.`);
    for (const item of ['memory', 'sessions', 'install.log', '.session-counter']) {
      const src = join(backupDir, item);
      if (existsSync(src)) {
        const dst = join(dir, item);
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
        renameSync(src, dst);
      }
    }
    rmSync(backupDir, { recursive: true, force: true });
    return 'updated';
  } catch (err) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    renameSync(backupDir, dir);
    throw err;
  }
}

function runInstallScript(dir) {
  const script = join(dir, 'scripts', 'install.sh');
  if (!existsSync(script)) throw new Error(`IJFW install script not found at ${script} -- re-run the installer to restore it.`);
  // Tell install.sh whether this is a custom-dir install so it skips the
  // user-home mutations (sibling links, ~/.local/bin wiring, ~/.claude
  // cache invalidation, real plugin .mcp.json patching).
  const canonicalDir = join(homedir(), '.ijfw');
  const isCustomDir = resolve(dir) !== canonicalDir ? '1' : '0';
  const env = {
    ...process.env,
    IJFW_NONINTERACTIVE: process.env.CI ? '1' : (process.env.IJFW_NONINTERACTIVE ?? ''),
    IJFW_HOME: dir,
    IJFW_CUSTOM_DIR: isCustomDir,
  };
  const bashExe = findBash();
  if (!bashExe) {
    throw new Error('IJFW could not locate bash (preflight should have caught this -- file an issue).');
  }
  const r = spawnSync(bashExe, ['scripts/install.sh'], { cwd: dir, stdio: 'inherit', env });
  if (r.status !== 0) throw new Error(`IJFW platform config step did not complete (exit ${r.status}) -- run ijfw doctor to see what to fix.`);
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
  const createdThisRun = !existsSync(target);

  const sigint = () => {
    if (createdThisRun && existsSync(target)) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    process.exit(130);
  };
  process.on('SIGINT', sigint);

  const ref = resolveBranchOrTag({ branch: opts.branch, branchExplicit: opts.branchExplicit });
  console.log(`IJFW install target: ${target}`);
  console.log(`  version: ${ref}`);
  const action = cloneOrPull(target, ref);
  console.log(`  repo ${action}`);

  runInstallScript(target);
  console.log('  platform configs applied');

  if (!opts.noMarketplace) {
    const settingsPath = claudeSettingsPath();
    mergeMarketplace(settingsPath);
    console.log(`  marketplace registered in ${settingsPath}`);
  }

  console.log('');
  console.log('IJFW now active across 13 platforms -- one memory layer, all your AIs, zero config.');
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
