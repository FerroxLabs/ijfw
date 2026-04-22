#!/usr/bin/env node
// Background update-check worker. Detached from SessionStart hook (v3 Âsection 3).
//
// Contract:
//   - Reads settings.json + state.json + cache/update-check.json
//   - Honors IJFW_DISABLE_UPDATE_CHECK env (truthy regex)
//   - Honors in-flight marker dedupe (skip if another check ran <30s ago)
//   - Honors negative cache (failure_backoff_hours)
//   - Honors interval_hours
//   - Honors re-entrancy: if state.last_applied_version >= cache.last_latest_seen, skip
//   - Atomic cache write with single rename
//   - Best-effort log to ~/.ijfw/logs/update-check.log (rotated at 1MB)
//   - Cleans stale ~/.ijfw/run/<sid>/ dirs older than 24h
//   - Always exits 0
//
// SIGTERM handler aborts before any write (parent timeout safety).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, readdirSync, statSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const PKG = '@ijfw/install';
const MAX_LOG_BYTES = 1024 * 1024;

let aborted = false;
process.on('SIGTERM', () => { aborted = true; setTimeout(() => process.exit(0), 50); });

function ijfwHome() { return process.env.IJFW_HOME || join(homedir(), '.ijfw'); }
function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 }); }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(path, data) {
  ensureDir(path.replace(/[/\\][^/\\]+$/, ''));
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function rotateLog(path) {
  try {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (st.size < MAX_LOG_BYTES) return;
    const r1 = `${path}.1`;
    const r2 = `${path}.2`;
    try { if (existsSync(r2)) unlinkSync(r2); } catch { /* */ }
    try { if (existsSync(r1)) renameSync(r1, r2); } catch { /* */ }
    try { renameSync(path, r1); } catch { /* */ }
  } catch { /* */ }
}

function logLine(message) {
  try {
    const dir = join(ijfwHome(), 'logs');
    ensureDir(dir);
    const path = join(dir, 'update-check.log');
    rotateLog(path);
    const safe = String(message).replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/g, '$1?<redacted>').slice(0, 200);
    appendFileSync(path, `${new Date().toISOString()} ${safe}\n`, { mode: 0o600 });
  } catch { /* logging is best-effort */ }
}

function isDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.IJFW_DISABLE_UPDATE_CHECK || '');
}

function cleanStaleRunDirs() {
  try {
    const root = join(ijfwHome(), 'run');
    if (!existsSync(root)) return;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const entry of readdirSync(root)) {
      const p = join(root, entry);
      try {
        const st = statSync(p);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          rmSync(p, { recursive: true, force: true });
        }
      } catch { /* per-entry */ }
    }
  } catch { /* dir-level */ }
}

function cmpSemver(a, b) {
  const parse = v => {
    const [main, pre] = String(v).split('-', 2);
    const nums = main.split('.').map(n => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre || null };
  };
  const A = parse(a); const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return A.pre < B.pre ? -1 : 1;
}

function npmView(pkg) {
  const r = spawnSync('npm', ['view', pkg, 'version', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error) return { ok: false, message: r.error.message || String(r.error) };
  if (r.status !== 0) return { ok: false, message: (r.stderr || '').trim().slice(0, 100) || `exit ${r.status}` };
  const raw = (r.stdout || '').trim().replace(/^"|"$/g, '');
  if (!VERSION_RE.test(raw)) return { ok: false, message: `malformed:${raw.slice(0, 40)}` };
  return { ok: true, version: raw };
}

(function main() {
  if (aborted || isDisabled()) return process.exit(0);

  const home = ijfwHome();
  const cacheDir = join(home, 'cache');
  ensureDir(cacheDir);

  // Stale run-dir cleanup happens regardless (v3 Âsection 2)
  cleanStaleRunDirs();

  // Dedupe: in-flight marker
  try {
    for (const f of readdirSync(cacheDir)) {
      if (!f.startsWith('.check-in-flight.')) continue;
      try {
        const st = statSync(join(cacheDir, f));
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs < 30_000) return process.exit(0);
        unlinkSync(join(cacheDir, f));
      } catch { /* */ }
    }
  } catch { /* */ }
  const marker = join(cacheDir, `.check-in-flight.${process.pid}`);
  try { writeFileSync(marker, String(process.pid)); } catch { /* */ }

  const cleanup = () => { try { unlinkSync(marker); } catch { /* */ } };
  process.on('exit', cleanup);

  if (aborted) return process.exit(0);

  // Read settings + state + cache
  const settings = readJson(join(home, 'settings.json')) || {};
  const state = readJson(join(home, 'state.json')) || {};
  const cache = readJson(join(cacheDir, 'update-check.json')) || {};

  const intervalHours = (settings.update_check && settings.update_check.interval_hours) || 24;
  const failureBackoffHours = (settings.update_check && settings.update_check.failure_backoff_hours) || 1;

  const nowSec = Math.floor(Date.now() / 1000);

  // Negative cache backoff
  if (cache.last_failure && (nowSec - cache.last_failure) < failureBackoffHours * 3600) {
    return process.exit(0);
  }

  // Re-entrancy: if last_applied_version is at or beyond last_latest_seen, skip
  if (cache.last_latest_seen && state.last_applied_version &&
      cmpSemver(state.last_applied_version, cache.last_latest_seen) >= 0) {
    // Up-to-date based on last apply -- no fresh work needed unless interval expired
    if (cache.last_check && (nowSec - cache.last_check) < intervalHours * 3600) {
      return process.exit(0);
    }
  }

  // Interval check
  if (cache.last_check && (nowSec - cache.last_check) < intervalHours * 3600 &&
      !cache.last_failure) {
    return process.exit(0);
  }

  // Clock skew clamp
  if (cache.last_check && cache.last_check > nowSec) {
    // Clock went backwards; ignore cached value
    cache.last_check = null;
  }

  if (aborted) return process.exit(0);

  const r = npmView(PKG);
  if (!r.ok) {
    logLine(`npm view failed: ${r.message}`);
    writeJsonAtomic(join(cacheDir, 'update-check.json'), {
      schema_version: 1,
      last_check: nowSec,
      last_latest_seen: cache.last_latest_seen || null,
      last_failure: nowSec,
      error_class: r.message.slice(0, 60),
    });
    return process.exit(0);
  }

  // Monotonic: never advertise a lower version than previously seen
  let latest = r.version;
  if (cache.last_latest_seen && cmpSemver(latest, cache.last_latest_seen) < 0) {
    latest = cache.last_latest_seen;
  }

  writeJsonAtomic(join(cacheDir, 'update-check.json'), {
    schema_version: 1,
    last_check: nowSec,
    last_latest_seen: latest,
    last_failure: null,
  });

  process.exit(0);
})();
