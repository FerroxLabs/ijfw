// Installer cwd-parity guard tests.
//
// Mirrors the SessionStart hook P0 fix on the installer side: project-scoped
// (cwd-relative) writes -- ./.cursor/, ./.windsurfrules, ./.vscode/mcp.json,
// ./.github/copilot-instructions.md -- must NOT be authored when `ijfw install`
// runs from $HOME (or '/'), or they become a global config bleed.
//
// Two layers:
//   (a) unit test isProjectWritable(cwd, home) directly -- the load-bearing
//       decision, including symlinked-home equivalence.
//   (b) one integration check per project-scoped installer (Cursor, Copilot,
//       Windsurf) driving the real install fn with ctx.cwd === home and
//       asserting the project files are NOT created; and with a real project
//       dir asserting they ARE.
//
// Run: node --test test/project-write-guard.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { isProjectWritable } from '../src/install-helpers.js';
import { installCursor, installWindsurf } from '../src/install-targets-1-7.js';
import { installCopilot } from '../src/install-targets-8-14.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

function mkscratch(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// ---------------------------------------------------------------------------
// (a) isProjectWritable — pure decision
// ---------------------------------------------------------------------------

describe('isProjectWritable (guard decision)', () => {
  it('refuses when cwd === home (the bleed vector)', () => {
    const home = mkscratch('ijfw-guard-home-');
    try {
      assert.equal(isProjectWritable(home, home), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('allows a real project dir distinct from home', () => {
    const home = mkscratch('ijfw-guard-home-');
    const proj = mkscratch('ijfw-guard-proj-');
    try {
      assert.equal(isProjectWritable(proj, home), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('refuses the filesystem root', () => {
    const home = mkscratch('ijfw-guard-home-');
    try {
      assert.equal(isProjectWritable('/', home), false);
      assert.equal(isProjectWritable(sep, home), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses empty / non-string cwd (fail closed)', () => {
    const home = mkscratch('ijfw-guard-home-');
    try {
      assert.equal(isProjectWritable('', home), false);
      assert.equal(isProjectWritable(undefined, home), false);
      assert.equal(isProjectWritable(null, home), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('treats a symlinked cwd that resolves to home as home (refuses)', () => {
    const home = mkscratch('ijfw-guard-home-');
    const link = join(dirname(home), `ijfw-guard-link-${Date.now()}`);
    try {
      symlinkSync(home, link, 'dir');
      // The symlink path string differs from home, but realpath resolves to it.
      assert.notEqual(link, home);
      assert.equal(isProjectWritable(link, home), false);
    } finally {
      try { rmSync(link, { recursive: true, force: true }); } catch { /* best-effort */ }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still allows a symlinked project dir that does NOT resolve to home', () => {
    const home = mkscratch('ijfw-guard-home-');
    const proj = mkscratch('ijfw-guard-proj-');
    const link = join(dirname(proj), `ijfw-guard-plink-${Date.now()}`);
    try {
      symlinkSync(proj, link, 'dir');
      assert.equal(isProjectWritable(link, home), true);
    } finally {
      try { rmSync(link, { recursive: true, force: true }); } catch { /* best-effort */ }
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) integration: real installer fns honor the guard
// ---------------------------------------------------------------------------

function makeCtx({ home, cwd }) {
  return {
    home,
    homeReal: home,
    cwd,
    ijfwCustomDir: false,
    isIjfwSource: false,
    repoRoot: REPO_ROOT,
    serverJs: join(REPO_ROOT, 'mcp-server', 'src', 'server.js'),
    serverJsNative: join(REPO_ROOT, 'mcp-server', 'src', 'server.js'),
    nodeBin: process.execPath,
    ts: '20260609-000000',
    log: { ok() {}, note() {}, info() {}, warn() {} },
  };
}

describe('project-scoped installers honor the cwd guard', () => {
  it('Cursor: cwd === home => NO ./.cursor written; real project => written', async () => {
    const home = mkscratch('ijfw-cur-home-');
    const proj = mkscratch('ijfw-cur-proj-');
    try {
      // cwd === home: refuse.
      const r1 = await installCursor(makeCtx({ home, cwd: home }));
      assert.equal(r1.status, 'noop');
      assert.ok(!existsSync(join(home, '.cursor', 'mcp.json')), 'no ~/.cursor/mcp.json bleed');
      assert.ok(!existsSync(join(home, '.cursor')), 'no ~/.cursor dir created at all');

      // real project: write.
      const r2 = await installCursor(makeCtx({ home, cwd: proj }));
      assert.equal(r2.status, 'ok');
      assert.ok(existsSync(join(proj, '.cursor', 'mcp.json')), 'project .cursor/mcp.json written');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('Copilot: cwd === home => NO ./.vscode or ./.github written; real project => written', async () => {
    const home = mkscratch('ijfw-cop-home-');
    const proj = mkscratch('ijfw-cop-proj-');
    try {
      const r1 = await installCopilot(makeCtx({ home, cwd: home }));
      assert.equal(r1.status, 'noop');
      assert.ok(!existsSync(join(home, '.vscode', 'mcp.json')), 'no ~/.vscode/mcp.json bleed');
      assert.ok(!existsSync(join(home, '.github', 'copilot-instructions.md')), 'no ~/.github bleed');

      const r2 = await installCopilot(makeCtx({ home, cwd: proj }));
      assert.equal(r2.status, 'ok');
      assert.ok(existsSync(join(proj, '.vscode', 'mcp.json')), 'project .vscode/mcp.json written');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('Windsurf: cwd === home => home MCP still written but NO ./.windsurfrules bleed', async () => {
    const home = mkscratch('ijfw-wind-home-');
    const proj = mkscratch('ijfw-wind-proj-');
    try {
      const r1 = await installWindsurf(makeCtx({ home, cwd: home }));
      assert.equal(r1.status, 'ok'); // home-scoped MCP merge still happens
      // Home-scoped MCP config IS expected (it's a global config, correct).
      assert.ok(
        existsSync(join(home, '.codeium', 'windsurf', 'mcp_config.json')),
        'home-scoped windsurf MCP config written (correct)',
      );
      // Project-scoped rules must NOT land at the home root.
      assert.ok(!existsSync(join(home, '.windsurfrules')), 'no ~/.windsurfrules bleed');

      const r2 = await installWindsurf(makeCtx({ home, cwd: proj }));
      assert.equal(r2.status, 'ok');
      assert.ok(existsSync(join(proj, '.windsurfrules')), 'project .windsurfrules written');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
});
