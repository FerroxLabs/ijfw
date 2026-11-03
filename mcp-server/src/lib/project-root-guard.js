// project-root-guard.js -- single vetting point for "what directory may
// become an .ijfw project root".
//
// Hardens against FerroxLabs/wayland#755: a host app spawned this server
// with cwd inside its own signed bundle
// (Wayland.app/Contents/Resources/app.asar.unpacked/...). Writability-only
// root selection accepted it, the layout migration wrote
// .ijfw/.layout-version inside the bundle, the macOS codesign seal broke,
// and the OS blocked every child process the app spawned afterwards.
//
// Every module that turns a caller-supplied / env / cwd candidate into a
// filesystem root that receives .ijfw writes must route through
// vetProjectRoot() (or safeProjectDir() when there is no candidate) instead
// of hand-rolling `candidate || process.env.IJFW_PROJECT_DIR || process.cwd()`.

import {
  existsSync, mkdirSync, accessSync, realpathSync,
  constants as fsConstants,
} from 'node:fs';
import {
  resolve, normalize, isAbsolute, join, dirname, basename, sep,
} from 'node:path';
import { homedir, tmpdir } from 'node:os';

// --- Bundle-interior detection ------------------------------------------------
//
// Segment matching (not exact-match) so any depth inside the bundle is
// rejected: <anything>.asar / <anything>.asar.unpacked segments (Electron
// archives), and any *.app segment immediately followed by Contents (macOS
// bundle layout). Case-insensitive: macOS/Windows filesystems are.
//
// Lexical rules alone miss the bundle ROOT itself (".../Wayland.app" has no
// following Contents segment) and bundle-internal siblings of Contents
// (".../Wayland.app/Resources"). For those, an fs-backed pass walks the
// ancestor chain: any level whose basename ends in .app AND which has a real
// Contents directory on disk is a live bundle -- writing .ijfw anywhere
// under it breaks the seal just the same. A project merely NAMED
// "my.app" (no Contents dir) stays accepted -- that is the deliberate
// false-positive tradeoff.
function hasContentsDirOnDisk(appDir) {
  try {
    return existsSync(join(appDir, 'Contents'));
  } catch {
    return false;
  }
}

