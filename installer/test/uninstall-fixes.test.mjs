// Full-audit-sweep regression tests for the uninstaller (fix/full-audit-sweep).
//
// Covers:
//  - removeTomlSection: no-op detection + idempotency + no trailing-newline growth
//  - removeCodexHookFiles: provenance header sentinel (user hooks that merely
//    MENTION ijfw survive) + backup before delete
//  - writeAtomic: target file mode preserved (0600 stays 0600)
//  - removeJsonMcpEntry: 'parse-failed' sentinel + cleanPlatforms honest report
//  - removeYamlMcpEntry: backup is the TRUE pre-edit original; no stray .bak on no-op
//  - assertSafePurgeTarget: IJFW-specific markers required; Windows-style paths
//    are not refused as "shallow"
//  - stripMarkerFile: write failure reported honestly, not conflated with no-op
//  - main(): non-TTY stdin without --yes aborts (fail-closed confirmation)
//
// Style (a): import the exported functions and drive them against a scratch
// sandbox. The non-TTY test spawns the real script with piped stdio.
//
// Run: node --test installer/test/uninstall-fixes.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync, chmodSync, statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  removeTomlSection,
  removeJsonMcpEntry,
  removeYamlMcpEntry,
  removeCodexHookFiles,
  assertSafePurgeTarget,
  stripMarkerFile,
  cleanPlatforms,
} from '../src/uninstall.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const UNINSTALL_JS = join(REPO_ROOT, 'installer', 'src', 'uninstall.js');

let sandbox;
before(() => { sandbox = mkdtempSync(join(tmpdir(), 'unfix-')); });
after(() => { try { rmSync(sandbox, { recursive: true, force: true }); } catch {} });

function write(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function baks(p) {
  const dir = dirname(p);
  const base = p.split('/').pop();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith(base + '.bak.')).map((n) => join(dir, n));
}

// ---------------------------------------------------------------------------
// confirmed[16]: removeTomlSection no-op detection + idempotency
// ---------------------------------------------------------------------------

describe('removeTomlSection (no-op detection)', () => {
  it('returns false and leaves the file byte-identical when no IJFW section exists', () => {
    const p = join(sandbox, 'toml-noop', 'config.toml');
    const content = 'model = "x"\n\n[other_section]\nk = 1\n';
    write(p, content);
    assert.equal(removeTomlSection(p), false);
    assert.equal(readFileSync(p, 'utf8'), content);
    assert.equal(baks(p).length, 0, 'no-op must not drop a .bak file');
  });

  it('removes the section once, then is a no-op with no newline growth', () => {
    const p = join(sandbox, 'toml-once', 'config.toml');
    write(p, 'a = 1\n\n[mcp_servers.ijfw-memory]\ncommand = "node"\n\n[other]\nk = 1\n');
    assert.equal(removeTomlSection(p), true);
    const afterFirst = readFileSync(p, 'utf8');
    assert.ok(!afterFirst.includes('ijfw-memory'));
    assert.ok(afterFirst.includes('[other]'));
    assert.equal(baks(p).length, 1, 'destructive edit must back up first');
    // Second run: nothing left to remove.
    assert.equal(removeTomlSection(p), false);
    assert.equal(readFileSync(p, 'utf8'), afterFirst, 'repeat run must not mutate (no trailing-newline growth)');
    assert.equal(baks(p).length, 1, 'repeat run must not drop another .bak');
  });
});

// ---------------------------------------------------------------------------
// confirmed[17]: removeCodexHookFiles provenance sentinel + backup
// ---------------------------------------------------------------------------

describe('removeCodexHookFiles (provenance, not mention)', () => {
  it('keeps a user hook that mentions ijfw in the body; deletes IJFW-headed hooks with a backup', () => {
    const hooksDir = join(sandbox, 'codex-hooks');
    mkdirSync(hooksDir, { recursive: true });
    const userHook = join(hooksDir, 'my-own.sh');
    writeFileSync(userHook, '#!/usr/bin/env bash\n# my personal hook\nijfw status || true\ncat ~/.ijfw/state.json\n');
    const ijfwHook = join(hooksDir, 'session-start.sh');
    writeFileSync(ijfwHook, '#!/usr/bin/env bash\n# IJFW SessionStart (Codex) -- initialize state.\necho hi\n');
    const count = removeCodexHookFiles(hooksDir);
    assert.equal(count, 1);
    assert.ok(existsSync(userHook), 'user-authored hook mentioning ijfw must survive');
    assert.ok(!existsSync(ijfwHook), 'IJFW-headed hook must be removed');
    assert.equal(baks(ijfwHook).length, 1, 'deletion must be backed up');
  });
});

