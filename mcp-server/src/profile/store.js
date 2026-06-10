/**
 * profile/store.js — Cross-system profile bus, P0.2 + P0.3.
 *
 * The user-global profile store: path resolution + atomic read/write with a
 * `.bak` backup and a symlink guard.
 *
 * KEY INVARIANT (design-v2 §2, audit MED-Storage): this tier is **user-global,
 * homedir-rooted, and EXEMPT from the per-project PROJECT_HASH namespacing**.
 * Project memory is REPO_ROOT-scoped to prevent cross-project worming; the
 * profile is the deliberate, documented exception (it's about the user, not the
 * project). Therefore every path resolves from `os.homedir()` — NEVER from CWD
 * or REPO_ROOT — so two host processes in two projects converge on ONE file.
 *
 * Layout-v2 note: a future rename moves `.ijfw/` → `ijfw/`. We key off homedir
 * + a single base-dir constant so that rename is a one-line change here, not a
 * literal sprinkled across the codebase.
 *
 * Atomic write: temp file in the SAME directory → fsync → rename. The target is
 * opened with O_NOFOLLOW (via openSync flags) so a symlinked target is refused
 * rather than followed (anti-symlink-swap). A `.bak` copy of the prior good
 * content is kept; a corrupt/unparseable primary is recovered from `.bak`.
 *
 * Zero deps, Node built-ins only. NO LLM calls.
 */

import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  readFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { makeProfile, serializeProfile, parseProfile } from './schema.js';
import { resolveOverrideDir, homedirProfileDefault } from './path-policy.js';

const PROFILE_FILE = 'user-profile.md';

/**
 * Max bytes we will read from an on-disk profile (audit LOW: read-size cap).
 * The profile is bounded by P0.6 eviction/decay, so a file larger than this is
 * a hand-edited or corrupt artifact; refusing to slurp it whole avoids an OOM
 * on a pathological input. 4 MiB is ~orders of magnitude above any legitimate
 * profile. A too-large primary falls through to .bak recovery (readProfile).
 */
const MAX_PROFILE_BYTES = 4 * 1024 * 1024;

/**
 * The user-global profile directory. Override via IJFW_PROFILE_DIR (tests +
 * power users). Default: `~/.ijfw/profile`. Resolved from homedir, never CWD.
 *
 * SECURITY (audit HIGH-4): a verbatim env override is a relocation/identity-
 * partition-defeat surface, so the override is validated by `resolveOverrideDir`
 * — honored only under a test runner OR when it resolves under os.homedir() and
 * is uid-owned. An unsafe override falls back to the default homedir path.
 *
 * TEST-ISOLATION: when there is no safe override, the default is resolved by
 * `homedirProfileDefault`, which under a test context returns a process-unique
 * `os.tmpdir()` scratch dir (never the real homedir) — so a test that forgot to
 * set IJFW_PROFILE_DIR is auto-isolated and can never write into the user's real
 * `~/.ijfw/profile`. Production behavior is unchanged (real homedir).
 */
export function profileDir() {
  const safe = resolveOverrideDir(process.env.IJFW_PROFILE_DIR);
  if (safe) return safe;
  return homedirProfileDefault(['.ijfw', 'profile']);
}

export function profilePath() {
  return join(profileDir(), PROFILE_FILE);
}

export function backupPath() {
  return `${profilePath()}.bak`;
}

/** The user-global archive dir (P0.6 decay-to-archive lands files here). */
export function archiveDir() {
  return join(profileDir(), 'archive');
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * True iff `p` exists AND is a symlink. We refuse to read/write through a
 * symlinked target — an attacker who can pre-create the profile path as a
 * symlink could otherwise redirect our atomic rename / our read at an arbitrary
 * file. lstat() (not stat()) so the link itself is inspected, not its target.
 */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false; // absent → not a symlink
  }
}

/**
 * writeProfile(profile) — atomic, backup-keeping, symlink-guarded write.
 * Returns { ok:true } or { ok:false, code, message }. Never throws.
 */
