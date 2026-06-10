// PROFILE CORRECTION LOOP — TRUE END-TO-END (the functional-smoke discipline).
//
// unit-green != working. Every other profile test exercises ONE module in
// isolation; this one drives the REAL pipeline the product ships:
//
//   capture-shaped JSONL  ->  profileDeriveStage (dream/derive)  ->  deriveProfile
//   ->  deriveEditPreferences (S4 correction loop)  ->  mergeAndWrite (admission
//   gate: >=3 NON-ADJACENT sessions, contradiction-flips)  ->  stampPrecisionEligible
//   (S2 gate)  ->  GLOBAL profile  ->  the REAL serve read (eligiblePreferenceSlugs
//   via renderSnapshot) with the on-disk approval registry.
//
// It proves the four behaviours the adversarial review demanded:
//   (a) an edit-delta correction repeated across 3 NON-ADJACENT sessions, once
//       APPROVED, mints a precision-gated slug that APPEARS in the rendered brief;
//   (b) a NOISE/meaningless correction never mints / never injects;
//   (c) a profile_influenced session is NOT re-derived (no self-corroboration —
//       evidence_count does not climb from injected output);
//   (d) an un-approved OR sub-0.8/un-stamped slug is NOT in the brief.
//
// Isolation: temp REPO_ROOT for signals + temp IJFW_PROFILE_DIR / state dir for
// the global profile, lock, and approvals — no real homedir writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profileDeriveStage } from '../src/dream/runner.mjs';
import { readProfile } from '../src/profile/store.js';
import { computeIdentity } from '../src/profile/capture.js';
import { renderSnapshot, eligiblePreferenceSlugs } from '../src/profile/render-brief.js';
import { approveAndWrite } from '../src/profile/audit.js';
import { profileSnapshot } from '../src/profile/serve.js';
import { createHash } from 'node:crypto';

const ENV = { USER: 'corr-loop-tester', IJFW_IDENTITY_SALT: 'corr-loop-salt' };
const ID = computeIdentity({ env: ENV }).identity;