export function isBundleInternalPath(p) {
  if (!p || typeof p !== 'string') return false;
  const normalized = normalize(p);

  // Lexical pass: pure string segments, no fs access.
  const segs = normalized.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i].toLowerCase();
    if (/\.asar(\.unpacked)?$/.test(s)) return true;
    if (s.endsWith('.app') && i + 1 < segs.length && segs[i + 1].toLowerCase() === 'contents') {
      return true;
    }
  }

  // FS-backed pass: *.app ancestor (or p itself) with a real Contents dir.
  try {
    let cur = normalized;
    for (let depth = 0; depth < 64; depth++) {
      if (basename(cur).toLowerCase().endsWith('.app') && hasContentsDirOnDisk(cur)) return true;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch { /* unreadable chain: fall back to the lexical verdict */ }
  return false;
}

// Symlink defense: an env/caller candidate can be a symlink whose TARGET
// lives inside a bundle while its own path looks clean. Check both the
// lexical path and its physical resolution. realpathSync failures (dangling
// link, permission) fall back to the lexical verdict rather than throwing.
function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function isBundleInternalDeep(p) {
  if (!p || typeof p !== 'string') return false;
  if (isBundleInternalPath(p)) return true;
  const real = realpathOrSelf(p);
  return real !== p && isBundleInternalPath(real);
}

// --- Candidate validation ------------------------------------------------------

export function validatePath(raw) {
  if (!raw) return null;
  const resolved = resolve(raw);
  const normalized = normalize(resolved);
  if (!isAbsolute(normalized)) return null;
  const parts = normalized.split(/[\\/]+/);
  if (parts.includes('..')) return null;
  return normalized;
}

export function isWritable(dir) {
  try {
    if (!existsSync(dir)) {
      // Try to create it; if mkdir fails, treat as non-writable.
      mkdirSync(dir, { recursive: true });
      return true;
    }
    // v1.5.2.1 H-1 (Lens 1): previously wrote+unlinked a probe file
    // (`.ijfw-probe-<pid>-<ts>`). That broke the "importing server.js
    // produces ZERO filesystem artifacts" contract: the probe leaked
    // under inotify/fswatch even when self-tests in tmpdir saw nothing.
    // accessSync(W_OK) gives the same writability signal with no I/O.
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// --- Temp / template / root detection ---------------------------------------
//
// A host that spawns the server from a temp dir (or '/') would otherwise get
// project memory in a place that is wiped on reboot (macOS purges
// /var/folders/*/T) or that is not a project at all. Those cwd values are
// skipped; explicit env signals are still honoured.
const TEMP_ROOTS_STATIC = [
  '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp',
  '/var/folders', '/private/var/folders',
];

function within(p, root) {
  if (!p || !root) return false;
  const a = normalize(p);
  const r = normalize(root).replace(/[\\/]+$/, '');
  if (!r) return false;
  const cmp = process.platform === 'win32' || process.platform === 'darwin'
    ? (x) => x.toLowerCase() : (x) => x;
  return cmp(a) === cmp(r) || cmp(a).startsWith(cmp(r) + sep) || cmp(a).startsWith(cmp(r) + '/');
}

export function isTempPath(p) {
  if (!p || typeof p !== 'string') return false;
  const roots = [...TEMP_ROOTS_STATIC];
  try { const t = tmpdir(); if (t) { roots.push(t); roots.push(realpathOrSelf(t)); } } catch { /* no tmpdir */ }
  const candidates = [p, realpathOrSelf(p)];
  return candidates.some((c) => roots.some((r) => within(c, r)));
}

// Host config templates that reached us unexpanded (e.g. Gemini keeps
// "${PWD}" literally when PWD is unset). Resolving one would create a
// directory literally named "${PWD}" under cwd.
export function isUnexpandedTemplate(raw) {
  if (typeof raw !== 'string') return false;
  return /\$\{|\$[A-Z_][A-Z0-9_]*|\{\{|%[A-Za-z_][A-Za-z0-9_]*%/.test(raw);
}

function isFilesystemRoot(p) {
  return dirname(p) === p;
}

// --- Root resolution -----------------------------------------------------------
//
// Deterministic contract (see docs/PROJECT-ROOT.md):
//   1. IJFW_PROJECT_DIR, 2. CLAUDE_PROJECT_DIR -- explicit. Accepted when
//      absolute, not an unexpanded template, not bundle-internal (wayland#755,
//      including via symlink), and writable. An explicit temp dir is honoured.
//   3. process.cwd() -- accepted when not bundle-internal, not the
//      filesystem root, and writable. With { hostSpawned: true } (the MCP
//      server: the HOST picked its cwd, the user did not) a cwd inside an OS
//      temp root is skipped too. CLI callers run where the user typed the
//      command, so a temp cwd there is a deliberate choice and is kept.
//   4. HOME -- user-global memory. Never crashes the server (any stderr byte
//      during MCP init makes the client mark the server failed).
// The bundle/template checks run BEFORE the writability probe so a rejected
// candidate directory is never mkdir'd as a side-effect.
export function describeProjectRoot(opts = {}) {
  const hostSpawned = opts.hostSpawned === true;
  const rejected = [];
  for (const source of ['IJFW_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']) {
    const raw = process.env[source];
    if (!raw) continue;
    if (isUnexpandedTemplate(raw)) { rejected.push({ source, reason: 'unexpanded-template' }); continue; }
    if (!isAbsolute(raw)) { rejected.push({ source, reason: 'not-absolute' }); continue; }
    const p = validatePath(raw);
    if (!p) { rejected.push({ source, reason: 'invalid' }); continue; }
    if (isBundleInternalDeep(p)) { rejected.push({ source, reason: 'bundle-internal' }); continue; }
    if (!isWritable(p)) { rejected.push({ source, reason: 'not-writable' }); continue; }
    return { dir: p, source, rejected };
  }

  let cwd = null;
  try { cwd = process.cwd(); } catch { rejected.push({ source: 'cwd', reason: 'unavailable' }); }
  if (cwd) {
    if (isBundleInternalDeep(cwd)) rejected.push({ source: 'cwd', reason: 'bundle-internal' });
    else if (isFilesystemRoot(cwd)) rejected.push({ source: 'cwd', reason: 'filesystem-root' });
    else if (hostSpawned && isTempPath(cwd)) rejected.push({ source: 'cwd', reason: 'temp-dir' });
    else if (!isWritable(cwd)) rejected.push({ source: 'cwd', reason: 'not-writable' });
    else return { dir: cwd, source: 'cwd', rejected };
  }

  return { dir: homedir(), source: 'home-fallback', rejected };
}

export function safeProjectDir(opts = {}) {
  return describeProjectRoot(opts).dir;
}

// Vet a caller-supplied root (MCP tool arg, dispatch ctx, CLI flag) before
// it becomes an .ijfw write target. A clean candidate is returned resolved;
// a missing or bundle-internal candidate falls through to `fallback` when
// given (callers with a precomputed PROJECT_DIR pass it), else to a fresh
// safeProjectDir() -- never a throw, never a bundle interior.
//
// Deliberately NO writability probe on the candidate: probing mkdirs
// missing directories as a side-effect, and silently redirecting a merely
// unwritable-but-explicit root elsewhere would mis-scope the caller's data.
// An unwritable root still fails downstream exactly as it always did; the
// bundle gate is the security boundary this helper adds.
export function vetProjectRoot(candidate, fallback) {
  if (typeof candidate === 'string' && candidate.length > 0) {
    const resolved = validatePath(candidate);
    if (resolved && !isBundleInternalDeep(resolved)) return resolved;
  }
  return fallback !== undefined ? fallback : safeProjectDir();
}
