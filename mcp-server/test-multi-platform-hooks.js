/**
 * test-multi-platform-hooks.js
 *
 * IJFW v1.4.1 B7 -- parametric tests for multi-platform tier-2 hooks.
 *
 * One block per platform. Each block:
 *   1. Synthesises a tmp HOME with ~/.ijfw/state/active-extension.json
 *      containing { name, permissions: { writes: ['tool:edit'], reads: ['tool:read'] } }
 *   2. Feeds a synthetic platform-shape payload to the hook script via stdin.
 *   3. Asserts exit 0 for an allowed tool (Edit) and exit non-zero for a
 *      denied tool (Bash -- not in permissions.writes).
 *
 * Python hooks: spawned with python3 directly. Skipped on Windows if python3
 * is not installed (same pattern as test-session-start-detachment.js).
 * Shell hooks: skipped on Windows (no bash).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-hook-test-'));
  const stateDir = path.join(home, '.ijfw', 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const activeExt = {
    name: 'test-ext',
    permissions: {
      writes: ['tool:edit'],
      reads: ['tool:read'],
    },
  };
  await fs.writeFile(
    path.join(stateDir, 'active-extension.json'),
    JSON.stringify(activeExt),
  );
  return home;
}

async function cleanup(home) {
  await fs.rm(home, { recursive: true, force: true });
}

// Run a shell hook script, feeding payload as stdin. Returns { status, stderr }.
function runShellHook(scriptPath, payload, home) {
  const result = spawnSync('bash', [scriptPath], {
    input: JSON.stringify(payload),
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
      HOME: home,
      USERPROFILE: home,
      IJFW_DISABLE: '',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { status: result.status, stderr: result.stderr || '' };
}

// Run a Python hook, feeding payload as stdin. Returns { status, stderr }.
function runPythonHook(scriptPath, payload, home) {
  const result = spawnSync('python3', [scriptPath], {
    input: JSON.stringify(payload),
    env: {
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
      HOME: home,
      USERPROFILE: home,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { status: result.status, stderr: result.stderr || '' };
}

function hasBash() {
  return spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
}

function hasPython3() {
  return spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
}

const onWindows = process.platform === 'win32';
const skipBash = onWindows || !hasBash() ? 'bash not available on this platform' : undefined;
const skipPython = !hasPython3() ? 'python3 not installed' : undefined;

// ---------------------------------------------------------------------------
// Shared module: extension-permission-check.mjs (drives shell hooks)
// ---------------------------------------------------------------------------

test('shared module: no active-extension.json → exit 0', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-hook-empty-'));
  try {
    const checkerPath = path.join(REPO_ROOT, 'mcp-server', 'src', 'extension-permission-check.mjs');
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
    const result = spawnSync('node', [checkerPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'should exit 0 when no active-extension.json');
  } finally {
    await cleanup(home);
  }
});

test('shared module: allowed tool → exit 0', async () => {
  const home = await makeTmpHome();
  try {
    const checkerPath = path.join(REPO_ROOT, 'mcp-server', 'src', 'extension-permission-check.mjs');
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} };
    const result = spawnSync('node', [checkerPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'Edit is in permissions.writes → allow');
  } finally {
    await cleanup(home);
  }
});

test('shared module: denied tool → exit 1', async () => {
  const home = await makeTmpHome();
  try {
    const checkerPath = path.join(REPO_ROOT, 'mcp-server', 'src', 'extension-permission-check.mjs');
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
    const result = spawnSync('node', [checkerPath], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, 'Bash not in permissions.writes → deny');
    assert.ok(result.stderr.includes('test-ext'), 'stderr should name the extension');
  } finally {
    await cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Codex platform hook
// ---------------------------------------------------------------------------

const codexScript = path.join(REPO_ROOT, 'codex', '.codex', 'hooks', 'scripts', 'pre-tool-use-extension-check.sh');

test('Codex hook: allowed tool (Edit) → exit 0', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} };
    const { status } = runShellHook(codexScript, payload, home);
    assert.equal(status, 0, 'Edit allowed → exit 0');
  } finally {
    await cleanup(home);
  }
});

test('Codex hook: denied tool (Bash) → exit non-zero', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
    const { status } = runShellHook(codexScript, payload, home);
    assert.notEqual(status, 0, 'Bash denied → exit non-zero');
  } finally {
    await cleanup(home);
  }
});

test('Codex hook: no active-extension.json → exit 0', { skip: skipBash }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-codex-empty-'));
  try {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} };
    const { status } = runShellHook(codexScript, payload, home);
    assert.equal(status, 0, 'no active ext → always allow');
  } finally {
    await cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Gemini platform hook
// ---------------------------------------------------------------------------

const geminiScript = path.join(
  REPO_ROOT, 'gemini', 'extensions', 'ijfw', 'hooks', 'scripts',
  'pre-tool-use-extension-check.sh',
);

// Gemini payload shape: { event, tool: { name, input } }
test('Gemini hook: allowed tool (Edit) → exit 0', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { event: 'pre_tool_use', tool: { name: 'Edit', input: {} } };
    const { status } = runShellHook(geminiScript, payload, home);
    assert.equal(status, 0, 'Edit allowed → exit 0');
  } finally {
    await cleanup(home);
  }
});

test('Gemini hook: denied tool (Bash) → exit non-zero', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { event: 'pre_tool_use', tool: { name: 'Bash', input: {} } };
    const { status } = runShellHook(geminiScript, payload, home);
    assert.notEqual(status, 0, 'Bash denied → exit non-zero');
  } finally {
    await cleanup(home);
  }
});

test('Gemini hook: no active-extension.json → exit 0', { skip: skipBash }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-gemini-empty-'));
  try {
    const payload = { event: 'pre_tool_use', tool: { name: 'Bash', input: {} } };
    const { status } = runShellHook(geminiScript, payload, home);
    assert.equal(status, 0, 'no active ext → always allow');
  } finally {
    await cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Hermes platform hook (Python)
// ---------------------------------------------------------------------------

const hermesScript = path.join(
  REPO_ROOT, 'hermes', 'plugins', 'ijfw', 'hooks',
  'pre_tool_use_extension_check.py',
);

// Hermes payload shape: { tool: { name } }
test('Hermes hook: allowed tool (edit) → exit 0', { skip: skipPython }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { tool: { name: 'edit', input: {} } };
    const { status } = runPythonHook(hermesScript, payload, home);
    assert.equal(status, 0, 'edit allowed → exit 0');
  } finally {
    await cleanup(home);
  }
});

test('Hermes hook: denied tool (bash) → exit non-zero', { skip: skipPython }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { tool: { name: 'bash', input: {} } };
    const { status, stderr } = runPythonHook(hermesScript, payload, home);
    assert.notEqual(status, 0, 'bash denied → exit non-zero');
    assert.ok(stderr.includes('test-ext'), 'stderr should name the extension');
  } finally {
    await cleanup(home);
  }
});

test('Hermes hook: no active-extension.json → exit 0', { skip: skipPython }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-hermes-empty-'));
  try {
    const payload = { tool: { name: 'bash', input: {} } };
    const { status } = runPythonHook(hermesScript, payload, home);
    assert.equal(status, 0, 'no active ext → always allow');
  } finally {
    await cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// Wayland platform hook (Python)
// ---------------------------------------------------------------------------

const waylandScript = path.join(
  REPO_ROOT, 'wayland', 'plugins', 'ijfw', 'hooks',
  'pre_tool_use_extension_check.py',
);

test('Wayland hook: allowed tool (edit) → exit 0', { skip: skipPython }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { tool: { name: 'edit', input: {} } };
    const { status } = runPythonHook(waylandScript, payload, home);
    assert.equal(status, 0, 'edit allowed → exit 0');
  } finally {
    await cleanup(home);
  }
});

test('Wayland hook: denied tool (bash) → exit non-zero', { skip: skipPython }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { tool: { name: 'bash', input: {} } };
    const { status, stderr } = runPythonHook(waylandScript, payload, home);
    assert.notEqual(status, 0, 'bash denied → exit non-zero');
    assert.ok(stderr.includes('test-ext'), 'stderr should name the extension');
  } finally {
    await cleanup(home);
  }
});

test('Wayland hook: no active-extension.json → exit 0', { skip: skipPython }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-wayland-empty-'));
  try {
    const payload = { tool: { name: 'bash', input: {} } };
    const { status } = runPythonHook(waylandScript, payload, home);
    assert.equal(status, 0, 'no active ext → always allow');
  } finally {
    await cleanup(home);
  }
});

// ---------------------------------------------------------------------------
// W8.1 -- Gemini reshape fail-closed + permission-events.jsonl emission
// ---------------------------------------------------------------------------

test('Gemini hook: corrupt payload (raw string) → exit non-zero (deny)', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const result = spawnSync('bash', [geminiScript], {
      input: 'not-json',
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
        HOME: home,
        USERPROFILE: home,
        IJFW_DISABLE: '',
      },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, 'corrupt payload must be denied (exit non-zero)');
    assert.ok(result.stderr.includes('malformed payload'), 'stderr should mention malformed payload');
  } finally {
    await cleanup(home);
  }
});

test('Codex hook: allow emits event to permission-events.jsonl', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} };
    const { status } = runShellHook(codexScript, payload, home);
    assert.equal(status, 0, 'Edit allowed → exit 0');
    const logPath = path.join(home, '.ijfw', 'state', 'permission-events.jsonl');
    const raw = await fs.readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'at least one event line emitted');
    const evt = JSON.parse(lines[lines.length - 1]);
    assert.equal(evt.extension, 'test-ext', 'event names the extension');
    assert.equal(evt.tool, 'Edit', 'event names the tool');
    assert.equal(evt.allowed, true, 'event marks allowed=true');
    assert.ok(evt.ts, 'event has a timestamp');
  } finally {
    await cleanup(home);
  }
});

test('Gemini hook: deny emits event to permission-events.jsonl', { skip: skipBash }, async () => {
  const home = await makeTmpHome();
  try {
    const payload = { event: 'pre_tool_use', tool: { name: 'Bash', input: {} } };
    const { status } = runShellHook(geminiScript, payload, home);
    assert.notEqual(status, 0, 'Bash denied → exit non-zero');
    const logPath = path.join(home, '.ijfw', 'state', 'permission-events.jsonl');
    const raw = await fs.readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'at least one event line emitted');
    const evt = JSON.parse(lines[lines.length - 1]);
    assert.equal(evt.extension, 'test-ext', 'event names the extension');
    assert.equal(evt.tool, 'Bash', 'event names the tool');
    assert.equal(evt.allowed, false, 'event marks allowed=false');
    assert.ok(evt.ts, 'event has a timestamp');
  } finally {
    await cleanup(home);
  }
});
