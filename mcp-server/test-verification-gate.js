import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkVerificationGate,
  isVerificationCommand,
  recordViolation,
  _resetRecordViolationDedup,
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

// ---------------------------------------------------------------------------
// v1.5.0 audit-H4.3 (HIGH-Rel1): recordViolation no longer silently swallows
// write failures. Failures emit one stderr line per target-path (dedup'd) and
// are observable in the return shape. Posture stays advisory — no throw.
// ---------------------------------------------------------------------------

/**
 * Capture stderr.write calls inside the supplied async fn. Returns the array
 * of captured strings. Restores the original after fn resolves/rejects.
 */
async function captureStderr(fn) {
  const captured = [];
  const original = process.stderr.write.bind(process.stderr);
  // @ts-ignore — patching for test isolation
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    // @ts-ignore — restore
    process.stderr.write = original;
  }
  return captured;
}

test('v1.5.0 H4.3: recordViolation success returns { ok: true, path }', async () => {
  _resetRecordViolationDedup();
  const root = await mkdtemp(join(tmpdir(), 'vgate-ok-'));
  const result = await recordViolation(
    { violation: 'Completion claim "DONE" without verification', claim: 'DONE' },
    root,
  );
  assert.equal(result.ok, true, 'success path must return ok:true');
  assert.equal(
    result.path,
    join(root, '.ijfw', 'memory', 'verification-violations.jsonl'),
    'success path must include resolved file path',
  );
});

test('v1.5.0 H4.3: recordViolation on unwritable dir returns { ok:false, error } + stderr line', async () => {
  _resetRecordViolationDedup();
  // A path that is guaranteed-unwritable: nest under /dev/null (a non-directory
  // on POSIX), which makes mkdir's recursive walk fail with ENOTDIR/EACCES.
  const root = '/dev/null/ijfw-vgate-unwritable-' + Math.random();
  let result;
  const stderr = await captureStderr(async () => {
    result = await recordViolation(
      { violation: 'Completion claim "shipped" without verification', claim: 'shipped' },
      root,
    );
  });
  assert.equal(result.ok, false, 'failure path must return ok:false');
  assert.ok(typeof result.error === 'string' && result.error.length > 0,
    'failure path must include error message');
  assert.ok(typeof result.path === 'string' && result.path.length > 0,
    'failure path must still include target path for diagnostics');
  // Exactly one stderr line for this failure
  const matchingLines = stderr.filter((s) => s.includes('[verification-gate]'));
  assert.equal(matchingLines.length, 1,
    'failure must emit exactly one stderr line');
  // Stderr line must carry the claim so the violation isn't fully lost
  assert.ok(matchingLines[0].includes('shipped'),
    'stderr line must include the claim string');
});

test('v1.5.0 H4.3: recordViolation dedup — same unwritable path twice emits ONE stderr line', async () => {
  _resetRecordViolationDedup();
  const root = '/dev/null/ijfw-vgate-dedup-' + Math.random();
  let r1, r2;
  const stderr = await captureStderr(async () => {
    r1 = await recordViolation({ violation: 'first', claim: 'DONE' }, root);
    r2 = await recordViolation({ violation: 'second', claim: 'completed' }, root);
  });
  assert.equal(r1.ok, false, 'first call must fail');
  assert.equal(r2.ok, false, 'second call must also fail (still unwritable)');
  const matchingLines = stderr.filter((s) => s.includes('[verification-gate]'));
  assert.equal(matchingLines.length, 1,
    'same target-path failure must only log to stderr once per process');
});

test('v1.5.0 H4.3: recordViolation failure does NOT throw (posture stays advisory)', async () => {
  _resetRecordViolationDedup();
  const root = '/dev/null/ijfw-vgate-noth-' + Math.random();
  // Wrap the call in captureStderr so the failure log is absorbed; the
  // contract under test is "no rejection", not the stderr line itself.
  let threw = false;
  await captureStderr(async () => {
    try {
      await recordViolation({ violation: 'x', claim: 'DONE' }, root);
    } catch {
      threw = true;
    }
  });
  assert.equal(threw, false,
    'recordViolation must NEVER throw — it remains advisory in posture');
});

// ---------------------------------------------------------------------------
// v1.5.0 audit-MED-work-M8 — low-confidence advisory tier
// ---------------------------------------------------------------------------
import {
  checkVerificationGateLowConfidence,
  LOW_CONFIDENCE_PATTERNS,
} from './src/orchestrator/verification-gate.js';

