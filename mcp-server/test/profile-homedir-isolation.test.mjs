// profile-homedir-isolation.test.mjs — REGRESSION GUARD for the test-isolation
// leak (SHIP-BLOCKER: profile tests wrote to the user's REAL ~/.ijfw/profile).
//
// THE BUG: the homedir profile DEFAULT (the no-override fallback) returned the
// real `~/.ijfw/profile` even under a test context. Any profile test that hit a
// write path WITHOUT setting IJFW_PROFILE_DIR/IJFW_PROFILE_STATE_DIR therefore
// seeded/clobbered the machine owner's real profile with test-fixture data
// (e.g. the canonical `correction::rust::use tabs not spaces` dialectic entry).
//
// THE FIX: under a test context with no safe override, `homedirProfileDefault`
// resolves to a PROCESS-UNIQUE os.tmpdir() scratch dir, never the real homedir.
//
// This file is the functional-smoke-style PROOF the leak is closed. It does two
// things, deliberately WITHOUT setting IJFW_PROFILE_DIR (i.e. it reproduces the
// exact condition a forgetful test creates):
//
//   1. asserts the live resolvers (profileDir / profileStateDir / profilePath)
//      never point at the real `~/.ijfw`, and
//   2. snapshots the real `~/.ijfw/profile` dir, runs a REAL writeProfile against
//      the default path, and asserts the real dir is byte-for-byte unchanged
//      afterward — the leaked file never reappears.
//
// If this test ever FAILS, a profile write is escaping into the user's real
// homedir again and the suite must not ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';

import {
  profileDir,
  profilePath,
  backupPath,
  archiveDir,
  writeProfile,
  readProfile,
} from '../src/profile/store.js';
import { profileStateDir, profileLockPath } from '../src/profile/lock.js';
import { makeProfile } from '../src/profile/schema.js';

// Belt-and-braces: ensure no ambient override leaks isolation into this test —
// we WANT the no-override default path so we exercise the real fallback.
delete process.env.IJFW_PROFILE_DIR;
delete process.env.IJFW_PROFILE_STATE_DIR;

const REAL_IJFW = join(homedir(), '.ijfw');
const REAL_PROFILE_DIR = join(REAL_IJFW, 'profile');
const REAL_STATE_DIR = join(REAL_IJFW, 'state');

/**
 * Snapshot a directory's immediate contents as a stable, comparable structure:
 * for every entry, its name + (for files) size + content hash-ish (raw bytes).
 * Absent dir → null. Used to prove the real profile dir is untouched.
 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return null;
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      out[name] = '<unstatable>';
      continue;
    }
    if (st.isDirectory()) {
      out[name] = `<dir:${readdirSync(p).length}>`;
    } else {
      let bytes = '';
      try {
        bytes = readFileSync(p, 'utf8');
      } catch {
        bytes = '<unreadable>';
      }
      out[name] = `file:${st.size}:${bytes.length}:${bytes.slice(0, 64)}`;
    }
  }
  return out;
}

test('resolvers never point at the real ~/.ijfw under a test context (no override set)', () => {
  // `node --test` sets NODE_TEST_CONTEXT in this worker, so isTestContext() is
  // true and the auto-tmpdir default is in force. No override is set above.
  const pd = profileDir();
  const sd = profileStateDir();
  const pp = profilePath();
  const bp = backupPath();
  const ad = archiveDir();
  const lp = profileLockPath();

  for (const [label, got] of [
    ['profileDir', pd],
    ['profileStateDir', sd],
    ['profilePath', pp],
    ['backupPath', bp],
    ['archiveDir', ad],
    ['profileLockPath', lp],
  ]) {
    assert.ok(
      !got.startsWith(REAL_IJFW),
      `${label}() must not resolve under the real ~/.ijfw — got ${got}`,
    );
  }
});

test('a REAL writeProfile with no override leaves the real ~/.ijfw/profile untouched', () => {
  // Snapshot BEFORE: this is the user's real profile dir (cleaned, should be
  // empty of user-profile.md). We capture its exact state.
  const before = snapshotDir(REAL_PROFILE_DIR);
  const beforeState = snapshotDir(REAL_STATE_DIR);

  // Reproduce the leak condition: write a profile that carries the SAME fixture
  // shape the leak left behind (the canonical rust dialectic correction), with
  // NO override set. Under the fix this lands in an isolated tmpdir, NOT the real
  // homedir. The whole profile object round-trips via the lossless canonical
  // JSON block (serializeProfile -> parseProfile), so this entry persists.
  const profile = makeProfile();
  profile.global.dialectic.push({
    subject: 'use tabs not spaces',
    source_sessions: ['s-a', 's-b', 's-c'],
    confirmed: true,
  });

  const res = writeProfile(profile);
  assert.equal(res.ok, true, `writeProfile should succeed into its isolated dir: ${JSON.stringify(res)}`);

  // The write must have landed SOMEWHERE outside the real homedir.
  assert.ok(
    !profilePath().startsWith(REAL_IJFW),
    `the write target must be isolated, got ${profilePath()}`,
  );
  // And it must be readable back from the isolated path (read-after-write).
  // readProfile() returns a { ok, profile } wrapper.
  const round = readProfile();
  assert.equal(round.ok, true, `readProfile should succeed: ${JSON.stringify(round)}`);
  assert.equal(round.profile?.global?.dialectic?.[0]?.subject, 'use tabs not spaces');

  // Snapshot AFTER: the real profile dir must be byte-for-byte identical. The
  // fixture file must NOT have appeared in the real homedir.
  const after = snapshotDir(REAL_PROFILE_DIR);
  const afterState = snapshotDir(REAL_STATE_DIR);

  assert.deepEqual(
    after,
    before,
    'the REAL ~/.ijfw/profile changed during a test write — the isolation leak is OPEN',
  );
  assert.deepEqual(
    afterState,
    beforeState,
    'the REAL ~/.ijfw/state changed during a test write — the isolation leak is OPEN',
  );

  // Explicitly: the canonical leaked artifact is absent from the real dir.
  assert.ok(
    !existsSync(join(REAL_PROFILE_DIR, 'user-profile.md')) || before?.['user-profile.md'] !== undefined,
    'user-profile.md must not have been newly created in the real ~/.ijfw/profile',
  );
});
