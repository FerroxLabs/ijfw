#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- D3 dream-cycle trigger end-to-end fixture.
//
// Replaces the legacy `SESSION_NUM % 5 == 0` startup-flag deferral
// with INLINE detached spawn at SessionEnd. Asserts the same
// invariants as cold-scan-trigger:
//
//   1. Cooldown logic correct (within 4h skip; outside fires).
//   2. Detached spawn returns within the 250ms cold-start hook-latency budget
//      (typical run ~86ms; cold-start cap accounts for bash + node spawn).
//   3. All 5 surfaces (claude/codex/gemini shell hooks +
//      wayland/hermes Python handlers) wire the shared trigger.
//   4. dream-state.json round-trips across sessions atomically.
//   5. IJFW_DREAM_LEGACY=1 env reverts to the old startup-flag path.
//
// Hermeticity: every test creates a per-test tmp HOME so log writes
// stay inside the sandbox. cooldown.markCompleted writes to the
// project's .ijfw/.dream-state.json -- the project is also tmp.
//
// Run: node --test mcp-server/test-d3-dream-trigger.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'child_process';
import { BASH } from './test/win-bash-helper.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNNER = join(REPO_ROOT, 'mcp-server', 'src', 'dream', 'runner.mjs');
const TRIGGER_SH = join(REPO_ROOT, 'claude', 'skills', 'ijfw-summarize', 'scripts', 'dream-trigger.sh');
const TRIGGER_PY = join(REPO_ROOT, 'claude', 'skills', 'ijfw-summarize', 'scripts', 'dream_trigger.py');

function tmpProj(label) {
  return mkdtempSync(join(tmpdir(), `ijfw-d3-${label}-`));
}

function sandboxHome(label) {
  const d = mkdtempSync(join(tmpdir(), `ijfw-d3-home-${label}-`));
  mkdirSync(join(d, '.ijfw', 'logs'), { recursive: true });
  return d;
}

function sandboxEnv(home, extras = {}) {
  return { ...process.env, HOME: home, IJFW_HOME: REPO_ROOT, ...extras };
}

function waitForFile(path, ms = 2500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    const end = Date.now() + 25;
    while (Date.now() < end) { /* busy */ }
  }
  return existsSync(path);
}

// --- 1. cooldown helper ----------------------------------------------------