// ---------------------------------------------------------------------------
// confirmed[18]: writeAtomic preserves the target file mode
// ---------------------------------------------------------------------------

describe('writeAtomic mode preservation (via removeJsonMcpEntry)', () => {
  it('a 0600 config stays 0600 after rewrite', { skip: process.platform === 'win32' }, () => {
    const p = join(sandbox, 'mode600', 'settings.json');
    write(p, JSON.stringify({ mcpServers: { 'ijfw-memory': { command: 'node' } } }, null, 2) + '\n');
    chmodSync(p, 0o600);
    assert.equal(removeJsonMcpEntry(p), true);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  it('a 0644 config stays 0644 after rewrite', { skip: process.platform === 'win32' }, () => {
    const p = join(sandbox, 'mode644', 'settings.json');
    write(p, JSON.stringify({ mcpServers: { 'ijfw-memory': { command: 'node' } } }, null, 2) + '\n');
    chmodSync(p, 0o644);
    assert.equal(removeJsonMcpEntry(p), true);
    assert.equal(statSync(p).mode & 0o777, 0o644);
  });
});

// ---------------------------------------------------------------------------
// confirmed[50]: corrupt config != nothing-to-do
// ---------------------------------------------------------------------------

describe('removeJsonMcpEntry parse-failed sentinel', () => {
  it("returns 'parse-failed' for corrupt JSON that still references ijfw-memory", () => {
    const p = join(sandbox, 'corrupt', 'settings.json');
    write(p, '{ "mcpServers": { "ijfw-memory": { "command": ');
    assert.equal(removeJsonMcpEntry(p), 'parse-failed');
    assert.ok(existsSync(p), 'corrupt file must be left untouched');
  });

  it('returns false for corrupt JSON with no ijfw reference', () => {
    const p = join(sandbox, 'corrupt2', 'settings.json');
    write(p, '{ not json at all');
    assert.equal(removeJsonMcpEntry(p), false);
  });

  it('cleanPlatforms reports the corrupt config as KEPT instead of staying silent', () => {
    const home = join(sandbox, 'home-corrupt');
    const cwd = join(sandbox, 'cwd-corrupt');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    write(join(home, '.qwen', 'settings.json'), '{ "mcpServers": { "ijfw-memory": broken');
    const removed = cleanPlatforms({ home, cwd, repoRoot: REPO_ROOT });
    assert.ok(
      removed.some((l) => l.includes('.qwen') && l.includes('KEPT')),
      `expected an honest KEPT line for ~/.qwen/settings.json, got:\n  ${removed.join('\n  ')}`
    );
    assert.ok(
      !removed.some((l) => l.includes('.qwen') && l.includes('(removed')),
      'must not claim the entry was removed'
    );
  });
});

describe('stripMarkerFile write-failure honesty', () => {
  it('reports KEPT + FAILED when the file cannot be rewritten', {
    skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0),
  }, () => {
    const dir = join(sandbox, 'ro-dir');
    const p = join(dir, 'CLAUDE.md');
    write(p, '# Mine\n\n<!-- IJFW-MEMORY-START -->\nblah\n<!-- IJFW-MEMORY-END -->\n');
    chmodSync(dir, 0o555); // backup/rewrite both need to create siblings -> fails
    try {
      const status = stripMarkerFile(p, { label: 'CLAUDE.md' });
      assert.ok(status, 'a failed strip must NOT return the nothing-to-do sentinel (null)');
      assert.ok(/KEPT/.test(status) && /FAILED/i.test(status), `expected honest failure status, got: ${status}`);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// confirmed[14]: YAML backup must be the pre-edit original
// ---------------------------------------------------------------------------

describe('removeYamlMcpEntry backup ordering', () => {
  it('the .bak is byte-identical to the ORIGINAL file (taken before any rewrite)', () => {
    const p = join(sandbox, 'yaml', 'config.yaml');
    const original = [
      '# user comment that PyYAML round-trips would destroy',
      'mcp_servers:',
      '  ijfw-memory:',
      '    command: node',
      '    args:',
      '      - /tmp/server.js',
      'other: keep',
      '',
    ].join('\n');
    write(p, original);
    assert.equal(removeYamlMcpEntry(p), true);
    const after = readFileSync(p, 'utf8');
    assert.ok(!after.includes('ijfw-memory'));
    assert.ok(after.includes('other: keep'));
    const b = baks(p);
    assert.equal(b.length, 1);
    assert.equal(readFileSync(b[0], 'utf8'), original, '.bak must be the pre-edit original, not the rewritten file');
  });

  it('leaves no stray .bak when nothing is actually removed', () => {
    const p = join(sandbox, 'yaml-noop', 'config.yaml');
    // Mentions ijfw-memory but holds no removable entry (top-level, not under
    // mcp_servers; the regex fallback does not match either).
    write(p, 'note: ijfw-memory is mentioned here only\n');
    assert.equal(removeYamlMcpEntry(p), false);
    assert.equal(baks(p).length, 0, 'no-op must not leave a speculative .bak behind');
  });
});

// ---------------------------------------------------------------------------
// confirmed[15] + confirmed[40]: purge guard
// ---------------------------------------------------------------------------

describe('assertSafePurgeTarget', () => {
  it('refuses a generic agent project dir that has memory/ + a non-IJFW state.json', () => {
    const dir = join(sandbox, 'my-agent-project');
    mkdirSync(join(dir, 'memory'), { recursive: true });
    mkdirSync(join(dir, 'mcp-server'), { recursive: true });
    write(join(dir, 'state.json'), JSON.stringify({ counter: 3 }));
    assert.throws(() => assertSafePurgeTarget(dir), /does not look like an IJFW install/);
  });

  it('accepts a dir named .ijfw', () => {
    const dir = join(sandbox, 'deep', '.ijfw');
    mkdirSync(dir, { recursive: true });
    assert.doesNotThrow(() => assertSafePurgeTarget(dir));
  });

  it('accepts a custom dir carrying the install ledger', () => {
    const dir = join(sandbox, 'custom-home');
    mkdirSync(dir, { recursive: true });
    write(join(dir, 'install-ledger.json'), JSON.stringify({ version: 1, createdDirs: [] }));
    assert.doesNotThrow(() => assertSafePurgeTarget(dir));
  });

  it('accepts a custom dir whose state.json carries the installer schema keys', () => {
    const dir = join(sandbox, 'custom-home2');
    mkdirSync(dir, { recursive: true });
    write(join(dir, 'state.json'), JSON.stringify({ schema_version: 1, install_method: 'npm', installed_version: '1.6.1' }));
    assert.doesNotThrow(() => assertSafePurgeTarget(dir));
  });

  it('refuses a Windows drive root', () => {
    assert.throws(() => assertSafePurgeTarget('C:\\'), /home or filesystem root/);
    assert.throws(() => assertSafePurgeTarget('C:/'), /home or filesystem root/);
  });

  it('does not refuse a deep Windows-style path as "shallow"', () => {
    // On POSIX this still throws the looks-like-IJFW error (the dir does not
    // exist here), but it must NOT be the shallow-path refusal that killed
    // every Windows uninstall when split('/') saw one segment.
    try {
      assertSafePurgeTarget('C:\\Users\\someone\\.ijfw');
      // On an actual Windows runner with that dir present this may pass; fine.
    } catch (err) {
      assert.ok(!/shallow/.test(err.message), `Windows path wrongly judged shallow: ${err.message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// confirmed[19]: non-TTY confirmation fails closed
// ---------------------------------------------------------------------------

describe('non-TTY confirmation gate', () => {
  it('aborts with exit 1 when stdin is not a TTY and --yes is absent', () => {
    const home = join(sandbox, 'home-notty');
    mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, [UNINSTALL_JS], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      input: '',
      encoding: 'utf8',
    });
    assert.equal(r.status, 1, `expected abort, got status ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(/--yes/.test(r.stderr), `stderr must point at --yes: ${r.stderr}`);
  });

  it('proceeds when --yes is passed (no prompt needed)', () => {
    const home = join(sandbox, 'home-yes');
    mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, [UNINSTALL_JS, '--yes'], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      input: '',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `expected success, got status ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
});
