// Regression tests from the cdvatx/ijfw Mac rollout (FerroxLabs/ijfw#50).
//
//   1. Running the installer from INSIDE the IJFW checkout
//      (cd ~/.ijfw/installer && node src/install.js) treated that folder as
//      "your project" and wrote .cursor/ .vscode/ .ijfw/ .windsurfrules into
//      the IJFW install itself. The project-write guard must refuse any cwd
//      inside the IJFW home.
//   2. Claude Desktop had no installer target. It is wired as an MCP-only
//      target that merges ~/Library/Application Support/Claude/
//      claude_desktop_config.json (macOS) and keeps the app's other settings.
//
// Run: node --test installer/test/macos-desktop-and-guard.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { isProjectWritable } from '../src/install-helpers.js';
import { installClaudeDesktop, claudeDesktopConfigPath } from '../src/install-targets-8-14.js';
import { cleanPlatforms } from '../src/uninstall.js';
import { CANONICAL_ORDER } from '../src/install-flow.js';
import { INSTALL_PLAN } from '../src/install-ledger.js';

function macHome() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ijfw-desk-')));
  const home = join(base, 'Users', 'test user');
  mkdirSync(home, { recursive: true });
  return { base, home };
}

function ctxFor(home, extra = {}) {
  const serverJs = join(home, '.ijfw', 'mcp-server', 'src', 'server.js');
  return {
    home, homeReal: home, cwd: home, ijfwCustomDir: false,
    repoRoot: join(home, '.ijfw'), serverJs, serverJsNative: serverJs,
    nodeBin: process.execPath, ts: '20261103-120000', platform: 'darwin',
    log: { ok() {}, note() {}, info() {}, warn() {} },
    ...extra,
  };
}

describe('project-write guard: never inside the IJFW install', () => {
  it('refuses ~/.ijfw and anything under it', () => {
    const { base, home } = macHome();
    try {
      const inner = join(home, '.ijfw', 'installer');
      mkdirSync(inner, { recursive: true });
      assert.equal(isProjectWritable(join(home, '.ijfw'), home), false);
      assert.equal(isProjectWritable(inner, home), false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('refuses a custom IJFW_HOME checkout too', () => {
    const { base, home } = macHome();
    const saved = process.env.IJFW_HOME;
    try {
      const custom = join(base, 'opt', 'ijfw');
      mkdirSync(join(custom, 'installer'), { recursive: true });
      process.env.IJFW_HOME = custom;
      assert.equal(isProjectWritable(join(custom, 'installer'), home), false);
    } finally {
      if (saved === undefined) delete process.env.IJFW_HOME; else process.env.IJFW_HOME = saved;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('still allows a real project, including one on a separate volume', () => {
    const { base, home } = macHome();
    try {
      const proj = join(base, 'Volumes', 'Work Drive', 'Test');
      mkdirSync(proj, { recursive: true });
      assert.equal(isProjectWritable(proj, home), true);
      const homeProj = join(home, 'dev', 'my project');
      mkdirSync(homeProj, { recursive: true });
      assert.equal(isProjectWritable(homeProj, home), true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('Claude Desktop target', () => {
  it('is a canonical target with a dry-run plan entry', () => {
    assert.ok(CANONICAL_ORDER.includes('claude-desktop'));
    assert.ok(Array.isArray(INSTALL_PLAN['claude-desktop']) && INSTALL_PLAN['claude-desktop'].length > 0);
  });

  it('config path: macOS Application Support, Windows APPDATA, none on Linux', () => {
    assert.equal(
      claudeDesktopConfigPath('/Users/test user', 'darwin'),
      '/Users/test user/Library/Application Support/Claude/claude_desktop_config.json',
    );
    assert.match(claudeDesktopConfigPath('C:\\Users\\t', 'win32', { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }),
      /Claude[\\/]claude_desktop_config\.json$/);
    assert.equal(claudeDesktopConfigPath('/home/u', 'linux'), null);
  });

  it('merges ijfw-memory and keeps the app\'s other settings; idempotent', () => {
    const { base, home } = macHome();
    try {
      const cfg = claudeDesktopConfigPath(home, 'darwin');
      mkdirSync(dirname(cfg), { recursive: true });
      writeFileSync(cfg, JSON.stringify({
        preferences: { sidebarMode: 'chat' },
        mcpServers: { other: { command: 'uvx', args: ['x'] } },
      }, null, 2));
      assert.equal(installClaudeDesktop(ctxFor(home)).status, 'ok');
      const first = readFileSync(cfg, 'utf8');
      const doc = JSON.parse(first);
      assert.deepEqual(doc.preferences, { sidebarMode: 'chat' });
      assert.deepEqual(doc.mcpServers.other, { command: 'uvx', args: ['x'] });
      assert.deepEqual(doc.mcpServers['ijfw-memory'].args, [join(home, '.ijfw', 'mcp-server', 'src', 'server.js')]);
      assert.ok(doc.mcpServers['ijfw-memory'].env && doc.mcpServers['ijfw-memory'].env.PATH,
        'GUI apps get a minimal PATH: the entry carries its own');

      installClaudeDesktop(ctxFor(home));
      assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')), doc, 'reinstall leaves the same config');

      cleanPlatforms({ home, cwd: home, repoRoot: join(home, '.ijfw') });
      const after = JSON.parse(readFileSync(cfg, 'utf8'));
      assert.equal(after.mcpServers['ijfw-memory'], undefined, 'uninstall removes the IJFW entry');
      assert.deepEqual(after.mcpServers.other, { command: 'uvx', args: ['x'] });
      assert.deepEqual(after.preferences, { sidebarMode: 'chat' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('app not installed: nothing is created', () => {
    const { base, home } = macHome();
    try {
      const r = installClaudeDesktop(ctxFor(home));
      assert.equal(r.status, 'noop');
      assert.equal(existsSync(join(home, 'Library', 'Application Support', 'Claude')), false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('Codex config.toml: the MCP entry carries its own PATH (desktop apps)', () => {
  it('writes env.PATH inside the ijfw-memory section; reinstall + uninstall stay clean', async () => {
    const { mergeToml } = await import('../src/install-helpers.js');
    const { removeTomlSection } = await import('../src/uninstall.js');
    const { base, home } = macHome();
    try {
      const cfg = join(home, '.codex', 'config.toml');
      mkdirSync(dirname(cfg), { recursive: true });
      writeFileSync(cfg, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "uvx"\n');
      const server = join(home, '.ijfw', 'mcp-server', 'src', 'server.js');
      mergeToml(cfg, server, 't1');
      mergeToml(cfg, server, 't2');
      const text = readFileSync(cfg, 'utf8');
      assert.equal(text.split('[mcp_servers.ijfw-memory]').length - 1, 1, 'one section after reinstall');
      const section = text.slice(text.indexOf('[mcp_servers.ijfw-memory]'));
      const m = section.match(/^env = \{ PATH = "([^"]+)" \}$/m);
      assert.ok(m, `env.PATH line in section:\n${section}`);
      assert.ok(m[1].split(':').includes(dirname(process.execPath)), 'includes the installing node\'s directory');
      assert.match(text, /\[mcp_servers\.other\]\ncommand = "uvx"/, 'other servers untouched');

      removeTomlSection(cfg);
      const after = readFileSync(cfg, 'utf8');
      assert.ok(!after.includes('ijfw-memory') && !after.includes('env = { PATH'), after);
      assert.match(after, /\[mcp_servers\.other\]/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
