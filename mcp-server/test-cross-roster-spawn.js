// test-cross-roster-spawn.js
// -----------------------------------------------------------------------------
// Regression coverage for the cross-audit SPAWN path — the flagship feature.
//
// WHY THIS EXISTS (v1.6.0 xaudit-fix):
// The external auditor CLIs (gemini, opencode, codex, ...) change their
// invocation contract between versions. Twice this silently rotted the roster's
// hardcoded `invoke` strings while a surface `--help` smoke still passed:
//   * gemini >=0.43 added a trusted-directory gate -> bare `gemini` exits with
//     zero output; the CLI path NEVER succeeded (every receipt showed
//     source='api', only rescued when GEMINI_API_KEY happened to be set).
//   * opencode's bare `opencode` launches the interactive TUI -> the piped
//     prompt is never consumed and the process hangs until SIGKILL. opencode
//     has no API fallback, so it was 100% broken for everyone.
//
// The pre-existing orchestrator tests only exercised FAILURE paths and even
// noted "we can't override picks — it's a const ROSTER entry", so a stale argv
// that produced NO findings was invisible. This file closes that gap with:
//   1. ROSTER-invariant guards (cheap, durable) that pin the exact argv tokens
//      whose absence caused the breakage.
//   2. A real spawn end-to-end through runCrossOp against a FAKE auditor CLI on
//      disk (no network/model) that records its argv+stdin and emits a
//      prose-wrapped JSON fence — asserting detection, spawn-argv correctness,
//      stdin prompt delivery, robust fence parsing, and `--with` selection.
//   3. Error-mapping unit checks (ENOENT / timeout / auth).
//
// Optional live leg: set IJFW_XAUDIT_LIVE=1 to additionally hit a real auditor.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROSTER, _installedCache } from './src/audit-roster.js';
import { runCrossOp } from './src/cross-orchestrator.js';
import { parseResponse } from './src/cross-dispatcher.js';
import { translateAuditorError } from './src/cross-orchestrator-cli.js';

// ---------------------------------------------------------------------------
// 1. ROSTER invariants — pin the argv tokens whose absence broke the feature.
//    These are the cheapest, most durable guard against silent argv rot.
// ---------------------------------------------------------------------------

test('roster invariant: gemini invoke bypasses the trusted-directory gate', () => {
  const gemini = ROSTER.find(e => e.id === 'gemini');
  assert.ok(gemini, 'gemini must be in the roster');
  // Bare `gemini` hits the >=0.43 trust gate and emits zero output. The invoke
  // MUST carry --skip-trust (or set GEMINI_CLI_TRUST_WORKSPACE) or the CLI path
  // can never succeed.
  assert.match(gemini.invoke, /--skip-trust\b/, 'gemini invoke must include --skip-trust');
  // Must NOT use a bare `-p` with no value (yargs error under whitespace-split
  // argv); the prompt is delivered on stdin instead.
  assert.doesNotMatch(gemini.invoke, /-p\s*$/, 'gemini invoke must not end with a valueless -p');
});

test('roster invariant: opencode invoke uses the headless `run` subcommand', () => {
  const opencode = ROSTER.find(e => e.id === 'opencode');
  assert.ok(opencode, 'opencode must be in the roster');
  // Bare `opencode` opens the TUI and hangs. `opencode run` is headless.
  assert.match(opencode.invoke, /^opencode\s+run\b/, 'opencode invoke must be `opencode run ...`');
});

test('roster invariant: codex invoke is non-interactive + reads stdin', () => {
  const codex = ROSTER.find(e => e.id === 'codex');
  assert.ok(codex, 'codex must be in the roster');
  assert.match(codex.invoke, /\bexec\b/, 'codex must use `exec` (non-interactive)');
  assert.match(codex.invoke, /--skip-git-repo-check\b/, 'codex must bypass the trusted-dir gate');
  assert.match(codex.invoke, /(^|\s)-(\s|$)/, 'codex must end with `-` to read the prompt from stdin');
});

// --- v1.6.0 roster sweep: pin the corrected argv for the REMAINING auditors ---
// These rotted the same way (external CLIs changed their non-interactive
// contract). The orchestrator delivers the prompt on STDIN and whitespace-splits
// `invoke` into bin+args, so each invoke MUST be a stdin-reading, non-TUI,
// gate-bypassing form. The `--help` surface smoke never spawns, so only these
// argv pins catch the drift before a release.

