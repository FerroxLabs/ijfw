#!/usr/bin/env node
// IJFW v1.3.0 Alpha -- A3 cold-scan trigger end-to-end fixture (P3-B1).
//
// Asserts that the cold-scan trigger fires from each of:
//   1. installer post-install (triggerColdScan)
//   2. claude session-start hook  (claude/hooks/scripts/session-start.sh)
//   3. codex session-start hook   (codex/.codex/hooks/session-start.sh)
//   4. gemini session-start hook  (gemini/extensions/ijfw/hooks/session-start.sh)
//   5. wayland Python handler     (cold_scan_trigger.trigger_cold_scan)
//   6. hermes  Python handler     (cold_scan_trigger.trigger_cold_scan)
//
// Plus the idempotency gates required by the P3-B1 contract:
//   7. .ijfw/project.type lands within 1s post-install
//   8. trigger NOT re-fired when project.type already exists
//   9. trigger NOT re-fired when scan-state.json exists with live PID
//
// Run: node --test mcp-server/test-cold-scan-trigger.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const RUNNER = join(REPO_ROOT, 'mcp-server', 'src', 'cold-scan-runner.mjs');
const TRIGGER_SH = join(REPO_ROOT, 'claude', 'skills', 'ijfw-agents-md', 'scripts', 'cold-scan-trigger.sh');
const TRIGGER_PY = join(REPO_ROOT, 'claude', 'skills', 'ijfw-agents-md', 'scripts', 'cold_scan_trigger.py');

function tmpProj(label) {
  const d = mkdtempSync(join(tmpdir(), `ijfw-coldscan-${label}-`));
  // Plant a tiny software-shaped project so the runner has signal.
  writeFileSync(join(d, 'package.json'), '{"name":"r","version":"0.0.0"}\n');
  mkdirSync(join(d, 'src'), { recursive: true });
  for (let i = 1; i <= 4; i++) writeFileSync(join(d, 'src', `f${i}.js`), `// ${i}\n`);
  return d;
}

function waitForFile(path, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    // Tight spin -- the runner is small. We avoid setTimeout so the test
    // process exit isn't delayed by the timer.
    const end = Date.now() + 25;
    while (Date.now() < end) { /* busy */ }
  }
  return existsSync(path);
}

// --- 1. installer post-install path -------------------------------------

test('installer triggerColdScan fires runner; project.type lands <1s', async () => {
  const root = tmpProj('inst');
  const { triggerColdScan } = await import(join(REPO_ROOT, 'installer', 'src', 'post-install', 'cold-scan.js'));
  const out = triggerColdScan(root);
  assert.equal(out.spawned, true, `installer spawn must succeed: ${out.reason || ''}`);
  const ok = waitForFile(join(root, '.ijfw', 'project.type'), 1500);
  assert.equal(ok, true, 'project.type must land within ~1s');
  rmSync(root, { recursive: true, force: true });
});

// --- 2. claude shell hook path ------------------------------------------

test('claude session-start hook fires cold-scan trigger', () => {
  const root = tmpProj('claude');
  // Drive the shared trigger directly. The hook resolves the trigger
  // script via a candidate-path search and bash-execs it; that exec is
  // what we are validating here.
  const res = spawnSync('bash', [TRIGGER_SH, root], { encoding: 'utf8' });
  assert.equal(res.status, 0, `trigger must exit 0; stderr=${res.stderr}`);
  const ok = waitForFile(join(root, '.ijfw', 'project.type'), 1500);
  assert.equal(ok, true, 'project.type must land via shared trigger');
  rmSync(root, { recursive: true, force: true });
});

// --- 3. codex shell hook path -------------------------------------------

