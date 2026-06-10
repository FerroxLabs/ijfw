/**
 * test-session-start-no-inject.js
 *
 * P2 (config-write hardening): consent opt-out + first-run notice.
 *
 * Injection is ON by default (unification), but a project can opt OUT of the
 * CLAUDE.md/AGENTS.md managed-block writes via `.ijfw/no-inject` or the
 * IJFW_NO_INJECT=1 env. On the first session that injects into a project, IJFW
 * drops a one-time sentinel (`.ijfw/.inject-noticed`) so the heads-up fires once.
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

function envFor(home, cwd, extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: home,
    PWD: cwd,
    IJFW_SKIP_PARSE: '1',
    CLAUDE_PLUGIN_ROOT: '/nonexistent/ijfw-test-plugin-root',
    ...extra,
  };
}

function runHook(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SESSION_START_PATH], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('exit', () => resolve());
    child.once('error', reject);
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, 30000);
    t.unref();
  });
}

async function mkProject() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-noinj-home-'));
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-noinj-proj-'));
  await fs.mkdir(path.join(project, '.ijfw'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }));
  return { home, project };
}

test('opt-out via .ijfw/no-inject: CLAUDE.md is NOT written', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await fs.writeFile(path.join(project, '.ijfw', 'no-inject'), '');
  await runHook(project, envFor(home, project));
  assert.ok(!existsSync(path.join(project, 'CLAUDE.md')), 'no-inject project must not get a CLAUDE.md');
});

test('opt-out via IJFW_NO_INJECT=1 env: CLAUDE.md is NOT written', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await runHook(project, envFor(home, project, { IJFW_NO_INJECT: '1' }));
  assert.ok(!existsSync(path.join(project, 'CLAUDE.md')), 'IJFW_NO_INJECT=1 must suppress the write');
});

test('opt-out leaves an existing managed block untouched', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  const claudeMd = path.join(project, 'CLAUDE.md');
  // Pre-existing CLAUDE.md WITH a managed block + user content.
  const original = `# My Project\n\nKEEP-ME line.\n\n<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->\nstale block\n<!-- IJFW-MEMORY-END -->\n`;
  await fs.writeFile(claudeMd, original);
  await fs.writeFile(path.join(project, '.ijfw', 'no-inject'), '');
  await runHook(project, envFor(home, project));
  const after = await fs.readFile(claudeMd, 'utf8');
  assert.equal(after, original, 'no-inject must not rewrite an existing managed block');
});

test('first-run notice: a one-time sentinel is dropped on first injection', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  const sentinel = path.join(project, '.ijfw', '.inject-noticed');
  assert.ok(!existsSync(sentinel), 'sentinel should not exist before the first run');
  await runHook(project, envFor(home, project));
  assert.ok(existsSync(path.join(project, 'CLAUDE.md')), 'default project should still inject');
  assert.ok(existsSync(sentinel), 'first injection must drop the .inject-noticed sentinel');
});

async function registryContains(home, projectPath) {
  const reg = path.join(home, '.ijfw', 'registry.md');
  if (!existsSync(reg)) return false;
  const content = await fs.readFile(reg, 'utf8');
  return content.includes(projectPath);
}

test('registry: a project is enumerated by default', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await runHook(project, envFor(home, project));
  // pwd -P may canonicalize (/var -> /private/var on macOS); match on basename.
  assert.ok(await registryContains(home, path.basename(project)), 'default project should be added to the registry');
});

test('registry opt-out via .ijfw/no-registry: project is NOT enumerated', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await fs.writeFile(path.join(project, '.ijfw', 'no-registry'), '');
  await runHook(project, envFor(home, project));
  assert.ok(!(await registryContains(home, path.basename(project))), 'no-registry project must stay out of the registry');
});

test('registry opt-out via IJFW_NO_REGISTRY=1: project is NOT enumerated', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await runHook(project, envFor(home, project, { IJFW_NO_REGISTRY: '1' }));
  assert.ok(!(await registryContains(home, path.basename(project))), 'IJFW_NO_REGISTRY=1 must keep the project out of the registry');
});

// --- migration (first-run memory auto-import) opt-out -----------------------
// The migration block writes `.ijfw/.migrated` first thing when it runs, so the
// flag's presence is a clean proxy for "the auto-import block executed".
test('migration runs by default (.migrated flag written)', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await runHook(project, envFor(home, project));
  assert.ok(existsSync(path.join(project, '.ijfw', '.migrated')), 'default first run should execute the migration block');
});

test('migration opt-out via .ijfw/no-import: auto-import skipped', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await fs.writeFile(path.join(project, '.ijfw', 'no-import'), '');
  await runHook(project, envFor(home, project));
  assert.ok(!existsSync(path.join(project, '.ijfw', '.migrated')), '.ijfw/no-import must skip the auto-import migration');
});

test('migration opt-out via IJFW_NO_IMPORT=1: auto-import skipped', { skip: skipOnWin }, async () => {
  const { home, project } = await mkProject();
  await runHook(project, envFor(home, project, { IJFW_NO_IMPORT: '1' }));
  assert.ok(!existsSync(path.join(project, '.ijfw', '.migrated')), 'IJFW_NO_IMPORT=1 must skip the auto-import migration');
});
