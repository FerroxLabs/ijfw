// profile-path-policy.test.mjs — TEST-ISOLATION LEAK FIX (auto-tmpdir default).
//
// The audit HIGH-4 work guarded the env *override* but not the homedir
// *default*: a profile test that hit a write path WITHOUT setting
// IJFW_PROFILE_DIR silently wrote into the user's REAL `~/.ijfw/profile`.
// `homedirProfileDefault` now returns a PROCESS-UNIQUE os.tmpdir() scratch dir
// under a test context (never the real homedir), so any such test is silently
// ISOLATED instead of clobbering the real profile. Production (non-test) still
// returns the real homedir path. These tests pin that contract from both
// directions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  inTestContext,
  isTestContext,
  homedirProfileDefault,
  resolveOverrideDir,
} from '../src/profile/path-policy.js';

test('isTestContext is an alias of inTestContext', () => {
  assert.equal(isTestContext, inTestContext);
});

test('inTestContext: NODE_ENV=test marks a test context', () => {
  assert.equal(inTestContext({ NODE_ENV: 'test' }), true);
  assert.equal(inTestContext({ NODE_ENV: 'TEST' }), true);
});

test('inTestContext: NODE_TEST_CONTEXT marker marks a test context', () => {
  assert.equal(inTestContext({ NODE_TEST_CONTEXT: 'child' }), true);
});

test('inTestContext: a plain production env is NOT a test context', () => {
  assert.equal(inTestContext({ NODE_ENV: 'production' }), false);
  assert.equal(inTestContext({}), false);
});

test('homedirProfileDefault auto-isolates to os.tmpdir() under a test context (no real-homedir leak)', () => {
  // Simulate the runner marker — this is exactly the live-suite condition that
  // used to silently write into ~/.ijfw/profile.
  const testEnv = { NODE_TEST_CONTEXT: 'child' };
  const home = homedir();
  const tmp = tmpdir();

  const profile = homedirProfileDefault(['.ijfw', 'profile'], testEnv);
  const state = homedirProfileDefault(['.ijfw', 'state'], testEnv);

  // The decisive isolation guarantee: NEVER the real homedir profile.
  assert.ok(
    !profile.startsWith(join(home, '.ijfw')),
    `test-context default must not be under the real ~/.ijfw (got ${profile})`,
  );
  assert.ok(
    !state.startsWith(join(home, '.ijfw')),
    `test-context default must not be under the real ~/.ijfw (got ${state})`,
  );
  // And it IS an os.tmpdir() scratch dir.
  assert.ok(profile.startsWith(tmp), `expected a tmpdir scratch path, got ${profile}`);
  assert.ok(state.startsWith(tmp), `expected a tmpdir scratch path, got ${state}`);
  // The tail segments are preserved so the store/lock layout is intact.
  assert.ok(profile.endsWith(join('.ijfw', 'profile')), profile);
  assert.ok(state.endsWith(join('.ijfw', 'state')), state);
});

test('homedirProfileDefault is stable within a process (read-after-write works)', () => {
  // Two calls with the same subParts must return the SAME path or a write then a
  // read in one test process would diverge. The scratch root is memoized per
  // process, so this holds; distinct subParts share that one root.
  const testEnv = { NODE_TEST_CONTEXT: 'child' };
  const a = homedirProfileDefault(['.ijfw', 'profile'], testEnv);
  const b = homedirProfileDefault(['.ijfw', 'profile'], testEnv);
  assert.equal(a, b);
  const stateA = homedirProfileDefault(['.ijfw', 'state'], testEnv);
  // profile and state live under the same process-unique scratch root.
  assert.equal(join(a, '..', '..'), join(stateA, '..', '..'));
});

test('homedirProfileDefault returns the homedir default in a NON-test context', () => {
  // Pass an explicit non-test env so the assertion holds even though the test
  // RUNNER itself is a test context. We assert the RETURNED PATH only — we never
  // write there, so this test creates nothing under the real homedir.
  const prodEnv = { NODE_ENV: 'production' };
  assert.equal(
    homedirProfileDefault(['.ijfw', 'profile'], prodEnv),
    join(homedir(), '.ijfw', 'profile'),
  );
  assert.equal(
    homedirProfileDefault(['.ijfw', 'state'], prodEnv),
    join(homedir(), '.ijfw', 'state'),
  );
});

test('resolveOverrideDir honors a set override verbatim under a test context', () => {
  // The fail-closed default applies only when there is NO safe override; a
  // provided override still resolves (this is what the leaking tests will set).
  const testEnv = { NODE_TEST_CONTEXT: 'child' };
  const override = join(homedir(), 'nope-not-real-tmp-override');
  assert.equal(resolveOverrideDir(override, testEnv), override);
});

test('resolveOverrideDir returns null for an unset/empty override', () => {
  const testEnv = { NODE_TEST_CONTEXT: 'child' };
  assert.equal(resolveOverrideDir(undefined, testEnv), null);
  assert.equal(resolveOverrideDir('', testEnv), null);
  assert.equal(resolveOverrideDir('   ', testEnv), null);
});
