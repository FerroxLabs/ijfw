/**
 * test-project-root-contract.js -- deterministic MCP project-root contract.
 *
 * Contract (lib/project-root-guard.js describeProjectRoot / safeProjectDir):
 *   1. IJFW_PROJECT_DIR, then CLAUDE_PROJECT_DIR: explicit signals. Used when
 *      absolute after resolution, not an unexpanded host template ("${PWD}",
 *      "$HOME", "{{x}}", "%VAR%"), not bundle-internal, writable. An explicit
 *      temp dir IS honoured (the caller chose it).
 *   2. process.cwd(): used when it is a real directory that is not a bundle
 *      interior, not the filesystem root, not inside an OS temp root
 *      (os.tmpdir(), /tmp, /var/tmp, macOS /var/folders and their /private
 *      twins), and writable.
 *   3. Otherwise HOME: user-global memory (~/.ijfw), never a temp dir or '/'.
 *
 * Paths are simulated macOS shapes ("Users/test user/...") built under a
 * NON-temp scratch dir inside this package, because a project under /tmp
 * is exactly what the contract rejects for cwd.
 */

import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  describeProjectRoot, safeProjectDir, isTempPath, isUnexpandedTemplate,
} from './src/lib/project-root-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ORIG_CWD = process.cwd();
const KEYS = ['IJFW_PROJECT_DIR', 'CLAUDE_PROJECT_DIR', 'HOME'];
const SAVED = {};
let BASE, HOME_DIR, PROJECT;

