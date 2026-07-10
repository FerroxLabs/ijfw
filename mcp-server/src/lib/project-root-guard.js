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
  resolve, normalize, isAbsolute, join, dirname, basename,
} from 'node:path';
import { homedir } from 'node:os';

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

// --- Root resolution -----------------------------------------------------------
//
// Every candidate must pass BOTH gates: not bundle-internal (wayland#755)
// AND writable. A rejected candidate falls through to the next-safest
// option; the HOME fallback guarantees we never crash the server (any
// stderr byte during MCP init makes the client mark the server failed).
// The bundle check runs BEFORE the writability probe so a rejected
// candidate directory is never mkdir'd as a side-effect.
export function safeProjectDir() {
  // 1. Explicit IJFW_PROJECT_DIR wins (user or installer set it deliberately).
  //    Still validated: even an explicit signal must not point inside a
  //    signed app bundle -- not even via a symlink.
  const fromIjfw = validatePath(process.env.IJFW_PROJECT_DIR);
  if (fromIjfw && !isBundleInternalDeep(fromIjfw) && isWritable(fromIjfw)) return fromIjfw;

  // 2. CLAUDE_PROJECT_DIR (set by some Claude Code versions).
  const fromClaude = validatePath(process.env.CLAUDE_PROJECT_DIR);
  if (fromClaude && !isBundleInternalDeep(fromClaude) && isWritable(fromClaude)) return fromClaude;

  // 3. CWD if writable -- normal case for shell-invoked use and Claude Code
  //    sessions rooted in a project. Hosts sometimes spawn MCP servers with
  //    cwd inside their own bundle (wayland#755) -- never accept that.
  const cwd = process.cwd();
  if (!isBundleInternalDeep(cwd) && isWritable(cwd)) return cwd;

  // 4. HOME fallback -- always writable for the user. Memory becomes
  //    user-global but we stay alive instead of crashing.
  return homedir();
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