function withFixtures(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ijfw-corr-repo-'));
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-corr-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-corr-s-'));
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

function hash(s) { return createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

/**
 * One capture-shaped edit-delta row (the .session-edits.jsonl wire contract that
 * captureEditDelta writes). An `edit-after` row IS a correction; the cited span is
 * the diff that grounds it. proposed/committed hashes are the direction key.
 */
function editRow({
  sessionId, ts, citedSpan, language = 'rust', committed = 'tabs', proposed = 'spaces',
  profileInfluenced = false, outcome = 'edit-after',
}) {
  return {
    ts,
    session_id: sessionId,
    host: 'claude',
    scope: { language, file_pattern: `*.${language === 'rust' ? 'rs' : 'txt'}` },
    outcome,
    changed: outcome === 'edit-after',
    proposed_hash: hash(proposed),
    committed_hash: hash(committed),
    cited_span: citedSpan,
    direction: citedSpan,
    profile_influenced: profileInfluenced,
    global_eligible: true,
    identity: ID,
    trust_weight: 1.0,
  };
}

function appendEdit(ijfwDir, row) {
  appendFileSync(join(ijfwDir, '.session-edits.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * Drive ONE dream/derive cycle. Each call consumes the rows appended since the
 * last cycle (the runner's per-stream cursor). We pass an explicit NON-ADJACENT
 * sessionOrdinal so 3 cycles carry ordinals with gaps > 1 (the merge's
 * non-adjacency admission gate: a real recurring preference shows across
 * spread-out work, not a back-to-back burst).
 */
async function cycle({ repoRoot, lockPath, sessionId, sessionOrdinal }) {
  return profileDeriveStage({
    projectRoot: repoRoot, host: 'claude', sessionId,
    sessionOrdinal, log: () => {}, lockPath, env: ENV,
  });
}

// ---------------------------------------------------------------------------
// (a) THE HAPPY PATH — 3 non-adjacent edit corrections -> minted + precision-
//     gated; once APPROVED it surfaces in the rendered snapshot brief.
// (d) is folded in: BEFORE approval the (precision-eligible, corroborated) slug
//     is still held back, proving the approval gate is load-bearing.
// ---------------------------------------------------------------------------
test('(a)+(d) 3 non-adjacent edit corrections mint a precision-gated slug that surfaces only once approved', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const SPAN = 'use tabs not spaces';
    // Three spread-out sessions correcting the SAME thing (same scope + cited
    // span => one atom that corroborates). Ordinals 1, 3, 5 => non-adjacent.
    // Timestamps are RECENT (within the 60-day confirm half-life) so the merge's
    // half-life check does not decay the freshly-corroborated atom back to
    // unconfirmed — the most recent corroboration lands ~now.
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const sessions = [
      { sid: 's-a', ord: 1, ts: now - 20 * DAY },
      { sid: 's-b', ord: 3, ts: now - 10 * DAY },
      { sid: 's-c', ord: 5, ts: now - 1 * DAY },
    ];
    for (const s of sessions) {
      appendEdit(ijfwDir, editRow({ sessionId: s.sid, ts: s.ts, citedSpan: SPAN }));
      const res = await cycle({ repoRoot, lockPath, sessionId: s.sid, sessionOrdinal: s.ord });
      assert.equal(res.ok, true, `cycle ${s.sid}: ${JSON.stringify(res)}`);
    }

    // The atom is in the GLOBAL profile, corroborated (>=3 distinct sessions),
    // confirmed (non-adjacent), and PRECISION-ELIGIBLE (the stamp fired).
    const r = readProfile();
    assert.equal(r.ok, true);
    const atom = r.profile.global.dialectic.find((i) => /tabs/.test(i.subject));
    assert.ok(atom, 'the edit-delta correction minted a global atom');
    assert.ok(atom.evidence_count >= 3, `evidence accrued across sessions (got ${atom.evidence_count})`);
    assert.equal(atom.confirmed, true, 'non-adjacent corroboration confirmed the atom');
    assert.equal(atom.precision_eligible, true, 'S2 precision gate stamped the grounded slug eligible');

    // A correction is a MED-sensitivity field, so the brief only surfaces it when
    // the user has opted into sharing sensitive fields (the personalization opt-
    // in). shareSensitive:true models that consent; the gate is otherwise unchanged.
    const SHARE = { env: {}, includePreferences: true, shareSensitive: true };

    // (d) BEFORE approval: precision-eligible + corroborated, but NO approval =>
    // the snapshot gate holds it back (fail-closed on the human-in-the-loop axis).
    const before = renderSnapshot(r.profile, SHARE);
    assert.doesNotMatch(before.text, /tabs/, 'un-approved slug must not surface');
    assert.equal(eligiblePreferenceSlugs(r.profile, { registry: null, shareOpts: { shareSensitive: true } }).length, 0);

    // APPROVE the atom (the citation locator exists -> it CAN be approved). This
    // is lock-serialized + async; awaiting it (a) lets the registry write commit
    // and (b) keeps the lock off the teardown race. lockPath isolates the lock.
    const ap = await approveAndWrite(atom.id, { lockPath });
    assert.ok(ap.ok, JSON.stringify(ap));

    // (a) AFTER approval: the REAL render path surfaces the cleared slug. We read
    // the approval registry back from disk (what serve does) and thread it in.
    const r2 = readProfile();
    const after = renderSnapshot(r2.profile, { ...SHARE, registry: { [atom.id]: { state: 'approved' } } });
    assert.match(after.text, /tabs/, 'an approved + precision-eligible + corroborated slug surfaces');
    assert.ok(after.fields.includes(atom.id), 'the surfaced id is recorded for egress');

    // And the serve path (profileSnapshot) loads the on-disk approval registry +
    // applies the SAME gate end to end (host allowlisted so the med field clears).
    const srv = profileSnapshot({
      env: {}, includePreferences: true, shareSensitive: true,
      shareHosts: ['claude'], context: { host: 'claude', session: 'srv' },
    });
    assert.ok(srv.ok);
  });
});

// ---------------------------------------------------------------------------
// (a2) PRODUCTION ORDINAL PATH — drive 3 cycles WITHOUT an explicit sessionOrdinal
//      so the runner's auto-derived (cursor-persisted, step-by-2) ordinal carries
//      the non-adjacency. Proves production (not just the test-injected ordinal)
//      confirms a 3-cycle corroboration and stamps it precision-eligible.
// ---------------------------------------------------------------------------
test('(a2) the auto-derived ordinal (no explicit sessionOrdinal) confirms across 3 cycles', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const SPAN = 'prefer const over let';
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const sessions = [
      { sid: 'p-a', ts: now - 20 * DAY },
      { sid: 'p-b', ts: now - 10 * DAY },
      { sid: 'p-c', ts: now - 1 * DAY },
    ];
    for (const s of sessions) {
      appendEdit(ijfwDir, editRow({ sessionId: s.sid, ts: s.ts, citedSpan: SPAN, language: 'js' }));
      // NOTE: sessionOrdinal intentionally OMITTED -> the runner auto-derives it.
      const res = await profileDeriveStage({
        projectRoot: repoRoot, host: 'claude', sessionId: s.sid, log: () => {}, lockPath, env: ENV,
      });
      assert.equal(res.ok, true, JSON.stringify(res));
    }
    const r = readProfile();
    const atom = r.profile.global.dialectic.find((i) => /const over let/.test(i.subject));
    assert.ok(atom, 'the correction minted across the 3 auto-ordinal cycles');
    assert.ok(atom.evidence_count >= 3, `evidence accrued (got ${atom.evidence_count})`);
    assert.equal(atom.confirmed, true,
      'auto-derived non-adjacent ordinals (step-by-2) confirmed the atom in production path');
    assert.equal(atom.precision_eligible, true, 'the grounded slug is precision-eligible');
  });
});