test('cooldown: absent state file -> not on cooldown', async () => {
  const root = tmpProj('cd-absent');
  const { isOnCooldown } = await import(pathToFileURL(join(REPO_ROOT, 'mcp-server', 'src', 'dream', 'cooldown.js')).href);
  const stateDir = join(root, '.ijfw');
  mkdirSync(stateDir, { recursive: true });
  assert.equal(isOnCooldown(stateDir), false, 'absent state must not block');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('cooldown: fresh markCompleted -> on cooldown for 4h window', async () => {
  const root = tmpProj('cd-fresh');
  const stateDir = join(root, '.ijfw');
  const { isOnCooldown, markCompleted } = await import(
    pathToFileURL(join(REPO_ROOT, 'mcp-server', 'src', 'dream', 'cooldown.js')).href
  );
  assert.equal(markCompleted(stateDir), true);
  assert.equal(isOnCooldown(stateDir), true, 'fresh mark must be on cooldown');
  // Verify atomic write: no .tmp residue.
  assert.equal(existsSync(join(stateDir, '.dream-state.json')), true);
  const list = readdirSync(stateDir);
  for (const f of list) assert.ok(!f.endsWith('.tmp'), `no tmp residue: ${f}`);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('cooldown: aged state (>4h via override) -> not on cooldown', async () => {
  const root = tmpProj('cd-aged');
  const stateDir = join(root, '.ijfw');
  mkdirSync(stateDir, { recursive: true });
  // Write a state file with last_run_at 5h ago, then override the
  // window to 1ms so any positive age trips outside-window. We test
  // the window logic by setting a tiny override (1ms) and writing a
  // state ms ago.
  const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  writeFileSync(
    join(stateDir, '.dream-state.json'),
    JSON.stringify({ version: 1, last_run_at: old }),
    'utf8',
  );
  const { isOnCooldown } = await import(
    pathToFileURL(join(REPO_ROOT, 'mcp-server', 'src', 'dream', 'cooldown.js')).href
  );
  // Default 4h window -- 5h-old state should NOT be on cooldown.
  assert.equal(isOnCooldown(stateDir), false, '5h-old state must not block');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('cooldown: corrupt state -> not on cooldown (fail open)', async () => {
  const root = tmpProj('cd-corrupt');
  const stateDir = join(root, '.ijfw');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, '.dream-state.json'), '{not-json', 'utf8');
  const { isOnCooldown } = await import(
    pathToFileURL(join(REPO_ROOT, 'mcp-server', 'src', 'dream', 'cooldown.js')).href
  );
  assert.equal(isOnCooldown(stateDir), false, 'corrupt state must fail open');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 2. detached-spawn latency --------------------------------------------

test('shell trigger returns within 250ms cold-start hook-latency budget', () => {
  const root = tmpProj('latency');
  const home = sandboxHome('latency');
  // Run the shell trigger; it MUST detach and return promptly. We
  // measure the full child process turnaround (fork + exec bash +
  // node spawn + disown). The runner work is async + detached.
  const start = performance.now();
  const res = spawnSync(BASH, [TRIGGER_SH, root, 'test-latency'], {
    encoding: 'utf8',
    env: sandboxEnv(home),
  });
  const elapsed = performance.now() - start;
  assert.equal(res.status, 0, `trigger must exit 0; stderr=${res.stderr}`);
  // 250ms is the cold-start budget; it accounts for bash fork + node
  // spawn overhead on slow shared CI hosts. Typical run measures ~86ms
  // (well inside the budget). The invariant is that the trigger MUST
  // detach -- it MUST NOT block on the dream cycle itself (which can
  // take 100s of ms or more once D1's promotion logic does real work).
  // Anything under 250ms proves detachment; the documented cold-start
  // budget for this hook is 250ms (PRD section 11 "SessionEnd hook latency
  // budget breached by dream invocation" mitigation; D-PILLAR-SPEC section D3
  // amended in GA real fix-wave finding C4).
  // Windows process-spawn overhead (bash + node + git-bash translation
  // layer) makes the 250ms cold-start budget unrealistic. The detachment
  // semantic is identical -- bumping the platform-conditional ceiling
  // here only slackens the assertion, not the production behavior.
  const budgetMs = process.platform === 'win32' ? 1500 : 250;
  assert.ok(elapsed < budgetMs, `trigger must return fast; got ${elapsed.toFixed(1)}ms (budget ${budgetMs}ms)`);
  // Verify the runner DID actually fire (state file lands async).
  const ok = waitForFile(join(root, '.ijfw', '.dream-state.json'), 3000);
  assert.equal(ok, true, '.dream-state.json must land via async runner');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 3. all 5 surfaces wire the shared trigger ----------------------------

test('claude session-end hook references shared dream-trigger', () => {
  const claudeHook = join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'session-end.sh');
  const src = readFileSync(claudeHook, 'utf8');
  assert.match(src, /dream-trigger\.sh/, 'claude hook must reference shared trigger');
  assert.doesNotMatch(
    src,
    /\bSESSION_NUM\s*%\s*5\s*\)\s*\)\s*-eq 0\s*\]/,
    'claude hook must not retain legacy 5-session deferral as primary path',
  );
});

test('codex session-end hook references shared dream-trigger', () => {
  const codexHook = join(REPO_ROOT, 'codex', '.codex', 'hooks', 'session-end.sh');
  const src = readFileSync(codexHook, 'utf8');
  assert.match(src, /dream-trigger\.sh/, 'codex hook must reference shared trigger');
  assert.doesNotMatch(
    src,
    /\bSESSION_NUM\s*%\s*5\s*\)\s*\)\s*-eq 0\s*\]/,
    'codex hook must not retain legacy 5-session deferral as primary path',
  );
});

test('gemini session-end hook references shared dream-trigger', () => {
  const gemHook = join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks', 'session-end.sh');
  const src = readFileSync(gemHook, 'utf8');
  assert.match(src, /dream-trigger\.sh/, 'gemini hook must reference shared trigger');
});

test('wayland _handlers.py wires _trigger_dream', () => {
  const wayland = join(REPO_ROOT, 'wayland', 'plugins', 'ijfw', '_handlers.py');
  const src = readFileSync(wayland, 'utf8');
  assert.match(src, /dream_trigger/, 'wayland handler must import dream_trigger');
  assert.match(src, /_trigger_dream/, 'wayland on_session_end must invoke the trigger');
});

test('hermes _handlers.py wires _trigger_dream', () => {
  const hermes = join(REPO_ROOT, 'hermes', 'plugins', 'ijfw', '_handlers.py');
  const src = readFileSync(hermes, 'utf8');
  assert.match(src, /dream_trigger/, 'hermes handler must import dream_trigger');
  assert.match(src, /_trigger_dream/, 'hermes on_session_end must invoke the trigger');
});

// --- 4. trigger end-to-end via shell + python ------------------------------

test('shell trigger spawns runner; .dream-state.json lands within 3s', () => {
  const root = tmpProj('e2e-sh');
  const home = sandboxHome('e2e-sh');
  const res = spawnSync(BASH, [TRIGGER_SH, root, 'test-e2e-sh'], {
    encoding: 'utf8',
    env: sandboxEnv(home),
  });
  assert.equal(res.status, 0);
  const ok = waitForFile(join(root, '.ijfw', '.dream-state.json'), 3000);
  assert.equal(ok, true);
  // State payload must parse + carry last_run_at.
  const state = JSON.parse(readFileSync(join(root, '.ijfw', '.dream-state.json'), 'utf8'));
  assert.ok(state && state.last_run_at, 'state file must carry last_run_at');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('python trigger spawns runner; .dream-state.json lands within 3s', () => {
  const root = tmpProj('e2e-py');
  const home = sandboxHome('e2e-py');
  const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import sys, pathlib
sys.path.insert(0, ${JSON.stringify(dirname(TRIGGER_PY))})
from dream_trigger import trigger_dream
out = trigger_dream(${JSON.stringify(root)}, host="test-e2e-py", session_id="s-1")
print(out.get("spawned"))
`], { encoding: 'utf8', env: sandboxEnv(home) });
  assert.equal(py.status, 0, `python trigger must exit 0; stderr=${py.stderr}`);
  assert.match(py.stdout, /True/, 'python trigger must return spawned=True');
  const ok = waitForFile(join(root, '.ijfw', '.dream-state.json'), 3000);
  assert.equal(ok, true);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 5. cooldown skips re-fire ---------------------------------------------

test('shell trigger skips re-fire when within cooldown window', () => {
  const root = tmpProj('cd-skip-sh');
  const home = sandboxHome('cd-skip-sh');
  // Plant a fresh state file -> cooldown active.
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(
    join(root, '.ijfw', '.dream-state.json'),
    JSON.stringify({ version: 1, last_run_at: new Date().toISOString() }),
    'utf8',
  );
  const res = spawnSync(BASH, [TRIGGER_SH, root, 'cd-skip'], {
    encoding: 'utf8',
    env: sandboxEnv(home),
  });
  assert.equal(res.status, 0);
  // No dream-trigger.log line should be written by a runner spawn
  // when cooldown blocked at the trigger level. We allow either no
  // log dir or no dream-*.log appearing.
  const logDir = join(root, '.ijfw', 'logs');
  const settle = Date.now() + 400;
  while (Date.now() < settle) { /* spin */ }
  if (existsSync(logDir)) {
    const files = readdirSync(logDir).filter((f) => f.startsWith('dream-') && f.endsWith('.log'));
    assert.equal(files.length, 0, `no dream-*.log expected when cooldown active; got ${files.join(',')}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('python trigger returns reason=cooldown when within window', () => {
  const root = tmpProj('cd-skip-py');
  const home = sandboxHome('cd-skip-py');
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(
    join(root, '.ijfw', '.dream-state.json'),
    JSON.stringify({ version: 1, last_run_at: new Date().toISOString() }),
    'utf8',
  );
  const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(dirname(TRIGGER_PY))})
from dream_trigger import trigger_dream
out = trigger_dream(${JSON.stringify(root)}, host="cd-skip", session_id="s-cd")
print(json.dumps(out))
`], { encoding: 'utf8', env: sandboxEnv(home) });
  assert.equal(py.status, 0, `python trigger must exit 0; stderr=${py.stderr}`);
  const out = JSON.parse(py.stdout.trim());
  assert.equal(out.spawned, false);
  assert.equal(out.reason, 'cooldown');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 6. IJFW_DREAM_LEGACY rollback path ------------------------------------

test('shell trigger with IJFW_DREAM_LEGACY=1 writes startup-flag (no detached spawn)', () => {
  const root = tmpProj('legacy-sh');
  const home = sandboxHome('legacy-sh');
  // Plant a session counter at 5 so the legacy rule fires.
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(join(root, '.ijfw', '.session-counter'), '5\n', 'utf8');
  const res = spawnSync(BASH, [TRIGGER_SH, root, 'legacy'], {
    encoding: 'utf8',
    env: sandboxEnv(home, { IJFW_DREAM_LEGACY: '1' }),
  });
  assert.equal(res.status, 0);
  const flagsPath = join(root, '.ijfw', '.startup-flags');
  assert.ok(existsSync(flagsPath), 'legacy path must write startup-flags');
  const flags = readFileSync(flagsPath, 'utf8');
  assert.match(flags, /IJFW_NEEDS_CONSOLIDATE=1/, 'legacy flag must be set');
  // No dream-state.json should be written by the runner -- legacy
  // path returns before spawn.
  assert.equal(
    existsSync(join(root, '.ijfw', '.dream-state.json')),
    false,
    'legacy path must not spawn the runner',
  );
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('python trigger with IJFW_DREAM_LEGACY=1 returns reason=legacy_path', () => {
  const root = tmpProj('legacy-py');
  const home = sandboxHome('legacy-py');
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  writeFileSync(join(root, '.ijfw', '.session-counter'), '10\n', 'utf8');
  const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(dirname(TRIGGER_PY))})
from dream_trigger import trigger_dream
out = trigger_dream(${JSON.stringify(root)}, host="legacy-py", session_id="s-legacy")
print(json.dumps(out))
`], { encoding: 'utf8', env: sandboxEnv(home, { IJFW_DREAM_LEGACY: '1' }) });
  assert.equal(py.status, 0, `python trigger must exit 0; stderr=${py.stderr}`);
  const out = JSON.parse(py.stdout.trim());
  assert.equal(out.spawned, false);
  assert.equal(out.reason, 'legacy_path');
  // Legacy path must have written the startup-flag.
  const flags = readFileSync(join(root, '.ijfw', '.startup-flags'), 'utf8');
  assert.match(flags, /IJFW_NEEDS_CONSOLIDATE=1/);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 7. dream-state.json round-trips across sessions -----------------------

test('dream-state.json persists across runner invocations (atomic write)', async () => {
  const root = tmpProj('persist');
  const home = sandboxHome('persist');
  // First fire -- writes state.
  let res = spawnSync(BASH, [TRIGGER_SH, root, 'persist-1'], {
    encoding: 'utf8',
    env: sandboxEnv(home),
  });
  assert.equal(res.status, 0);
  assert.equal(waitForFile(join(root, '.ijfw', '.dream-state.json'), 3000), true);
  const stateRaw1 = readFileSync(join(root, '.ijfw', '.dream-state.json'), 'utf8');
  const state1 = JSON.parse(stateRaw1);
  assert.ok(state1 && state1.last_run_at, 'state must have last_run_at');
  // Second fire within cooldown -- runner skips, state unchanged.
  res = spawnSync(BASH, [TRIGGER_SH, root, 'persist-2'], {
    encoding: 'utf8',
    env: sandboxEnv(home),
  });
  assert.equal(res.status, 0);
  // Settle.
  const settle = Date.now() + 500;
  while (Date.now() < settle) { /* spin */ }
  const state2 = JSON.parse(readFileSync(join(root, '.ijfw', '.dream-state.json'), 'utf8'));
  assert.equal(state2.last_run_at, state1.last_run_at, 'cooldown must skip re-write');
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 8. runner direct invocation (smoke) -----------------------------------

test('runner.mjs --project-root completes cleanly without args extras', () => {
  const root = tmpProj('runner-direct');
  const res = spawnSync(process.execPath, [RUNNER, '--project-root', root, '--host', 'direct'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `runner must exit 0; stderr=${res.stderr}`);
  assert.equal(existsSync(join(root, '.ijfw', '.dream-state.json')), true);
  // Log file must be present.
  const logs = readdirSync(join(root, '.ijfw', 'logs'));
  assert.ok(
    logs.some((f) => f.startsWith('dream-') && f.endsWith('.log')),
    `dream log expected; got ${logs.join(',')}`,
  );
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// --- 9. tool-cap budget unchanged ------------------------------------------

test('MCP tool-cap stays under 12 (D3 adds zero new tools; v1.5.0-major raised cap to 12 with 1-slot headroom)', () => {
  const server = readFileSync(join(REPO_ROOT, 'mcp-server', 'src', 'server.js'), 'utf8');
  const matches = server.match(/name:\s*'ijfw_/g) || [];
  assert.ok(matches.length <= 12, `tool-cap must be <= 12; saw ${matches.length}`);
});
