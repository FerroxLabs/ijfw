// Test helper: resolve a usable bash binary across platforms.
//
// On POSIX, returns 'bash' (relies on PATH).
// On Windows, walks `where git` to locate bash.exe inside Git for Windows'
// install tree, then falls back to well-known Program Files paths.
//
// Mirrors installer/src/install.js findBash() so both surfaces agree on
// where bash lives. Tests that spawnSync('bash', ...) directly fail on
// Windows because Git for Windows installs bash.exe but does not put it
// on PATH -- this helper bridges that gap.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function resolveBash() {
  if (process.platform !== 'win32') return 'bash';

  // Windows: derive bash.exe from git.exe's install root.
  const whereGit = spawnSync('where', ['git'], { encoding: 'utf8' });
  if (whereGit.status === 0) {
    const gitPath = (whereGit.stdout || '').split(/\r?\n/)[0].trim();
    if (gitPath && existsSync(gitPath)) {
      const gitDir = dirname(gitPath);
      const gitRoot = dirname(gitDir);
      for (const c of [
        join(gitDir, 'bash.exe'),
        join(gitRoot, 'bin', 'bash.exe'),
        join(gitRoot, 'usr', 'bin', 'bash.exe'),
      ]) if (existsSync(c)) return c;
    }
  }

  for (const c of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ]) if (existsSync(c)) return c;

  return 'bash';
}

export const BASH = resolveBash();
