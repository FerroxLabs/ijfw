#!/usr/bin/env node
/**
 * Tests: claude/hooks/scripts/post-tool-use.js -- W5.1 (v1.6.0).
 * Run: node --test test-post-tool-use-hook.js
 *
 * The PostToolUse hook used to re-emit the (cleaned) tool output as
 * hookSpecificOutput.additionalContext. additionalContext is ADDITIVE in
 * Claude Code -- it cannot replace the tool result the model already received,
 * so the output was injected twice, every tool call. W5.1 makes the hook emit
 * NOTHING on success and a single-line breadcrumb on failure, while keeping
 * exit 0 (hooks must never block) and the disk-side signal capture intact.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'post-tool-use.js');

// Run the hook with a payload on stdin, in an isolated cwd + HOME. No argv[2]
// so the detached obs-capture child is never dispatched. Returns the parsed
// run result.
function runHook(payload) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ijfw-pth-'));
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 10000,
  });
  const signalsPath = path.join(home, '.ijfw', '.session-signals.jsonl');
  const signals = fs.existsSync(signalsPath) ? fs.readFileSync(signalsPath, 'utf8') : '';
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  return { status: r.status, stdout: (r.stdout || '').trim(), signals };
}

const BULK = Array.from({ length: 40 }, (_, i) => `output line ${i} alpha bravo charlie`).join('\n');

test('exit 0 on success (hooks must never block)', () => {
  const { status } = runHook({ tool_response: { stdout: BULK } });
  assert.equal(status, 0);
});

test('success emits no additionalContext (no tool-output duplication)', () => {
  const { stdout } = runHook({ tool_response: { stdout: BULK } });
  // Either no stdout at all, or an envelope with empty additionalContext.
  if (stdout === '') return;
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext ?? '';
  assert.equal(ctx, '', 'success must not re-inject the tool output');
});

test('large success output is NOT echoed back into context', () => {
  const huge = Array.from({ length: 1200 }, (_, i) => `line ${i} payload token`).join('\n');
  const { stdout } = runHook({ tool_response: { stdout: huge } });
  assert.ok(!stdout.includes('payload token'),
    'must not duplicate (even condensed) bulk output into additionalContext');
});

test('failure emits a single-line breadcrumb, not the full output', () => {
  const failOut = `${BULK}\nERROR: the build exploded at step 7\n${BULK}`;
  const { stdout, status } = runHook({ tool_response: { stdout: failOut } });
  assert.equal(status, 0, 'still non-blocking on failure');
  assert.notEqual(stdout, '', 'failure should surface a breadcrumb');
  const parsed = JSON.parse(stdout);
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.startsWith('[ijfw]'), 'breadcrumb is ijfw-tagged');
  assert.ok(!ctx.includes('\n'), 'breadcrumb is a single line');
  assert.ok(ctx.length < 256, 'breadcrumb is short, not the whole output');
  assert.ok(!ctx.includes('output line 39'), 'breadcrumb must not contain the bulk output');
});

test('signal capture to disk still works (kept intact)', () => {
  const { signals } = runHook({ tool_response: { stdout: 'ERROR: boom happened\n' } });
  assert.ok(signals.includes('boom'), 'error signal still written to .session-signals.jsonl');
});

test('no tool_response is a clean no-op', () => {
  const { status, stdout } = runHook({ some_other_field: 1 });
  assert.equal(status, 0);
  assert.equal(stdout, '');
});