test('M8: LOW_CONFIDENCE_PATTERNS exported', () => {
  assert.ok(Array.isArray(LOW_CONFIDENCE_PATTERNS));
  assert.ok(LOW_CONFIDENCE_PATTERNS.length >= 1);
});

test('M8: strict gate does NOT fire on lowercase "done" (preserves r13-M-01 fix)', () => {
  const result = checkVerificationGate('not yet done with this work', []);
  assert.equal(result.ok, true);
});

test('M8: low-confidence variant DOES fire on lowercase "done"', () => {
  const result = checkVerificationGateLowConfidence(
    'I am done with the patch',
    [],
  );
  assert.equal(result.ok, false);
  assert.equal(result.lowConfidence, true);
  assert.match(result.violation, /advisory/i);
});

test('M8: low-confidence variant passes when verification command present', () => {
  const result = checkVerificationGateLowConfidence(
    'I am done with the patch',
    [{ tool: 'Bash', input: { command: 'npm test' } }],
  );
  assert.equal(result.ok, true);
});

test('M8: low-confidence variant returns ok when no low-confidence signal', () => {
  const result = checkVerificationGateLowConfidence(
    'just thinking out loud here',
    [],
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// v1.5.0 T18 — W3: verification at every enumerated boundary.
//
// docs/ENFORCEMENT-MATRIX.md §3 fixes the W3 boundary set at exactly four
// state-advancing verbs:
//
//   1. phase.complete       — verdict-fail → REFUSE (enforceVerificationGate)
//   2. phase.plan-check     — HIGH finding  → REFUSE (validatePlan)
//   3. subagent.post-done   — failed self-check → REFUSE (runSelfCheck)
//   4. wave.advance (hard)  — missing checkpoint → REFUSE (inline gate)
//
// Coverage philosophy: T15 / T17 prove the first three boundaries via
// `test-verification-gate-strict.js` against real `query()` calls. This
// block proves each boundary is structurally reachable from the public
// state-SDK surface — one falsifiable refusal per boundary. The first three
// tests are intentionally minimal (the strict-mode test file owns the deep
// coverage) and the wave.advance test is fuller because that path is new
// in T18 and the audit explicitly demands a falsifiable hard-gate test.
//
// Every test uses real `query()` against a real temp dir — no mocks beyond
// the documented `_setGateFnsForTest` seam.
// ---------------------------------------------------------------------------

import { test as t18Test } from 'node:test';
import { mkdtempSync, rmSync, existsSync as existsSyncT18, writeFileSync, readFileSync as readFileSyncT18 } from 'node:fs';
import { join as joinT18 } from 'node:path';
import { tmpdir as tmpdirT18 } from 'node:os';

let t18SdkCounter = 0;
async function loadFreshStateSdkT18() {
  t18SdkCounter += 1;
  return import(`./src/orchestrator/state-sdk.js?t18=${Date.now()}-${t18SdkCounter}`);
}

function mkT18Project(label) {
  const root = mkdtempSync(joinT18(tmpdirT18(), `t18-${label}-`));
  const home = mkdtempSync(joinT18(tmpdirT18(), `t18-${label}-home-`));
  return {
    root,
    ctx: { projectRoot: root, homeDir: home },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

t18Test('T18 boundary 1/4: phase.complete fires the verification gate (REFUSE on red)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdkT18();
  const { root, ctx, cleanup } = mkT18Project('boundary-complete');
  try {
    const r = await query('phase.complete', {
      phase: 'build',
      evidence: { reportText: 'all tests pass ✅', toolCalls: [] },
    }, ctx);
    // Falsifiable: a verdict-fail at this boundary MUST refuse and MUST NOT
    // write workflow.json. Flip either invariant → test fails.
    assert.equal(r.ok, false, 'phase.complete must refuse on red gate');
    assert.equal(r.refused, true);
    assert.equal(r.gate, 'verification');
    assert.equal(
      existsSyncT18(joinT18(root, '.ijfw', 'state', 'workflow.json')),
      false,
      'refused phase.complete must not mutate workflow.json',
    );
  } finally { cleanup(); }
});

t18Test('T18 boundary 2/4: phase.plan-check fires the plan-check gate (REFUSE on HIGH finding)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdkT18();
  const { root, ctx, cleanup } = mkT18Project('boundary-plancheck');
  try {
    // Empty plan body raises BLOCK-severity findings in validatePlan.
    const r = await query('phase.plan-check', { planText: '' }, ctx);
    // Falsifiable: HIGH-tier finding MUST refuse pre-lock and MUST NOT write
    // the workflow.json plan_check verdict. Flip either invariant → fail.
    assert.equal(r.ok, false, 'phase.plan-check must refuse on HIGH finding');
    assert.equal(r.refused, true);
    assert.equal(r.gate, 'plan-check');
    assert.ok(Array.isArray(r.findings) && r.findings.length > 0,
      'refused plan-check must surface its findings');
    assert.equal(
      existsSyncT18(joinT18(root, '.ijfw', 'state', 'workflow.json')),
      false,
      'refused phase.plan-check must not mutate workflow.json',
    );
  } finally { cleanup(); }
});

t18Test('T18 boundary 3/4: subagent.post-done fires the self-check gate (REFUSE on missing file claim)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdkT18();
  const { root, ctx, cleanup } = mkT18Project('boundary-postdone');
  try {
    const report = [
      'Done. Created the following file:',
      '- src/file-that-does-not-exist-t18.js',
      '',
      'Verified with `npm test`.',
    ].join('\n');
    const r = await query('subagent.post-done', {
      subagentId: 'sa-t18',
      reportText: report,
      projectRoot: root,
    }, ctx);
    // Falsifiable: a claimed file that isn't on disk MUST refuse.
    assert.equal(r.ok, false, 'subagent.post-done must refuse on missing file claim');
    assert.equal(r.refused, true);
    assert.equal(r.gate, 'post-done-self-check');
    assert.match(r.reason, /self-check FAILED/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Boundary 4/4 — wave.advance hard gate.
//
// Per the T16 matrix, `wave.advance` is "advisory by default; verdict-fail
// only when wave declares a hard gate." T16's review concern requires
// PROVING that the verdict-fail path is reachable, not just the advisory
// path. The three tests below cover:
//
//   (a) hard gate + missing checkpoint        → REFUSE (verdict-fail path)
//   (b) hard gate + all checkpoints present   → ADVANCE (gate satisfied)
//   (c) no hard gate declared                 → ADVANCE (advisory-by-default)
//
// (a) is the falsifiable proof T16 demands; (b)+(c) prevent over-triggering.
// ---------------------------------------------------------------------------

t18Test('T18 boundary 4/4: wave.advance hard gate REFUSES on missing checkpoint (verdict-fail)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdkT18();
  const { root, ctx, cleanup } = mkT18Project('boundary-wave-refuse');
  try {
    // Register two subagents on the wave roster via subagent.dispatch.
    await query('subagent.dispatch', {
      waveId: 'W18A', subagentId: 'sa-alpha', brief: 'work alpha',
    }, ctx);
    await query('subagent.dispatch', {
      waveId: 'W18A', subagentId: 'sa-beta', brief: 'work beta',
    }, ctx);

    // Only sa-alpha writes its checkpoint; sa-beta is missing.
    await query('subagent.checkpoint', {
      waveId: 'W18A', subagentId: 'sa-alpha',
      dedupKey: 'cp-alpha-1',
      checkpoint: { status: 'DONE', note: 'alpha complete' },
    }, ctx);

    // Advance the wave with hardGate:true. The pre-lock check sees sa-beta
    // has no checkpoint file → verdict-fail → REFUSE.
    const r = await query('wave.advance', {
      waveId: 'W18A', status: 'in_progress', hardGate: true,
    }, ctx);

    // Falsifiable: the hard-gate refusal MUST carry refused:true + ok:false
    // AND name the missing subagent. Mutate any of:
    //   - drop the `hardGate` precondition → test fails (advisory path)
    //   - write the missing checkpoint → test fails (gate satisfied)
    //   - mask the missing[] array → test fails (no observable proof)
    assert.equal(r.ok, false, 'hard-gate wave.advance must refuse on missing checkpoint');
    assert.equal(r.refused, true);
    assert.equal(r.gate, 'wave-advance-hard');
    assert.ok(Array.isArray(r.missing), 'refusal must list missing subagents');
    assert.ok(r.missing.includes('sa-beta'),
      'refusal must name the subagent with no checkpoint');
    assert.ok(!r.missing.includes('sa-alpha'),
      'present checkpoints must not be reported missing');
    assert.match(r.reason, /hard-gate/);

    // State invariant: the wave STATE.md status was NOT changed by the
    // refused advance. Read it back and confirm it is still in_progress
    // from the subagent.dispatch (not the refused advance's status).
    // The frontmatter must still carry its original status; even when the
    // attempted status string equals the dispatch-time one, the pre-lock
    // refusal guarantees writeWaveStateFile was never called.
    const wave = await query('wave.get', { waveId: 'W18A' }, ctx);
    assert.ok(wave.wave, 'wave should still exist from dispatch');
    // Frontmatter must NOT carry hard_gate=true since the advance was
    // refused before persisting it. This is the clean-mutation proof.
    assert.notEqual(wave.wave.frontmatter?.hard_gate, true,
      'refused advance must not persist hard_gate flag');
  } finally { cleanup(); }
});

t18Test('T18 wave.advance hard gate ADVANCES when every checkpoint is present (gate-satisfied)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdkT18();
  const { ctx, cleanup } = mkT18Project('boundary-wave-pass');
  try {
    await query('subagent.dispatch', {
      waveId: 'W18B', subagentId: 'sa-one', brief: 'b1',
    }, ctx);
    await query('subagent.checkpoint', {
      waveId: 'W18B', subagentId: 'sa-one', dedupKey: 'cp-one',
      checkpoint: { status: 'DONE' },
    }, ctx);

    const r = await query('wave.advance', {
      waveId: 'W18B', status: 'complete', hardGate: true,
    }, ctx);
    // Falsifiable: a fully-checkpointed wave MUST advance. If the gate over-
    // triggers and refuses, this test catches it.
    assert.equal(r.ok, true, 'satisfied hard gate must advance');
    assert.notEqual(r.refused, true);
    assert.equal(r.wave.frontmatter.status, 'complete');
    assert.equal(r.wave.frontmatter.hard_gate, true,
      'satisfied advance must persist hard_gate flag for downstream calls');
  } finally { cleanup(); }
});

t18Test('T18 wave.advance is advisory-by-default when no hard gate declared (matrix §3)', async () => {
  delete process.env.IJFW_STATE_GATE_BYPASS;
  const { query } = await loadFreshStateSdkT18();
  const { ctx, cleanup } = mkT18Project('boundary-wave-advisory');
  try {
    // Register a subagent but never write its checkpoint.
    await query('subagent.dispatch', {
      waveId: 'W18C', subagentId: 'sa-x', brief: 'bx',
    }, ctx);

    // No hardGate → advance must succeed (advisory-by-default per matrix).
    const r = await query('wave.advance', {
      waveId: 'W18C', status: 'in_progress',
    }, ctx);
    // Falsifiable: advisory-by-default must NOT refuse. If we accidentally
    // tightened the gate to always-on, this test catches it.
    assert.equal(r.ok, true, 'no hardGate → advance must succeed');
    assert.notEqual(r.refused, true);
    assert.notEqual(r.wave.frontmatter.hard_gate, true);
  } finally { cleanup(); }
});

t18Test('T18 wave.advance hard gate honors IJFW_STATE_GATE_BYPASS=1 (loud advisory + advance)', async () => {
  process.env.IJFW_STATE_GATE_BYPASS = '1';
  try {
    const { query } = await loadFreshStateSdkT18();
    const { ctx, cleanup } = mkT18Project('boundary-wave-bypass');
    try {
      await query('subagent.dispatch', {
        waveId: 'W18D', subagentId: 'sa-missing', brief: 'b',
      }, ctx);

      const captured = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk) => {
        captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      };
      let r;
      try {
        r = await query('wave.advance', {
          waveId: 'W18D', status: 'in_progress', hardGate: true,
        }, ctx);
      } finally {
        process.stderr.write = original;
      }
      // Falsifiable: bypass must downgrade refusal to a loud advisory.
      assert.equal(r.ok, true, 'bypass must NOT refuse');
      assert.equal(r.advisory, true);
      assert.equal(r.gate, 'wave-advance-hard');
      assert.match(r.reason, /IJFW_STATE_GATE_BYPASS/);
      const warns = captured.filter((s) => s.includes('[state-sdk]')
        && s.includes('wave.advance')
        && s.includes('IJFW_STATE_GATE_BYPASS'));
      assert.ok(warns.length >= 1, 'bypass must emit a loud stderr WARN line');
      assert.ok(warns[0].includes('would-refuse'),
        'WARN must surface what enforcement was skipped');
    } finally { cleanup(); }
  } finally {
    delete process.env.IJFW_STATE_GATE_BYPASS;
  }
});