test('roster invariant: qwen invoke is headless + does not hang on startup auto-discovery', () => {
  const qwen = ROSTER.find(e => e.id === 'qwen');
  assert.ok(qwen, 'qwen must be in the roster');
  // `qwen -p` (no value) is a yargs error and the bare positional path silently
  // auto-cancels under piped stdin. `--bare` skips the startup auto-discovery
  // that cancels, `--yolo` auto-approves so it reaches the model / a clean auth
  // error. Prompt comes from stdin, so the invoke must NOT end with a valueless
  // -p and must NOT be a bare `qwen`.
  assert.match(qwen.invoke, /^qwen\b/, 'qwen invoke must invoke the qwen binary');
  assert.match(qwen.invoke, /--bare\b/, 'qwen invoke must include --bare (skip auto-discovery that auto-cancels under piped stdin)');
  assert.match(qwen.invoke, /--yolo\b/, 'qwen invoke must include --yolo (auto-approve in non-interactive mode)');
  assert.doesNotMatch(qwen.invoke, /-p\s*$/, 'qwen invoke must not end with a valueless -p');
});

test('roster invariant: kimi invoke uses headless --print (not the interactive default)', () => {
  const kimi = ROSTER.find(e => e.id === 'kimi');
  assert.ok(kimi, 'kimi must be in the roster');
  // Bare `kimi` prompts interactively and stalls on a piped prompt. `--print`
  // is the non-interactive print mode (implies --yolo) and reads stdin.
  assert.match(kimi.invoke, /^kimi\b/, 'kimi invoke must invoke the kimi binary');
  assert.match(kimi.invoke, /--print\b/, 'kimi invoke must include --print (headless mode; bare kimi prompts interactively)');
});

test('roster invariant: copilot invoke is the standalone CLI headless form (not the gh extension)', () => {
  const copilot = ROSTER.find(e => e.id === 'copilot');
  assert.ok(copilot, 'copilot must be in the roster');
  // `gh copilot suggest` is the OLD gh extension (echoes a shell command, not an
  // audit). The standalone `copilot` CLI uses `-p` (stdin prompt) and REQUIRES
  // --allow-all-tools for non-interactive mode.
  assert.match(copilot.invoke, /^copilot\b/, 'copilot invoke must be the standalone `copilot` binary, not `gh copilot`');
  assert.doesNotMatch(copilot.invoke, /^gh\b/, 'copilot invoke must NOT shell out to the stale `gh copilot` extension');
  assert.match(copilot.invoke, /(^|\s)-p\b/, 'copilot invoke must use -p (non-interactive prompt)');
  assert.match(copilot.invoke, /--allow-all-tools\b/, 'copilot invoke must include --allow-all-tools (required for non-interactive mode)');
});

test('roster invariant: claude invoke uses headless -p/--print', () => {
  const claude = ROSTER.find(e => e.id === 'claude');
  assert.ok(claude, 'claude must be in the roster');
  // `claude -p` (== --print) reads the prompt from stdin and prints the reply.
  assert.match(claude.invoke, /^claude\b/, 'claude invoke must invoke the claude binary');
  assert.match(claude.invoke, /(^|\s)(-p\b|--print\b)/, 'claude invoke must use -p/--print (headless mode)');
});

