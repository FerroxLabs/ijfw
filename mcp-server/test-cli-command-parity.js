import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const IJFW = join(REPO, 'installer', 'src', 'ijfw.js');
// v1.5.0 T12 — the `state:<verb>` CLI face routes through cli-run.js, the
// bash-callable shim for the colon-syntax dispatch surface. Subprocess
// invocation (not in-process import) is the contract: this test asserts CLI
// parity, so it must hit the exact spawn path that shell hooks + e2e-smoke use.
const CLI_RUN = join(__dirname, 'src', 'cli-run.js');

function runIjfw(args, opts = {}) {
  return spawnSync(process.execPath, [IJFW, ...args], {
    cwd: opts.cwd || REPO,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function runCliRun(args, opts = {}) {
  return spawnSync(process.execPath, [CLI_RUN, ...args], {
    cwd: opts.cwd || REPO,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function freshProjectDir() {
  return mkdtempSync(join(tmpdir(), 'ijfw-state-cli-'));
}

test('cli: ijfw cross reaches the orchestrator instead of launcher unknown-subcommand', () => {
  const result = runIjfw(['cross', 'bogus-mode']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ijfw cross requires a mode/);
  assert.doesNotMatch(result.stderr, /Unknown subcommand: cross/);
});

test('cli: ijfw cross audit <file> resolves through the terminal dispatcher', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-cli-cross-'));
  try {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'CLI dispatch smoke target\n');
    const result = runIjfw(['cross', 'audit', target], {
      cwd: dir,
      env: {
        PATH: '',
        OPENAI_API_KEY: '',
        GEMINI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GH_TOKEN: '',
      },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Trident is standing by|Fired:/);
    assert.doesNotMatch(result.stderr, /Unknown subcommand: cross/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: slash-style command aliases do not fall through to unknown command', () => {
  const aliases = [
    ['cross-audit'],
    ['workflow'],
    ['handoff'],
    ['compress'],
    ['consolidate'],
    ['ijfw-audit'],
    ['ijfw-execute'],
    ['ijfw-help'],
    ['ijfw-plan'],
    ['ijfw-ship'],
    ['ijfw-verify'],
    ['memory-audit'],
    ['memory-consent'],
    ['memory-why'],
    ['metrics'],
    ['mode'],
  ];

  for (const args of aliases) {
    const result = runIjfw(args);
    assert.notEqual(result.status, null, `${args.join(' ')} timed out`);
    assert.doesNotMatch(result.stderr, /Unknown (sub)?command/i, `${args.join(' ')} should be recognized`);
  }
});

test('cli: cross-audit alias accepts Claude-style --with before target', () => {
  const result = runIjfw(['cross-audit', '--with', 'codex', 'bogus-target.txt'], {
    env: {
      PATH: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GH_TOKEN: '',
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Trident is standing by|Fired:/);
  assert.doesNotMatch(result.stderr, /Unknown (sub)?command/i);
});

// ---------------------------------------------------------------------------
// v1.5.0 T12 — `state:<verb>` colon-namespace CLI face
// ---------------------------------------------------------------------------
//
// The state-SDK is reachable three ways (contract §0): JS module, CLI face,
// MCP tool. These tests cover the CLI face — spawned as a subprocess (not
// imported) so we measure the same path shell hooks (T11) and the e2e-smoke
// gate actually exercise. Four scenarios prove routing is generic over the
// verb registry, not hardcoded to a single verb.

test('cli: state:workflow.get returns valid JSON with ok:true on a fresh project', () => {
  const dir = freshProjectDir();
  try {
    const result = runCliRun(['state:workflow.get', '{}'], { cwd: dir });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} / stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.verbId, 'string', 'response must carry verbId per contract §7');
    // Fresh project -> workflow.json absent -> readJson returns null.
    assert.equal(parsed.workflow, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: state:state.validate (a different verb) proves routing is not hardcoded', () => {
  const dir = freshProjectDir();
  try {
    const result = runCliRun(['state:state.validate', '{}'], { cwd: dir });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} / stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.verbId, 'string');
    // state.validate returns { valid, issues } per the contract.
    assert.equal(typeof parsed.valid, 'boolean');
    assert.ok(Array.isArray(parsed.issues), 'state.validate must return issues[]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: state:workflow.set-phase with JSON payload mutates state end-to-end', () => {
  const dir = freshProjectDir();
  try {
    const writeRes = runCliRun(['state:workflow.set-phase', '{"phase":"plan"}'], { cwd: dir });
    assert.equal(writeRes.status, 0, `set-phase failed: stderr=${writeRes.stderr}`);
    const writeParsed = JSON.parse(writeRes.stdout.trim());
    assert.equal(writeParsed.ok, true);
    assert.equal(writeParsed.workflow.phase, 'plan');

    // Round-trip: a subsequent state:workflow.get must observe the write.
    const readRes = runCliRun(['state:workflow.get', '{}'], { cwd: dir });
    assert.equal(readRes.status, 0);
    const readParsed = JSON.parse(readRes.stdout.trim());
    assert.equal(readParsed.ok, true);
    assert.equal(readParsed.workflow.phase, 'plan', 'set-phase write must round-trip through get');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: state:<unknown-verb> exits non-zero with a clear stderr message', () => {
  const dir = freshProjectDir();
  try {
    const result = runCliRun(['state:foo.bar', '{}'], { cwd: dir });
    assert.notEqual(result.status, 0, 'unknown verb must exit non-zero');
    // stdout still carries the JSON result envelope so callers can JSON.parse it.
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'UNKNOWN_VERB');
    assert.match(parsed.error, /unknown verb/i);
    // stderr carries the human-readable line so shell logs are scannable.
    assert.match(result.stderr, /state:foo\.bar/);
    assert.match(result.stderr, /unknown verb/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: state:<verb> with no payload defaults to {} (read-verb convenience)', () => {
  const dir = freshProjectDir();
  try {
    // `workflow.get` ignores its payload; absent args must still reach the
    // handler so shell hooks can call `cli-run state:workflow.get` without
    // an empty-JSON dummy.
    const result = runCliRun(['state:workflow.get'], { cwd: dir });
    assert.equal(result.status, 0, `expected exit 0, got ${result.status} / stderr=${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(typeof parsed.verbId, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: state:<verb> with malformed JSON payload exits non-zero with INVALID_JSON code', () => {
  const dir = freshProjectDir();
  try {
    const result = runCliRun(['state:workflow.set-phase', 'not-json{'], { cwd: dir });
    assert.notEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'INVALID_JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: every generated Codex command alias has a terminal route', () => {
  const commandsDir = join(REPO, 'codex', 'commands');
  assert.ok(existsSync(commandsDir), 'codex command aliases missing');
  const aliases = [
    'compress',
    'consolidate',
    'cross-audit',
    'cross-critique',
    'cross-research',
    'doctor',
    'handoff',
    'ijfw-audit',
    'ijfw-execute',
    'ijfw-help',
    'ijfw-plan',
    'ijfw-ship',
    'ijfw-verify',
    'memory-audit',
    'memory-consent',
    'memory-why',
    'metrics',
    'mode',
    'status',
    'team',
    'workflow',
  ];

  for (const alias of aliases) {
    const result = runIjfw([alias]);
    assert.doesNotMatch(result.stderr, /Unknown (sub)?command/i, `${alias} should be recognized`);
  }
});
