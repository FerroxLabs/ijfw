// Cross-platform atomic I/O helpers. Zero deps. POSIX + Windows NTFS.
//
// writeAtomic(path, data, opts) -- write to <path>.tmp.<rand>, fsync (POSIX),
//   rename to final. Atomic on same volume on POSIX + NTFS (since Vista).
//   Network FS / FAT32 -- logs warning, writes non-atomically; tolerable.
//
// readSafe(path, validator?) -- never throws. Returns {ok, data, error}.
//   If validator(data) returns falsy/throws, returned as no-data path.
//
// withLock(lockPath, fn, opts) -- exclusive PID-file lock via O_EXCL.
//   5s default wait with 50ms retry. On timeout returns {status:'locked', pid}.

import { writeFileSync, openSync, closeSync, fsyncSync, renameSync, readFileSync,
  existsSync, mkdirSync, unlinkSync, statSync, lstatSync, chmodSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';

const IS_WIN = platform() === 'win32';

export function writeAtomic(targetPath, data, opts = {}) {
  const { mode = 0o600, ensureDir = true, fsyncDir = !IS_WIN } = opts;
  const abs = pathResolve(targetPath);
  const dir = dirname(abs);

  if (ensureDir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Refuse symlinks at target -- supply-chain hygiene per v3 sec 1.
  //
  // v1.5.1 H1.3 (audit update-install-trust.md F-COR-1): was `statSync`, which
  // follows symlinks. On a symlink target's stat, `isSymbolicLink()` always
  // returns false, so the check was dead code. Fixed to `lstatSync`.
  //
  // v1.5.1 H1.3-followup (Trident r18): the throw was nested inside a try/
  // catch that string-matched `e.message.startsWith('refusing')` to decide
  // whether to rethrow. Functionally correct but fragile — if the message
  // string ever changes the catch swallows the symlink refusal. Restructured
  // so the throw is OUTSIDE any try/catch: only the lstatSync probe is
  // try-wrapped (to tolerate a race where the file vanishes between
  // existsSync and lstatSync), and the refusal throw runs unconditionally
  // when isSymbolicLink() is true.
  //
  // NB: the rename pattern below (write tmp, rename to abs) is already
  // symlink-safe at the POSIX `rename(2)` level — rename replaces a symlink
  // rather than writing through it. This check is defense-in-depth: it makes
  // symlink-replacement an explicit refusal instead of a silent overwrite.
  if (existsSync(abs)) {
    let st = null;
    try {
      st = lstatSync(abs);
    } catch {
      // Race: file vanished between existsSync and lstatSync. Tolerate —
      // the subsequent rename will either succeed cleanly or surface its own
      // error. We do NOT silently allow a symlink overwrite via this path.
    }
    if (st && st.isSymbolicLink && st.isSymbolicLink()) {
      throw new Error(`refusing to overwrite symlink at ${abs}`);
    }
  }

  const tmp = `${abs}.tmp.${randomBytes(8).toString('hex')}`;
  const buf = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  let fd;
  try {
    fd = openSync(tmp, 'w', mode);
    writeFileSync(fd, buf);
    if (!IS_WIN) {
      try { fsyncSync(fd); } catch { /* fsync may fail on some FS, tolerable */ }
    }
    closeSync(fd);
    fd = null;

    renameWithRetry(tmp, abs);

    if (fsyncDir) {
      try {
        const dfd = openSync(dir, 'r');
        try { fsyncSync(dfd); } catch { /* dir fsync best-effort */ }
        closeSync(dfd);
      } catch { /* dir fsync optional */ }
    }

    try { chmodSync(abs, mode); } catch { /* perms best-effort, hot-path validates */ }
  } catch (e) {
    if (fd != null) try { closeSync(fd); } catch { /* */ }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* */ }
    throw e;
  }

  return { ok: true, path: abs, bytes: Buffer.byteLength(buf) };
}

export function readSafe(targetPath, validator) {
  try {
    if (!existsSync(targetPath)) return { ok: false, error: 'enoent' };
    const raw = readFileSync(targetPath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: 'parse', message: e.message };
    }
    if (typeof validator === 'function') {
      try {
        const ok = validator(parsed);
        if (!ok) return { ok: false, error: 'invalid', data: parsed };
      } catch (e) {
        return { ok: false, error: 'validator', message: e.message, data: parsed };
      }
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: 'io', message: e.message };
  }
}

