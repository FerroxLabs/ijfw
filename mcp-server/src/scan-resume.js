// IJFW v1.3.0 Alpha -- A3 cross-session checkpoint+resume helper (V3-F2).
//
// Persists scan progress at <project>/.ijfw/scan-state.json so a crash
// mid-walk on a 100k-file repo never re-scans from zero. State shape:
//
//   {
//     scan_id:           string  -- opaque id, regenerated per restart
//     started_at:        ISO8601 -- when the run began
//     last_path_walked:  string  -- absolute path of last entry visited
//     files_scanned:     number
//     total_estimate:    number
//     attempts:          number  -- bump on each resume; 3 caps it
//     incomplete:        bool    -- false on clean finish, true on guardrail
//     session_id:        string? -- forensic only; not used for resume
//   }
//
// shouldResume() rules (per spec):
//   - state.incomplete must be true
//   - state.started_at must be <24h old
//   - state.attempts must be <3 (so a 3rd attempt triggers fresh restart;
//     a 4th is rejected by the cap)
//
// Atomic write: tmp + rename. POSIX rename(2) is atomic on the same fs.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync } from 'fs';
import { join } from 'path';

const STATE_FILE = 'scan-state.json';
const LOCK_FILE = 'scan-state.json.lock';
const STALENESS_MS = 24 * 60 * 60 * 1000; // 24h
const ATTEMPT_CAP = 3;
// P3-M6: stale-lock reclamation -- a lock older than this and with a dead
// owner PID is reclaimable. Mirrors lock.sh's STALE_AGE_SECONDS=60.
const LOCK_STALE_MS = 60 * 1000;

function statePath(projectRoot) {
  return join(String(projectRoot), '.ijfw', STATE_FILE);
}

export function loadScanState(projectRoot) {
  const path = statePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through */ }
  return null;
}

export function writeScanState(projectRoot, state) {
  const dir = join(String(projectRoot), '.ijfw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = statePath(projectRoot);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const safe = {
    scan_id: String(state.scan_id || ''),
    started_at: String(state.started_at || new Date().toISOString()),
    last_path_walked: String(state.last_path_walked || ''),
    files_scanned: Number.isFinite(state.files_scanned) ? state.files_scanned : 0,
    total_estimate: Number.isFinite(state.total_estimate) ? state.total_estimate : 0,
    attempts: Number.isFinite(state.attempts) ? state.attempts : 1,
    incomplete: state.incomplete !== false,
    session_id: state.session_id || null,
  };
  // P3-H3: persist accumulated partial walk state (counters, fingerprint
  // sample, manifest hits, dir hits, ext totals, pattern hits) so resume
  // continues to add to it rather than restarting at zero.
  if (state.partial && typeof state.partial === 'object') {
    safe.partial = state.partial;
  }
  writeFileSync(tmpPath, JSON.stringify(safe, null, 2) + '\n', 'utf8');
  // P3-H5: cross-mount symlink layouts raise EXDEV from rename; copy +
  // unlink keeps the write durable on dotfile setups where .ijfw/ lives
  // on a different filesystem than the temp file.
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
    try {
      copyFileSync(tmpPath, finalPath);
    } finally {
      try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    }
  }
  return finalPath;
}

// P3-M6: TOCTOU lock helpers for scan-state.json. Mirrors the noclobber
// CAS pattern used by lock.sh -- exclusive create, PID + epoch_ms inside,
// stale-lock reclamation on dead owners or age > LOCK_STALE_MS.
function lockPath(projectRoot) {
  return join(String(projectRoot), '.ijfw', LOCK_FILE);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function reclaimIfStale(lp) {
  if (!existsSync(lp)) return;
  let raw;
  try { raw = readFileSync(lp, 'utf8'); } catch { return; }
  const lines = String(raw).split(/\r?\n/);
  const pid = Number(lines[0]);
  const ts = Number(lines[1]);
  const ageOk = Number.isFinite(ts) && (Date.now() - ts) <= LOCK_STALE_MS;
  if (isPidAlive(pid) && ageOk) return;
  try { unlinkSync(lp); } catch { /* best-effort */ }
}

/**
 * acquireScanLock(projectRoot) -> { released } | null
 * Returns null when another live writer holds the lock; the caller MUST
 * skip its write rather than racing. On success, callers must invoke
 * the returned `released` function (or implicitly release on process exit).
 */
export function acquireScanLock(projectRoot) {
  const dir = join(String(projectRoot), '.ijfw');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lp = lockPath(projectRoot);
  reclaimIfStale(lp);
  const payload = String(process.pid) + '\n' + String(Date.now()) + '\n';
  try {
    writeFileSync(lp, payload, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
  let released = false;
  return {
    released: () => {
      if (released) return;
      released = true;
      try { unlinkSync(lp); } catch { /* best-effort */ }
    },
  };
}

export function shouldResume(state) {
  if (!state || typeof state !== 'object') return false;
  if (state.incomplete !== true) return false;
  if (!state.started_at || typeof state.started_at !== 'string') return false;
  const startedMs = Date.parse(state.started_at);
  if (!Number.isFinite(startedMs)) return false;
  const ageMs = Date.now() - startedMs;
  if (ageMs > STALENESS_MS) return false;
  const attempts = Number.isFinite(state.attempts) ? state.attempts : 0;
  if (attempts >= ATTEMPT_CAP) return false;
  return true;
}

export function clearScanState(projectRoot) {
  const path = statePath(projectRoot);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best-effort */ }
  }
}

export const __test = { STALENESS_MS, ATTEMPT_CAP, LOCK_STALE_MS, statePath, lockPath };
