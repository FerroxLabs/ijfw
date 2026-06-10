// Issue #17 acceptance test: install into an isolated $HOME, uninstall --purge
// --yes, then assert ZERO `ijfw` references remain (excluding intentional
// .bak.* backups). Exercises the real installer + uninstaller as subprocesses
// so the created-vs-merged ledger, hook-file removal, Hermes plugin-tree
// removal, and known_marketplaces cleanup are all covered end-to-end.
//
// Run: node --test installer/test/uninstall-grep-zero.test.mjs

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INSTALL_FLOW = join(REPO_ROOT, 'installer', 'src', 'install-flow.js');
const UNINSTALL_JS = join(REPO_ROOT, 'installer', 'src', 'uninstall.js');

// Recursively collect files whose contents OR path contain a case-insensitive
// "ijfw" reference, skipping intentional .bak.* backups (the uninstaller keeps
// these on purpose) and dangling symlinks.
function grepIjfw(root) {
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      const rel = p.slice(root.length); // path RELATIVE to sandbox (root name is ignored)
      if (/\.bak\.[0-9]/.test(e.name)) continue; // intentional backup
      let st;
      try { st = statSync(p); } catch { continue; } // skip dangling symlink
      if (st.isDirectory()) { walk(p); continue; }
      if (/ijfw/i.test(rel)) { hits.push(rel + '  (path)'); continue; }
      // Read small text files only.
      if (st.size > 2_000_000) continue;
      let body = '';
      try { body = readFileSync(p, 'utf8'); } catch { continue; }
      if (/ijfw/i.test(body)) hits.push(rel + '  (content)');
    }
  };
  walk(root);
  return hits;
}

describe('issue #17: install -> uninstall --purge leaves zero ijfw references', () => {
  let sandbox;

  before(() => {
    // NB: temp dir name must NOT contain "ijfw" or every path under it would
    // false-match the grep.
    sandbox = mkdtempSync(join(tmpdir(), 'gz-home-'));
  });
  after(() => {
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  });

  it('installs, then purges clean', () => {
    // Hermetic: restrict PATH to Node's own dir so the installer cannot invoke
    // real external CLIs (e.g. a locally-installed `openclaw`) whose own audit
    // logs would mention ijfw-memory as a side effect we do not own.
    const env = {
      ...process.env,
      HOME: sandbox,
      USERPROFILE: sandbox,
      PATH: dirname(process.execPath),
      IJFW_NONINTERACTIVE: '1',
      CI: '1',
    };

    // 1) Install (platform writes only -- no git clone needed; runInstall copies
    //    from the live repoRoot). Run as a subprocess with the sandbox HOME.
    const installScript =
      `import { runInstall } from ${JSON.stringify(INSTALL_FLOW)};` +
      `await runInstall({ targets: undefined, ijfwHome: ${JSON.stringify(join(sandbox, '.ijfw'))},` +
      ` ijfwCustomDir: false, repoRoot: ${JSON.stringify(REPO_ROOT)}, noninteractive: true });`;
    const ins = spawnSync(process.execPath, ['--input-type=module', '-e', installScript],
      { cwd: sandbox, env, encoding: 'utf8' });
    assert.equal(ins.status, 0, `install failed: ${ins.stderr || ins.stdout}`);

    // Sanity: the install actually wrote ijfw references.
    assert.ok(grepIjfw(sandbox).length > 0, 'install wrote no ijfw references (test is not exercising anything)');

    // 2) Uninstall --purge --yes against the same sandbox HOME.
    const un = spawnSync(process.execPath, [UNINSTALL_JS, '--purge', '--yes'],
      { cwd: sandbox, env, encoding: 'utf8' });
    assert.equal(un.status, 0, `uninstall failed: ${un.stderr || un.stdout}`);

    // 3) Zero ijfw references remain (excluding .bak.* backups).
    const remaining = grepIjfw(sandbox);
    assert.equal(remaining.length, 0,
      `uninstall left ${remaining.length} ijfw reference(s):\n  ${remaining.slice(0, 40).join('\n  ')}`);
  });
});