export function writeProfile(profile) {
  const target = profilePath();
  // Symlink guard: refuse a symlinked target outright.
  if (isSymlink(target)) {
    return { ok: false, code: 'EPROFILE_SYMLINK', message: `refusing symlinked target: ${target}` };
  }

  let content;
  try {
    content = serializeProfile(profile);
  } catch (err) {
    return { ok: false, code: 'ESERIALIZE', message: err.message };
  }

  try {
    ensureDir(profileDir());
  } catch (err) {
    return { ok: false, code: err.code || 'EMKDIR', message: err.message };
  }

  // Back up the prior good content (best-effort) BEFORE we overwrite, so a
  // crash mid-rename leaves a recoverable .bak. Guard BOTH sides against a
  // symlink swap: the source (`target`) so we don't read through a link, AND
  // the destination (`backupPath()`) — a pre-planted `user-profile.md.bak`
  // symlink would otherwise let copyFileSync follow it and overwrite an
  // arbitrary file. If the .bak path is a symlink, drop it (unlink) and copy to
  // a real file instead; never write through the link.
  if (existsSync(target) && !isSymlink(target)) {
    try {
      const bak = backupPath();
      if (isSymlink(bak)) {
        try { unlinkSync(bak); } catch {}
      }
      copyFileSync(target, bak);
    } catch {
      // non-fatal — proceed; worst case is no fresh backup this round.
    }
  }

  const tmp = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let fd;
  try {
    // O_NOFOLLOW on the tmp create is belt-and-suspenders; the tmp name is
    // random so it cannot pre-exist as an attacker symlink, but we keep the
    // flag for defense in depth. O_EXCL ensures we never open an existing file.
    // NOTE: O_NOFOLLOW is a no-op on Windows (no symlink semantics there) — the
    // real cross-platform guard is the isSymlink() (lstat) check above/below.
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // Re-check the target right before rename — TOCTOU narrowing.
    if (isSymlink(target)) {
      try { unlinkSync(tmp); } catch {}
      return { ok: false, code: 'EPROFILE_SYMLINK', message: `target became a symlink: ${target}` };
    }
    renameSync(tmp, target);
    // Durability: rename() is atomic, but on Linux ext4/XFS the parent
    // directory entry is not guaranteed to survive a power-fail until the
    // directory itself is fsynced — even though the file data was fsynced
    // above. Best-effort fsync the parent dir to durably commit the new entry.
    // Wrapped in try/catch: rename atomicity already holds, so a failed dir
    // fsync degrades durability, not correctness, and must not fail the write.
    try {
      const dirFd = openSync(profileDir(), fsConstants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // best-effort — some platforms (e.g. Windows) cannot fsync a directory.
    }
    return { ok: true };
  } catch (err) {
    if (fd != null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    return { ok: false, code: err.code || 'EWRITE', message: err.message };
  }
}

function tryParseFile(p) {
  // Refuse symlinked source.
  if (isSymlink(p)) return { ok: false, code: 'EPROFILE_SYMLINK' };
  // Read-size cap (audit LOW): refuse to slurp a pathologically large profile
  // into memory. The profile is bounded by P0.6, so an oversized file is a
  // corrupt/hand-edited artifact — surface ETOOBIG so readProfile falls through
  // to .bak recovery rather than OOMing on the read.
  try {
    const st = lstatSync(p);
    if (st.isFile() && st.size > MAX_PROFILE_BYTES) {
      return { ok: false, code: 'ETOOBIG', message: `profile exceeds ${MAX_PROFILE_BYTES} bytes` };
    }
  } catch {
    // stat failure falls through to the read, which will surface its own error.
  }
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    return { ok: false, code: err.code || 'EREAD', message: err.message };
  }
  try {
    return { ok: true, profile: parseProfile(raw) };
  } catch (err) {
    return { ok: false, code: 'EPARSE', message: err.message };
  }
}

/**
 * readProfile() — read the user-global profile.
 *  - missing file → fresh default profile, { ok:true, created:true }
 *  - good file    → { ok:true, profile }
 *  - corrupt file → recover from .bak → { ok:true, profile, recovered:true }
 *  - symlinked    → { ok:false } (refused)
 */
export function readProfile() {
  const target = profilePath();

  if (isSymlink(target)) {
    return { ok: false, code: 'EPROFILE_SYMLINK', message: `refusing symlinked target: ${target}` };
  }

  if (!existsSync(target)) {
    return { ok: true, profile: makeProfile(), created: true };
  }

  const primary = tryParseFile(target);
  if (primary.ok) return { ok: true, profile: primary.profile };

  // Primary unparseable — attempt backup recovery.
  const bak = backupPath();
  if (existsSync(bak) && !isSymlink(bak)) {
    const recovered = tryParseFile(bak);
    if (recovered.ok) {
      return { ok: true, profile: recovered.profile, recovered: true };
    }
  }

  // Neither primary nor backup is usable. Surface the error rather than
  // silently clobbering with a default (caller decides; merge layer will hold
  // the lock and can choose to reinitialize).
  return { ok: false, code: 'ECORRUPT', message: 'primary unparseable and no usable backup' };
}