// ---------------------------------------------------------------------------
// (b) NOISE — a meaningless but cited correction never clears the precision gate,
//     so even with corroboration + approval it can never reach the brief.
// ---------------------------------------------------------------------------
test('(b) a noise/meaningless feedback slug never mints a precision-eligible slug and never injects', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    // DISCRIMINATION test (non-vacuous): in the SAME 3 non-adjacent sessions we
    // capture BOTH (1) a REAL edit-grounded correction (the diff is the citation)
    // and (2) a NOISE feedback slug (a regex trigger with no grounding). Both
    // corroborate across 3 sessions, so the corroboration gate alone would pass
    // BOTH. The PRECISION gate must let the grounded one through and block the
    // noise one — proving it discriminates, not that it blocks everything.
    const REAL = 'prefer early returns over nested ifs';
    const NOISE = 'ugh whatever just deal with this garbage thing';
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const sessions = [
      { sid: 'n-a', ord: 1, ts: now - 20 * DAY },
      { sid: 'n-b', ord: 3, ts: now - 10 * DAY },
      { sid: 'n-c', ord: 5, ts: now - 1 * DAY },
    ];
    for (const s of sessions) {
      // (1) grounded edit-delta correction -> seeds the gold + is itself eligible.
      appendEdit(ijfwDir, editRow({ sessionId: s.sid, ts: s.ts, citedSpan: REAL, language: 'js' }));
      // (2) feedback-shaped noise (regex trigger), NOT edit-grounded: matches no
      // grounded correction in the gold -> WRONG -> never precision-eligible.
      appendFileSync(join(ijfwDir, '.session-feedback.jsonl'),
        `${JSON.stringify({ ts: new Date(s.ts).toISOString(), kind: 'preference', phrase: 'I prefer', context: `I prefer ${NOISE}`, session_id: s.sid, profile_influenced: false })}\n`, 'utf8');
      const res = await cycle({ repoRoot, lockPath, sessionId: s.sid, sessionOrdinal: s.ord });
      assert.equal(res.ok, true, JSON.stringify(res));
    }

    const r = readProfile();
    assert.equal(r.ok, true);

    // The REAL grounded correction IS precision-eligible (control: gate is alive).
    const realAtom = r.profile.global.dialectic.find((i) => /early returns/.test(i.subject));
    assert.ok(realAtom, 'the grounded edit correction minted');
    assert.equal(realAtom.precision_eligible, true, 'a grounded correction clears the precision gate');

    // The NOISE feedback slug is NOT precision-eligible (the actual finding).
    const noiseAtom = r.profile.global.dialectic.find((i) => /garbage|deal with/.test(i.subject));
    assert.ok(noiseAtom, 'the noise feedback slug minted an atom (corroborated) ...');
    assert.notEqual(noiseAtom.precision_eligible, true,
      '... but a feedback-only noise slug with no grounded gold is NOT precision-eligible');

    // Even if a human mistakenly APPROVES the noise + opts into sensitive sharing,
    // the precision gate (precision_eligible !== true) blocks it from the brief.
    await approveAndWrite(noiseAtom.id, { lockPath });
    const r2 = readProfile();
    const out = renderSnapshot(r2.profile, {
      env: {}, includePreferences: true, shareSensitive: true,
      registry: { [noiseAtom.id]: { state: 'approved' } },
    });
    assert.doesNotMatch(out.text, /garbage|deal with/, 'a noise slug can never reach the brief');
  });
});

