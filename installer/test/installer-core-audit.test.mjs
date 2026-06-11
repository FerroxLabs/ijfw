// Regression tests for the installer-core audit fixes:
//   - INSTALL_PLAN covers every CANONICAL_ORDER target (dry-run disclosure)
//   - writeLedger merges the prior ledger (purge keeps tracking created dirs)
//   - mergeJson backup gate fires without a caller-supplied ts, and corrupt
//     existing configs are preserved as .corrupt-<ts>.bak before replacement
//   - looksLikeIjfwInstall marker check + cloneOrPull refusal on non-IJFW dirs
//   - parseArgs rejects flag-shaped / missing values for --dir and --branch
//
// Run: node --test test/installer-core-audit.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { CANONICAL_ORDER } from '../src/install-flow.js';
import { INSTALL_PLAN, renderPlan, writeLedger, readLedger } from '../src/install-ledger.js';
import { mergeJson } from '../src/install-helpers.js';
import { looksLikeIjfwInstall } from '../src/install.js';

const __filename = fileURLToPath(import.meta.url);
const INSTALL_JS = resolve(dirname(__filename), '..', 'src', 'install.js');

function mkscratch(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// ---------------------------------------------------------------------------
// --dry-run plan coverage
// ---------------------------------------------------------------------------

describe('INSTALL_PLAN dry-run coverage', () => {
  it('has an entry for every CANONICAL_ORDER target', () => {
    for (const t of CANONICAL_ORDER) {
      assert.ok(
        Array.isArray(INSTALL_PLAN[t]) && INSTALL_PLAN[t].length > 0,
        `INSTALL_PLAN is missing an entry for target "${t}" -- --dry-run would silently omit its writes`,
      );
    }
  });

  it('renderPlan prints every canonical target', () => {
    const out = renderPlan(CANONICAL_ORDER);
    for (const t of CANONICAL_ORDER) {
      assert.ok(out.includes(`  ${t}:`), `renderPlan output is missing target "${t}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// writeLedger merge semantics
// ---------------------------------------------------------------------------

describe('writeLedger', () => {
  it('keeps dirs created by a prior install when a re-run sees them as pre-existing', () => {
    const home = mkscratch('ijfw-ledger-home-');
    const ijfwHome = join(home, '.ijfw');
    mkdirSync(ijfwHome, { recursive: true });
    // Run 1 created ~/.codex; it still exists.
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(ijfwHome, 'install-ledger.json'), JSON.stringify({ version: 1, createdDirs: ['.codex'] }));

    // Run 2: the snapshot sees .codex as pre-existing.
    const ledger = writeLedger({ home, ijfwHome, preExisting: ['.codex'] });
    assert.ok(ledger.createdDirs.includes('.codex'), 'upgrade clobbered createdDirs -- purge would leak ~/.codex');

    const onDisk = readLedger(ijfwHome);
    assert.ok(onDisk.createdDirs.includes('.codex'));
  });

  it('drops prior entries whose dirs no longer exist and unknown/hostile entries', () => {
    const home = mkscratch('ijfw-ledger-home2-');
    const ijfwHome = join(home, '.ijfw');
    mkdirSync(ijfwHome, { recursive: true });
    writeFileSync(
      join(ijfwHome, 'install-ledger.json'),
      JSON.stringify({ version: 1, createdDirs: ['.codex', '../outside', 'Documents'] }),
    );
    const ledger = writeLedger({ home, ijfwHome, preExisting: [] });
    assert.deepEqual(ledger.createdDirs, [], 'stale/unknown ledger entries must not survive the merge');
  });

  it('still records dirs newly created by this run', () => {
    const home = mkscratch('ijfw-ledger-home3-');
    const ijfwHome = join(home, '.ijfw');
    mkdirSync(ijfwHome, { recursive: true });
    mkdirSync(join(home, '.qwen'), { recursive: true });
    const ledger = writeLedger({ home, ijfwHome, preExisting: [] });
    assert.ok(ledger.createdDirs.includes('.qwen'));
  });
});

// ---------------------------------------------------------------------------
// mergeJson backup gate + corrupt-config preservation
// ---------------------------------------------------------------------------

describe('mergeJson', () => {
  it('backs up an existing valid config even when no ts is passed (V155-009 gate fires)', () => {
    const dir = mkscratch('ijfw-mergejson-');
    const dst = join(dir, 'mcp.json');
    writeFileSync(dst, JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2));

    mergeJson(dst, '/tmp/server.js'); // production-shaped call: no ts

    const baks = readdirSync(dir).filter((f) => /\.bak\./.test(f));
    assert.equal(baks.length, 1, 'expected a .bak.<ts> backup of the pre-merge config');
    const doc = JSON.parse(readFileSync(dst, 'utf8'));
    assert.ok(doc.mcpServers['ijfw-memory'], 'ijfw-memory entry missing after merge');
    assert.ok(doc.mcpServers.other, 'existing entries must survive the merge');
  });

  it('preserves a corrupt existing config as .corrupt-<ts>.bak before replacing it', () => {
    const dir = mkscratch('ijfw-mergejson-corrupt-');
    const dst = join(dir, 'mcp.json');
    const corrupt = '{ "mcpServers": { "other": { "command": "x" }, } }'; // trailing comma
    writeFileSync(dst, corrupt);

    mergeJson(dst, '/tmp/server.js');

    const corruptBaks = readdirSync(dir).filter((f) => /\.corrupt-.*\.bak$/.test(f));
    assert.equal(corruptBaks.length, 1, 'expected a .corrupt-<ts>.bak copy of the unparseable config');
    assert.equal(readFileSync(join(dir, corruptBaks[0]), 'utf8'), corrupt, 'corrupt backup must hold the original bytes');
    const doc = JSON.parse(readFileSync(dst, 'utf8'));
    assert.ok(doc.mcpServers['ijfw-memory']);
  });
});

// ---------------------------------------------------------------------------
// looksLikeIjfwInstall + cloneOrPull refusal
// ---------------------------------------------------------------------------

describe('looksLikeIjfwInstall', () => {
  it('accepts canonical/marker shapes and rejects arbitrary dirs', () => {
    const base = mkscratch('ijfw-marker-');

    const canonical = join(base, '.ijfw');
    mkdirSync(canonical);
    assert.equal(looksLikeIjfwInstall(canonical), true);

    const ledgered = join(base, 'custom');
    mkdirSync(ledgered);
    writeFileSync(join(ledgered, 'install-ledger.json'), '{}');
    assert.equal(looksLikeIjfwInstall(ledgered), true);

    const checkout = join(base, 'checkout');
    mkdirSync(join(checkout, 'mcp-server', 'src'), { recursive: true });
    writeFileSync(join(checkout, 'mcp-server', 'src', 'server.js'), '');
    mkdirSync(join(checkout, 'claude'), { recursive: true });
    assert.equal(looksLikeIjfwInstall(checkout), true);

    const arbitrary = join(base, 'documents');
    mkdirSync(arbitrary);
    writeFileSync(join(arbitrary, 'thesis.docx'), 'important');
    assert.equal(looksLikeIjfwInstall(arbitrary), false);

    // Generic agent-project names alone are NOT markers.
    const agentProj = join(base, 'agent-proj');
    mkdirSync(join(agentProj, 'memory'), { recursive: true });
    writeFileSync(join(agentProj, 'state.json'), '{}');
    assert.equal(looksLikeIjfwInstall(agentProj), false);
  });
});

describe('install.js CLI guards (spawned)', () => {
  const spawnInstaller = (args, env = {}) => spawnSync(process.execPath, [INSTALL_JS, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });

  it('refuses to rename/re-clone a non-empty non-IJFW --dir target', () => {
    const fakeHome = mkscratch('ijfw-fakehome-');
    const victim = mkscratch('ijfw-victim-');
    writeFileSync(join(victim, 'precious.txt'), 'do not lose me');

    const r = spawnInstaller(['--dir', victim, '--branch', 'main', '--no-marketplace'], {
      HOME: fakeHome, USERPROFILE: fakeHome,
    });
    assert.equal(r.status, 1, `expected refusal exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /Refusing to replace/);
    assert.ok(existsSync(join(victim, 'precious.txt')), 'victim dir was modified');
  });

  it('rejects --dir with a flag-shaped value', () => {
    const r = spawnInstaller(['--dir', '--yes']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--dir requires a path/);
  });

  it('rejects a trailing --branch with no value', () => {
    const r = spawnInstaller(['--branch']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--branch requires a name/);
  });
});
