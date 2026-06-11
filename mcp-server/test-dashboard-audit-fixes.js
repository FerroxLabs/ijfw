#!/usr/bin/env node
/**
 * Regression tests for the full-audit-sweep dashboard fixes:
 *  - CSRF guard fails CLOSED for state-changing methods (Origin/Referer vs Host)
 *  - POST /api/config writes config.json mode 0o600
 *  - /api/observations serves a bounded tail and busts its cache on append
 *  - --daemon singleton: second concurrent daemon exits without clobbering
 *    pid/port files; stale pid files are reclaimed
 * Run: node mcp-server/test-dashboard-audit-fixes.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(__dirname, 'src', 'dashboard-server.js');

// Patch HOME so config/pid/port writes land in a throwaway dir.
const TEST_HOME = join(tmpdir(), 'ijfw-dash-audit-test-' + Date.now());
mkdirSync(join(TEST_HOME, '.ijfw'), { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { startServer } = await import('./src/dashboard-server.js');

const BASE_PORT = 38911; // away from the canonical 37891 range so a real dashboard never interferes
// Distinct port per test: undici keep-alive pools sockets per origin, so reusing
// a port across server restarts hands the next test a dead pooled socket (ECONNRESET).
let nextPort = BASE_PORT;
function testPort() { nextPort += 5; return nextPort; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(predicate, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

test('CSRF: cross-origin POST without Sec-Fetch-Site is rejected; same-origin and tool POSTs pass', async () => {
  const ledger = join(TEST_HOME, '.ijfw', 'observations.jsonl');
  writeFileSync(ledger, '');
  const { port, server } = await startServer({ ledgerPath: ledger, port: testPort() });
  try {
    const base = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({ version: 1 });

    // Attacker page: no Sec-Fetch-Site, mismatched Origin (text/plain simple request).
    let r = await fetch(`${base}/api/config`, {
      method: 'POST', body,
      headers: { 'Origin': 'http://evil.example', 'Content-Type': 'text/plain' },
    });
    assert.equal(r.status, 403, 'mismatched Origin must be rejected');

    // Mismatched Referer, no Origin.
    r = await fetch(`${base}/api/config`, {
      method: 'POST', body,
      headers: { 'Referer': 'http://evil.example/page' },
    });
    assert.equal(r.status, 403, 'mismatched Referer must be rejected');

    // Explicit cross-site Sec-Fetch-Site still rejected (even on GET).
    r = await fetch(`${base}/api/observations`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);

    // Same-origin browser POST passes.
    r = await fetch(`${base}/api/config`, {
      method: 'POST', body,
      headers: { 'Origin': `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(r.status, 200);

    // Tool POST (no browser markers at all) passes.
    r = await fetch(`${base}/api/config`, { method: 'POST', body });
    assert.equal(r.status, 200);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('POST /api/config writes config.json owner-only (0o600)', { skip: process.platform === 'win32' }, async () => {
  const ledger = join(TEST_HOME, '.ijfw', 'observations.jsonl');
  writeFileSync(ledger, '');
  const { port, server } = await startServer({ ledgerPath: ledger, port: testPort() });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST', body: JSON.stringify({ version: 1, accounts: ['x'] }),
    });
    assert.equal(r.status, 200);
    const mode = statSync(join(TEST_HOME, '.ijfw', 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600, `config.json mode is 0o${mode.toString(8)}, expected 0o600`);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('/api/observations serves appended lines after the mtime/size cache busts', async () => {
  const ledger = join(TEST_HOME, '.ijfw', 'obs-cache-test.jsonl');
  writeFileSync(ledger, JSON.stringify({ id: 1, platform: 'claude' }) + '\n');
  const { port, server } = await startServer({ ledgerPath: ledger, port: testPort() });
  try {
    const base = `http://127.0.0.1:${port}`;
    let obs = await (await fetch(`${base}/api/observations`)).json();
    assert.equal(obs.length, 1);
    // Cached read returns the same content.
    obs = await (await fetch(`${base}/api/observations`)).json();
    assert.equal(obs.length, 1);
    // Append: size changes, cache key changes, new line shows up.
    appendFileSync(ledger, JSON.stringify({ id: 2, platform: 'codex' }) + '\n');
    obs = await (await fetch(`${base}/api/observations`)).json();
    assert.equal(obs.length, 2);
    assert.equal(obs[1].id, 2);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('--daemon singleton: loser exits without clobbering pid/port; stale pid is reclaimed', async () => {
  const dir = join(TEST_HOME, 'daemon-race');
  mkdirSync(dir, { recursive: true });
  const pidFile = join(dir, 'dashboard.pid');
  const portFile = join(dir, 'dashboard.port');
  const env = {
    ...process.env,
    HOME: TEST_HOME,
    USERPROFILE: TEST_HOME,
    IJFW_PID_FILE: pidFile,
    IJFW_PORT_FILE: portFile,
    IJFW_DASHBOARD_PORT: String(BASE_PORT + 20),
  };
  function spawnDaemon() {
    return spawn(process.execPath, [SERVER_SRC, '--daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  // Stale pid: pre-write a pid that cannot be alive; daemon must reclaim it.
  writeFileSync(pidFile, '999999999', 'utf8');

  const first = spawnDaemon();
  let firstDone = false;
  first.on('exit', () => { firstDone = true; });
  try {
    assert.ok(await waitFor(() => existsSync(portFile)), 'first daemon should bind and write port file');
    assert.equal(readFileSync(pidFile, 'utf8').trim(), String(first.pid), 'stale pid file reclaimed by first daemon');
    const portBefore = readFileSync(portFile, 'utf8').trim();

    const second = spawnDaemon();
    let secondStderr = '';
    second.stderr.on('data', d => { secondStderr += d; });
    const secondExit = await new Promise(resolve => second.on('exit', resolve));

    assert.equal(secondExit, 0, 'losing daemon must exit 0');
    assert.match(secondStderr, /already running/, 'losing daemon reports already running');
    assert.equal(readFileSync(pidFile, 'utf8').trim(), String(first.pid), 'pid file NOT clobbered by loser');
    assert.equal(readFileSync(portFile, 'utf8').trim(), portBefore, 'port file NOT clobbered by loser');
    assert.equal(firstDone, false, 'winning daemon still running');
  } finally {
    try { first.kill('SIGTERM'); } catch {}
    await waitFor(() => firstDone, 3000);
    if (!firstDone) { try { first.kill('SIGKILL'); } catch {} }
  }
});

process.on('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});
