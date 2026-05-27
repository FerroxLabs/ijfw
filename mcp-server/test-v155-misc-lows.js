// Regression tests for v1.5.5 fix wave — agent G4b scope, misc LOW cluster.
// Covers:
//   V155-058 — extension-registry.js comment accuracy (misleading
//              "v1.4.1 back-compat tests" framing → corrected).
//   V155-060 — install-flow.js PATH composition scopes /opt/homebrew/bin
//              to macOS only.
//   V155-061 — extension-installer.js exports dirsAreByteIdentical helper
//              and the install flow surfaces `unchanged:true` short-circuit.
//   V155-063 — codex-agents.js syncCodexAgents GCs orphan .toml files
//              when a role is removed from the charter.
//
// Run: node --test test-v155-misc-lows.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const READ = (p) => readFileSync(join(__dirname, p), 'utf8');

import { syncCodexAgents } from './src/codex-agents.js';

describe('V155-058: extension-registry.js comment accurately describes live code', () => {
  it('removes the legacy banner that called the cache helpers v1.4.1 back-compat scaffolding', () => {
    const src = READ('src/extension-registry.js');
    // The original misleading banner was literally:
    //   "Legacy single-source cache helpers (kept for v1.4.1 back-compat tests)."
    // V155-058 fixed it. The phrase "v1.4.1 back-compat tests" may still appear
    // inside the new forensic comment that quotes the prior wording — what we
    // forbid is the EXACT banner string, which would only appear as the live
    // (non-quoted) section header.
    assert.equal(
      /Legacy single-source cache helpers \(kept for v1\.4\.1 back-compat tests\)/.test(src),
      false,
      'expected the misleading legacy banner to be removed',
    );
    // The replacement comment should name the actual production caller.
    assert.ok(
      /refreshTrustFromRegistry/.test(src),
      'expected replacement comment to name refreshTrustFromRegistry',
    );
  });
});

describe('V155-060: install-flow.js PATH composition scopes homebrew to darwin', () => {
  it('source explicitly gates /opt/homebrew/bin to process.platform === "darwin"', () => {
    const src = readFileSync(
      join(__dirname, '..', 'installer', 'src', 'install-flow.js'),
      'utf8',
    );
    // The Linux (non-darwin POSIX) branch must NOT include /opt/homebrew/bin.
    // Look for the new else branch after the darwin block.
    assert.ok(
      /process\.platform === 'darwin'/.test(src),
      'expected darwin branch in PATH composition',
    );
    // Match the Linux fallback line (no homebrew).
    const linuxFallback = src.match(/} else \{\s*\n\s*commonPaths = \[nodeDir,\s*'\/usr\/local\/bin'/);
    assert.ok(
      linuxFallback,
      'expected Linux fallback branch without /opt/homebrew/bin',
    );
  });
});

describe('V155-061: extension-installer byte-identical re-install is a no-op', () => {
  it('exports a dirsAreByteIdentical helper and surfaces unchanged:true', () => {
    const src = READ('src/extension-installer.js');
    assert.ok(
      /async function dirsAreByteIdentical/.test(src),
      'expected dirsAreByteIdentical helper to be defined',
    );
    assert.ok(
      /unchanged:\s*true/.test(src),
      'expected unchanged:true return in install flow',
    );
    assert.ok(
      /byte-identical/i.test(src),
      'expected explanatory comment naming byte-identical',
    );
  });
});

describe('V155-063: syncCodexAgents GCs orphan .toml files', () => {
  it('removes a stale role-toml that is no longer in the charter', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-063-'));
    try {
      // Seed an existing stale TOML inside the canonical .codex/agents dir.
      const agentsDir = join(tmp, '.codex', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      const stale = join(agentsDir, 'old-role.toml');
      writeFileSync(stale, '[agent]\nname="old"\n');

      // Provide a minimal bundle with a single role; the stale toml is NOT in it.
      const bundle = {
        charter: {
          team_name: 'test-team',
          roles: [
            { name: 'new-role', role_type: 'builder', responsibilities: ['x'] },
          ],
        },
      };
      const r = syncCodexAgents(tmp, { bundle });
      assert.equal(r.ok, true, `syncCodexAgents failed: ${JSON.stringify(r)}`);
      assert.ok(Array.isArray(r.removed),
        `expected r.removed array, got: ${JSON.stringify(r)}`);
      assert.ok(
        r.removed.some((p) => p.endsWith('old-role.toml')),
        `expected old-role.toml in removed list: ${JSON.stringify(r.removed)}`,
      );
      assert.equal(existsSync(stale), false,
        'expected stale TOML to be unlinked');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT remove a TOML that matches a current role', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'v155-063-keep-'));
    try {
      const bundle = {
        charter: {
          team_name: 'test-team',
          roles: [
            { name: 'kept-role', role_type: 'builder', responsibilities: ['x'] },
          ],
        },
      };
      const r1 = syncCodexAgents(tmp, { bundle });
      assert.equal(r1.ok, true);
      assert.equal(r1.removed, undefined,
        'expected no removed array on fresh sync');

      // Second sync with the same charter should leave the kept role alone.
      const r2 = syncCodexAgents(tmp, { bundle });
      assert.equal(r2.ok, true);
      assert.equal(r2.removed, undefined);
      // And the kept TOML should still exist.
      const kept = r1.agentFiles[0];
      assert.equal(existsSync(kept), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
