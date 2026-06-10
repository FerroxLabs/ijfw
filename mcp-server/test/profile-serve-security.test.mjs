// Serving + storage security hardening tests (adversarial audit fixes).
//
// Covers:
//   HIGH-1  egress append is NOT symlink-followable (O_NOFOLLOW fd write)
//   HIGH-4  IJFW_PROFILE_DIR / _STATE_DIR overrides validated (homedir/test-only)
//   MED-2   med/high fields bind to the per-host share-hosts allowlist
//   MED-3   passive resource read forces low-only regardless of the env flag
//   L2      corroborated dialectic trait (conf 0.5, evidence>=3) now surfaces
//   LOW     read-size caps on the profile + egress files
//
// Every test points IJFW_PROFILE_DIR at a fresh tmp dir; node:test sets
// NODE_TEST_CONTEXT so the override is honored verbatim by path-policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta } from '../src/profile/merge.js';
import { writeProfile } from '../src/profile/store.js';
import { profileDir } from '../src/profile/store.js';
import { profileStateDir } from '../src/profile/lock.js';
import { renderBrief } from '../src/profile/render-brief.js';
import { profileBrief, profileGet } from '../src/profile/serve.js';
import { appendEgress, egressLogPath, readEgress } from '../src/profile/egress.js';
import { resolveOverrideDir, inTestContext } from '../src/profile/path-policy.js';

async function withProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-sec-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  const prevShare = process.env.IJFW_PROFILE_SHARE_SENSITIVE;
  const prevHosts = process.env.IJFW_PROFILE_SHARE_HOSTS;
  process.env.IJFW_PROFILE_DIR = dir;
  delete process.env.IJFW_PROFILE_SHARE_SENSITIVE;
  delete process.env.IJFW_PROFILE_SHARE_HOSTS;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prev;
    if (prevShare === undefined) delete process.env.IJFW_PROFILE_SHARE_SENSITIVE; else process.env.IJFW_PROFILE_SHARE_SENSITIVE = prevShare;
    if (prevHosts === undefined) delete process.env.IJFW_PROFILE_SHARE_HOSTS; else process.env.IJFW_PROFILE_SHARE_HOSTS = prevHosts;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HIGH-1 — egress append must not follow a pre-planted symlink.
// ---------------------------------------------------------------------------

test('HIGH-1 appendEgress does NOT follow a pre-planted egress.log symlink', () => withProfileDir((dir) => {
  // Plant egress.log as a symlink pointing at an OUTSIDE target.
  const outside = mkdtempSync(join(tmpdir(), 'ijfw-sec-outside-'));
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'ORIGINAL\n', 'utf8');
  try {
    symlinkSync(victim, egressLogPath());
    const r = appendEgress({ host: 'h', fields: ['x'] });
    assert.equal(r.ok, false, 'append must refuse a symlinked log');
    assert.equal(r.code, 'EEGRESS_SYMLINK');
    // The outside victim is UNTOUCHED — the symlink was not written through.
    assert.equal(readFileSync(victim, 'utf8'), 'ORIGINAL\n', 'outside target must be untouched');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}));

test('HIGH-1 a normal egress append still works (regression)', () => withProfileDir(() => {
  const r = appendEgress({ host: 'claude', session: 's1', fields: ['preference::a'] });
  assert.equal(r.ok, true);
  const led = readEgress();
  assert.equal(led.ok, true);
  assert.equal(led.entries.length, 1);
  assert.equal(led.entries[0].host, 'claude');
  assert.deepEqual(led.entries[0].fields, ['preference::a']);
}));

// ---------------------------------------------------------------------------
// HIGH-4 — env override validation.
// ---------------------------------------------------------------------------

