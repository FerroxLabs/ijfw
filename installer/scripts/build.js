// Cross-platform build for @ijfw/install.
//
// Replaces the previous shell pipeline (rm -rf / mkdir -p / cp / chmod) so
// `npm run build` works identically on macOS, Linux, and Windows PowerShell.
// The POSIX pipeline silently broke dev-tree builds on Windows -- the root
// cause a user had to hit before their npx retry could verify the fix.
//
// Responsibilities:
//   1. Refresh installer/docs/ from ../docs/ so the npm tarball carries the
//      rendered guide.
//   2. Bundle src/install.js, src/uninstall.js, src/ijfw.js through esbuild.
//   3. Mark the bundled entries executable on POSIX (chmod 0o755). No-op on
//      Windows which does not use POSIX permission bits for launchability.

import { rmSync, mkdirSync, cpSync, chmodSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const installerRoot = resolve(here, '..');
const repoRoot = resolve(installerRoot, '..');
const repoDocs = resolve(repoRoot, 'docs');

process.chdir(installerRoot);

// --- 1. Stage docs for the tarball ------------------------------------------
rmSync('docs', { recursive: true, force: true });
mkdirSync('docs/guide', { recursive: true });
const guideSrc = resolve(repoDocs, 'GUIDE.md');
const assetsSrc = resolve(repoDocs, 'guide', 'assets');
if (existsSync(guideSrc)) cpSync(guideSrc, 'docs/GUIDE.md');
if (existsSync(assetsSrc)) cpSync(assetsSrc, 'docs/guide/assets', { recursive: true });

// --- 1b. Stage Aider convention templates for the tarball -------------------
// The published @ijfw/install package does NOT ship the repo's `aider/` dir.
// uninstall.js byte-compares the user's ~/.aider.conf.yml / ~/CONVENTIONS.md
// against the shipped templates before auto-removing them; without the
// templates in the tarball that comparison always fails and pristine IJFW
// files are never cleaned up. Stage them into templates/aider/ (declared in
// package.json "files") and resolve from there in uninstall.js.
rmSync('templates/aider', { recursive: true, force: true });
mkdirSync('templates/aider', { recursive: true });
for (const name of ['aider.conf.yml', 'CONVENTIONS.md']) {
  const src = resolve(repoRoot, 'aider', name);
  if (existsSync(src)) cpSync(src, resolve('templates/aider', name));
}

// --- 2. Bundle ---------------------------------------------------------------
await build({
  entryPoints: ['src/install.js', 'src/uninstall.js', 'src/ijfw.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

// --- 3. POSIX exec bit -------------------------------------------------------
for (const f of ['dist/install.js', 'dist/uninstall.js', 'dist/ijfw.js']) {
  try { chmodSync(f, 0o755); } catch { /* non-POSIX filesystem, ignore */ }
}

console.log('[build] done');
