// Regression tests for the install-targets audit-sweep fixes.
//
// Covers:
//   - Hermes re-install keeps the ijfw-memory block anchored under
//     mcp_servers: (was: re-appended at EOF under plugins:/hooks:).
//   - Hermes YAML merge escapes backslashes (Windows server.js path).
//   - Hermes inline plugins.enabled list does not gain duplicates.
//   - Hermes mirror step is skipped when the source readdir fails (was:
//     wiped the installed plugin tree).
//   - Copilot writes the VS Code `servers` key (not `mcpServers`) and
//     migrates a wrong-key entry on re-install.
//   - Gemini hooks.json / gemini-extension.json refresh on upgrade with a
//     backup of a user-modified copy.
//   - Claude: corrupt ~/.claude/settings.json is refused (noop), not
//     rewritten with IJFW-only keys.
//   - Cursor: user-modified .cursor/rules/ijfw.mdc is backed up before
//     being refreshed.
//
// Run: node --test installer/test/install-targets-audit-fixes.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  chmodSync, realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  installClaude, installGemini, installHermes, installCursor,
} from '../src/install-targets-1-7.js';
import { installCopilot } from '../src/install-targets-8-14.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const TS = '20260611-120000';

function mkscratch(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeCtx({ home, cwd, repoRoot, serverJsNative }) {
  return {
    home,
    homeReal: home,
    cwd: cwd || home,
    ijfwCustomDir: false,
    isIjfwSource: false,
    repoRoot: repoRoot || REPO_ROOT,
    serverJs: join(REPO_ROOT, 'mcp-server', 'src', 'server.js'),
    serverJsNative: serverJsNative || join(REPO_ROOT, 'mcp-server', 'src', 'server.js'),
    nodeBin: process.execPath,
    ts: TS,
    log: { ok() {}, note() {}, info() {}, warn() {} },
  };
}

describe('Hermes config.yaml merge', () => {
  it('keeps ijfw-memory anchored under mcp_servers: across re-installs', async () => {
    const home = mkscratch('ijfw-herm-anchor-');
    try {
      await installHermes(makeCtx({ home }));
      await installHermes(makeCtx({ home }));
      const text = readFileSync(join(home, '.hermes', 'config.yaml'), 'utf8');
      const lines = text.split('\n');
      const mcpIdx = lines.findIndex((l) => /^mcp_servers:\s*$/.test(l));
      const memIdx = lines.findIndex((l) => l === '  ijfw-memory:');
      const plugIdx = lines.findIndex((l) => /^plugins:\s*$/.test(l));
      assert.ok(mcpIdx >= 0, 'mcp_servers: present');
      assert.ok(memIdx >= 0, 'ijfw-memory mapping present');
      assert.equal(memIdx, mcpIdx + 2, 'ijfw-memory sits directly under mcp_servers (after sentinel)');
      assert.ok(plugIdx > memIdx, 'plugins: block comes after the mcp_servers children');
      assert.equal(
        lines.filter((l) => l === '  ijfw-memory:').length, 1,
        'exactly one ijfw-memory mapping after two installs',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('escapes backslashes in the double-quoted args scalar', async () => {
    const home = mkscratch('ijfw-herm-esc-');
    try {
      const winPath = 'C:\\Users\\x\\.ijfw\\mcp-server\\src\\server.js';
      await installHermes(makeCtx({ home, serverJsNative: winPath }));
      const text = readFileSync(join(home, '.hermes', 'config.yaml'), 'utf8');
      assert.ok(
        text.includes('args: ["C:\\\\Users\\\\x\\\\.ijfw\\\\mcp-server\\\\src\\\\server.js"]'),
        'backslashes doubled inside the YAML double-quoted scalar',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not duplicate ijfw in an inline plugins.enabled list', async () => {
    const home = mkscratch('ijfw-herm-inline-');
    try {
      const cfg = join(home, '.hermes', 'config.yaml');
      mkdirSync(dirname(cfg), { recursive: true });
      writeFileSync(cfg, 'mcp_servers:\nplugins:\n  enabled: [other, ijfw]\n');
      await installHermes(makeCtx({ home }));
      await installHermes(makeCtx({ home }));
      const text = readFileSync(cfg, 'utf8');
      const enabledLine = text.split('\n').find((l) => /^\s+enabled:\s*\[/.test(l));
      assert.ok(enabledLine, 'inline enabled list survives');
      const count = (enabledLine.match(/\bijfw\b/g) || []).length;
      assert.equal(count, 1, `ijfw listed exactly once (got: ${enabledLine})`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips the plugin mirror when the source readdir fails (no wipe)', async (t) => {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) {
      t.skip('chmod-based fault injection needs a non-root POSIX host');
      return;
    }
    const home = mkscratch('ijfw-herm-mirror-');
    const fakeRepo = mkscratch('ijfw-herm-repo-');
    const badSrc = join(fakeRepo, 'hermes', 'plugins', 'ijfw');
    try {
      // Seed an installed plugin tree, then make the SOURCE unreadable
      // (existsSync passes, readdirSync throws EACCES).
      const pluginDst = join(home, '.hermes', 'plugins', 'ijfw');
      mkdirSync(pluginDst, { recursive: true });
      writeFileSync(join(pluginDst, 'keepme.py'), '# installed\n');
      mkdirSync(badSrc, { recursive: true });
      chmodSync(badSrc, 0o000);

      await installHermes(makeCtx({ home, repoRoot: fakeRepo }));

      assert.ok(
        existsSync(join(pluginDst, 'keepme.py')),
        'installed plugin tree untouched after source readdir failure',
      );
    } finally {
      try { chmodSync(badSrc, 0o755); } catch { /* best-effort */ }
      rmSync(home, { recursive: true, force: true });
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});

describe('Copilot .vscode/mcp.json schema', () => {
  it('writes the VS Code servers key, not mcpServers', async () => {
    const home = mkscratch('ijfw-cop-home-');
    const proj = mkscratch('ijfw-cop-proj-');
    try {
      const r = await installCopilot(makeCtx({ home, cwd: proj }));
      assert.equal(r.status, 'ok');
      const doc = JSON.parse(readFileSync(join(proj, '.vscode', 'mcp.json'), 'utf8'));
      assert.ok(doc.servers && doc.servers['ijfw-memory'], 'servers.ijfw-memory present');
      assert.equal(doc.servers['ijfw-memory'].type, 'stdio');
      assert.equal(doc.servers['ijfw-memory'].command, 'node');
      assert.ok(!doc.mcpServers, 'no stray mcpServers key on fresh install');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('migrates an existing wrong-key entry and preserves other content', async () => {
    const home = mkscratch('ijfw-cop2-home-');
    const proj = mkscratch('ijfw-cop2-proj-');
    try {
      const dst = join(proj, '.vscode', 'mcp.json');
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, JSON.stringify({
        mcpServers: {
          'ijfw-memory': { command: 'node', args: ['/old/server.js'] },
          'user-server': { command: 'foo', args: [] },
        },
        servers: { existing: { type: 'stdio', command: 'bar', args: [] } },
        inputs: [{ id: 'token', type: 'promptString' }],
      }, null, 2));

      await installCopilot(makeCtx({ home, cwd: proj }));
      const doc = JSON.parse(readFileSync(dst, 'utf8'));
      assert.ok(doc.servers['ijfw-memory'], 'ijfw-memory migrated to servers');
      assert.ok(doc.servers.existing, 'pre-existing servers entry preserved');
      assert.ok(doc.inputs && doc.inputs.length === 1, 'inputs preserved');
      assert.ok(doc.mcpServers && doc.mcpServers['user-server'], 'unrelated mcpServers entry preserved');
      assert.ok(!doc.mcpServers['ijfw-memory'], 'ijfw entry removed from the wrong key');
      assert.ok(existsSync(`${dst}.bak.${TS}`), 'pre-rewrite backup taken');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe('Gemini upgrade refresh', () => {
  it('refreshes a stale hooks.json (with backup) instead of copy-if-absent', async () => {
    const home = mkscratch('ijfw-gem-home-');
    try {
      const extDst = join(home, '.gemini', 'extensions', 'ijfw');
      const hooksJson = join(extDst, 'hooks', 'hooks.json');
      mkdirSync(dirname(hooksJson), { recursive: true });
      writeFileSync(hooksJson, '{ "hooks": { "stale": [] } }\n');

      await installGemini(makeCtx({ home }));

      const now = readFileSync(hooksJson, 'utf8');
      assert.ok(!now.includes('"stale"'), 'stale registration replaced');
      assert.ok(!now.includes('{{extensionPath}}'), 'placeholder expanded');
      assert.ok(existsSync(`${hooksJson}.bak.${TS}`), 'user copy backed up');

      // Idempotent: a second run must not re-back-up or churn.
      const before = readFileSync(hooksJson, 'utf8');
      await installGemini(makeCtx({ home }));
      assert.equal(readFileSync(hooksJson, 'utf8'), before, 'second run is a no-op');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Claude corrupt settings.json', () => {
  it('refuses to rewrite a corrupt settings.json (noop + file untouched)', async () => {
    const home = mkscratch('ijfw-cla-home-');
    try {
      const settings = join(home, '.claude', 'settings.json');
      mkdirSync(dirname(settings), { recursive: true });
      const corrupt = '{ "permissions": { "allow": ["Bash(*)"] }, }';
      writeFileSync(settings, corrupt);

      const r = await installClaude(makeCtx({ home }));
      assert.equal(r.status, 'noop');
      assert.equal(readFileSync(settings, 'utf8'), corrupt, 'corrupt file left as-is');
      assert.ok(existsSync(`${settings}.bak.${TS}`), 'backup of the corrupt original exists');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('parses a BOM-prefixed (otherwise valid) settings.json instead of refusing', async () => {
    const home = mkscratch('ijfw-cla-bom-');
    try {
      const settings = join(home, '.claude', 'settings.json');
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(settings, '\uFEFF{ "permissions": { "allow": ["Bash(ls)"] } }');

      const r = await installClaude(makeCtx({ home }));
      assert.equal(r.status, 'ok');
      const doc = JSON.parse(readFileSync(settings, 'utf8'));
      assert.deepEqual(doc.permissions, { allow: ['Bash(ls)'] }, 'user keys preserved');
      assert.ok(doc.mcpServers['ijfw-memory'], 'ijfw entry merged');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Cursor rules file', () => {
  it('backs up a user-modified ijfw.mdc before refreshing it', async () => {
    const home = mkscratch('ijfw-cur-home-');
    const proj = mkscratch('ijfw-cur-proj-');
    try {
      await installCursor(makeCtx({ home, cwd: proj }));
      const mdc = join(proj, '.cursor', 'rules', 'ijfw.mdc');
      assert.ok(existsSync(mdc), 'rules file installed');

      writeFileSync(mdc, '---\nalwaysApply: false\n---\nuser tuned\n');
      await installCursor(makeCtx({ home, cwd: proj }));

      const src = readFileSync(join(REPO_ROOT, 'cursor', '.cursor', 'rules', 'ijfw.mdc'), 'utf8');
      assert.equal(readFileSync(mdc, 'utf8'), src, 'refreshed to the shipped version');
      assert.ok(existsSync(`${mdc}.bak.${TS}`), 'user-modified copy backed up');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});
