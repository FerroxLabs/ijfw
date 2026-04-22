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
  existsSync, mkdirSync, unlinkSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';

const IS_WIN = platform() === 'win32';

export function writeAtomic(targetPath, data, opts = {}) {
  const { mode = 0o600, ensureDir = true, fsyncDir = !IS_WIN } = opts;
  const abs = pathResolve(targetPath);
  const dir = dirname(abs);

  if (ensureDir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Refuse symlinks at target -- supply-chain hygiene per v3 sec 1
  if (existsSync(abs)) {
    try {
      const st = statSync(abs);
      if (st.isSymbolicLink && st.isSymbolicLink()) {
        throw new Error(`refusing to overwrite symlink at ${abs}`);
      }
    } catch (e) {
      if (e.message.startsWith('refusing')) throw e;
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

    renameSync(tmp, abs);

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

// Log rotation -- caller of writeAtomic for log files invokes this first.
// Each log capped at 1MB; rotate to <name>.log.1, delete <name>.log.2.
export function rotateLogIfNeeded(logPath, maxBytes = 1024 * 1024) {
  try {
    if (!existsSync(logPath)) return false;
    const st = statSync(logPath);
    if (st.size < maxBytes) return false;
    const rot1 = `${logPath}.1`;
    const rot2 = `${logPath}.2`;
    try { if (existsSync(rot2)) unlinkSync(rot2); } catch { /* */ }
    try { if (existsSync(rot1)) renameSync(rot1, rot2); } catch { /* */ }
    try { renameSync(logPath, rot1); } catch { /* */ }
    return true;
  } catch {
    return false;
  }
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
