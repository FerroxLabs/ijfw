// profile-e2e.test.mjs — the cross-system profile bus END-TO-END proof.
//
// "No stubs, everything connected." This test drives the REAL modules in the
// REAL sequence — capture -> dream stage (derive) -> merge -> serve — with NO
// mocking of the pipeline. It is the load-bearing integration gate: if it fails,
// the system is not actually wired.
//
// The chain under test:
//   1. capture.js  captureMessage()/flushSession()  -> REAL .session-style.jsonl
//      + a hand-authored .session-feedback.jsonl (the corrections/preferences
//        stream the detector would emit).
//   2. dream/runner.mjs  profileDeriveStage()        -> reads those signals,
//      maps them through toDeriveMeta (SEAM 1), filters quarantined +
//      profile_influenced rows (SEAM 2), derives, and merges under the global
//      lock into the ONE user-global profile.
//   3. store.js  readProfile()                       -> read the global back.
//   4. render-brief.js renderBrief() / serve.js profileBrief() -> the brief a
//      host actually receives.
//
// THE FOUR ASSERTIONS (each tied to a seam / contract):
//   (a) SEAM 1: emoji_use AND energy axes actually MOVED off the neutral 0.5
//       prior. They would be flat (no evidence, ema==0.5) if the raw wire rows
//       were passed without toDeriveMeta — that is exactly the bug this proves
//       fixed.
//   (b) SEAM 2: the quarantined (global_eligible:false) + profile_influenced
//       sessions did NOT contribute — the style axes' evidence_count equals the
//       count of CLEAN sessions only, not the total flushed.
//   (c) a preference inference from the feedback stream is present in the global
//       profile's dialectic[].
//   (d) renderBrief() over that profile returns a coherent, non-empty brief that
//       reflects the learned style + the learned preference.
//
// Isolation: a temp REPO_ROOT for the per-project capture signals, and temp
// HOME-rooted dirs (IJFW_PROFILE_DIR / IJFW_PROFILE_STATE_DIR) for the global
// profile + lock, so the test never touches the real user profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureMessage, flushSession } from '../src/profile/capture.js';
import { profileDeriveStage } from '../src/dream/runner.mjs';
import { readProfile, profileDir } from '../src/profile/store.js';
import { renderBrief } from '../src/profile/render-brief.js';
import { profileBrief } from '../src/profile/serve.js';

// ---------------------------------------------------------------------------
// Fixtures: isolate global profile + lock + a fresh REPO_ROOT per test.
// ---------------------------------------------------------------------------
function withFixtures(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ijfw-e2e-repo-'));
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-e2e-profile-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-e2e-state-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  mkdirSync(join(repoRoot, '.ijfw'), { recursive: true });
  const restore = () => {
    if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
    if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  };
  return Promise.resolve(fn({ repoRoot, pdir, sdir, lockPath: join(sdir, '.profile.lock') }))
    .finally(restore);
}

// A clean (non-CI, identity-resolvable) env: a real USER so computeIdentity is
// NOT ambiguous and detectQuarantine sees no CI vars => global_eligible:true.
// We strip any inherited CI vars so the test is deterministic on CI machines.
function cleanEnv() {
  return { USER: 'e2e-tester', IJFW_HOST: 'claude-code', IJFW_IDENTITY_SALT: 'e2e-salt' };
}

// Drive a REAL multi-message session through capture, then flush it to the wire
// file. `texts` are the per-message strings (metadata-only extraction happens
// inside capture). Returns nothing — the side effect is one appended JSONL row.
function runSession({ repoRoot, sessionId, texts, env, profileInjected = false, baseTs }) {
  // Per-message capture with monotonically increasing timestamps so flushSession
  // computes a real turn cadence (energy axis needs cadence > 0).
  for (let i = 0; i < texts.length; i++) {
    const r = captureMessage({
      sessionId,
      text: texts[i],
      ts: baseTs + i * 20000, // 20s between turns
      profileInjected: profileInjected && i === 0, // taint at first message
      cwd: repoRoot,
    });
    assert.equal(r.ok, true, `captureMessage failed: ${JSON.stringify(r)}`);
  }
  const f = flushSession({
    sessionId,
    ts: baseTs + texts.length * 20000,
    cwd: repoRoot,
    env,
  });
  assert.equal(f.ok, true, `flushSession failed: ${JSON.stringify(f)}`);
  return f.record;
}