test('roster invariant: no installed auditor invoke is a bare interactive binary', () => {
  // The shared failure mode across the whole sweep: a single-token `invoke` (just
  // the binary name) almost always launches an interactive TUI/REPL that ignores
  // the piped prompt and hangs until SIGKILL. Every spawn-path auditor that runs
  // a local CLI must carry at least one headless flag/subcommand. deepseek is the
  // sole exception: it ships no canonical CLI and is API-only, so a single-token
  // placeholder is acceptable (it is never actually spawned — no binary on PATH).
  const API_ONLY = new Set(['deepseek']);
  for (const e of ROSTER) {
    if (API_ONLY.has(e.id)) continue;
    const tokens = e.invoke.trim().split(/\s+/);
    assert.ok(
      tokens.length >= 2,
      `${e.id} invoke "${e.invoke}" is a bare binary — would launch an interactive TUI and hang on the piped prompt; add a headless subcommand/flag`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fake-auditor harness: a real executable on disk that records argv + stdin
// and emits a prose-wrapped JSON fence. Lets us drive the genuine spawn path
// in runCrossOp without any network or model call.
// ---------------------------------------------------------------------------

function makeFakeAuditor(dir, { name, argvFile, stdinFile, items }) {
  const scriptPath = join(dir, name);
  const json = JSON.stringify(items);
  // Prose intentionally wraps the fence on BOTH sides to prove the parser
  // tolerates leading/trailing commentary (the real-world failure mode where a
  // model "emits prose without the JSON fence" — here the fence IS present but
  // buried).
  const body = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > "${argvFile}"`,
    `cat > "${stdinFile}"`,
    `cat <<'XAEOF'`,
    'Thanks for the target. Here is my adversarial review below.',
    '',
    '```json',
    json,
    '```',
    '',
    'That concludes the audit. Some closing prose after the fence.',
    'XAEOF',
    '',
  ].join('\n');
  writeFileSync(scriptPath, body, 'utf8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function withFakeRoster(entries, fn) {
  for (const e of entries) {
    ROSTER.push(e);
    _installedCache.set(e.id, true);
  }
  try {
    return fn();
  } finally {
    for (const e of entries) {
      const i = ROSTER.findIndex(r => r.id === e.id);
      if (i >= 0) ROSTER.splice(i, 1);
      _installedCache.delete(e.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. End-to-end spawn through runCrossOp against the fake auditor.
// ---------------------------------------------------------------------------

test('spawn E2E: detection -> exact argv -> stdin prompt -> prose-wrapped fence -> merged findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xa-spawn-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'xa-proj-'));
  const argvFile = join(dir, 'argv.txt');
  const stdinFile = join(dir, 'stdin.txt');

  const items = [
    { severity: 'high', dimension: 'correctness', location: 'x.js:3', issue: 'XAFAKE_ONE subtraction instead of addition', whyItMatters: 'wrong results', fix: 'use +' },
    { severity: 'medium', dimension: 'robustness', location: 'x.js:8', issue: 'XAFAKE_TWO missing zero guard', whyItMatters: 'div by zero', fix: 'guard b===0' },
  ];
  const scriptPath = makeFakeAuditor(dir, { name: 'xa-fake', argvFile, stdinFile, items });

  const fake = {
    id: 'xafake', family: 'oss', model: '', name: 'XA Fake Auditor',
    // Whitespace-split argv: bin=<scriptPath>, args=['--xa-mode','audit'].
    invoke: `${scriptPath} --xa-mode audit`,
    note: '', detect: () => false, apiFallback: null,
  };

  const TARGET = 'function add(a,b){ return a - b; } // XA_TARGET_SENTINEL';
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDECODE: '1',            // caller=claude(self) so the fake stays non-self
    IJFW_AUDIT_TIMEOUT_SEC: '15',
  };

  const result = await withFakeRoster([fake], () =>
    runCrossOp({ mode: 'audit', target: TARGET, projectDir, only: 'xafake', env, quiet: true })
  );

  // --- detection + selection ---
  assert.ok(result && Array.isArray(result.picks), 'runCrossOp returned a result');
  assert.equal(result.picks.length, 1, 'exactly the fake auditor was picked');
  assert.equal(result.picks[0].id, 'xafake');

  // --- spawn argv correctness (the heart of the rot) ---
  assert.ok(existsSync(argvFile), 'fake auditor was actually spawned (argv recorded)');
  const recordedArgv = readFileSync(argvFile, 'utf8').trim().split('\n');
  assert.deepEqual(recordedArgv, ['--xa-mode', 'audit'], 'args after the binary match the invoke string exactly');

  // --- stdin prompt delivery ---
  const recordedStdin = readFileSync(stdinFile, 'utf8');
  assert.match(recordedStdin, /## Target/, 'buildRequest prompt was piped to the auditor on stdin');
  assert.match(recordedStdin, /XA_TARGET_SENTINEL/, 'the actual target content reached the auditor');

  // --- robust (prose-wrapped) fence parsing + merge ---
  const merged = Array.isArray(result.merged) ? result.merged : [];
  assert.equal(merged.length, 2, 'both findings parsed out of the prose-wrapped fence');
  const issues = merged.map(m => m.issue).join(' | ');
  assert.match(issues, /XAFAKE_ONE/);
  assert.match(issues, /XAFAKE_TWO/);

  // --- receipt provenance: CLI path, status ok ---
  assert.ok(result.auditorResults && result.auditorResults[0]);
  assert.equal(result.auditorResults[0].status, 'ok');
  assert.equal(result.auditorResults[0].source, 'cli');

  rmSync(dir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. `--with` swapping: `only` selects the requested auditor, not a sibling.
// ---------------------------------------------------------------------------

test('`--with` (only) fires exactly the requested auditor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xa-with-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'xa-proj2-'));

  const mkEntry = (id, sentinel) => {
    const argvFile = join(dir, `${id}.argv`);
    const stdinFile = join(dir, `${id}.stdin`);
    const sp = makeFakeAuditor(dir, {
      name: id, argvFile, stdinFile,
      items: [{ severity: 'low', dimension: 'x', location: 'a:1', issue: sentinel, whyItMatters: '', fix: '' }],
    });
    return { entry: { id, family: 'oss', model: '', name: id, invoke: sp, note: '', detect: () => false, apiFallback: null }, argvFile };
  };

  const a = mkEntry('xafakea', 'SENTINEL_A');
  const b = mkEntry('xafakeb', 'SENTINEL_B');

  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDECODE: '1', IJFW_AUDIT_TIMEOUT_SEC: '15' };

  const result = await withFakeRoster([a.entry, b.entry], () =>
    runCrossOp({ mode: 'audit', target: 'x', projectDir, only: 'xafakeb', env, quiet: true })
  );

  assert.equal(result.picks.length, 1);
  assert.equal(result.picks[0].id, 'xafakeb', 'only xafakeb was selected');
  assert.ok(existsSync(b.argvFile), 'xafakeb was spawned');
  assert.ok(!existsSync(a.argvFile), 'xafakea was NOT spawned');
  const merged = Array.isArray(result.merged) ? result.merged : [];
  assert.match(merged.map(m => m.issue).join(' '), /SENTINEL_B/);

  rmSync(dir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. Prose-wrapped fence parsing (direct unit on the parser).
// ---------------------------------------------------------------------------

test('parseResponse extracts a JSON fence buried in leading + trailing prose', () => {
  const raw = [
    'Sure — here are my findings after reviewing the file carefully.',
    '',
    '```json',
    '[{"severity":"high","issue":"BURIED_FINDING","location":"f.js:1"}]',
    '```',
    '',
    'Let me know if you want more detail. (trailing prose)',
  ].join('\n');
  const { items, prose } = parseResponse('audit', raw);
  assert.equal(items.length, 1);
  assert.equal(items[0].issue, 'BURIED_FINDING');
  assert.match(prose, /reviewing the file/, 'prose is preserved (sans fence)');
  assert.doesNotMatch(prose, /BURIED_FINDING/, 'fence body is stripped from prose');
});

test('parseResponse returns no items when the model emits prose with no fence', () => {
  const { items } = parseResponse('audit', 'I looked at it and it seems fine, no JSON here.');
  assert.equal(items.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Error mapping — ENOENT / timeout / auth produce actionable guidance.
// ---------------------------------------------------------------------------

test('translateAuditorError maps the common spawn/auth/timeout signatures', () => {
  const enoent = translateAuditorError('opencode', 'failed', 'spawn opencode ENOENT', null);
  assert.match(enoent, /not found on PATH|Install/i);

  const timeout = translateAuditorError('gemini', 'timeout', '', null);
  assert.match(timeout, /timed out/i);

  const auth401 = translateAuditorError('opencode', 'failed', 'Error: 401 Unauthorized', 1);
  assert.match(auth401, /401|403|Authentication/i);

  const codexAuth = translateAuditorError('codex', 'failed', 'failed to refresh token', 1);
  assert.match(codexAuth, /codex login/i);

  const emptyProse = translateAuditorError('gemini', 'empty', '', null);
  assert.match(emptyProse, /no parseable findings|prose/i);
});

// ---------------------------------------------------------------------------
// Optional LIVE leg — opt-in, hits a real auditor. Skipped by default so CI
// stays hermetic. Run with: IJFW_XAUDIT_LIVE=1 node --test test-cross-roster-spawn.js
// ---------------------------------------------------------------------------

test('LIVE: a real installed auditor returns findings on a buggy target', { skip: process.env.IJFW_XAUDIT_LIVE !== '1' }, async () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'xa-live-'));
  const TARGET = 'function add(a,b){ return a - b; }\nfunction div(a,b){ return a / b; }';
  // codex is the reference reliable auditor; override via IJFW_XAUDIT_LIVE_WITH.
  const only = process.env.IJFW_XAUDIT_LIVE_WITH || 'codex';
  const result = await runCrossOp({
    mode: 'audit', target: TARGET, projectDir, only,
    env: { ...process.env, IJFW_AUDIT_TIMEOUT_SEC: process.env.IJFW_AUDIT_TIMEOUT_SEC || '120' },
    quiet: true,
  });
  assert.ok(result.picks.length >= 1, `auditor ${only} was reachable`);
  const merged = Array.isArray(result.merged) ? result.merged : [];
  assert.ok(merged.length >= 1, `auditor ${only} returned at least one finding`);
  rmSync(projectDir, { recursive: true, force: true });
});