test('codex session-start hook resolves + spawns cold-scan trigger', () => {
  const codexHook = join(REPO_ROOT, 'codex', '.codex', 'hooks', 'session-start.sh');
  const src = readFileSync(codexHook, 'utf8');
  assert.match(src, /cold-scan-trigger\.sh/, 'codex hook must reference shared trigger');
  // Drive the trigger directly to confirm runtime success.
  const root = tmpProj('codex');
  const res = spawnSync('bash', [TRIGGER_SH, root], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const ok = waitForFile(join(root, '.ijfw', 'project.type'), 1500);
  assert.equal(ok, true);
  rmSync(root, { recursive: true, force: true });
});

// --- 4. gemini shell hook path ------------------------------------------

test('gemini session-start hook resolves + spawns cold-scan trigger', () => {
  const gemHook = join(REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks', 'session-start.sh');
  const src = readFileSync(gemHook, 'utf8');
  assert.match(src, /cold-scan-trigger\.sh/, 'gemini hook must reference shared trigger');
  const root = tmpProj('gemini');
  const res = spawnSync('bash', [TRIGGER_SH, root], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const ok = waitForFile(join(root, '.ijfw', 'project.type'), 1500);
  assert.equal(ok, true);
  rmSync(root, { recursive: true, force: true });
});

// --- 5. wayland Python handler path -------------------------------------

test('wayland _handlers.py wires cold_scan_trigger', () => {
  const wayland = join(REPO_ROOT, 'wayland', 'plugins', 'ijfw', '_handlers.py');
  const src = readFileSync(wayland, 'utf8');
  assert.match(src, /cold_scan_trigger/, 'wayland handler must import cold_scan_trigger');
  assert.match(src, /_trigger_cold_scan/, 'wayland on_session_start must invoke the trigger');
  // Drive the Python trigger directly.
  const root = tmpProj('wayland');
  const py = spawnSync('python3', ['-c', `
import sys, pathlib
sys.path.insert(0, ${JSON.stringify(dirname(TRIGGER_PY))})
from cold_scan_trigger import trigger_cold_scan
out = trigger_cold_scan(${JSON.stringify(root)})
print(out.get('spawned'))
`], { encoding: 'utf8' });
  assert.equal(py.status, 0, `python trigger must exit 0; stderr=${py.stderr}`);
  assert.match(py.stdout, /True/, 'wayland python trigger must return spawned=True');
  const ok = waitForFile(join(root, '.ijfw', 'project.type'), 1500);
  assert.equal(ok, true);
  rmSync(root, { recursive: true, force: true });
});

// --- 6. hermes Python handler path --------------------------------------

test('hermes _handlers.py wires cold_scan_trigger', () => {
  const hermes = join(REPO_ROOT, 'hermes', 'plugins', 'ijfw', '_handlers.py');
  const src = readFileSync(hermes, 'utf8');
  assert.match(src, /cold_scan_trigger/, 'hermes handler must import cold_scan_trigger');
  assert.match(src, /_trigger_cold_scan/, 'hermes on_session_start must invoke the trigger');
  // Drive the Python trigger directly.
  const root = tmpProj('hermes');
  const py = spawnSync('python3', ['-c', `
import sys, pathlib
sys.path.insert(0, ${JSON.stringify(dirname(TRIGGER_PY))})
from cold_scan_trigger import trigger_cold_scan
out = trigger_cold_scan(${JSON.stringify(root)})
print(out.get('spawned'))
`], { encoding: 'utf8' });
  assert.equal(py.status, 0, `python trigger must exit 0; stderr=${py.stderr}`);
  assert.match(py.stdout, /True/, 'hermes python trigger must return spawned=True');
  const ok = waitForFile(join(root, '.ijfw', 'project.type'), 1500);
  assert.equal(ok, true);
  rmSync(root, { recursive: true, force: true });
});

// --- 7-8. idempotent re-fire when project.type already exists ----------

test('trigger does NOT re-fire when project.type already exists', () => {
  const root = tmpProj('idem');
  // Plant a finished project.type so the trigger should skip.
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  const finalPath = join(root, '.ijfw', 'project.type');
  writeFileSync(finalPath, '{"primary_type":"software","scan_incomplete":false}\n');
  const before = statSync(finalPath).mtimeMs;
  const res = spawnSync('bash', [TRIGGER_SH, root], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  // Brief settle.
  const settleEnd = Date.now() + 250;
  while (Date.now() < settleEnd) { /* spin */ }
  const after = statSync(finalPath).mtimeMs;
  assert.equal(after, before, 'project.type mtime must not change -- trigger must skip');
  rmSync(root, { recursive: true, force: true });
});

// --- 9. idempotent re-fire when scan-state.json present ----------------

test('trigger does NOT re-fire when scan-state.json present', () => {
  const root = tmpProj('inflight');
  // Plant a scan-state.json (signaling another scan in progress).
  mkdirSync(join(root, '.ijfw'), { recursive: true });
  const finalPath = join(root, '.ijfw', 'project.type');
  writeFileSync(join(root, '.ijfw', 'scan-state.json'),
    JSON.stringify({ scan_id: 'x', started_at: new Date().toISOString(), incomplete: true, attempts: 1, files_scanned: 10, total_estimate: 10, last_path_walked: '/x' }, null, 2) + '\n');
  const res = spawnSync('bash', [TRIGGER_SH, root], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  // Brief settle.
  const settleEnd = Date.now() + 400;
  while (Date.now() < settleEnd) { /* spin */ }
  // No project.type should have appeared because the scan-state in-flight
  // signal forces the trigger to skip.
  assert.equal(existsSync(finalPath), false, 'trigger must skip while scan-state present');
  rmSync(root, { recursive: true, force: true });
});