// Terse + emoji-heavy clean message set (short messages, emoji present) — drives
// terseness HIGH and emoji_use ABOVE the neutral prior.
const TERSE_EMOJI = ['yes 🚀', 'do it 🔥', 'ship 🎉', 'nice 😎', 'go ✅'];
// Verbose + formal clean message set (long messages, formality markers, no
// emoji) — a contrasting clean persona to prove style is genuinely observed.
const VERBOSE_FORMAL = [
  'Could you please walk me through the architecture in detail? Thank you kindly for your help.',
  'I would appreciate a thorough, step-by-step explanation; furthermore, please include the rationale.',
];

test('E2E: capture -> dream-derive -> merge -> serve, with both seams proven', async () => {
  await withFixtures(async ({ repoRoot, lockPath }) => {
    const env = cleanEnv();
    const t0 = Date.UTC(2026, 5, 1);
    const day = 24 * 60 * 60 * 1000;

    // ── Author a REAL feedback stream (the detector's output shape) ──────────
    // Two corrections/preferences the profile must learn. Corroborated across
    // >=3 sessions so the brief's evidence floor (>=3) + confidence floor (>0.6)
    // are cleared honestly by the heuristic tier.
    const feedbackPath = join(repoRoot, '.ijfw', '.session-feedback.jsonl');
    const fbRows = [];
    for (let i = 0; i < 5; i++) {
      const ts = new Date(t0 + i * day).toISOString();
      fbRows.push({ session_id: `clean-${i}`, ts, kind: 'correction', phrase: 'use tabs not spaces', context: '' });
      fbRows.push({ session_id: `clean-${i}`, ts, kind: 'preference', phrase: 'keep responses terse', context: '' });
    }
    writeFileSync(feedbackPath, fbRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // ── Drive REAL sessions into the wire file, then run the REAL dream stage ─
    // We run the dream stage once per session so style-axis evidence accrues
    // across sessions (each stage call folds the most-recent row's metadata +
    // re-merges the feedback). This mirrors SessionEnd firing per session.
    const CLEAN_SESSIONS = 5;
    let staged;
    const allLogs = [];
    for (let i = 0; i < CLEAN_SESSIONS; i++) {
      // 5 clean terse+emoji sessions (the dominant persona).
      runSession({ repoRoot, sessionId: `clean-${i}`, texts: TERSE_EMOJI, env, baseTs: t0 + i * day });

      // After the 3rd clean session, also flush ONE quarantined session
      // (CI env => global_eligible:false) and ONE profile_influenced session.
      // Both land in the SAME wire file and MUST be filtered by SEAM 2.
      if (i === 2) {
        const ciEnv = { ...cleanEnv(), CI: 'true' };
        const qr = runSession({ repoRoot, sessionId: 'quarantined-0', texts: VERBOSE_FORMAL, env: ciEnv, baseTs: t0 + i * day + 1000 });
        assert.equal(qr.global_eligible, false, 'quarantined session must be global-ineligible');
        const ir = runSession({ repoRoot, sessionId: 'influenced-0', texts: VERBOSE_FORMAL, env, profileInjected: true, baseTs: t0 + i * day + 2000 });
        assert.equal(ir.profile_influenced, true, 'influenced session must be flagged profile_influenced');
      }

      // REAL dream stage: read signals -> map (SEAM 1) -> filter (SEAM 2) ->
      // derive -> merge into the GLOBAL profile under the lock.
      const logs = [];
      // FIX 3 (HIGH-3): the dream stage now binds eligibility to the merging
      // machine's identity (fail-closed). The machine that DERIVES is the machine
      // that CAPTURED, so we pass the SAME clean env the sessions were flushed
      // under — otherwise the identity-bound gate would (correctly) exclude every
      // row as a cross-machine import. This mirrors real SessionEnd, where capture
      // and derivation run in one process on one machine.
      // eslint-disable-next-line no-await-in-loop
      staged = await profileDeriveStage({
        projectRoot: repoRoot, host: 'claude-code', sessionId: `clean-${i}`,
        log: (m) => logs.push(m), lockPath, env,
      });
      assert.equal(staged.ok, true, `dream stage failed: ${JSON.stringify(staged)}`);
      allLogs.push(...logs);

      // FIX 1 (C1/C2) + SEAM 2: the quarantined + influenced rows are introduced
      // on cycle i===2 and consumed EXACTLY ONCE (the cursor advances past them),
      // so the SEAM-2 exclusion is logged on the cycle that first reads them —
      // NOT re-logged every subsequent cycle (which was a symptom of the re-read
      // bug). On cycle i===2 the stage MUST log the split exclusion counts and
      // count the CI/quarantined row as non-eligible (global_eligible!==true).
      if (i === 2) {
        assert.ok(
          logs.some((l) => /excluded \d+ non-eligible .* \+ \d+ identity-mismatch \+ \d+ profile_influenced/.test(l)),
          `SEAM 2 exclusion must be LOGGED on the introducing cycle; got: ${JSON.stringify(logs)}`,
        );
        assert.ok(
          logs.some((l) => /excluded 1 non-eligible/.test(l)),
          `the quarantined (global_eligible:false) row must be counted non-eligible; got: ${JSON.stringify(logs)}`,
        );
        assert.ok(
          logs.some((l) => /\+ 1 profile_influenced/.test(l)),
          `the profile_influenced row must be counted; got: ${JSON.stringify(logs)}`,
        );
      }
    }
    // The exclusion must have been observed exactly during the run (one-fold-per-row).
    assert.ok(
      allLogs.some((l) => /excluded 1 non-eligible.*\+ 0 identity-mismatch \+ 1 profile_influenced/.test(l)),
      `SEAM 2 exclusion (1 non-eligible + 1 influenced, identity matched) must appear once; got: ${JSON.stringify(allLogs)}`,
    );

    // ── Read the GLOBAL profile back via the REAL store ─────────────────────
    const r = readProfile();
    assert.equal(r.ok, true, JSON.stringify(r));
    const style = r.profile.global.style;

    // ── ASSERTION (a) — SEAM 1: emoji_use AND energy axes MOVED ─────────────
    // If the raw wire rows had been passed straight through (the bug), deriveStyle
    // would see no emoji_per_msg / turn_cadence_per_min => those axes get NO
    // evidence and stay at the neutral 0.5 prior. Proving they have evidence AND
    // an ema distinct from 0.5 proves toDeriveMeta is applied.
    assert.ok(style.emoji_use, 'emoji_use axis must exist');
    assert.ok(style.energy, 'energy axis must exist');
    assert.ok((style.emoji_use.evidence_count || 0) >= CLEAN_SESSIONS,
      `emoji_use must have evidence from every clean session (got ${style.emoji_use.evidence_count})`);
    assert.ok((style.energy.evidence_count || 0) >= CLEAN_SESSIONS,
      `energy must have evidence from every clean session (got ${style.energy.evidence_count})`);
    assert.notEqual(Math.round(style.emoji_use.ema * 1000) / 1000, 0.5,
      'emoji_use ema must have moved off the neutral prior (SEAM 1)');
    assert.notEqual(Math.round(style.energy.ema * 1000) / 1000, 0.5,
      'energy ema must have moved off the neutral prior (SEAM 1)');
    // The terse+emoji persona should push emoji_use ABOVE neutral.
    assert.ok(style.emoji_use.ema > 0.5, `emoji_use should read high for an emoji-heavy persona (got ${style.emoji_use.ema})`);

    // ── ASSERTION (b) — SEAM 2: quarantined + influenced did NOT contribute ──
    // Every style axis must carry evidence from the CLEAN sessions ONLY. If the
    // quarantined/influenced rows had leaked in, the most-recent-row metadata on
    // the i>=3 cycles would have come from a VERBOSE_FORMAL row (long, no emoji),
    // and the evidence_count would exceed the clean-session count.
    for (const axis of ['terseness', 'emoji_use', 'formality', 'energy']) {
      assert.equal(style[axis].evidence_count, CLEAN_SESSIONS,
        `${axis} evidence_count must equal clean-session count (${CLEAN_SESSIONS}), proving the `
        + `quarantined + influenced rows were excluded (got ${style[axis].evidence_count})`);
    }
    // emoji_use staying HIGH is a second, independent witness: a leaked
    // VERBOSE_FORMAL (zero-emoji) row as the most-recent metadata would have
    // dragged emoji_use back toward / below neutral.
    assert.ok(style.emoji_use.ema > 0.5,
      'emoji_use staying high confirms no zero-emoji quarantined/influenced row became the metadata');

    // ── ASSERTION (c) — a preference inference from feedback is present ──────
    const dialectic = r.profile.global.dialectic;
    const subjects = dialectic.map((i) => i.subject);
    assert.ok(subjects.some((s) => /tabs/.test(s)),
      `a 'tabs' preference inference must be present; got ${JSON.stringify(subjects)}`);
    assert.ok(subjects.some((s) => /terse/.test(s)),
      `a 'terse' preference inference must be present; got ${JSON.stringify(subjects)}`);
    // It must have accumulated evidence across the 5 sessions (>= the brief floor).
    const tabsInf = dialectic.find((i) => /tabs/.test(i.subject));
    assert.ok((tabsInf.evidence_count || 0) >= 3,
      `the tabs preference must have accrued >=3 evidence (got ${tabsInf.evidence_count})`);

    // ── ASSERTION (d) — renderBrief / profileBrief returns a coherent brief ──
    // Direct renderBrief over the read-back profile. shareSensitive so the
    // med-tier corrections (the levers) can surface — the trusted-host scenario.
    // (Direct renderBrief does NOT engage the MED-2 host allowlist, so the opt-in
    // alone surfaces med fields here — that allowlist binds only on the serve
    // path, asserted below.)
    const brief = renderBrief(r.profile, { shareSensitive: true });
    assert.ok(brief.text.length > 0, 'brief must be non-empty');
    assert.ok(brief.fields.length > 0, 'brief must emit at least one field');
    // It reflects the learned STYLE (confirmed axes need >=5 sessions — we have
    // exactly 5, so style axes are confirmed and MUST appear).
    assert.match(brief.text, /Communication style/, 'brief must reflect the learned communication style');
    // It reflects the learned PREFERENCE.
    assert.match(brief.text, /tabs/, 'brief must reflect the learned tabs preference');

    // The serve verb (profileBrief) reads the SAME global profile via the store
    // and renders the SAME brief — proves the production serve path is wired too.
    // MED-2: the serve path binds med/high to a per-host allowlist, so the
    // "trusted-host scenario" must name a host AND list it in share-hosts.txt;
    // the opt-in alone is (correctly) no longer sufficient to surface med fields.
    writeFileSync(join(profileDir(), 'share-hosts.txt'), 'trusted-cli\n', 'utf8');
    const served = profileBrief({ shareSensitive: true, context: { host: 'trusted-cli' } });
    assert.equal(served.ok, true);
    assert.ok(served.brief.length > 0, 'profileBrief serve verb must return a non-empty brief');
    assert.match(served.brief, /tabs/, 'served brief must reflect the learned preference');

    // MED-2 negative: the SAME serve call from a NON-allowlisted host must NOT
    // surface the med-tier 'tabs' correction even with the opt-in set.
    const denied = profileBrief({ shareSensitive: true, context: { host: 'untrusted-cli' } });
    assert.equal(denied.ok, true);
    assert.doesNotMatch(denied.brief, /tabs/, 'a non-allowlisted host must not get med fields (MED-2)');
  });
});
