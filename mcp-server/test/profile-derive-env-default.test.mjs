// profile-derive-env-default.test.mjs — LIVE-PATH regression for DEFECT 1.
//
// THE BUG (release-blocking, missed by the unit + e2e suites):
//   The production dream entry (runDream's `profile_derive` stage) called
//   profileDeriveStage() WITHOUT passing `env`. Inside the stage,
//   computeIdentity({ env: params.env }) then ran with `params.env === undefined`
//   -> an empty env -> the ambiguous 'UNKNOWN'-basis identity. But capture
//   (flushSession) stamps every wire row with computeIdentity(real process.env).
//   The two NEVER matched, so the fail-closed identity-bound eligibility gate
//   rejected EVERY style row as `identity-mismatch`. Net: the global profile was
//   never written and profile.brief was always empty in real use.
//
// WHY THE EXISTING e2e TEST MISSED IT:
//   profile-e2e.test.mjs ALWAYS injects a clean `env` into profileDeriveStage
//   (so capture-identity == derive-identity by construction). That hides the
//   production default path, where no env is threaded.
//
// THIS TEST closes that exact gap: it captures under the REAL process.env and
// then calls profileDeriveStage WITHOUT an explicit `env`, exercising the
// production `env = params.env || process.env` default. It asserts the style
// rows are ADMITTED (not excluded as identity-mismatch) and the profile IS
// written with evidence_count > 0.
//
//   - BEFORE the fix: FAILS (rows excluded; profile never written / no style
//     evidence; the stage logs an all-excluded / identity-mismatch no-op).
//   - AFTER the fix:  PASSES (capture-identity == derive-identity because both
//     resolve over the SAME real process.env).
//
// It ALSO asserts the security property is preserved: a row stamped with a
// FOREIGN identity (a different machine/user) is still excluded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureMessage, flushSession, computeIdentity } from '../src/profile/capture.js';
import { profileDeriveStage } from '../src/dream/runner.mjs';
import { readProfile } from '../src/profile/store.js';

const TERSE = ['fix the paginator bug', 'use the existing helper', 'ship it'];

// Run the body with TEMP global-profile isolation while LEAVING the real
// process.env identity inputs (USER) in place, and — crucially — NOT injecting
// `env` into profileDeriveStage. That exercises the production default
// (`env = params.env || process.env`), the path the dream entry actually uses,
// while the temp IJFW_PROFILE_DIR / IJFW_PROFILE_STATE_DIR keep the write
// sandboxed.
//
// ISOLATION NOTE (load-bearing — do NOT delete NODE_TEST_CONTEXT): the
// profile store's path policy honors IJFW_PROFILE_DIR verbatim ONLY under a
// test context; stripping the node:test marker would push the override through
// the production homedir-containment check, reject the /tmp dir, and fall back
// to the REAL ~/.ijfw/profile. We therefore preserve the test-context markers
// (the DEFECT 1 fix has nothing to do with them — it is purely about the `env`
// argument threaded into computeIdentity/deriveProfile inside the stage). The
// matching no-test-context REAL-homedir path is covered by the bash live smoke
// (profile-bus-live-smoke.sh) under a scratch HOME.
function withRealEnvFixtures(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ijfw-envdef-repo-'));
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-envdef-profile-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-envdef-state-'));
  mkdirSync(join(repoRoot, '.ijfw'), { recursive: true });

  // Snapshot every env var we touch so we restore process.env exactly.
  const touched = [
    'IJFW_PROFILE_DIR', 'IJFW_PROFILE_STATE_DIR', 'IJFW_IDENTITY_SALT',
    'IJFW_HOST', 'USER', 'IJFW_SHARED_MACHINE',
    // strip the common CI signals so detectQuarantine keeps the row eligible
    // (a CI box would (correctly) quarantine the row as global-ineligible).
    'CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE',
    'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD',
    'BITBUCKET_BUILD_NUMBER', 'DRONE', 'APPVEYOR', 'CODEBUILD_BUILD_ID',
  ];
  const prev = {};
  for (const k of touched) prev[k] = process.env[k];

  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  process.env.IJFW_IDENTITY_SALT = 'envdef-salt';
  process.env.IJFW_HOST = 'claude-code';
  // Guarantee a resolvable USER so computeIdentity is non-ambiguous. On a CI box
  // USER may be empty, so set a stable fallback.
  process.env.USER = process.env.USER || 'envdef-tester';
  delete process.env.IJFW_SHARED_MACHINE;
  for (const k of [
    'CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE',
    'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD',
    'BITBUCKET_BUILD_NUMBER', 'DRONE', 'APPVEYOR', 'CODEBUILD_BUILD_ID',
  ]) delete process.env[k];

  const restore = () => {
    for (const k of touched) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  };
  return Promise.resolve(fn({ repoRoot, pdir, sdir, lockPath: join(sdir, '.profile.lock') }))
    .finally(restore);
}