export function withLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 5000, retryMs = 50 } = opts;
  const abs = pathResolve(lockPath);
  const dir = dirname(abs);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const start = Date.now();
  let acquired = false;
  let heldByPid = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = openSync(abs, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); } catch { /* */ }
      closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const pidStr = readFileSync(abs, 'utf8').trim();
          heldByPid = Number(pidStr) || null;
          // Stale-lock detection -- if PID isn't running, reclaim
          if (heldByPid && !pidAlive(heldByPid)) {
            try { unlinkSync(abs); } catch { /* */ }
            continue;
          }
        } catch { /* */ }
        const waited = Date.now() - start;
        const remaining = timeoutMs - waited;
        if (remaining <= 0) break;
        // Synchronous sleep via Atomics
        sleepSync(Math.min(retryMs, remaining));
      } else {
        throw e;
      }
    }
  }

  if (!acquired) return { status: 'locked', pid: heldByPid };

  try {
    const result = fn();
    return { status: 'ok', result };
  } finally {
    try { unlinkSync(abs); } catch { /* */ }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// Windows-safe rename. On NTFS a rename over an existing file transiently
// fails with EPERM/EACCES/EBUSY when antivirus, the Search indexer, or another
// process momentarily holds a handle on src or dest -- the classic
// "EPERM: operation not permitted, rename '<x>.tmp' -> '<x>'". POSIX rename(2)
// is atomic and does not exhibit this, so on non-Windows we rename once and
// return. On Windows we retry a bounded number of times with exponential
// backoff; only the known-transient codes are retried, everything else
// rethrows immediately so real errors are not masked.
const RENAME_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);
function renameWithRetry(src, dest, { maxAttempts = 10, baseDelayMs = 10, maxDelayMs = 250 } = {}) {
  if (!IS_WIN) { renameSync(src, dest); return; }
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      renameSync(src, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (!RENAME_TRANSIENT.has(e.code)) throw e;
      if (attempt < maxAttempts - 1) {
        sleepSync(Math.min(baseDelayMs * (2 ** attempt), maxDelayMs));
      }
    }
  }
  throw lastErr;
}

// Log rotation -- caller of writeAtomic for log files invokes this first.
// Each log capped at 1MB; rotate to <name>.log.1, delete <name>.log.2.
//
// V155-052 (v1.5.5): the original implementation was destructive-then-might-
// fail: unlink rot2 (oldest history), then rename rot1→rot2, then rename
// logPath→rot1. If the third rename failed (Windows AV scanner holds an open
// handle, e.g.) we'd already have thrown away the oldest history for no
// benefit while reporting `return true` (rotated). New shape:
//   1. Pre-check that logPath rename will succeed (renameSync is the most
//      likely failure point on Windows). Do this by renaming through a tmp
//      probe inside the same directory — atomic same-FS rename is the only
//      reliable test short of actually doing the rotation.
//   2. Only then proceed with the destructive cleanup.
//   3. Return `{rotated, error?}` so callers can log a structured warning
//      when rotation fails. Boolean-true legacy path preserved via
//      `result.rotated`.
export function rotateLogIfNeeded(logPath, maxBytes = 1024 * 1024) {
  if (!existsSync(logPath)) return false;
  let st;
  try { st = statSync(logPath); }
  catch (e) { return { rotated: false, error: `stat-failed: ${e?.message || e}` }; }
  if (st.size < maxBytes) return false;
  const rot1 = `${logPath}.1`;
  const rot2 = `${logPath}.2`;

  // V155-052 step 1: try to rename logPath → rot1 directly. On POSIX this is
  // atomic; on Windows it fails with EBUSY when the file is held. We DON'T
  // touch rot1 or rot2 yet, so the existing rotation history stays intact
  // until we know the live-log handoff is going to succeed. We need rot1 to
  // be free first — but the prior rot1 contents are valuable, so we move
  // them to rot2 BEFORE the live rename, and only after that succeeds do we
  // remove the previous rot2.
  //
  // Sequence (loud on failure):
  //   (a) if rot2 exists: keep it for now (we still have a copy until step c)
  //   (b) rename rot1 → rot2_new (a unique temp name) — preserves both old
  //       generations while we attempt the live rename
  //   (c) rename logPath → rot1
  //   (d) on success: unlink the previous rot2 (which was preserved through
  //       step b under its temp name); rename rot2_new → rot2
  //   (e) on failure of (c): roll back step b
  //
  // The cost is one extra rename; the benefit is we never destroy oldest
  // history except after the new history has landed.
  const rot2Tmp = `${rot2}.tmp.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const hadRot1 = existsSync(rot1);
  const hadRot2 = existsSync(rot2);

  if (hadRot1) {
    try { renameSync(rot1, rot2Tmp); }
    catch (e) {
      return { rotated: false, error: `pre-rotate move rot1→rot2.tmp failed: ${e?.message || e}` };
    }
  }
  try { renameSync(logPath, rot1); }
  catch (e) {
    // Roll back step (b) so the prior rot1 is preserved.
    if (hadRot1) {
      try { renameSync(rot2Tmp, rot1); } catch { /* best-effort rollback */ }
    }
    return { rotated: false, error: `rotate logPath→rot1 failed: ${e?.message || e}` };
  }
  // Live rename succeeded. Now retire the previous rot2 and commit rot2Tmp
  // as the new rot2. Both steps are best-effort: if they fail we still have
  // a successful live rotation plus an over-N tmp file that can be cleaned
  // out next run.
  if (hadRot2) {
    try { unlinkSync(rot2); } catch { /* best-effort */ }
  }
  if (hadRot1) {
    try { renameSync(rot2Tmp, rot2); } catch { /* best-effort */ }
  }
  return true;
}

// URL redactor -- strip query strings before logging per v3 sec 15
export function redactUrl(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1?<redacted>');
}

// ANSI-strip for safe console output of fetched content (CHANGELOG etc).
// Strips ESC sequences + bell + non-printable controls except \n \t.
export function stripAnsi(s) {
  if (typeof s !== 'string') return '';
  // ESC sequences (CSI + OSC + simple ESC + 8-bit CSI)
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[@-Z\\-_]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x9b[0-9;?]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return out;
}
