/**
 * test-session-start-byte-skip.js
 *
 * P1 (config-write hardening): byte-identical skip.
 *
 * The CLAUDE.md managed-block rewrite ran every SessionStart even when the block
 * was unchanged, dirtying `git status` with a no-op diff every session — the #1
 * "wince" the cross-audit flagged. The marker-replace branch must now skip the
 * write entirely when the freshly-built block already matches what's on disk.
 *
 * Test: run the hook in a project (writes CLAUDE.md), pin the file's mtime to a
 * fixed point in the past, run the hook again, and assert the mtime did NOT move
 * (no rewrite) and the content is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SESSION_START_PATH = path.join(REPO_ROOT, 'claude', 'hooks', 'scripts', 'session-start.sh');
const skipOnWin = process.platform === 'win32' ? 'bash not on Windows runner PATH' : undefined;

function envFor(home, cwd) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    HOME: home,
    PWD: cwd,
    IJFW_SKIP_PARSE: '1',
    CLAUDE_PLUGIN_ROOT: '/nonexistent/ijfw-test-plugin-root',
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

test('byte-identical skip: unchanged managed block is NOT rewritten on the next session', { skip: skipOnWin }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-skip-home-'));
  await fs.mkdir(path.join(home, '.ijfw'), { recursive: true });
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ijfw-skip-proj-'));
  await fs.mkdir(path.join(project, '.ijfw'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo' }));
  const claudeMd = path.join(project, 'CLAUDE.md');
  const env = envFor(home, project);

  // Run 1: autogen writes CLAUDE.md (with the IJFW marker block).
  await runHook(project, env);
  const after1 = await fs.readFile(claudeMd, 'utf8');
  assert.ok(after1.includes('IJFW-MEMORY-START'), 'run 1 should write the managed block');

  // Pin mtime to a fixed point in the past. A rewrite would bump it to ~now.
  const PINNED = 1_000_000_000; // 2001-09-09 in epoch seconds
  utimesSync(claudeMd, PINNED, PINNED);

  // Run 2: block is unchanged -> must skip the write.
  await runHook(project, env);

  const mtimeMs = statSync(claudeMd).mtimeMs;
  assert.ok(
    mtimeMs < 1_100_000_000_000,
    `CLAUDE.md was rewritten on an unchanged second session (mtime moved to ${new Date(mtimeMs).toISOString()}). ` +
      `The byte-identical skip must avoid the no-op write.`,
  );
  const after2 = await fs.readFile(claudeMd, 'utf8');
  assert.equal(after2, after1, 'content must be unchanged across the skipped write');
});