test('DEFECT 1 (live path): derive with NO injected env admits same-machine rows and writes the profile', async () => {
  await withRealEnvFixtures(async ({ repoRoot, lockPath }) => {
    const t0 = Date.UTC(2026, 5, 1);
    const day = 24 * 60 * 60 * 1000;

    // SANITY: capture stamps the row with THIS machine's identity (real env).
    const captureIdentity = computeIdentity({ env: process.env });
    assert.equal(captureIdentity.ambiguous, false,
      'precondition: identity must be non-ambiguous (USER set, no shared-machine signal)');

    // Drive >= STYLE_CONFIRM_MIN_SESSIONS clean sessions so a style axis accrues
    // evidence. Capture + flush use the REAL process.env (the `env` arg is the
    // real env here, exactly as the live capture hook passes process.env).
    const CLEAN_SESSIONS = 5;
    let lastStage;
    for (let i = 0; i < CLEAN_SESSIONS; i++) {
      for (let j = 0; j < TERSE.length; j++) {
        const r = captureMessage({
          sessionId: `envdef-${i}`,
          text: TERSE[j],
          ts: t0 + i * day + j * 20000,
          profileInjected: false,
          cwd: repoRoot,
        });
        assert.equal(r.ok, true, `captureMessage failed: ${JSON.stringify(r)}`);
      }
      const f = flushSession({
        sessionId: `envdef-${i}`,
        ts: t0 + i * day + TERSE.length * 20000,
        cwd: repoRoot,
        env: process.env, // capture flush uses the real env (the hook's process.env)
      });
      assert.equal(f.ok, true, `flushSession failed: ${JSON.stringify(f)}`);
      assert.equal(f.record.global_eligible, true,
        `flushed row must be global_eligible (got ${JSON.stringify(f.record)})`);
      assert.equal(f.record.identity, captureIdentity.identity,
        'flushed row identity must equal this machine identity');

      // THE PRODUCTION DEFAULT: call the dream stage WITHOUT `env`. Before the
      // fix this computes an 'UNKNOWN' self-identity and excludes every row as
      // identity-mismatch; after the fix it defaults to process.env and matches.
      const logs = [];
      // eslint-disable-next-line no-await-in-loop
      lastStage = await profileDeriveStage({
        projectRoot: repoRoot,
        host: 'claude-code',
        sessionId: `envdef-${i}`,
        log: (m) => logs.push(m),
        lockPath,
        // NOTE: NO `env` key here — this is the regression surface.
      });
      assert.equal(lastStage.ok, true, `dream stage failed: ${JSON.stringify(lastStage)}`);

      // The stage must NOT report an all-excluded / identity-mismatch no-op for
      // these same-machine rows. (This is the precise pre-fix failure signature.)
      assert.notEqual(lastStage.skipped, 'all-excluded',
        `same-machine rows must be ADMITTED, not excluded as a no-op; logs: ${JSON.stringify(logs)}`);
      assert.ok(
        !logs.some((l) => /identity-mismatch/.test(l) && !/0 identity-mismatch/.test(l)),
        `no row should be excluded as identity-mismatch on the production default path; logs: ${JSON.stringify(logs)}`,
      );
    }

    // THE PROFILE WAS WRITTEN with real style evidence (> 0). Before the fix the
    // profile is never written (all rows excluded) -> this read finds no style
    // evidence and the assertion fails.
    const r = readProfile();
    assert.equal(r.ok, true, JSON.stringify(r));
    const style = r.profile.global.style || {};
    const axes = Object.values(style);
    assert.ok(axes.length > 0, 'profile must have at least one style axis after the derive');
    const totalEvidence = axes.reduce((n, a) => n + (a.evidence_count || 0), 0);
    assert.ok(totalEvidence > 0,
      `profile must carry style evidence (evidence_count > 0) after a same-machine `
      + `capture->derive with NO injected env; got ${JSON.stringify(style)}`);
    // The terseness axis specifically should have accrued one unit of evidence
    // per clean session (the rows were admitted, not excluded).
    assert.ok(style.terseness && (style.terseness.evidence_count || 0) >= CLEAN_SESSIONS,
      `terseness must have evidence from every clean session (got ${style.terseness && style.terseness.evidence_count})`);
  });
});

test('DEFECT 1 (security preserved): a FOREIGN-identity row is still excluded on the default env path', async () => {
  await withRealEnvFixtures(async ({ repoRoot, lockPath }) => {
    const stylePath = join(repoRoot, '.ijfw', '.session-style.jsonl');
    const selfIdentity = computeIdentity({ env: process.env }).identity;
    const foreignIdentity = `${'f'.repeat(24)}`; // not this machine
    assert.notEqual(foreignIdentity, selfIdentity);

    // A hand-authored wire row that is global_eligible + NOT profile_influenced
    // but stamped with a FOREIGN identity (another machine/user). The fail-closed
    // identity-bound gate MUST exclude it even though env now defaults to
    // process.env — the fix must not weaken cross-machine isolation.
    const foreignRow = {
      session_id: 'foreign-0',
      schema: 1,
      ts: new Date(Date.UTC(2026, 5, 1)).toISOString(),
      host: 'claude-code',
      global_eligible: true,
      profile_influenced: false,
      identity: foreignIdentity,
      avg_msg_chars: 12,
      emoji_rate: 0,
      code_block_ratio: 0,
      formality_markers: 0,
      turn_cadence_s: 20,
    };
    writeFileSync(stylePath, JSON.stringify(foreignRow) + '\n', 'utf8');

    const logs = [];
    const staged = await profileDeriveStage({
      projectRoot: repoRoot,
      host: 'claude-code',
      sessionId: 'foreign-0',
      log: (m) => logs.push(m),
      lockPath,
      // again: NO `env` — default path.
    });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    // The single foreign row is the only signal -> after exclusion there is no
    // style + no feedback -> the stage no-ops as all-excluded.
    assert.equal(staged.skipped, 'all-excluded',
      `a foreign-identity row must be excluded (all-excluded no-op); logs: ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => /1 identity-mismatch/.test(l)),
      `the foreign row must be counted as an identity-mismatch exclusion; logs: ${JSON.stringify(logs)}`,
    );

    // And no global profile style was written from a foreign row.
    const r = readProfile();
    if (r.ok && r.profile && r.profile.global) {
      const axes = Object.values(r.profile.global.style || {});
      const total = axes.reduce((n, a) => n + (a.evidence_count || 0), 0);
      assert.equal(total, 0, 'a foreign-identity row must NOT contribute any style evidence');
    }
  });
});
