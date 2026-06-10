// P3.1 — the `profile_derive` SessionEnd dream stage (end-to-end-ish).
//
// This is the wire the whole feature hinges on: synthetic signal JSONLs in a
// temp REPO_ROOT -> the stage reads them -> builds the deriveHeuristic input ->
// deriveProfile() -> mergeAndWrite() to the GLOBAL profile under the global
// lock. We assert the global profile FILE actually gains the derived deltas
// (read back via the store).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profileDeriveStage } from '../src/dream/runner.mjs';
import { readProfile } from '../src/profile/store.js';
import { computeIdentity } from '../src/profile/capture.js';

// FIX 3 (HIGH-3): global eligibility is now FAIL-CLOSED + identity-bound. A row
// reaches the merge only if global_eligible===true AND its identity matches the
// merging machine's computeIdentity({env}). These fixtures use a fixed env and
// stamp the matching identity so the productive-path tests still admit rows.
const ENV = { USER: 'dream-stage-tester', IJFW_IDENTITY_SALT: 'dream-stage-salt' };
const ID = computeIdentity({ env: ENV }).identity;

// Isolate the GLOBAL profile + lock into temp dirs per case (the store + lock
// read these env overrides), and provide a temp REPO_ROOT holding the signals.
function withFixtures(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ijfw-dream-repo-'));
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-dream-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-dream-s-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  const ijfwDir = join(repoRoot, '.ijfw');
  mkdirSync(ijfwDir, { recursive: true });
  const restore = () => {
    if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
    if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  };
  return Promise.resolve(fn({ repoRoot, ijfwDir, pdir, sdir, lockPath: join(sdir, '.profile.lock') }))
    .finally(restore);
}

function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const META = (i) => ({
  session_id: `s${i}`, host: 'claude',
  ts: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
  avg_msg_chars: 38, emoji_per_msg: 0, code_block_ratio: 0.6,
  formality_markers: 0.2, turn_cadence_per_min: 5, msg_count: 18,
  // FIX 3 fail-closed eligibility fields (strict-true + identity-bound).
  global_eligible: true, profile_influenced: false,
  identity: ID, trust_weight: 1.0, delta_cap: 0.25,
});

test('profile_derive stage reads signals and merges deltas into the GLOBAL profile', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [META(0), META(1), META(2)]);
    writeJsonl(join(ijfwDir, '.session-feedback.jsonl'), [
      { ts: new Date(Date.UTC(2026, 5, 2)).toISOString(), kind: 'correction',
        phrase: 'use tabs not spaces', context: '' },
    ]);

    const logs = [];
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's2',
      log: (m) => logs.push(m), lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));

    // The GLOBAL profile file must now carry the derived deltas.
    const r = readProfile();
    assert.equal(r.ok, true);
    // style fingerprint folded (terseness axis got evidence)
    assert.ok(r.profile.global.style.terseness.evidence_count >= 1,
      'style axis gained evidence from the session metadata');
    // preference inference from the correction feedback landed in dialectic[]
    const subjects = r.profile.global.dialectic.map((i) => i.subject);
    assert.ok(subjects.some((s) => /tabs/.test(s)),
      'correction feedback became a preference inference in the global profile');
  });
});

test('profile_derive stage is a clean no-op when no signal files exist (never throws)', async () => {
  await withFixtures(async ({ repoRoot, lockPath }) => {
    const logs = [];
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 'sX',
      log: (m) => logs.push(m), lockPath, env: ENV,
    });
    // best-effort: no files -> empty delta -> still a successful no-op
    assert.equal(res.ok, true, JSON.stringify(res));
    const r = readProfile();
    assert.equal(r.ok, true);
    // global dialectic stays empty
    assert.equal(r.profile.global.dialectic.length, 0);
  });
});

test('profile_derive stage failure is reported (not silently swallowed)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [META(0), META(1)]);
    // Point the lock+profile at an impossible location to force a write failure,
    // and assert the stage surfaces a logged, non-ok result rather than throwing.
    const logs = [];
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1',
      log: (m) => logs.push(m), env: ENV,
      // inject a merge that fails, to exercise the error-surfacing path
      _mergeAndWrite: async () => ({ ok: false, code: 'ETEST', message: 'forced' }),
    });
    assert.equal(res.ok, false, 'forced merge failure surfaces as non-ok');
    assert.ok(logs.some((l) => /profile_derive|ETEST|forced/i.test(l)),
      'the failure was LOGGED, not silently swallowed');
  });
});

test('profile_derive stage tolerates a corrupt signal line (skips, still merges the rest)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    // One valid row, one garbage line, one valid row.
    writeFileSync(join(ijfwDir, '.session-style.jsonl'),
      JSON.stringify(META(0)) + '\n' + 'NOT JSON\n' + JSON.stringify(META(1)) + '\n', 'utf8');
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1',
      log: () => {}, lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const r = readProfile();
    assert.ok(r.profile.global.style.terseness.evidence_count >= 1,
      'valid rows still folded despite a corrupt line');
  });
});
