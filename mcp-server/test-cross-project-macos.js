/**
 * test-cross-project-macos.js -- "search all projects" must find memory that
 * another agent stored, on the layout macOS users actually have
 * (FerroxLabs/ijfw#50 follow-up).
 *
 * Reproduces the field report: Codex stored "BLUE-HERON-42" in a project on a
 * separate volume; Claude Code then searched scope:"all" from that project and
 * found nothing. Four causes, each covered here:
 *   1. readProjectMemory() only read <project>/.ijfw/memory -- new projects
 *      (layout v2) keep content in <project>/ijfw/memory.
 *   2. Registry entries outside $HOME were skipped; on macOS projects often
 *      live under /Volumes/<drive>.
 *   3. The corpus cache signature only watched the legacy paths.
 *   4. scope:"all" excluded the CURRENT project.
 *
 * Real server processes, sandboxed HOME, simulated volume
 * "<tmp>/Volumes/Work Drive" passed via IJFW_PROJECT_ROOTS (on macOS
 * /Volumes is allowed by default; see defaultAllowedRoots test).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { defaultAllowedRoots } from './src/cross-project-search.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-xproj-')));
after(() => rmSync(BASE, { recursive: true, force: true }));

const HOME = join(BASE, 'Users', 'test user');
const VOLUME = join(BASE, 'Volumes', 'Work Drive');
const TEST_PROJ = join(VOLUME, 'Test');
const OTHER_PROJ = join(VOLUME, 'Other Project');
for (const d of [HOME, TEST_PROJ, OTHER_PROJ]) mkdirSync(d, { recursive: true });

// Registry exactly as the session-start hooks write it.
mkdirSync(join(HOME, '.ijfw'), { recursive: true });
writeFileSync(join(HOME, '.ijfw', 'registry.md'),
  [TEST_PROJ, OTHER_PROJ].map((p, i) => `${p} | 00000000000${i} | 2026-11-03T10:00:00Z`).join('\n') + '\n');

async function callServer(projectDir, calls) {
  const child = spawn(process.execPath, [join(HERE, 'src', 'server.js')], {
    cwd: projectDir,
    env: {
      PATH: process.env.PATH,
      HOME,
      IJFW_PROJECT_DIR: projectDir, // sandbox lives under the OS temp dir
      IJFW_PROJECT_ROOTS: VOLUME,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id) => {
    for (let i = 0; i < 150; i++) {
      const m = out.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((x) => x && x.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '0' }, capabilities: {} } });
  await waitFor(1);
  const texts = [];
  let id = 2;
  for (const [name, args] of calls) {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const r = await waitFor(id);
    texts.push(r && r.result && r.result.content ? r.result.content.map((c) => c.text).join('\n') : JSON.stringify(r));
    id++;
  }
  child.stdin.end();
  child.kill();
  await new Promise((r) => child.on('close', r));
  return texts;
}

test('agent A stores in a /Volumes project; a fresh session finds it with scope:"all" (same project)', async () => {
  const [stored] = await callServer(TEST_PROJ, [
    ['ijfw_memory_store', { content: 'test token BLUE-HERON-42', type: 'decision' }],
  ]);
  assert.match(stored, /Stored/);

  const [all] = await callServer(TEST_PROJ, [
    ['ijfw_memory_search', { query: 'BLUE-HERON-42', scope: 'all' }],
  ]);
  assert.doesNotMatch(all, /^No results/, `scope:all from the same project: ${all}`);
  assert.match(all, /\[project:Test\][^\n]*BLUE-HERON-42/, `scope:all from the same project: ${all}`);
});

test('a session in ANOTHER project finds it with scope:"all"', async () => {
  const [all] = await callServer(OTHER_PROJ, [
    ['ijfw_memory_search', { query: 'BLUE-HERON-42', scope: 'all' }],
  ]);
  assert.match(all, /\[project:Test\][^\n]*BLUE-HERON-42/, `scope:all from another project: ${all}`);
});

test('a new memory in an already-searched project is picked up (cache not stale)', async () => {
  // Warm the cache, then write, then search again in ONE server process.
  const texts = await callServer(OTHER_PROJ, [
    ['ijfw_memory_search', { query: 'GREEN-OWL-7', scope: 'all' }],
  ]);
  assert.match(texts[0], /^No results/, 'nothing stored yet');
  await callServer(TEST_PROJ, [['ijfw_memory_store', { content: 'second token GREEN-OWL-7', type: 'decision' }]]);
  const [again] = await callServer(OTHER_PROJ, [['ijfw_memory_search', { query: 'GREEN-OWL-7', scope: 'all' }]]);
  assert.match(again, /\[project:Test\][^\n]*GREEN-OWL-7/, again);
});

test('defaultAllowedRoots: HOME always; /Volumes on macOS; IJFW_PROJECT_ROOTS entries', () => {
  const env = { HOME: '/Users/test user', IJFW_PROJECT_ROOTS: '/srv/code:/mnt/projects' };
  const mac = defaultAllowedRoots({ platform: 'darwin', env, home: '/Users/test user' });
  assert.ok(mac.includes('/Users/test user'));
  assert.ok(mac.includes('/Volumes'));
  assert.ok(mac.includes('/srv/code') && mac.includes('/mnt/projects'));
  const linux = defaultAllowedRoots({ platform: 'linux', env: { HOME: '/home/u' }, home: '/home/u' });
  assert.ok(!linux.includes('/Volumes'));
  assert.deepEqual(linux, ['/home/u']);
});

test('outside HOME, a registry entry without an owned .ijfw dir is skipped (no arbitrary reads)', async () => {
  const { buildCorpus, _resetSkipLog, _resetCorpusCache } = await import('./src/cross-project-search.js');
  _resetSkipLog(); _resetCorpusCache();
  const notAProject = join(VOLUME, 'random-folder');
  mkdirSync(notAProject, { recursive: true });
  const saved = { HOME: process.env.HOME, R: process.env.IJFW_PROJECT_ROOTS };
  process.env.HOME = HOME;
  process.env.IJFW_PROJECT_ROOTS = VOLUME;
  try {
    let reads = 0;
    const reader = () => { reads++; return { knowledge: 'secret line', journal: '', handoff: '' }; };
    const docs = buildCorpus([{ path: notAProject }, { path: TEST_PROJ }], reader);
    assert.equal(reads, 1, 'only the real IJFW project was read');
    assert.ok(docs.every((d) => d.meta.projectPath === TEST_PROJ));
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.R === undefined) delete process.env.IJFW_PROJECT_ROOTS; else process.env.IJFW_PROJECT_ROOTS = saved.R;
  }
});

test('the same project listed twice (symlinked spelling) is searched once', async () => {
  const { buildCorpus, _resetCorpusCache } = await import('./src/cross-project-search.js');
  const { symlinkSync } = await import('node:fs');
  _resetCorpusCache();
  const link = join(BASE, 'Users', 'test user', 'test-link');
  symlinkSync(TEST_PROJ, link);
  let reads = 0;
  const reader = () => { reads++; return { knowledge: 'x', journal: '', handoff: '' }; };
  buildCorpus([{ path: TEST_PROJ }, { path: link }], reader, { allowedRoots: [BASE], useCache: false });
  assert.equal(reads, 1);
});

test('ijfw_cross_project_search ("every IJFW project") also covers the current project', async () => {
  const [hit] = await callServer(TEST_PROJ, [
    ['ijfw_cross_project_search', { pattern: 'BLUE-HERON-42' }],
  ]);
  assert.match(hit, /@Test:L\d+\][^\n]*BLUE-HERON-42/, `cross-project tool from the same project: ${hit}`);
});

// --- One unreadable project must never sink the whole search --------------
// Mac field report: Claude Desktop lacks macOS "Documents" permission; one
// registered project under ~/Documents threw EPERM reading
// .ijfw/.layout-version and BOTH search tools failed outright.

test('buildCorpus skips a project whose memory read throws (EPERM) and keeps the rest', async () => {
  const { buildCorpus, _resetCorpusCache } = await import('./src/cross-project-search.js');
  _resetCorpusCache();
  const blocked = join(VOLUME, 'Blocked Project');
  mkdirSync(join(blocked, '.ijfw'), { recursive: true });
  const reader = (p) => {
    if (p === blocked) {
      const e = new Error(`EPERM: operation not permitted, open '${p}/.ijfw/.layout-version'`);
      e.code = 'EPERM';
      throw e;
    }
    return { knowledge: 'reachable line', journal: '', handoff: '' };
  };
  let docs;
  assert.doesNotThrow(() => {
    docs = buildCorpus([{ path: blocked }, { path: TEST_PROJ }], reader, { allowedRoots: [BASE], useCache: false });
  });
  assert.ok(docs.length > 0 && docs.every((d) => d.meta.projectPath === TEST_PROJ));
});

test('real server: an unreadable registered project does not break scope:"all" or the cross-project tool', async () => {
  const unreadable = join(VOLUME, 'Unreadable Project');
  // A directory where the layout file should be makes every read of it fail
  // (EISDIR), the same failure path as macOS denying access (EPERM).
  mkdirSync(join(unreadable, '.ijfw', '.layout-version'), { recursive: true });
  const reg = join(HOME, '.ijfw', 'registry.md');
  writeFileSync(reg, `${unreadable} | 0000000000ff | 2026-11-03T10:00:00Z\n`
    + [TEST_PROJ, OTHER_PROJ].map((p, i) => `${p} | 00000000000${i} | 2026-11-03T10:00:00Z`).join('\n') + '\n');
  const [all, tool] = await callServer(OTHER_PROJ, [
    ['ijfw_memory_search', { query: 'BLUE-HERON-42', scope: 'all' }],
    ['ijfw_cross_project_search', { pattern: 'BLUE-HERON-42' }],
  ]);
  assert.doesNotMatch(all, /EISDIR|EPERM|failed/i, all);
  assert.match(all, /BLUE-HERON-42/, all);
  assert.doesNotMatch(tool, /EISDIR|EPERM|failed/i, tool);
  assert.match(tool, /@Test:L\d+\][^\n]*BLUE-HERON-42/, tool);
});
