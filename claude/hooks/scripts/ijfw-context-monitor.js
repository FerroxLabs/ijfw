#!/usr/bin/env node
// IJFW context monitor (PostToolUse) -- writes context state into the per-session
// bridge file so the next statusLine render has fresh data without subprocess work.
//
// Debounced: only writes every Nth call (default 5).
// Bridge-safe: writes to ~/.ijfw/run/<session_id>/context.json (0700 dir, 0600 file).
// SessionStart cleans dirs >24h old.
//
// Hot-path: sync, single read of stdin JSON + single atomic-ish write. No network.

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const DEBOUNCE_EVERY = 5;
const STDIN_TIMEOUT_MS = 1500;

function ijfwHome() { return process.env.IJFW_HOME || join(homedir(), '.ijfw'); }

function safeSession(sid) {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(sid || '') ? sid : 'default-session';
}

function readStdinJsonSync() {
  if (process.stdin.isTTY) return null;
  try {
    const fd = 0;
    try { fstatSync(fd); } catch { return null; }
    const buf = Buffer.alloc(16384);
    let total = 0;
    const start = Date.now();
    while (Date.now() - start < STDIN_TIMEOUT_MS && total < buf.length) {
      try {
        const n = readSync(fd, buf, total, buf.length - total, null);
        if (!n) break;
        total += n;
      } catch (e) {
        if (e.code === 'EAGAIN') {
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 20);
          continue;
        }
        break;
      }
    }
    const raw = buf.subarray(0, total).toString('utf8').trim();
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } catch { return null; }
}

function readJsonSafe(path) {
  try { if (!existsSync(path)) return null; return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function writeAtomicJson(path, data) {
  const dir = path.replace(/[/\\][^/\\]+$/, '');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (err) {
    // EXDEV / EACCES / EBUSY (Windows): tmp would otherwise leak. Clean up.
    try { unlinkSync(tmp); } catch { /* */ }
    throw err;
  }
}

(function main() {
  try {
    const stdinJson = readStdinJsonSync();
    if (!stdinJson) return process.exit(0);

    const sessionId = safeSession(stdinJson.session_id);
    const remainingPct = stdinJson.context_window && stdinJson.context_window.remaining_percentage;
    const counterPath = join(ijfwHome(), 'run', sessionId, 'tool-counter.json');
    const counter = readJsonSafe(counterPath) || { n: 0 };
    counter.n = (counter.n || 0) + 1;
    writeAtomicJson(counterPath, counter);

    // Debounce: only write context state every Nth call
    if (counter.n % DEBOUNCE_EVERY !== 0) return process.exit(0);

    const ctxPath = join(ijfwHome(), 'run', sessionId, 'context.json');
    writeAtomicJson(ctxPath, {
      schema_version: 1,
      remaining_percentage: typeof remainingPct === 'number' ? remainingPct : null,
      tool_calls: counter.n,
      updated_at: Date.now(),
    });
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
