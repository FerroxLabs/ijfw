// npm view helper -- regex-validated version string fetch with retry + log.
// Used by both the SessionStart bg check and ijfw_update_check MCP tool.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { rotateLogIfNeeded, redactUrl } from './atomic-io.js';

const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const PKG = '@ijfw/install';

export async function npmView(pkg = PKG, opts = {}) {
  const { retries = 2, timeoutMs = 10_000, backoffMs = 2000 } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = spawnSync('npm', ['view', pkg, 'version', '--json'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      // shell:true on Windows so npm.cmd resolves; harmless on POSIX.
      shell: process.platform === 'win32',
    });
    if (res.error) {
      lastErr = `spawn-${res.error.code || 'ERR'}: ${(res.error.message || String(res.error)).slice(0, 120)}`;
      logFailure(pkg, lastErr);
      if (attempt < retries && isTransient(res.error.code)) {
        await sleep(backoffMs);
        continue;
      }
      return { ok: false, error: 'spawn', message: lastErr };
    }
    if (res.signal) {
      lastErr = `killed by ${res.signal} (likely network timeout)`;
      logFailure(pkg, lastErr);
      if (attempt < retries) {
        await sleep(backoffMs);
        continue;
      }
      return { ok: false, error: 'signal', message: lastErr };
    }
    if (res.status !== 0) {
      lastErr = (res.stderr || '').trim() || `npm view exited ${res.status} with no stderr`;
      logFailure(pkg, lastErr);
      if (attempt < retries) {
        await sleep(backoffMs);
        continue;
      }
      return { ok: false, error: 'exit', message: lastErr };
    }
    const raw = (res.stdout || '').trim().replace(/^"|"$/g, '');
    if (!VERSION_RE.test(raw)) {
      logFailure(pkg, `malformed: ${raw.slice(0, 80)}`);
      return { ok: false, error: 'malformed', message: raw.slice(0, 80) };
    }
    return { ok: true, version: raw };
  }
  return { ok: false, error: 'exhausted', message: lastErr };
}

function isTransient(code) {
  return code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isVersionStringValid(s) {
  return typeof s === 'string' && VERSION_RE.test(s);
}

export function compareSemver(a, b) {
  // Returns -1 if a<b, 0 if eq, 1 if a>b. Pre-release sorts < release.
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

function logRoot() {
  const r = process.env.IJFW_HOME || join(homedir(), '.ijfw');
  const dir = join(r, 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function logFailure(pkg, message) {
  try {
    const path = join(logRoot(), 'update-check.log');
    rotateLogIfNeeded(path);
    const line = `${new Date().toISOString()} ${pkg} ${redactUrl(String(message)).slice(0, 200)}\n`;
    appendFileSync(path, line, { mode: 0o600 });
  } catch { /* logging is best-effort */ }
}
