import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkVerificationGate,
  isVerificationCommand,
  recordViolation,
} from './src/orchestrator/verification-gate.js';

// ---------------------------------------------------------------------------
// checkVerificationGate — core logic
// ---------------------------------------------------------------------------

test('checkVerificationGate returns ok:true for message with no completion claim', () => {
  const result = checkVerificationGate('Working on the implementation.', []);
  assert.deepEqual(result, { ok: true });
});

test('checkVerificationGate returns ok:false for "all tests pass" with no Bash tool call', () => {
  // r13-M-04: original test was "Tests pass!" but lowercase `pass(?:es)?` was
  // dropped (false positives on "pass the context"). The phrase pattern
  // "all tests pass" still catches the canonical completion claim.
  const result = checkVerificationGate('all tests pass', []);
  assert.equal(result.ok, false);
  assert.ok(typeof result.violation === 'string');
  assert.ok(result.violation.length > 0);
  assert.ok(typeof result.claim === 'string');
});

test('checkVerificationGate r13-M-04: does NOT flag neutral "pass the context"', () => {
  // Regression: pre-r13 the pattern `\bpass(?:es)?\b` fired on common neutral
  // language. Lowercase pass was dropped; uppercase PASS still fires.
  const r1 = checkVerificationGate("I'll pass the context to the next agent.", []);
  assert.equal(r1.ok, true, 'neutral "pass the context" should not fire');
  const r2 = checkVerificationGate('Please pass the variable through.', []);
  assert.equal(r2.ok, true, 'neutral "pass the variable" should not fire');
  // Uppercase PASS (verdict literal) still flags
  const r3 = checkVerificationGate('Verdict: PASS', []);
  assert.equal(r3.ok, false, 'uppercase PASS still detected');
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

test('checkVerificationGate detects DONE, completed, shipped, ✅, "all tests pass", "build succeeded"', () => {
  // r13-M-01: dropped bare `complete` / lowercase `done` — negations like
  // "not yet complete" fired falsely. Detection list is now: protocol literal
  // DONE, completed/shipped/PASS/passes/✅, plus phrase patterns.
  const claims = [
    'DONE',
    'completed',
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

test('checkVerificationGate r13-M-01: does NOT flag negations like "not yet complete"', () => {
  // Regression test: pre-r13 the pattern `\bcomplete\b` fired on "not yet complete"
  // — a NEGATION. Bare `complete` was dropped from COMPLETION_PATTERNS.
  const result1 = checkVerificationGate('The work is not yet complete.', []);
  assert.equal(result1.ok, true, 'negation "not yet complete" should not fire');
  const result2 = checkVerificationGate('Work to complete: 3 items remain.', []);
  assert.equal(result2.ok, true, 'forward-looking "to complete" should not fire');
});

test('checkVerificationGate ignores non-Bash tool calls as verification evidence', () => {
  const toolCalls = [{ tool: 'Read', input: { file_path: 'package.json' } }];
  const result = checkVerificationGate('DONE — task complete.', toolCalls);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// v1.5.1 H1 — audit finding HIGH-S2: `build` substring let
// `Bash("ls build/")` clear the Iron Law without running tests.
// Fix: require build/test verbs at command-start, not anywhere in the string.
// ---------------------------------------------------------------------------

test('v1.5.1 H1: Bash("ls build/") does NOT satisfy verification (audit HIGH-S2)', () => {
  const toolCalls = [{ tool: 'Bash', input: { command: 'ls build/' } }];
  const result = checkVerificationGate('DONE — shipping.', toolCalls);
  assert.equal(result.ok, false,
    'directory listing of a "build" folder must not clear the Iron Law');
});

test('v1.5.1 H1: Bash("echo \'build trust\'") does NOT satisfy verification', () => {
  const toolCalls = [{ tool: 'Bash', input: { command: "echo 'build trust'" } }];
  const result = checkVerificationGate('DONE — shipping.', toolCalls);
  assert.equal(result.ok, false,
    'echoing a string containing "build" must not clear the Iron Law');
});

test('v1.5.1 H1: Bash("mkdir build") does NOT satisfy verification', () => {
  const toolCalls = [{ tool: 'Bash', input: { command: 'mkdir build' } }];
  const result = checkVerificationGate('DONE — shipping.', toolCalls);
  assert.equal(result.ok, false,
    'making a directory called "build" must not clear the Iron Law');
});

test('v1.5.1 H1: real build commands still satisfy verification', () => {
  const realBuilds = [
    'npm run build',
    'yarn build',
    'pnpm build',
    'bun build',
    'cargo build',
    'cargo build --release',
    'make',
    'make build',
    'tsc --build',
    'tsc -b',
    'cd app && npm run build',
    'NODE_ENV=production npm run build',
  ];
  for (const cmd of realBuilds) {
    const toolCalls = [{ tool: 'Bash', input: { command: cmd } }];
    const result = checkVerificationGate('DONE — built clean.', toolCalls);
    assert.equal(result.ok, true,
      `legitimate build command must still satisfy gate: ${cmd}`);
  }
});

test('v1.5.1 H1: chained-after-separator verify commands still satisfy', () => {
  // Real-world: subagents often chain `cd foo && npm test`. The command-start
  // anchor must accept the verify verb after `&&`, `||`, `;`, `|`, or whitespace.
  const chained = [
    'cd mcp-server && npm test',
    'pushd app; npm run build',
    'mkdir -p logs && node --test',
    'foo || cargo test',
    'cd app | tee log && npm test',
  ];
  for (const cmd of chained) {
    const toolCalls = [{ tool: 'Bash', input: { command: cmd } }];
    const result = checkVerificationGate('DONE — verified.', toolCalls);
    assert.equal(result.ok, true,
      `chained verify command must still satisfy gate: ${cmd}`);
  }
});

// ---------------------------------------------------------------------------
// v1.5.1 H1.1-followup (Trident r18 finding): the first cut still let
// `echo npm test` and `printf 'npm run build'` satisfy the gate because plain
// whitespace inside an argument was treated as a "command boundary." Fix:
// segment-split on real shell separators and require the verb at the HEAD of
// at least one segment (after an optional env-var prefix).
// ---------------------------------------------------------------------------

test('v1.5.1 H1.1-followup: echo "npm test" does NOT satisfy verification', () => {
  // The Trident-found bug: echo's argument contained the verb. With the first
  // cut's `[\s;&|]` marker, the space after `echo` matched, so the gate cleared.
  const toolCalls = [{ tool: 'Bash', input: { command: 'echo npm test' } }];
  const result = checkVerificationGate('DONE — shipping.', toolCalls);
  assert.equal(result.ok, false,
    'echoing the verb name must not clear the Iron Law');
});

test('v1.5.1 H1.1-followup: printf "npm run build" does NOT satisfy', () => {
  const toolCalls = [{ tool: 'Bash', input: { command: "printf 'npm run build'" } }];
  const result = checkVerificationGate('DONE — shipping.', toolCalls);
  assert.equal(result.ok, false,
    'printf of a verb-shaped argument must not clear the Iron Law');
});

test('v1.5.1 H1.1-followup: real env-prefixed commands still satisfy', () => {
  // The fix must NOT regress env-prefixed real commands.
  const envs = [
    'NODE_ENV=production npm run build',
    'NODE_ENV=test CI=1 npm test',
    'DEBUG=* node --test',
  ];
  for (const cmd of envs) {
    const toolCalls = [{ tool: 'Bash', input: { command: cmd } }];
    const result = checkVerificationGate('DONE — verified.', toolCalls);
    assert.equal(result.ok, true,
      `env-prefixed verify command must satisfy gate: ${cmd}`);
  }
});

test('v1.5.1 H1.1-followup: isVerificationCommand splitter handles real chains', () => {
  // Direct test of the new function. Each example chains a non-verify command
  // with a verify command and must return true.
  for (const cmd of [
    'cd mcp-server && npm test',
    'mkdir build && cargo build --release',
    'rm -rf node_modules; npm test',
    'something || pytest',
    'echo "starting" && NODE_ENV=test node --test',
  ]) {
    assert.equal(isVerificationCommand(cmd), true, `must accept: ${cmd}`);
  }
  // These must NOT match.
  for (const cmd of [
    'echo npm test',
    "printf 'cargo build'",
    'mkdir build',
    'ls build/',
    'cat package.json | grep test',  // grep test isn't npm test
    'sleep 60',
  ]) {
    assert.equal(isVerificationCommand(cmd), false, `must reject: ${cmd}`);
  }
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
