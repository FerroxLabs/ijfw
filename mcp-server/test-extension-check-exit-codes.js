/**
 * test-extension-check-exit-codes.js
 *
 * Regression test for the PreToolUse blocking contract of
 * claude/hooks/scripts/pre-tool-use-extension-check.sh.
 *
 * Claude Code only BLOCKS a tool call when a PreToolUse hook exits 2
 * or emits hookSpecificOutput.permissionDecision:"deny" JSON on stdout.
 * Exit 1 is a NON-blocking error (stderr shown, tool runs anyway), which
 * is exactly the bug this guards against: every deny path used to exit 1,
 * making the advertised extension permission boundary a no-op.
 *
 * Asserts, for all four deny paths:
 *   - exit code is exactly 2 (not just non-zero)
 *   - stdout carries the structured permissionDecision:"deny" envelope
 * And for allow paths:
 *   - exit 0, no deny envelope on stdout
 *
 * Skipped on Windows (no bash), same pattern as test-multi-platform-hooks.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(
  __dirname, '..', 'claude', 'hooks', 'scripts', 'pre-tool-use-extension-check.sh'
);
const isWindows = process.platform === 'win32';

async function makeTmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-ext-check-'));
}

async function writeState(home, content) {
  const dir = path.join(home, '.ijfw', 'state');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'active-extension.json'), content);
}

function runHook(payload, home) {
  return spawnSync('bash', [HOOK], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, IJFW_DISABLE: '' },
  });
}

function parseDenyEnvelope(stdout) {
  // The envelope is one JSON line on stdout.
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj && obj.hookSpecificOutput) return obj.hookSpecificOutput;
  }
  return null;
}

function assertBlocking(res, reasonFragment) {
  assert.equal(res.status, 2,
    `deny must exit 2 (blocking), got ${res.status}; stderr: ${res.stderr}`);
  const hso = parseDenyEnvelope(res.stdout);
  assert.ok(hso, `deny must emit hookSpecificOutput JSON on stdout, got: ${res.stdout}`);
  assert.equal(hso.hookEventName, 'PreToolUse');
  assert.equal(hso.permissionDecision, 'deny');
  assert.ok(hso.permissionDecisionReason.includes(reasonFragment),
    `reason should mention "${reasonFragment}": ${hso.permissionDecisionReason}`);
}

const payloadFor = (tool) => JSON.stringify({ tool_name: tool, tool_input: {} });

test('extension-check PreToolUse exit-code contract', { skip: isWindows }, async (t) => {
  const STATE = JSON.stringify({
    name: 'demo-ext',
    permissions: { writes: ['tool:edit'], reads: ['tool:read'] },
  });

  await t.test('no active extension state -> allow (exit 0)', async () => {
    const home = await makeTmpHome();
    try {
      const res = runHook(payloadFor('Bash'), home);
      assert.equal(res.status, 0);
      assert.equal(parseDenyEnvelope(res.stdout), null);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test('declared write tool -> allow (exit 0)', async () => {
    const home = await makeTmpHome();
    try {
      await writeState(home, STATE);
      const res = runHook(payloadFor('Edit'), home);
      assert.equal(res.status, 0);
      assert.equal(parseDenyEnvelope(res.stdout), null);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test('undeclared write tool (Bash) -> blocking deny', async () => {
    const home = await makeTmpHome();
    try {
      await writeState(home, STATE);
      assertBlocking(runHook(payloadFor('Bash'), home), 'not permitted to use Bash');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test('undeclared read tool (Grep) -> blocking deny', async () => {
    const home = await makeTmpHome();
    try {
      await writeState(home, STATE);
      assertBlocking(runHook(payloadFor('Grep'), home), 'not permitted to use Grep');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test('malformed state (missing permissions) -> blocking deny (fail-closed)', async () => {
    const home = await makeTmpHome();
    try {
      await writeState(home, JSON.stringify({ name: 'demo-ext' }));
      assertBlocking(runHook(payloadFor('Edit'), home), 'malformed active-extension state');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  await t.test('unparseable state JSON -> blocking deny (fail-closed)', async () => {
    const home = await makeTmpHome();
    try {
      await writeState(home, '{not json');
      assertBlocking(runHook(payloadFor('Edit'), home), 'ijfw extension permission check');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
