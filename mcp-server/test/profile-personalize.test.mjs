// profile-personalize.test.mjs — v1.6.0 `ijfw personalize` + the inject GATE.
//
// Covers:
//   (1) settings `profile` block read/write/defaults (resolveProfileSettings)
//   (2) the inject-gate decision table (on / off / ask / IJFW_PROFILE_KILL)
//   (3) the `personalize` verb routing + each subcommand, against the REAL CLI
//       under a scratch HOME (no real ~/.ijfw mutation).
//
// The CLI exports resolveProfileInject for the pure-decision tests; the
// subcommand tests spawn cross-orchestrator-cli.js so routing + the parser are
// exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI = join(REPO_ROOT, 'mcp-server', 'src', 'cross-orchestrator-cli.js');

function withScratch(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ijfw-personalize-'));
  const ijfwHome = join(home, '.ijfw');
  mkdirSync(ijfwHome, { recursive: true });
  // Make the spawned CLI's own profile modules resolvable from IJFW_HOME by
  // symlinking the repo mcp-server into the scratch tree (the CLI also resolves
  // relative to its own file, so this is belt-and-braces).
  try { symlinkSync(join(REPO_ROOT, 'mcp-server'), join(ijfwHome, 'mcp-server')); } catch { /* */ }
  try { return fn({ home, ijfwHome }); } finally { rmSync(home, { recursive: true, force: true }); }
}

