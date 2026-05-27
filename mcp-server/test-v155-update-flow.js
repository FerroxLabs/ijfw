// test-v155-update-flow.js — V155-001 (BLOCKER) + Trident v1.5.5 follow-ups.
//
// Proves the fix for `verifyInstallSucceeded` actually refuses to advance
// state.json when the on-disk @ijfw/install version does not match the
// expected version. The original bug: `ijfw update` trusted `npm install`
// exit-0 as proof of upgrade, so a no-op install or registry blip would
// silently bump state.json to a version that did not exist on disk; every
// subsequent `--check` then said "we're up to date" and refused to retry.
//
// v1.5.5 Trident follow-ups baked into this file:
//   * TR-002 — npm-global probe is now method-strict. A stale local git
//     clone at the expected version must NOT mask a missing npm-global
//     install. The previous "fallback finds repoRoot" test actively codified
//     the bug; it is replaced below with two tests that prove the new shape.
//   * TR-006 — expectedVersion must be type-validated at function entry so
//     a stray trailing newline (or null) surfaces as a clean refusal rather
//     than the operator-hostile "v1.5.5 vs v1.5.5\n" mismatch.
//   * TS-001 — the Windows `installSh` invocation is wrapped in quotes for
//     cmd.exe so paths containing whitespace/`&`/`(`/`)`/`%` cannot
//     tokenize. The smoke test below asserts the source contains the quoted
//     form (full spawn observation requires Windows; the static check
//     defends the regression on all platforms).
//
// The fix lives in mcp-server/src/cross-orchestrator-cli.js
// (verifyInstallSucceeded + the Windows `installSh` invocation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyInstallSucceeded } from './src/cross-orchestrator-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeRepo(version) {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-v155-001-'));
  if (version != null) {
    const installer = join(root, 'installer');
    mkdirSync(installer, { recursive: true });
    writeFileSync(
      join(installer, 'package.json'),
      JSON.stringify({ name: '@ijfw/install', version }, null, 2),
      { mode: 0o600 },
    );
  }
  return root;
}

function rmAll(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

test('V155-001 mismatch refuses (git-clone, 1.0.0 vs 1.5.5)', () => {
  const root = makeRepo('1.0.0');
  try {
    const res = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, false, 'mismatch must refuse');
    assert.equal(res.actualVersion, null);
    assert.match(res.reason, /1\.5\.5/, 'reason must mention expected version');
    assert.match(res.reason, /v1\.0\.0|1\.0\.0/, 'reason must mention actual version');
  } finally { rmAll(root); }
});

test('V155-001 match accepts (git-clone, 1.5.5)', () => {
  const root = makeRepo('1.5.5');
  try {
    const res = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, true, 'matching version must accept');
    assert.equal(res.actualVersion, '1.5.5');
    assert.ok(res.source && res.source.endsWith('package.json'));
  } finally { rmAll(root); }
});

test('V155-001 unreadable refuses (no package.json)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ijfw-v155-001-empty-'));
  try {
    const res = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, false, 'missing package.json must refuse');
    assert.equal(res.actualVersion, null);
    // "unreadable" surfaces in seen-candidates listing; empty-candidates
    // is the alternate framing if the method path produces no candidates.
    assert.match(
      res.reason,
      /unreadable|no candidates|no package\.json/i,
      'reason must explain unreadable / no candidates',
    );
  } finally { rmAll(root); }
});

