import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkVerificationGate,
  recordViolation,
} from './src/orchestrator/verification-gate.js';

// ---------------------------------------------------------------------------
// checkVerificationGate — core logic
// ---------------------------------------------------------------------------

test('checkVerificationGate returns ok:true for message with no completion claim', () => {
  const result = checkVerificationGate('Working on the implementation.', []);
  assert.deepEqual(result, { ok: true });
});

test('checkVerificationGate returns ok:false for "Tests pass!" with no Bash tool call', () => {
  const result = checkVerificationGate('Tests pass!', []);
  assert.equal(result.ok, false);
  assert.ok(typeof result.violation === 'string');
  assert.ok(result.violation.length > 0);
  assert.ok(typeof result.claim === 'string');
});

test('checkVerificationGate returns ok:true for "All tests pass" WITH npm test Bash call', () => {
  const toolCalls = [{ tool: 'Bash', input: { command: 'cd mcp-server && npm test' } }];
  const result = checkVerificationGate('All tests pass — ready to ship.', toolCalls);
  assert.deepEqual(result, { ok: true });
});

test('checkVerificationGate returns ok:true for "completed" + node --test Bash call', () => {
  const toolCalls = [{ tool: 'Bash', input: { command: 'node --test --test-force-exit' } }];
  const result = checkVerificationGate('Task completed successfully.', toolCalls);
  assert.deepEqual(result, { ok: true });
});

test('checkVerificationGate detects DONE, complete, shipped, ✅, "all tests pass", "build succeeded"', () => {
  const claims = [
    'DONE',
    'complete',
    'shipped',
    '✅',
    'all tests pass',
    'build succeeded',
  ];
  for (const claim of claims) {
    const result = checkVerificationGate(`The work is ${claim}.`, []);
    assert.equal(result.ok, false, `Expected ok:false for claim: "${claim}"`);
  }
});

test('checkVerificationGate ignores non-Bash tool calls as verification evidence', () => {
  const toolCalls = [{ tool: 'Read', input: { file_path: 'package.json' } }];
  const result = checkVerificationGate('DONE — task complete.', toolCalls);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// recordViolation
// ---------------------------------------------------------------------------

test('recordViolation creates verification-violations.jsonl with correct JSON line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vgate-'));
  const violation = {
    violation: 'Completion claim "DONE" without fresh verification in same message',
    claim: 'DONE',
    taskId: 't42',
  };
  await recordViolation(violation, root);

  const file = join(root, '.ijfw', 'memory', 'verification-violations.jsonl');
  const content = await readFile(file, 'utf8');
  const parsed = JSON.parse(content.trim());

  assert.equal(parsed.violation, violation.violation);
  assert.equal(parsed.claim, violation.claim);
  assert.equal(parsed.taskId, violation.taskId);
  assert.ok(typeof parsed.recorded_at === 'string');
  assert.ok(parsed.recorded_at.includes('T')); // ISO format
});

test('recordViolation appends multiple lines without corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vgate-multi-'));
  await recordViolation({ violation: 'first', claim: 'DONE' }, root);
  await recordViolation({ violation: 'second', claim: 'complete' }, root);

  const file = join(root, '.ijfw', 'memory', 'verification-violations.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).violation, 'first');
  assert.equal(JSON.parse(lines[1]).violation, 'second');
});