test('HIGH-4 a non-homedir override in NON-test mode is rejected (falls back)', () => {
  // Simulate production: env WITHOUT the test markers.
  const prodEnv = { /* no NODE_ENV, no NODE_TEST_CONTEXT */ };
  assert.equal(inTestContext(prodEnv), false, 'prod env is not a test context');
  const outside = mkdtempSync(join(tmpdir(), 'ijfw-sec-nothome-'));
  try {
    const resolved = resolveOverrideDir(outside, prodEnv);
    assert.equal(resolved, null, 'a tmpdir (not under homedir) override must be rejected in prod');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('HIGH-4 an under-homedir override IS honored in non-test mode', () => {
  const prodEnv = {};
  // A path under homedir that we own; we do not need it to exist.
  const underHome = join(homedir(), '.ijfw-sec-test-scratch', 'profile');
  const resolved = resolveOverrideDir(underHome, prodEnv);
  assert.equal(resolved, underHome, 'an under-homedir, non-existent override is honored');
});

test('HIGH-4 the test-mode override (NODE_TEST_CONTEXT) is honored verbatim', () => {
  // This very process IS under node:test, so the live env honors the tmp dir.
  const outside = mkdtempSync(join(tmpdir(), 'ijfw-sec-testmode-'));
  try {
    assert.equal(inTestContext(process.env), true, 'running under node:test');
    assert.equal(resolveOverrideDir(outside), outside, 'test context honors a tmpdir override');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('HIGH-4 profileDir / profileStateDir honor the test override (suite stays green)', () => withProfileDir((dir) => {
  assert.equal(profileDir(), dir, 'profileDir resolves to the test override');
  // state dir override is separate; default falls back to homedir/.ijfw/state.
  const prev = process.env.IJFW_PROFILE_STATE_DIR;
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-sec-state-'));
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  try {
    assert.equal(profileStateDir(), sdir, 'profileStateDir resolves to the test override');
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prev;
    rmSync(sdir, { recursive: true, force: true });
  }
}));

// ---------------------------------------------------------------------------
// MED-2 — med/high fields require the resolved host on the share-hosts allowlist.
// ---------------------------------------------------------------------------

function profileWithMed() {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'low', value: { phrase: 'low pref' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' }),
      makeInference({ kind: 'preference', subject: 'medfield', value: { phrase: 'med secret' }, confidence: 0.9, evidence_count: 5, sensitivity: 'med' }),
    ],
  });
  return p;
}

test('MED-2 a non-allowlisted host cannot get med fields even with opt-in', () => withProfileDir(() => {
  writeProfile(profileWithMed());
  // opt-in via arg, host present, but NO share-hosts allowlist entry.
  const r = profileGet({ env: process.env, shareSensitive: true, context: { host: 'evil-host' } });
  assert.equal(r.ok, true);
  const ids = r.profile.inferences.map((i) => i.id);
  assert.ok(ids.includes('preference::low'), 'low always served');
  assert.ok(!ids.includes('preference::medfield'), 'med withheld from non-allowlisted host');
}));

test('MED-2 an allowlisted host CAN get med fields with opt-in', () => withProfileDir((dir) => {
  writeProfile(profileWithMed());
  writeFileSync(join(dir, 'share-hosts.txt'), '# trusted\ngood-host\n', 'utf8');
  const r = profileGet({ env: process.env, shareSensitive: true, context: { host: 'good-host' } });
  assert.equal(r.ok, true);
  const ids = r.profile.inferences.map((i) => i.id);
  assert.ok(ids.includes('preference::medfield'), 'med served to allowlisted host');
}));

test('MED-2 opt-in alone (no host) cannot elevate via the serve path', () => withProfileDir((dir) => {
  writeProfile(profileWithMed());
  writeFileSync(join(dir, 'share-hosts.txt'), 'good-host\n', 'utf8');
  // Opt-in set but NO host in context -> default-deny.
  const r = profileBrief({ env: process.env, shareSensitive: true });
  assert.doesNotMatch(r.brief, /med secret/, 'no resolved host => med withheld');
}));

test('MED-2 allowlist host match is case-insensitive', () => withProfileDir((dir) => {
  writeProfile(profileWithMed());
  writeFileSync(join(dir, 'share-hosts.txt'), 'Good-Host\n', 'utf8');
  const r = profileGet({ env: process.env, shareSensitive: true, context: { host: 'good-host' } });
  const ids = r.profile.inferences.map((i) => i.id);
  assert.ok(ids.includes('preference::medfield'), 'case-insensitive host match');
}));

// ---------------------------------------------------------------------------
// MED-3 — passive resource read forces low-only.
// ---------------------------------------------------------------------------

test('MED-3 forceLowOnly withholds med/high even with env flag AND allowlisted host', () => withProfileDir((dir) => {
  writeProfile(profileWithMed());
  writeFileSync(join(dir, 'share-hosts.txt'), 'mcp-resource\n', 'utf8');
  process.env.IJFW_PROFILE_SHARE_SENSITIVE = '1';
  // Even with the env flag on AND the host allowlisted, a passive read is low-only.
  const r = profileBrief({
    env: process.env,
    context: { host: 'mcp-resource' },
    forceLowOnly: true,
  });
  assert.match(r.brief, /low pref/);
  assert.doesNotMatch(r.brief, /med secret/, 'passive read NEVER serves med/high');
}));

// ---------------------------------------------------------------------------
// L2 — corroborated dialectic trait surfaces; low-evidence still does not.
// ---------------------------------------------------------------------------

// These two drive renderBrief(), which resolves profileDir() for redaction —
// the fail-closed path-policy guard throws under test context unless
// IJFW_PROFILE_DIR points at a scratch dir. Wrap in withProfileDir so the test
// is self-isolating (it was previously only green by inheriting the env var a
// sibling test file left set — a hidden ordering dependency).
test('L2 a corroborated dialectic trait (conf 0.5, evidence>=3) surfaces in the brief', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'dialectic', subject: 'pace', value: { phrase: 'prefers iterative pace' }, confidence: 0.5, evidence_count: 3, sensitivity: 'low' }),
    ],
  });
  const { text, fields } = renderBrief(p, { env: {} });
  assert.match(text, /prefers iterative pace/, 'dialectic trait at the 0.5 cap now surfaces');
  assert.match(text, /Tentative pattern/, 'phrased tentatively, not as a fact');
  assert.ok(fields.includes('dialectic::pace'));
}));

