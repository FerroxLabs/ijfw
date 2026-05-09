// Test helper: resolve a usable bash binary across platforms.
//
// On POSIX, returns 'bash' (relies on PATH).
// On Windows, tries -- in order:
//   1. `where.exe bash` (works when bash is on PATH; e.g. Git for Windows
//      installer "Use Git from the command line" option).
//   2. PowerShell `Get-Command bash` (catches some installs that aren't on
//      PATH for cmd.exe but are findable to PS).
//   3. `where.exe git` then probe sibling bin/usr-bin for bash.exe.
//   4. Well-known Program Files paths.
//   5. Literal 'bash' fallback (will ENOENT, but emits a one-line stderr
//      diagnostic so CI logs surface the resolution failure honestly).
//
// Mirrors installer/src/install.js findBash() in spirit. Tests that spawn
// 'bash' directly fail on Windows because Git for Windows installs bash.exe
// but the chocolatey-bootstrap shim path doesn't sibling it -- this helper
// bridges that gap with several fallbacks.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function tryWhere(arg) {
  try {
    const r = spawnSync('where.exe', [arg], { encoding: 'utf8', shell: false });
    if (r.status === 0) {
      const lines = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (existsSync(line)) return line;
      }
    }
  } catch { /* fall through */ }
  return null;
}

function tryPowerShell(cmd) {
  // PowerShell candidates installed on stock Windows.
  const psCandidates = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  ];
  for (const ps of psCandidates) {
    if (!existsSync(ps)) continue;
    try {
      const r = spawnSync(ps, [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-Command', `(Get-Command ${cmd} -ErrorAction SilentlyContinue).Source`,
      ], { encoding: 'utf8' });
      const out = (r.stdout || '').trim();
      if (out && existsSync(out)) return out;
    } catch { /* keep probing */ }
  }
  return null;
}

export function resolveBash() {
  if (process.platform !== 'win32') return 'bash';

  // 1. bash directly on PATH.
  const direct = tryWhere('bash');
  if (direct) return direct;

  // 2. PowerShell knows about extra PATH context cmd.exe doesn't.
  const fromPs = tryPowerShell('bash');
  if (fromPs) return fromPs;

  // 3. Walk from git.exe's install root.
  const gitPath = tryWhere('git');
  if (gitPath) {
    const gitDir = dirname(gitPath);    // ...\Git\cmd or ...\Git\bin
    const gitRoot = dirname(gitDir);    // ...\Git
    const gitGrand = dirname(gitRoot);  // ...\Program Files
    for (const c of [
      join(gitDir, 'bash.exe'),
      join(gitRoot, 'bin', 'bash.exe'),
      join(gitRoot, 'usr', 'bin', 'bash.exe'),
      // Some chocolatey shims point one level deeper -- e.g.
      // C:\ProgramData\chocolatey\bin\git.exe is a shim and the real Git
      // for Windows lives elsewhere; cover the common Program Files tree
      // even when the git shim itself doesn't sibling bash.
      join(gitGrand, 'Git', 'bin', 'bash.exe'),
      join(gitGrand, 'Git', 'usr', 'bin', 'bash.exe'),
    ]) if (existsSync(c)) return c;
  }

  // 4. Well-known Program Files paths.
  for (const c of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ]) if (existsSync(c)) return c;

  // 5. Last resort: surface diagnostic so CI logs explain ENOENT clearly.
  try {
    process.stderr.write(
      '[ijfw test] win-bash-helper: bash.exe could not be resolved on this ' +
      'Windows host. Tried where.exe, PowerShell Get-Command, Git-derived ' +
      'siblings, and Program Files defaults. Tests that shell out to bash ' +
      'will fail with ENOENT.\n',
    );
  } catch { /* nothing to do */ }
  return 'bash';
}

export const BASH = resolveBash();
