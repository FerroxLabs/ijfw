/**
 * test-session-start-cwd-guard.js
 *
 * P0 remediation (v1.6.0 config-write hardening).
 *
 * THE BUG (reproduced): session-start.sh authored CLAUDE.md/AGENTS.md relative
 * to the current working directory, gated only by `if true;`. When a session
 * started with cwd == $HOME, IJFW wrote a GLOBAL ~/CLAUDE.md (+ ~/AGENTS.md)
 * carrying the <ijfw-routing> block. Claude Code loads ~/CLAUDE.md for EVERY
 * project, so one stray write biased every repo the user opened -- a
 * cross-tenant config bleed (a Wayland customer hit this in the wild).
 *
 * THE FIX (P0a): a cwd guard -- `ijfw_is_project_writable` -- refuses the
 * CLAUDE.md and AGENTS.md writes when the resolved target directory is the
 * user's home root or the filesystem root. Project-scoped writes (the normal,
 * peer-standard case) are untouched, so unification is preserved.
 *
 * Strategy (mirrors test-session-start-detachment.js):
 *   - Run the REAL claude/hooks/scripts/session-start.sh under `bash`, with a
 *     throwaway $HOME and an explicit spawn cwd. stdin is /dev/null so the hook
 *     never blocks reading a payload.
 *   - NEGATIVE: cwd == $HOME  -> assert NO ~/CLAUDE.md and NO ~/AGENTS.md appear.
 *   - POSITIVE: cwd == project -> assert project/CLAUDE.md IS written
 *     (injection / unification still works).
 *   - Plus static-shape checks pinning the guard into the source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const SESSION_START_PATH = path.join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'session-start.sh');

const skipOnWin = process.platform === 'win32' ? 'bash not on Windows runner PATH' : undefined;

async function readScript() {
  return fs.readFile(SESSION_START_PATH, 'utf8');
}

function envFor(home, cwd) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: home,
    PWD: cwd,
    IJFW_SKIP_PARSE: '1',
    // Point the plugin root at a nonexistent path so the dashboard / indexer
    // shims return immediately and we stay close to a clean baseline.
    CLAUDE_PLUGIN_ROOT: '/nonexistent/ijfw-test-plugin-root',
  };
}

function runHook(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SESSION_START_PATH], {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('exit', (code) => resolve(code));
    child.once('error', reject);
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('runHook: bash exceeded 30s timeout'));
    }, 30000);
    t.unref();
  });
}

async function mkTmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Static shape -- pins the guard into the source so a future edit can't
// silently drop it back to `if true;`.
// ---------------------------------------------------------------------------

test('static: cwd guard helper exists and gates both CLAUDE.md and AGENTS.md writes', async () => {
  const src = await readScript();
  assert.match(src, /ijfw_is_project_writable\s*\(\)/, 'expected a ijfw_is_project_writable() helper definition');
  // The CLAUDE.md write must be gated by the helper, not the old `if true;`.
  assert.ok(
    !/\nif true; then\n\s*# Belt-and-suspenders/.test(src),
    'CLAUDE.md write must no longer be gated by `if true;`',
  );
  // The CLAUDE.md + AGENTS.md writes are gated by ijfw_seed_ok, which combines
  // the home/root guard (ijfw_is_project_writable) with the project-marker gate
  // (ijfw_should_seed, sourced from seed-gate.sh).
  assert.match(src, /ijfw_seed_ok\s*\(\)/, 'expected a ijfw_seed_ok() helper definition');
  assert.match(src, /if ijfw_seed_ok "\$IJFW_WRITE_ROOT"/, 'CLAUDE.md write must be gated by ijfw_seed_ok');
  assert.match(src, /ijfw_seed_ok "\$\(pwd -P 2>\/dev\/null\)"/, 'AGENTS.md merge must be gated by ijfw_seed_ok');
  // ijfw_seed_ok must still call the home/root guard internally.
  assert.match(src, /ijfw_seed_ok\(\)\s*\{[\s\S]*?ijfw_is_project_writable/, 'ijfw_seed_ok must call ijfw_is_project_writable');
  // The guard must compare against the physical $HOME so cwd==$HOME is refused.
  assert.match(src, /IJFW_HOME_PHYS/, 'expected a resolved physical-$HOME variable for the guard');
});

test('runtime SEED GATE: signal-less project dir (no marker) writes NO CLAUDE.md / AGENTS.md', { skip: skipOnWin }, async () => {
  const home = await mkTmp('ijfw-seed-home-');
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  // A bare scratch dir: .ijfw exists (the hook always makes it) but NO project
  // marker -- the throwaway "temporary space" case. The hook must NOT litter it.
  const scratch = await mkTmp('ijfw-seed-scratch-');
  await fs.mkdir(path.join(scratch, '.ijfw'), { recursive: true });

  const code = await runHook(scratch, envFor(home, scratch));
  assert.equal(code, 0, 'session-start.sh should exit 0');

  assert.ok(
    !existsSync(path.join(scratch, 'CLAUDE.md')),
    'SPAM: a CLAUDE.md was authored in a signal-less scratch dir',
  );
  assert.ok(
    !existsSync(path.join(scratch, 'AGENTS.md')),
    'SPAM: an AGENTS.md was authored in a signal-less scratch dir',
  );
});

test('runtime SEED GATE: `ijfw init` marker (.ijfw/project) re-enables the write', { skip: skipOnWin }, async () => {
  const home = await mkTmp('ijfw-seed-home3-');
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  const blessed = await mkTmp('ijfw-seed-blessed-');
  await fs.mkdir(path.join(blessed, '.ijfw'), { recursive: true });
  // No git / manifest -- only the explicit `ijfw init` bless marker.
  await fs.writeFile(path.join(blessed, '.ijfw', 'project'), '# blessed');

  const code = await runHook(blessed, envFor(home, blessed));
  assert.equal(code, 0, 'session-start.sh should exit 0');

  assert.ok(
    existsSync(path.join(blessed, 'CLAUDE.md')),
    '`ijfw init`-blessed dir must get a CLAUDE.md (override works)',
  );
});

// ---------------------------------------------------------------------------
// Runtime -- the actual bug and the preserved-unification case.
// ---------------------------------------------------------------------------

test('runtime NEGATIVE: cwd == $HOME writes NO global CLAUDE.md / AGENTS.md', { skip: skipOnWin }, async () => {
  const home = await mkTmp('ijfw-guard-home-');
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });

  // cwd IS the home dir -- the exact condition that produced the global bleed.
  const code = await runHook(home, envFor(home, home));
  assert.equal(code, 0, 'session-start.sh should exit 0');

  assert.ok(
    !existsSync(path.join(home, 'CLAUDE.md')),
    'BUG: a global ~/CLAUDE.md was authored when cwd == $HOME (cross-repo bleed)',
  );
  assert.ok(
    !existsSync(path.join(home, 'AGENTS.md')),
    'BUG: a global ~/AGENTS.md was authored when cwd == $HOME (cross-repo bleed)',
  );
});

test('runtime FAIL-CLOSED: $HOME unresolvable -> refuse the write (no CLAUDE.md in cwd)', { skip: skipOnWin }, async () => {
  // CI/containers can launch with HOME unset. Without a resolvable home we cannot
  // prove the target isn't the home root, so the guard must REFUSE, not write.
  const project = await mkTmp('ijfw-guard-nohome-');
  await fs.mkdir(path.join(project, '.ijfw'), { recursive: true });
  // env deliberately WITHOUT HOME.
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    PWD: project,
    IJFW_SKIP_PARSE: '1',
    CLAUDE_PLUGIN_ROOT: '/nonexistent/ijfw-test-plugin-root',
  };
  const code = await runHook(project, env);
  assert.equal(code, 0, 'session-start.sh should still exit 0 with HOME unset');
  assert.ok(
    !existsSync(path.join(project, 'CLAUDE.md')),
    'FAIL-OPEN: wrote CLAUDE.md with $HOME unresolvable — guard must fail closed',
  );
});

test('runtime POSITIVE: cwd == project still writes project/CLAUDE.md (unification preserved)', { skip: skipOnWin }, async () => {
  const home = await mkTmp('ijfw-guard-home2-');
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  const project = await mkTmp('ijfw-guard-proj-');
  await fs.mkdir(path.join(project, '.ijfw'), { recursive: true });
  // Make it look like a real project so the autogen scan has signal.
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'true' } }));

  const code = await runHook(project, envFor(home, project));
  assert.equal(code, 0, 'session-start.sh should exit 0');

  assert.ok(
    existsSync(path.join(project, 'CLAUDE.md')),
    'project-scoped CLAUDE.md should still be authored (injection must keep working)',
  );
  // And it must NOT have leaked into the home dir.
  assert.ok(
    !existsSync(path.join(home, 'CLAUDE.md')),
    'project session must not author a global ~/CLAUDE.md',
  );
});