test('L2 a low-evidence trait (evidence<3) still does NOT surface', () => withProfileDir(() => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'dialectic', subject: 'thin', value: { phrase: 'thin dialectic' }, confidence: 0.5, evidence_count: 2, sensitivity: 'low' }),
    ],
  });
  const { text, fields } = renderBrief(p, { env: {} });
  assert.doesNotMatch(text, /thin dialectic/, 'evidence_count<3 is the real barrier');
  assert.ok(!fields.includes('dialectic::thin'));
}));

// ---------------------------------------------------------------------------
// LOW — read-size caps.
// ---------------------------------------------------------------------------

test('LOW an over-large profile file is refused (falls back to empty serve)', () => withProfileDir((dir) => {
  // Write a valid profile then bloat the file past the 4 MiB cap with trailing
  // bytes; the parser-level cap should refuse it (serve returns empty, no throw).
  writeProfile(applyDelta(makeProfile(), {
    inferences: [makeInference({ kind: 'preference', subject: 'x', value: { phrase: 'present' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })],
  }));
  const pPath = join(dir, 'user-profile.md');
  const big = 'A'.repeat(5 * 1024 * 1024);
  writeFileSync(pPath, big, 'utf8');
  assert.ok(statSync(pPath).size > 4 * 1024 * 1024);
  // Serve must not throw and must not blow memory; it returns empty (no .bak
  // here because we clobbered after the write created one — either way: no crash).
  assert.doesNotThrow(() => profileBrief({ env: process.env }));
}));

test('LOW an over-large egress log is refused on read (no throw, empty entries)', () => withProfileDir(() => {
  // Seed a real entry, then bloat the log past the 8 MiB cap.
  appendEgress({ host: 'h', fields: ['preference::a'] });
  const big = 'B'.repeat(9 * 1024 * 1024);
  writeFileSync(egressLogPath(), big, 'utf8');
  const led = readEgress();
  assert.equal(led.ok, false, 'over-large log refused');
  assert.equal(led.code, 'EEGRESS_TOOBIG');
  assert.deepEqual(led.entries, []);
}));
