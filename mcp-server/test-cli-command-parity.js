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

function runIjfw(args, opts = {}) {
  return spawnSync(process.execPath, [IJFW, ...args], {
    cwd: opts.cwd || REPO,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
    timeout: 10_000,
  });
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