function runCli(args, { home, ijfwHome, env = {} } = {}) {
  // The profile store's fail-closed guard (path-policy.js) refuses the real
  // homedir default whenever NODE_TEST_CONTEXT is set — which the `node --test`
  // worker sets AND the spawned child inherits. Point IJFW_PROFILE_DIR at the
  // scratch profile dir so the store has a SAFE override (this mirrors how the
  // rest of the profile suite isolates). In production NODE_TEST_CONTEXT is
  // never set, so the CLI uses ~/.ijfw/profile normally.
  const childEnv = {
    ...process.env,
    HOME: home,
    IJFW_HOME: ijfwHome,
    IJFW_PROFILE_DIR: join(ijfwHome, 'profile'),
    IJFW_PROFILE_STATE_DIR: join(ijfwHome, 'profile-state'),
    NO_OPEN: '1',
    CI: '1',
    ...env,
  };
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input: '',
    env: childEnv,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function readSettings(ijfwHome) {
  const p = join(ijfwHome, 'settings.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

// ---------------------------------------------------------------------------
// (1) resolveProfileInject — pure decision table (imported directly).
// ---------------------------------------------------------------------------
const { resolveProfileInject } = await import('../src/cross-orchestrator-cli.js');

test('inject gate: defaults to "ask" when no profile block', () => {
  assert.equal(resolveProfileInject({ settings: {}, env: {} }), 'ask');
});

test('inject gate: honors explicit on / off', () => {
  assert.equal(resolveProfileInject({ settings: { profile: { inject: 'on' } }, env: {} }), 'on');
  assert.equal(resolveProfileInject({ settings: { profile: { inject: 'off' } }, env: {} }), 'off');
});

test('inject gate: IJFW_PROFILE_KILL forces off even when inject=on', () => {
  assert.equal(resolveProfileInject({ settings: { profile: { inject: 'on' } }, env: { IJFW_PROFILE_KILL: '1' } }), 'off');
  // Falsy kill values do NOT engage.
  assert.equal(resolveProfileInject({ settings: { profile: { inject: 'on' } }, env: { IJFW_PROFILE_KILL: '0' } }), 'on');
  assert.equal(resolveProfileInject({ settings: { profile: { inject: 'on' } }, env: { IJFW_PROFILE_KILL: 'false' } }), 'on');
});

test('inject gate: garbage inject value falls back to "ask"', () => {
  assert.equal(resolveProfileInject({ settings: { profile: { inject: 'maybe' } }, env: {} }), 'ask');
});

// ---------------------------------------------------------------------------
// (2) personalize subcommand routing + settings read/write/defaults.
// ---------------------------------------------------------------------------

test('personalize status: cold start prints flags + zero learned', () => {
  withScratch((s) => {
    const r = runCli(['personalize', 'status'], s);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /capture\s+on/);
    assert.match(r.out, /inject\s+ask/);
    assert.match(r.out, /share_sensitive\s+false/);
    assert.match(r.out, /0 inferences/);
  });
});

test('personalize on: writes inject=on + stamps consent', () => {
  withScratch((s) => {
    const r = runCli(['personalize', 'on'], s);
    assert.equal(r.code, 0, r.err);
    const set = readSettings(s.ijfwHome);
    assert.equal(set.profile.inject, 'on');
    assert.equal(set.profile.inject_consent_version, '1.6.0');
  });
});

test('personalize off: writes inject=off (capture untouched)', () => {
  withScratch((s) => {
    runCli(['personalize', 'on'], s);
    const r = runCli(['personalize', 'off'], s);
    assert.equal(r.code, 0, r.err);
    const set = readSettings(s.ijfwHome);
    assert.equal(set.profile.inject, 'off');
    assert.equal(set.profile.capture, 'on'); // capture is never gated
  });
});

test('personalize on: merges into existing settings (does not drop keys)', () => {
  withScratch((s) => {
    writeFileSync(join(s.ijfwHome, 'settings.json'), JSON.stringify({
      schema_version: 1, auto_update: 'ask', statusline: { enabled: 'auto' },
    }, null, 2));
    runCli(['personalize', 'on'], s);
    const set = readSettings(s.ijfwHome);
    assert.equal(set.auto_update, 'ask', 'unrelated key preserved');
    assert.equal(set.statusline.enabled, 'auto', 'nested unrelated key preserved');
    assert.equal(set.profile.inject, 'on');
  });
});

test('personalize share-sensitive on: writes allowlist; off removes it', () => {
  withScratch((s) => {
    const on = runCli(['personalize', 'share-sensitive', 'on'], s);
    assert.equal(on.code, 0, on.err);
    assert.equal(readSettings(s.ijfwHome).profile.share_sensitive, true);
    const allow = join(s.ijfwHome, 'profile', 'share-hosts.txt');
    assert.ok(existsSync(allow), 'allowlist written');
    assert.match(readFileSync(allow, 'utf8'), /\*/, 'wildcard line present');

    const off = runCli(['personalize', 'share-sensitive', 'off'], s);
    assert.equal(off.code, 0, off.err);
    assert.equal(readSettings(s.ijfwHome).profile.share_sensitive, false);
    assert.ok(!existsSync(allow), 'allowlist removed');
  });
});

test('personalize share-sensitive: bad arg exits non-zero with usage', () => {
  withScratch((s) => {
    const r = runCli(['personalize', 'share-sensitive', 'maybe'], s);
    assert.equal(r.code, 1);
    assert.match(r.err, /Usage: ijfw personalize share-sensitive on\|off/);
  });
});

test('personalize forget: empty profile reports zero, exit 0', () => {
  withScratch((s) => {
    const r = runCli(['personalize', 'forget'], s);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Forgot 0 inferences/);
  });
});

test('personalize status: reflects effective=off under IJFW_PROFILE_KILL', () => {
  withScratch((s) => {
    runCli(['personalize', 'on'], s);
    const r = runCli(['personalize', 'status'], { ...s, env: { IJFW_PROFILE_KILL: '1' } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /effective inject off \(forced by IJFW_PROFILE_KILL\)/);
  });
});

test('personalize: unknown subcommand exits 1 with help', () => {
  withScratch((s) => {
    const r = runCli(['personalize', 'frobnicate'], s);
    assert.equal(r.code, 1);
    assert.match(r.err, /Unknown personalize subcommand/);
  });
});

// ---------------------------------------------------------------------------
// (3) CLI-honesty — no advertised verb returns a BARE "Unknown command".
// ---------------------------------------------------------------------------

test('unknown verbs are GUIDED, never bare-unknown', () => {
  withScratch((s) => {
    for (const verb of ['marketplace', 'cluster', 'wave-status', 'on', 'worktree-drain']) {
      const r = runCli([verb], s);
      assert.equal(r.code, 1, `${verb} should exit 1`);
      // Every miss must carry a guidance line beyond the bare "Unknown command".
      assert.match(r.err, /Did you mean|Note:|not available|design milestone/i,
        `${verb} returned a BARE unknown with no guidance:\n${r.err}`);
    }
  });
});

test('typo "statuss" suggests nearest verb "status"', () => {
  withScratch((s) => {
    const r = runCli(['statuss'], s);
    assert.equal(r.code, 1);
    assert.match(r.err, /Did you mean:\s+ijfw status/);
  });
});

test('checkpoint alias routes to memory checkpoint', () => {
  withScratch((s) => {
    const r = runCli(['checkpoint', 'utest'], s);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Checkpoint created/);
  });
});

test('worktree alias routes to swarm worktree list', () => {
  withScratch((s) => {
    const r = runCli(['worktree', 'list'], s);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /No swarm worktrees recorded|task_id|\[/);
  });
});
