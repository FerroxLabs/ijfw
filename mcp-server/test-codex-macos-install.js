/**
 * test-codex-macos-install.js -- Codex install, hooks and AGENTS.md on a
 * SIMULATED macOS home ("<tmp>/Users/test user"). Linux-run simulation only:
 * this proves path handling (spaces, /Users layout, no ../../.. traversal),
 * not physical macOS behaviour.
 *
 * Layout mirrors a real install: ~/.ijfw is the IJFW checkout (here: a copy
 * of the parts the Codex install + hooks use), installCodex() writes into
 * ~/.codex, hooks run with cwd = the user's project.
 *
 * Covers:
 *   1. observation-capture.sh / user-prompt-submit-capture.sh / post-tool-use.sh
 *      reach capture.js from ~/.codex/hooks (was: ../../.. -> /Users/scripts).
 *   3. every command in the installed hooks.json exists and is executable
 *      (was: hooks/scripts/pre-tool-use-extension-check.sh never copied).
 *   4. ~/.codex/AGENTS.md managed block: clean install, user content kept,
 *      backup, reinstall idempotence, upgrade, uninstall removes only the block.
 *   6. session-end "Memory updates this session" counts this session only.
 *
 * Never touches the real HOME: every hook runs with HOME=<sandbox>.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync,
  statSync, cpSync, readdirSync, accessSync, constants as FS,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { installCodex, installGemini } from '../installer/src/install-targets-1-7.js';
import { cleanPlatforms } from '../installer/src/uninstall.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TS = '20261103-120000';
const BASE = mkdtempSync(join(tmpdir(), 'ijfw-codex-mac-'));
after(() => rmSync(BASE, { recursive: true, force: true }));

const FIX = join(REPO, 'scripts', 'observation', 'fixtures');
const IJFW_MD = readFileSync(join(REPO, 'codex', '.codex', 'IJFW.md'), 'utf8');
const BEGIN = '<!-- IJFW:BEGIN';
const END = '<!-- IJFW:END -->';

let n = 0;
// Build "<BASE>/case-N/Users/test user" with ~/.ijfw = IJFW checkout copy.
function sandbox() {
  const root = join(BASE, `case-${++n}`);
  const home = join(root, 'Users', 'test user');
  const ijfw = join(home, '.ijfw');
  const project = join(home, 'dev', 'my project');
  mkdirSync(join(project, '.git'), { recursive: true });
  for (const rel of ['codex', 'gemini', 'scripts/observation', 'mcp-server/src/redactor.js']) {
    cpSync(join(REPO, rel), join(ijfw, rel), { recursive: true });
  }
  return { root, home, ijfw, project };
}

function logs() {
  const notes = [];
  const push = (m) => notes.push(String(m));
  return { notes, log: { ok: push, note: push, info: push, warn: push } };
}

function ctxFor(sb, log) {
  return {
    home: sb.home,
    homeReal: sb.home,
    cwd: sb.home, // home cwd: project-level writes are skipped by the guard
    ijfwCustomDir: false,
    isIjfwSource: false,
    repoRoot: sb.ijfw,
    serverJs: join(sb.ijfw, 'mcp-server', 'src', 'server.js'),
    serverJsNative: join(sb.ijfw, 'mcp-server', 'src', 'server.js'),
    nodeBin: process.execPath,
    ts: TS,
    log: log || logs().log,
  };
}

function hookEnv(sb, extra = {}) {
  return { PATH: process.env.PATH, HOME: sb.home, ...extra };
}

function runHook(sb, script, stdin, extraEnv) {
  return spawnSync('bash', [script], {
    cwd: sb.project,
    input: stdin,
    env: hookEnv(sb, extraEnv),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function ledgerRows(sb) {
  const p = join(sb.home, '.ijfw', 'observations.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Capture runs detached (`& disown`): poll for the ledger row.
function waitRows(sb, count, ms = 15000) {
  const end = Date.now() + ms;
  let rows = ledgerRows(sb);
  while (rows.length < count && Date.now() < end) {
    spawnSync('sleep', ['0.2']);
    rows = ledgerRows(sb);
  }
  return rows;
}

// Undo the POSIX single-quoting installCodex applies to hook command paths.
function unquote(cmd) {
  const s = String(cmd);
  if (!s.startsWith("'")) return s;
  return s.slice(1, -1).replace(/'\\''/g, "'");
}

function blockCount(text) {
  return text.split(BEGIN).length - 1;
}

function backups(dir, base) {
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`));
}

const hooksDir = (sb) => join(sb.home, '.codex', 'hooks');
const agentsMd = (sb) => join(sb.home, '.codex', 'AGENTS.md');

// --- 3. installed hooks.json commands ----------------------------------------

test('every command in the installed hooks.json exists and is executable', { skip: process.platform === 'win32' }, async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const doc = JSON.parse(readFileSync(join(sb.home, '.codex', 'hooks.json'), 'utf8'));
  const cmds = [];
  for (const groups of Object.values(doc.hooks)) {
    for (const g of groups) for (const h of g.hooks || []) if (h.type === 'command') cmds.push(unquote(h.command));
  }
  assert.ok(cmds.length >= 7, 'IJFW registered its hooks');
  for (const c of cmds) {
    assert.ok(c.startsWith(sb.home), `absolute path inside the simulated home: ${c}`);
    assert.ok(existsSync(c), `hook command exists: ${c}`);
    assert.doesNotThrow(() => accessSync(c, FS.X_OK), `hook command is executable: ${c}`);
  }
});

// --- 1. capture wrappers reach capture.js -------------------------------------

test('Codex PostToolUse capture works from ~/.codex/hooks on a "/Users/test user" home', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const r = runHook(sb, join(hooksDir(sb), 'observation-capture.sh'),
    readFileSync(join(FIX, 'codex-post-tool-use-bash.json'), 'utf8'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'capture wrapper never writes stdout');
  const rows = waitRows(sb, 1);
  assert.equal(rows.length, 1, 'observation recorded');
  assert.equal(rows[0].title, 'npm run build');
  assert.equal(rows[0].platform, 'codex');
  // The broken traversal target must not have been created or used.
  assert.equal(existsSync(join(sb.root, 'Users', 'scripts')), false);
});

test('Codex UserPromptSubmit capture works from ~/.codex/hooks', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const r = runHook(sb, join(hooksDir(sb), 'user-prompt-submit-capture.sh'),
    readFileSync(join(FIX, 'codex-user-prompt-submit.json'), 'utf8'));
  assert.equal(r.status, 0);
  const rows = waitRows(sb, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'session-request');
  assert.equal(rows[0].title, 'Add a retry to the upload client');
});

test('full post-tool-use.sh path records an observation and stays silent', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const r = runHook(sb, join(hooksDir(sb), 'post-tool-use.sh'),
    readFileSync(join(FIX, 'codex-post-tool-use-apply-patch.json'), 'utf8'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const rows = waitRows(sb, 1);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].files, ['src/upload client.js']);
});

test('older install without the root marker still resolves via ~/.ijfw', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  rmSync(join(hooksDir(sb), '.ijfw-root'), { force: true });
  runHook(sb, join(hooksDir(sb), 'observation-capture.sh'),
    readFileSync(join(FIX, 'codex-post-tool-use-bash.json'), 'utf8'));
  assert.equal(waitRows(sb, 1).length, 1);
});

test('a stray capture.js at the old ../../.. location is never executed', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  // Plant a look-alike where the old traversal pointed (/Users/scripts/...).
  const planted = join(sb.root, 'Users', 'scripts', 'observation');
  mkdirSync(planted, { recursive: true });
  const sentinel = join(sb.root, 'PLANTED-RAN');
  writeFileSync(join(planted, 'capture.js'),
    `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');\n`);
  rmSync(join(hooksDir(sb), '.ijfw-root'), { force: true });
  rmSync(join(sb.ijfw, 'scripts'), { recursive: true, force: true });
  runHook(sb, join(hooksDir(sb), 'observation-capture.sh'),
    readFileSync(join(FIX, 'codex-post-tool-use-bash.json'), 'utf8'));
  spawnSync('sleep', ['1']);
  assert.equal(existsSync(sentinel), false, 'look-alike capture.js must not run');
});

// --- 4. AGENTS.md managed block -------------------------------------------------

test('clean install writes ~/.codex/AGENTS.md with one IJFW managed block', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const text = readFileSync(agentsMd(sb), 'utf8');
  assert.equal(blockCount(text), 1);
  assert.ok(text.includes(END));
  assert.ok(text.includes(IJFW_MD.trim().split('\n').find((l) => l.trim())), 'IJFW instructions inlined');
  assert.ok(existsSync(join(sb.home, '.codex', 'IJFW.md')), 'IJFW.md still shipped for reference');
});

test('existing AGENTS.md: user content preserved verbatim, backup taken, reinstall idempotent', async () => {
  const sb = sandbox();
  const original = '# My rules\n\nAlways run tests.\n';
  mkdirSync(dirname(agentsMd(sb)), { recursive: true });
  writeFileSync(agentsMd(sb), original);

  await installCodex(ctxFor(sb));
  const first = readFileSync(agentsMd(sb), 'utf8');
  assert.ok(first.startsWith(original), 'user content first and untouched');
  assert.equal(blockCount(first), 1);
  const baks = backups(dirname(agentsMd(sb)), 'AGENTS.md');
  assert.equal(baks.length, 1, 'one backup before first modification');
  assert.equal(readFileSync(join(dirname(agentsMd(sb)), baks[0]), 'utf8'), original);

  // Reinstall: byte-identical, still one block, no new backup.
  await installCodex(ctxFor(sb));
  assert.equal(readFileSync(agentsMd(sb), 'utf8'), first);
  assert.equal(backups(dirname(agentsMd(sb)), 'AGENTS.md').length, 1);
});

test('upgrade replaces a stale IJFW block in place and keeps text around it', async () => {
  const sb = sandbox();
  const before = '# Mine\n';
  const afterText = '\n## Added later by the user\nKeep me.\n';
  const stale = `${BEGIN} (managed by IJFW) -->\nOLD IJFW RULES v0\n${END}\n`;
  mkdirSync(dirname(agentsMd(sb)), { recursive: true });
  writeFileSync(agentsMd(sb), before + '\n' + stale + afterText);

  await installCodex(ctxFor(sb));
  const text = readFileSync(agentsMd(sb), 'utf8');
  assert.equal(blockCount(text), 1);
  assert.ok(!text.includes('OLD IJFW RULES v0'), 'stale block replaced');
  assert.ok(text.startsWith(before), 'text before block kept');
  assert.ok(text.endsWith(afterText), 'text after block kept');
});

test('uninstall removes only the managed block and restores the user file exactly', async () => {
  const sb = sandbox();
  const original = '# My rules\n\nAlways run tests.\n';
  mkdirSync(dirname(agentsMd(sb)), { recursive: true });
  writeFileSync(agentsMd(sb), original);
  await installCodex(ctxFor(sb));
  await installCodex(ctxFor(sb)); // repeat install

  cleanPlatforms({ home: sb.home, cwd: sb.project, repoRoot: sb.ijfw });
  assert.equal(readFileSync(agentsMd(sb), 'utf8'), original);
  assert.equal(existsSync(join(hooksDir(sb), '.ijfw-root')), false, 'root marker removed');
  assert.equal(existsSync(join(hooksDir(sb), 'observation-capture.sh')), false);
});

test('uninstall deletes an AGENTS.md that only ever held the IJFW block', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  cleanPlatforms({ home: sb.home, cwd: sb.project, repoRoot: sb.ijfw });
  assert.equal(existsSync(agentsMd(sb)), false);
});

test('AGENTS.override.md present: installer explains that Codex will read the override', async () => {
  const sb = sandbox();
  mkdirSync(join(sb.home, '.codex'), { recursive: true });
  writeFileSync(join(sb.home, '.codex', 'AGENTS.override.md'), 'override rules\n');
  const { notes, log } = logs();
  await installCodex(ctxFor(sb, log));
  assert.ok(notes.some((m) => m.includes('AGENTS.override.md')), notes.join('\n'));
  assert.equal(readFileSync(join(sb.home, '.codex', 'AGENTS.override.md'), 'utf8'), 'override rules\n',
    'override file never modified');
});

// --- 6. session-end memory metric ----------------------------------------------

function journal(sb) {
  return join(sb.project, '.ijfw', 'memory', 'project-journal.md');
}
function lastSessionFile(sb) {
  const dir = join(sb.project, '.ijfw', 'sessions');
  const files = readdirSync(dir).filter((f) => f.startsWith('session_')).sort();
  return readFileSync(join(dir, files[files.length - 1]), 'utf8');
}
function metricsRows(sb) {
  const p = join(sb.project, '.ijfw', 'metrics', 'sessions.jsonl');
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('session-end reports writes for THIS session, not the cumulative journal', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  // 40 entries from earlier sessions.
  mkdirSync(dirname(journal(sb)), { recursive: true });
  const old = ['<!-- ijfw schema:1 -->', '# IJFW Project Journal'];
  for (let i = 0; i < 40; i++) old.push(`- [2026-01-01T00:00:${String(i).padStart(2, '0')}Z] old decision ${i}`);
  writeFileSync(journal(sb), old.join('\n') + '\n');

  const sid = 'codex-sess-A';
  const start = runHook(sb, join(hooksDir(sb), 'session-start.sh'),
    JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, source: 'startup', cwd: sb.project }));
  assert.equal(start.status, 0, start.stderr);

  // Two memory writes during the session (same format the MCP server appends).
  writeFileSync(journal(sb), readFileSync(journal(sb), 'utf8')
    + '- [2026-11-03T10:00:00Z] new decision one\n- [2026-11-03T10:01:00Z] new decision two\n');

  const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: sid, turn_id: 't1', cwd: sb.project });
  assert.equal(runHook(sb, join(hooksDir(sb), 'session-end.sh'), stop).status, 0);
  assert.match(lastSessionFile(sb), /^Memory updates this session: 2$/m);

  // Second Stop in the same session (Codex fires Stop every turn): IJFW's own
  // bookkeeping line must not count as a memory update.
  spawnSync('sleep', ['1.1']); // distinct session-file timestamp
  assert.equal(runHook(sb, join(hooksDir(sb), 'session-end.sh'),
    JSON.stringify({ hook_event_name: 'Stop', session_id: sid, turn_id: 't2', cwd: sb.project })).status, 0);
  assert.match(lastSessionFile(sb), /^Memory updates this session: 2$/m);

  const rows = metricsRows(sb);
  assert.equal(rows[rows.length - 1].memory_stores, 2);
  assert.equal(rows[rows.length - 1].session_id, sid, 'metrics row keyed by Codex session_id');
});

test('session-end without a session baseline does not claim a per-session number', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  mkdirSync(dirname(journal(sb)), { recursive: true });
  writeFileSync(journal(sb), '- [2026-01-01T00:00:00Z] a\n- [2026-01-01T00:00:01Z] b\n');
  runHook(sb, join(hooksDir(sb), 'session-end.sh'),
    JSON.stringify({ hook_event_name: 'Stop', session_id: 'no-start', turn_id: 't1', cwd: sb.project }));
  const s = lastSessionFile(sb);
  assert.doesNotMatch(s, /Memory updates this session: \d/);
  assert.match(s, /^Journal entries \(all sessions\): 2$/m);
  const rows = metricsRows(sb);
  assert.equal(rows[rows.length - 1].memory_stores, null);
});

// --- 7. tool output written by post-tool-use.sh is redacted ---------------------

test('post-tool-use.sh redacts secrets in error snippets it stores in .session-signals.jsonl', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const fake = 'sk-' + 'proj-' + 'FAKEfake'.repeat(5);
  const payload = {
    hook_event_name: 'PostToolUse', session_id: 's', cwd: sb.project, tool_name: 'Bash',
    tool_input: { command: 'deploy' },
    tool_response: `Error: auth failed for key ${fake}\n`,
  };
  runHook(sb, join(hooksDir(sb), 'post-tool-use.sh'), JSON.stringify(payload));
  const p = join(sb.project, '.ijfw', '.session-signals.jsonl');
  assert.ok(existsSync(p), 'error signal recorded');
  const raw = readFileSync(p, 'utf8');
  assert.ok(!raw.includes(fake), 'fake key must not be stored');
  assert.match(raw, /REDACTED/);
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
});

// --- 1b. Gemini capture wrappers (same traversal bug: ../../../.. = $HOME) ------

test('Gemini AfterTool capture works from ~/.gemini/extensions/ijfw/hooks', async () => {
  const sb = sandbox();
  await installGemini(ctxFor(sb));
  const dir = join(sb.home, '.gemini', 'extensions', 'ijfw', 'hooks');
  assert.equal(readFileSync(join(dir, '.ijfw-root'), 'utf8').trim(), sb.ijfw);
  const r = runHook(sb, join(dir, 'observation-capture.sh'),
    readFileSync(join(FIX, 'gemini-after-tool.json'), 'utf8'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const rows = waitRows(sb, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'gemini');
  assert.equal(rows[0].title, 'ls -la');
});

test('Claude + Gemini PostToolUse hooks also redact the error snippets they store', async () => {
  const sb = sandbox();
  await installGemini(ctxFor(sb));
  const fake = 'sk-' + 'ant-' + 'api03-' + 'FAKEFAKE'.repeat(4);
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: 's', cwd: sb.project, tool_name: 'Bash',
    tool_input: { command: 'deploy' }, tool_response: `Error: rejected key ${fake}\n`,
  });
  const p = join(sb.project, '.ijfw', '.session-signals.jsonl');

  // Claude hook straight from the checkout copy in ~/.ijfw (the installed layout).
  cpSync(join(REPO, 'claude', 'hooks'), join(sb.ijfw, 'claude', 'hooks'), { recursive: true });
  runHook(sb, join(sb.ijfw, 'claude', 'hooks', 'scripts', 'post-tool-use.sh'), payload);
  // Gemini AfterTool from the installed extension dir.
  runHook(sb, join(sb.home, '.gemini', 'extensions', 'ijfw', 'hooks', 'after-tool.sh'),
    payload.replace('"PostToolUse"', '"AfterTool"'));

  const raw = readFileSync(p, 'utf8');
  assert.equal(raw.trim().split('\n').length, 2, 'both hooks recorded a signal');
  assert.ok(!raw.includes(fake), 'fake key must not be stored');
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
});

test('session metric counts real MCP-server memory writes (layout v2: ijfw/memory)', async () => {
  const sb = sandbox();
  await installCodex(ctxFor(sb));
  const sid = 'codex-sess-e2e';
  runHook(sb, join(hooksDir(sb), 'session-start.sh'),
    JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, source: 'startup', cwd: sb.project }));

  // Two ijfw_memory_store calls through the real server, cwd = the project.
  const { spawn } = await import('node:child_process');
  // The sandbox lives under the OS temp dir, which the server (correctly)
  // refuses as a host-chosen cwd -- so name the project explicitly.
  const child = spawn(process.execPath, [join(REPO, 'mcp-server', 'src', 'server.js')], {
    cwd: sb.project, env: hookEnv(sb, { IJFW_PROJECT_DIR: sb.project }), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id) => {
    for (let i = 0; i < 100; i++) {
      if (out.split('\n').some((l) => { try { return JSON.parse(l).id === id; } catch { return false; } })) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '0' }, capabilities: {} } });
  assert.ok(await waitFor(1));
  for (const [id, content] of [[2, 'first e2e memory'], [3, 'second e2e memory']]) {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ijfw_memory_store', arguments: { content, type: 'observation' } } });
    assert.ok(await waitFor(id));
  }
  child.stdin.end(); child.kill();
  await new Promise((r) => child.on('close', r));

  runHook(sb, join(hooksDir(sb), 'session-end.sh'),
    JSON.stringify({ hook_event_name: 'Stop', session_id: sid, turn_id: 't1', cwd: sb.project }));
  assert.match(lastSessionFile(sb), /^Memory updates this session: 2$/m);
});
