#!/usr/bin/env node
// IJFW statusLine -- sync, <50ms cache-hit, fail-open.
//
// Hot-path budget (v3 sec 4):
//   - read pre-validated cache (no hashing, stat, chmod, subprocess)
//   - read stdin JSON (Claude Code passes context_window.remaining_percentage)
//   - compute formatting
//   - emit one line
//   - exit 0 (always; never breaks Claude Code)
//
// Compose mode (when an existing statusLine command is detected + path-allowlisted):
//   - spawnSync the composed command with 120ms hard timeout
//   - wrap output safely; cap 80 chars
//   - on timeout/error -> fall back to IJFW-only render
//
// Stdin contract: Claude Code sends JSON {model:..., context_window:{remaining_percentage:N}}.
// Empty/malformed -> emit empty line, exit 0.

import { readFileSync, existsSync, readSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// STDIN_TIMEOUT_MS is the WORST-CASE bound on stdin read.
//
// v1.5.0 audit-LOW-update-#14: the v3 "sync, <50ms cache-hit" budget in the
// header refers to the HOT PATH when stdin is a TTY (we early-return null)
// or when stdin is already closed (the read loop exits on first zero-byte
// read). The 3000ms cap below is the WORST case: a producer pipe that's
// connected but stalling -- e.g. an upstream Claude Code build that
// occasionally takes a tick to flush its statusline JSON. Without a cap a
// stalled upstream would block the statusline indefinitely; with the cap we
// emit an empty line and exit cleanly within 3s. Typical observed read time
// on Claude Code 1.0+ is under 5ms; the cap is purely a safety net.
const STDIN_TIMEOUT_MS = 3000;
const WIDTH_BUDGET = 80;

function ijfwHome() { return process.env.IJFW_HOME || join(homedir(), '.ijfw'); }

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
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

function readStdinJsonSync() {
  if (process.stdin.isTTY) return null;
  try {
    const fd = 0; // stdin
    try { fstatSync(fd); } catch { return null; }
    // Pipe / FIFO -- try a single non-blocking read
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
          // Wait briefly + retry
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

function readUpdateCache() {
  const path = join(ijfwHome(), 'cache', 'update-check.json');
  return readJsonSafe(path);
}

function readState() {
  return readJsonSafe(join(ijfwHome(), 'state.json')) || {};
}

function readSettings() {
  return readJsonSafe(join(ijfwHome(), 'settings.json')) || {};
}

function makeContextSegment(remainingPct, settings) {
  if (typeof remainingPct !== 'number' || !isFinite(remainingPct)) return '';
  const cb = settings.context_bar || {};
  if (cb.enabled === false) return '';
  // Autocompact-aware usable percentage (v3 fix)
  const usableUsedPct = Math.max(0, Math.min(100,
    100 - Math.max(0, ((remainingPct - 16.5) / 83.5) * 100)
  ));
  const remaining = Math.max(0, Math.min(100, 100 - usableUsedPct));
  const filled = Math.round(usableUsedPct / 10);
  const empty = 10 - filled;
  const bar = '#'.repeat(filled) + '.'.repeat(empty);
  const style = cb.style || 'left';
  const label =
    style === 'runway' ? `${Math.round(remaining)}% runway` :
    style === 'classic' ? `${Math.round(usableUsedPct)}% used` :
    `${Math.round(remaining)}% left`;
  return `${bar} ${label}`;
}

function makeUpdateSegment(state, cache) {
  if (!cache || !cache.last_latest_seen) return '';
  const installed = state.installed_version || '0.0.0';
  const lastApplied = state.last_applied_version;
  // Re-entrancy: don't nudge after we just applied
  if (lastApplied && cmpSemver(lastApplied, cache.last_latest_seen) >= 0) return '';
  const cmp = cmpSemver(installed, cache.last_latest_seen);
  if (cmp >= 0) return '';
  return `^ ${cache.last_latest_seen} available`;
}

function fitToBudget(updateSeg, contextSeg) {
  const sep = '  |  ';
  if (!updateSeg && !contextSeg) return '';
  if (!updateSeg) return contextSeg;
  if (!contextSeg) return updateSeg;
  const combined = `${updateSeg}${sep}${contextSeg}`;
  if (combined.length <= WIDTH_BUDGET) return combined;
  // Drop the update nudge first (bar is more valuable per v3 sec 8)
  return contextSeg;
}

(function main() {
  // Hot-path budget: NO hashing, NO stat, NO chmod, NO subprocess (compose mode is
  // an explicit opt-in in Wave-2 polish). Just reads + formatting.
  try {
    const settings = readSettings();
    if (settings.statusline && settings.statusline.enabled === 'off') {
      process.stdout.write('\n');
      process.exit(0);
    }

    const stdinJson = readStdinJsonSync();
    const remainingPct = stdinJson && stdinJson.context_window
      ? stdinJson.context_window.remaining_percentage
      : null;

    const state = readState();
    const cache = readUpdateCache();

    const updateSeg = makeUpdateSegment(state, cache);
    const contextSeg = makeContextSegment(remainingPct, settings);
    const line = fitToBudget(updateSeg, contextSeg);
    process.stdout.write(line + '\n');
    process.exit(0);
  } catch {
    // Fail-open: never break Claude Code
    process.stdout.write('\n');
    process.exit(0);
  }
})();