// TR-002 — manual mode legitimately falls back to repoRoot/installer when
// the npm-global probe doesn't find @ijfw/install. This is the only place
// the multi-candidate fallback is still allowed.
test('V155-001 manual: falls back to repoRoot/installer/package.json', () => {
  const root = makeRepo('1.5.5');
  try {
    const res = verifyInstallSucceeded({
      method: 'manual',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, true, 'manual fallback must find repoRoot/installer/package.json');
    assert.equal(res.actualVersion, '1.5.5');
  } finally { rmAll(root); }
});

// TR-002 — npm-global mode MUST NOT fall back to a sibling repo tree.
// Even though the local clone is at the expected version, the npm-global
// package.json is the only valid source of truth for this install method.
// Previously this returned ok:true and silently advanced state.json — a
// "npm-global install succeeded" lie. The fix surfaces the missing
// npm-global package.json as a real failure.
test('TR-002 npm-global: must NOT fall back to stale repoRoot clone', () => {
  const root = makeRepo('1.5.5');
  // Point npm root -g at a directory that does NOT contain @ijfw/install
  // so the only on-disk evidence of v1.5.5 is the repoRoot tree. With the
  // pre-fix behavior, this returned ok:true via the unconditional repoRoot
  // fallback. The fix drops that fallback for method:'npm-global'.
  const fakeGlobalRoot = mkdtempSync(join(tmpdir(), 'ijfw-tr002-npmroot-'));
  const prevPrefix = process.env.npm_config_prefix;
  // `npm root -g` honors npm_config_prefix (-> <prefix>/lib/node_modules on
  // POSIX, <prefix>/node_modules on Windows). Either layout yields a path
  // that does not contain @ijfw/install/package.json, which is the
  // condition we want to test.
  process.env.npm_config_prefix = fakeGlobalRoot;
  try {
    const res = verifyInstallSucceeded({
      method: 'npm-global',
      repoRoot: root,
      expectedVersion: '1.5.5',
    });
    assert.equal(res.ok, false, 'npm-global must NOT mask via repoRoot fallback');
    assert.equal(res.actualVersion, null);
    // The reason must point at the npm-global probe, not at the repo tree.
    assert.doesNotMatch(
      res.reason,
      /repoRoot|installer\/package\.json/i,
      'reason must NOT cite the repoRoot fallback (we want npm-global to fail visibly)',
    );
  } finally {
    if (prevPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = prevPrefix;
    rmAll(root);
    rmAll(fakeGlobalRoot);
  }
});

// TR-006 — expectedVersion validation at function entry. Without this, a
// trailing-newline expectedVersion ("v1.5.5\n") would survive into the
// strict-eq comparison and produce a hostile mismatch message even when
// the on-disk version is correct. Validate + refuse early.
test('TR-006 expectedVersion: trailing newline / invalid input refuses cleanly', () => {
  const root = makeRepo('1.5.5');
  try {
    // Trailing newline should normalize via trim and then succeed.
    const trimmed = verifyInstallSucceeded({
      method: 'git-clone',
      repoRoot: root,
      expectedVersion: '1.5.5\n',
    });
    assert.equal(trimmed.ok, true, 'trailing newline must be trimmed, not masked');

    // Garbage version string must refuse with a precise reason.
    for (const bad of ['', 'not-a-semver', null, undefined, '1.5']) {
      const res = verifyInstallSucceeded({
        method: 'git-clone',
        repoRoot: root,
        expectedVersion: bad,
      });
      assert.equal(res.ok, false, `bad expectedVersion ${JSON.stringify(bad)} must refuse`);
      assert.equal(res.actualVersion, null);
      assert.match(
        res.reason,
        /expectedVersion not a valid semver|not a valid semver string/i,
        `reason must cite the validation refusal for ${JSON.stringify(bad)}`,
      );
    }
  } finally { rmAll(root); }
});

// TS-001 — static guard: ensure the Windows `installSh` spawn is wrapped
// in cmd-quotes. We can't reliably exercise the spawn observation on a
// non-Windows host, so the regression guard is a source-level assertion:
// the file must invoke spawnSync with `\`"${installSh}"\`` on the Windows
// branch. The pre-fix shape `spawnSync(installSh, [], { ... shell: true })`
// MUST be gone.
test('TS-001 Windows installSh invocation is cmd-quoted', () => {
  const src = readFileSync(
    join(__dirname, 'src', 'cross-orchestrator-cli.js'),
    'utf8',
  );
  // The quoted form must be present.
  assert.match(
    src,
    /spawnSync\(`"\$\{installSh\}"`,\s*\[\],\s*\{\s*stdio:\s*'inherit',\s*shell:\s*true\s*\}\)/,
    'Windows branch must wrap installSh in cmd-quotes',
  );
  // The unquoted shape must NOT be present.
  assert.doesNotMatch(
    src,
    /spawnSync\(installSh,\s*\[\],\s*\{\s*stdio:\s*'inherit',\s*shell:\s*true\s*\}\)/,
    'unquoted Windows installSh invocation must be removed',
  );
});