before(() => {
  BASE = realpathSync(mkdtempSync(join(HERE, '.ijfw-root-contract-')));
  HOME_DIR = join(BASE, 'Users', 'test user');
  PROJECT = join(HOME_DIR, 'dev', 'my project');
  mkdirSync(join(PROJECT, '.git'), { recursive: true });
});
after(() => rmSync(BASE, { recursive: true, force: true }));

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  delete process.env.IJFW_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = HOME_DIR; // os.homedir() reads HOME on POSIX
});
afterEach(() => {
  process.chdir(ORIG_CWD);
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const posixOnly = { skip: process.platform === 'win32' };

test('real project path with spaces (cwd) is used as-is', posixOnly, () => {
  process.chdir(PROJECT);
  const r = describeProjectRoot();
  assert.equal(r.dir, PROJECT);
  assert.equal(r.source, 'cwd');
  assert.equal(safeProjectDir(), PROJECT);
});

test('explicit IJFW_PROJECT_DIR with spaces wins over cwd', posixOnly, () => {
  const other = join(HOME_DIR, 'dev', 'other project');
  mkdirSync(other, { recursive: true });
  process.env.IJFW_PROJECT_DIR = other;
  process.chdir(PROJECT);
  const r = describeProjectRoot();
  assert.equal(r.dir, other);
  assert.equal(r.source, 'IJFW_PROJECT_DIR');
});

test('explicit IJFW_PROJECT_DIR inside a temp dir is honoured (deliberate choice)', posixOnly, () => {
  const tmp = mkdtempSync(join(os.tmpdir(), 'ijfw-explicit-'));
  try {
    process.env.IJFW_PROJECT_DIR = tmp;
    assert.equal(describeProjectRoot().dir, resolve(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('host-spawned server: cwd inside the OS temp dir falls back to HOME and creates nothing there', posixOnly, () => {
  const tmp = mkdtempSync(join(os.tmpdir(), 'ijfw-cwd-'));
  try {
    process.chdir(tmp);
    const r = describeProjectRoot({ hostSpawned: true });
    assert.equal(safeProjectDir({ hostSpawned: true }), HOME_DIR);
    assert.equal(r.dir, HOME_DIR);
    assert.equal(r.source, 'home-fallback');
    assert.ok(r.rejected.some((x) => x.source === 'cwd' && x.reason === 'temp-dir'), JSON.stringify(r.rejected));
    assert.equal(existsSync(join(tmp, '.ijfw')), false);
  } finally {
    process.chdir(ORIG_CWD);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI caller (default): a temp cwd the user chose is kept', posixOnly, () => {
  const tmp = realpathSync(mkdtempSync(join(os.tmpdir(), 'ijfw-cli-')));
  try {
    process.chdir(tmp);
    assert.equal(describeProjectRoot().dir, process.cwd());
  } finally {
    process.chdir(ORIG_CWD);
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Find the journal file that holds the probe entry under `root` (the server
// may use the legacy .ijfw/memory or the newer ijfw/memory brain layout).
function findProbe(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) return null;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isFile() && e.name === 'project-journal.md' && readFileSync(p, 'utf8').includes('root contract probe')) return p;
    if (e.isDirectory() && e.name !== 'dev') { const hit = findProbe(p, depth + 1); if (hit) return hit; }
  }
  return null;
}

// End-to-end: the real server process, spawned the way a host spawns it.
async function storeViaServer({ cwd, home, extraEnv = {} }) {
  const serverPath = join(HERE, 'src', 'server.js');
  const env = { PATH: process.env.PATH, HOME: home, ...extraEnv };
  const child = spawn(process.execPath, [serverPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id) => {
    for (let i = 0; i < 100; i++) {
      const hit = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((m) => m && m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'root-contract', version: '0' }, capabilities: {} } });
  await waitFor(1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'ijfw_memory_store', arguments: { content: 'root contract probe', type: 'observation' } } });
  const resp = await waitFor(2);
  child.stdin.end();
  child.kill();
  await new Promise((r) => child.on('close', r));
  return resp;
}

test('MCP server spawned in a temp cwd stores memory under HOME, never in the temp dir', posixOnly, async () => {
  const tmp = mkdtempSync(join(os.tmpdir(), 'ijfw-host-cwd-'));
  try {
    const resp = await storeViaServer({ cwd: tmp, home: HOME_DIR });
    assert.ok(resp && resp.result && !resp.result.isError, JSON.stringify(resp));
    assert.equal(findProbe(tmp), null, 'nothing stored in the temp cwd');
    assert.deepEqual(readdirSync(tmp), [], 'temp cwd left empty');
    assert.ok(findProbe(HOME_DIR), 'memory landed under HOME');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP server spawned in "/Users/test user/dev/my project" stores project memory there', posixOnly, async () => {
  const proj = join(HOME_DIR, 'dev', 'spawned project');
  mkdirSync(proj, { recursive: true });
  const resp = await storeViaServer({ cwd: proj, home: HOME_DIR });
  assert.ok(resp && resp.result && !resp.result.isError, JSON.stringify(resp));
  const hit = findProbe(proj);
  assert.ok(hit && hit.startsWith(proj + '/'), `project-scoped memory (found: ${hit})`);
});

test('cwd at the filesystem root falls back to HOME', posixOnly, () => {
  process.chdir('/');
  const r = describeProjectRoot();
  assert.equal(r.dir, HOME_DIR);
  assert.ok(r.rejected.some((x) => x.source === 'cwd' && x.reason === 'filesystem-root'));
});

test('cwd == HOME resolves to HOME (user-global memory)', posixOnly, () => {
  process.chdir(HOME_DIR);
  assert.equal(describeProjectRoot().dir, HOME_DIR);
});

test('unexpanded host template in IJFW_PROJECT_DIR is rejected and never mkdir-ed', posixOnly, () => {
  for (const tpl of ['${PWD}', '${workspacePath}', '$HOME/x', '{{extensionPath}}', '%CD%']) {
    process.env.IJFW_PROJECT_DIR = tpl;
    process.chdir(PROJECT);
    const r = describeProjectRoot();
    assert.equal(r.dir, PROJECT, `template ${tpl} falls through to cwd`);
    assert.ok(r.rejected.some((x) => x.source === 'IJFW_PROJECT_DIR' && x.reason === 'unexpanded-template'));
    assert.equal(existsSync(join(PROJECT, tpl)), false, `no literal "${tpl}" directory created`);
  }
});

test('relative IJFW_PROJECT_DIR is rejected (cannot be deterministic)', posixOnly, () => {
  process.env.IJFW_PROJECT_DIR = 'dev/my project';
  process.chdir(HOME_DIR);
  const r = describeProjectRoot();
  assert.ok(r.rejected.some((x) => x.source === 'IJFW_PROJECT_DIR' && x.reason === 'not-absolute'));
  assert.equal(existsSync(join(HOME_DIR, 'dev', 'my project', 'dev')), false);
});

test('isTempPath: macOS and Linux temp roots (lexical)', () => {
  for (const p of [
    '/tmp', '/tmp/x', '/private/tmp/proj', '/var/tmp/a',
    '/var/folders/ab/cdefg/T/proj', '/private/var/folders/ab/cdefg/T/proj',
  ]) assert.equal(isTempPath(p), true, p);
  for (const p of [
    '/Users/test user/dev/my project', '/Users/test user/tmp/proj',
    '/home/u/projects/tmp-tools', '/tmpfoo/x', '/var/folders-not/x',
    // FerroxLabs/ijfw#50: projects on a separate macOS volume.
    '/Volumes/Projects/my app', '/Volumes/Data/dev/x',
  ]) assert.equal(isTempPath(p), false, p);
});

test('isUnexpandedTemplate: only real template syntax is flagged', () => {
  assert.equal(isUnexpandedTemplate('${PWD}'), true);
  assert.equal(isUnexpandedTemplate('/Users/test user/dev/my project'), false);
  assert.equal(isUnexpandedTemplate('/Users/a/my$project'), false, 'a bare $ followed by lowercase is a legal path char');
});

test('FerroxLabs/ijfw#50: a project on a separate volume (/Volumes/...) is never treated as temp or bundle', async () => {
  const { isBundleInternalPath } = await import('./src/lib/project-root-guard.js');
  for (const p of ['/Volumes/Projects/my app', '/Volumes/Work Drive/dev/ijfw-client']) {
    assert.equal(isTempPath(p), false, p);
    assert.equal(isBundleInternalPath(p), false, p);
  }
});
