// test-upgrade-smoke-hermetic.js — TR-001 regression test.
//
// Proves the upgrade-smoke preflight gate's hermetic invariant holds:
//   (1) install.js honors IJFW_SKIP_NETWORK=1 — refuses to call git
//       clone/fetch and either returns a no-network-path or throws clearly.
//   (2) latestTagFromGithub returns null under IJFW_SKIP_NETWORK without
//       calling the network.
//   (3) cloneOrPull throws fail-fast when IJFW_SKIP_NETWORK is set AND the
//       target directory is missing — the silent-no-op shape the gate was
//       trying to retire is gone.
//
// Pre-fix shape: install.js ignored IJFW_SKIP_NETWORK entirely; the gate
// either failed offline (cloneOrPull tried `git clone`) or silently passed
// without writing settings.json on hosted CI.
//
// The fix lives in installer/src/install.js (`skipNetwork()` +
// `latestTagFromGithub` early-return + `cloneOrPull` skip-or-throw).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const installerRoot = resolve(__dirname, '..');
const installJsPath = join(installerRoot, 'src', 'install.js');

// We exercise the network-gating contract by spawning a tiny Node script
// that imports install.js's internals via dynamic-import-then-grep. The
// guards live in unexported functions, so we drive them through the
// publicly-exported `resolveBranchOrTag` (which calls latestTagFromGithub
// internally) and via a source-level static check on cloneOrPull.
test('TR-001 latestTagFromGithub returns null when IJFW_SKIP_NETWORK=1', () => {
  // resolveBranchOrTag is exported; with branchExplicit:false and no
  // _tagLookup override, it calls the real latestTagFromGithub. Under
  // IJFW_SKIP_NETWORK=1, that helper must short-circuit to null without
  // ever spawning git ls-remote. Verify by setting the env var on a child
  // process and asserting the helper returned the branch fallback.
  const probe = spawnSync(process.execPath, ['-e', `
    process.env.IJFW_SKIP_NETWORK = '1';
    import('${installJsPath.replace(/\\/g, '\\\\')}').then(m => {
      const t0 = Date.now();
      const ref = m.resolveBranchOrTag({ branch: 'main', branchExplicit: false, _logger: () => {} });
      const dt = Date.now() - t0;
      // Must return the branch fallback (latestTagFromGithub returned null)
      // and must do so quickly — if the network call ran, the spawn alone
      // takes 50ms+ even on cache hits.
      if (ref !== 'main') {
        console.error('REF_MISMATCH:' + ref);
        process.exit(1);
      }
      if (dt > 200) {
        console.error('TOO_SLOW:' + dt + 'ms — looks like network was called despite IJFW_SKIP_NETWORK');
        process.exit(2);
      }
      console.log('OK:' + ref + ':' + dt + 'ms');
    });
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(probe.status, 0, `child failed: ${probe.stdout} ${probe.stderr}`);
  assert.match(probe.stdout, /^OK:main:/, 'must return branch fallback fast');
});

test('TR-001 cloneOrPull fail-fast: IJFW_SKIP_NETWORK + missing dir throws', () => {
  // We can't call cloneOrPull directly (not exported), but we can prove
  // the static guard exists in the source — a grep-level regression test
  // that breaks if a future refactor drops the skipNetwork() check.
  const src = readFileSync(installJsPath, 'utf8');
  assert.match(
    src,
    /function\s+skipNetwork\s*\(\s*\)\s*\{\s*return\s+process\.env\.IJFW_SKIP_NETWORK\s*===\s*'1'/,
    'skipNetwork() helper must read IJFW_SKIP_NETWORK',
  );
  assert.match(
    src,
    /if\s*\(\s*skipNetwork\(\)\s*\)\s*return\s+null\s*;[\s\S]{0,80}?ls-remote/,
    'latestTagFromGithub must short-circuit on skipNetwork() BEFORE the ls-remote spawn',
  );
  assert.match(
    src,
    /if\s*\(\s*skipNetwork\(\)\s*\)\s*\{[\s\S]{0,400}?IJFW_SKIP_NETWORK=1 set but cloneOrPull needs network/,
    'cloneOrPull must throw fail-fast when IJFW_SKIP_NETWORK is set AND dir is missing',
  );
  assert.match(
    src,
    /if\s*\(\s*existsSync\(dir\)\s*\)\s*\{\s*return\s+'skipped-network'/,
    'cloneOrPull must return "skipped-network" when IJFW_SKIP_NETWORK is set AND dir exists',
  );
});

test('TR-001 upgrade-smoke gate asserts settings.json post-condition', () => {
  // Static regression guard: the upgrade-smoke gate must require
  // settings.json to exist after the installer runs. Pre-TR-001 the check
  // was wrapped in `if (existsSync(settingsPath)) { ... }` which silently
  // PASSed when the file was missing — same false-pass shape the gate was
  // supposed to retire.
  const gatePath = join(installerRoot, 'src', 'preflight', 'gates', 'upgrade-smoke.js');
  const src = readFileSync(gatePath, 'utf8');
  assert.match(
    src,
    /if\s*\(\s*!existsSync\(settingsPath\)\s*\)\s*\{[\s\S]{0,600}?installer did not write/,
    'gate must FAIL when settings.json is missing (not silently pass)',
  );
  // Make sure the old "if (existsSync(settingsPath)) { JSON.parse..." shape
  // (where the assertion only fires when the file IS present) is no longer
  // structurally present. The new shape is the negated guard above plus
  // an unconditional JSON.parse afterward.
  const oldShape = /if\s*\(\s*existsSync\(settingsPath\)\s*\)\s*\{\s*let\s+settings;[\s\S]{0,200}?JSON\.parse\(readFileSync\(settingsPath/;
  assert.doesNotMatch(
    src,
    oldShape,
    'old "only check if file exists" pattern must be replaced with a hard assertion',
  );
});

// Sanity: latestTagFromGithub still works without IJFW_SKIP_NETWORK.
// We skip the live network path under CI to avoid flake; the static check
// above is the load-bearing assertion. This case just documents that the
// short-circuit is opt-in.
test('TR-001 IJFW_SKIP_NETWORK is opt-in (not on by default)', () => {
  // Verify the env var is NOT being silently inherited from this test
  // process. If a parent test runner leaked IJFW_SKIP_NETWORK=1, the rest
  // of these tests would pass for the wrong reason. Fail loudly.
  assert.notEqual(
    process.env.IJFW_SKIP_NETWORK,
    '1',
    'IJFW_SKIP_NETWORK leaked into the test environment — fix the harness',
  );
});