// ---------------------------------------------------------------------------
// (c) SELF-CORROBORATION BARRIER — a profile_influenced session must NOT be
//     re-derived: evidence_count must not climb from the injected output.
// ---------------------------------------------------------------------------
test('(c) a profile_influenced session is excluded from re-derivation (no self-corroboration)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const SPAN = 'prefer explicit error handling';
    // Two CLEAN (non-influenced) corroborations first.
    appendEdit(ijfwDir, editRow({ sessionId: 'c-a', ts: Date.UTC(2026, 2, 1), citedSpan: SPAN }));
    await cycle({ repoRoot, lockPath, sessionId: 'c-a', sessionOrdinal: 1 });
    appendEdit(ijfwDir, editRow({ sessionId: 'c-b', ts: Date.UTC(2026, 2, 10), citedSpan: SPAN }));
    await cycle({ repoRoot, lockPath, sessionId: 'c-b', sessionOrdinal: 3 });

    const mid = readProfile();
    const midAtom = mid.profile.global.dialectic.find((i) => /error handling/.test(i.subject));
    assert.ok(midAtom, 'clean corroborations minted the atom');
    const midEvidence = midAtom.evidence_count;

    // Now a PROFILE-INFLUENCED edit in the SAME direction. It must be EXCLUDED:
    // the injected brief could have PRIMED this very edit, so re-deriving from it
    // would let the profile reinforce itself. evidence_count must NOT climb.
    appendEdit(ijfwDir, editRow({
      sessionId: 'c-c', ts: Date.UTC(2026, 2, 20), citedSpan: SPAN, profileInfluenced: true,
    }));
    // Also a profile_influenced FEEDBACK row in the same session (the feedback leg
    // must be quarantined too — that was the open leak).
    appendFileSync(join(ijfwDir, '.session-feedback.jsonl'),
      `${JSON.stringify({ ts: new Date(Date.UTC(2026, 2, 20)).toISOString(), kind: 'correction', phrase: 'No,', context: `No, ${SPAN}`, session_id: 'c-c', profile_influenced: true })}\n`, 'utf8');
    const res = await cycle({ repoRoot, lockPath, sessionId: 'c-c', sessionOrdinal: 5 });
    assert.equal(res.ok, true, JSON.stringify(res));

    const after = readProfile();
    const afterAtom = after.profile.global.dialectic.find((i) => /error handling/.test(i.subject));
    assert.ok(afterAtom, 'the atom still exists');
    assert.equal(afterAtom.evidence_count, midEvidence,
      'a profile_influenced session did NOT add evidence (self-corroboration barrier holds)');
  });
});

// ---------------------------------------------------------------------------
// (c2) FEEDBACK-LEG quarantine via the QUARANTINED-SESSION set: a clean feedback
//      row in a session whose STYLE/EDIT rows were profile_influenced is excluded.
// ---------------------------------------------------------------------------
test('(c2) feedback in a session quarantined by a profile_influenced edit is excluded', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    // The edit row marks session q-1 as profile_influenced (quarantined). A
    // feedback row in q-1 WITHOUT its own influenced flag must STILL be excluded,
    // because the session is quarantined by the edit's flag.
    appendEdit(ijfwDir, editRow({
      sessionId: 'q-1', ts: Date.UTC(2026, 3, 1), citedSpan: 'something', profileInfluenced: true,
    }));
    appendFileSync(join(ijfwDir, '.session-feedback.jsonl'),
      `${JSON.stringify({ ts: new Date(Date.UTC(2026, 3, 1)).toISOString(), kind: 'preference', phrase: 'I prefer', context: 'I prefer four space indents', session_id: 'q-1', profile_influenced: false })}\n`, 'utf8');

    const res = await cycle({ repoRoot, lockPath, sessionId: 'q-1', sessionOrdinal: 1 });
    assert.equal(res.ok, true, JSON.stringify(res));

    const r = readProfile();
    const leaked = r.profile.global.dialectic.find((i) => /space indents|four space/.test(i.subject));
    assert.ok(!leaked, 'feedback from a quarantined (profile_influenced) session must not be derived');
  });
});
