// FIX 1 (C1/C2/M3) — derivation must consume each captured row EXACTLY ONCE.
//
// The audit's load-bearing regression: profileDeriveStage read the WHOLE
// append-only .session-style.jsonl (+ .session-feedback.jsonl) every dream
// cycle, while capture only ever appends. So a row was folded again on cycle
// 2,3,…N: evidence_count inflated (false "confirmed" at >=5) and the per-session
// anti-drift guarantees were defeated because the same row re-amplified.
//
// The fix is a persisted per-stream CURSOR (safer than truncation — no data loss
// on merge failure): each cycle folds ONLY rows newer than the cursor, and the
// cursor advances ONLY after mergeAndWrite succeeds. These tests pin that
// behaviour with a REAL multi-cycle run against an UNCHANGED stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profileDeriveStage } from '../src/dream/runner.mjs';
import { readProfile } from '../src/profile/store.js';

// Isolate the GLOBAL profile + lock + dream state into temp dirs per case.
function withFixtures(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ijfw-cursor-repo-'));
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-cursor-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-cursor-s-'));
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
function appendJsonl(path, rows) {
  appendFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// A clean, GLOBAL-eligible style row. identity is left to the env (env:{} ->
// resolveOsUser empty -> these tests instead pass env that yields a matching
// identity via the helper below). For cursor tests we want rows to be ADMITTED,
// so we mark them eligible and stamp the SAME identity the stage will compute.
import { computeIdentity } from '../src/profile/capture.js';

function styleRow(i, identity) {
  return {
    session_id: `s${i}`, host: 'claude',
    ts: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
    avg_msg_chars: 38, emoji_rate: 0, code_block_ratio: 0.6,
    formality_markers: 0.2, turn_cadence_s: 12, msg_count: 18,
    global_eligible: true, profile_influenced: false,
    identity, trust_weight: 1.0, delta_cap: 0.25,
  };
}

// A fixed env whose computed identity we can pre-stamp onto rows so FIX 3's
// fail-closed identity check admits them.
const ENV = { USER: 'cursor-tester', IJFW_IDENTITY_SALT: 'cursor-test-salt' };
const ID = computeIdentity({ env: ENV }).identity;

test('FIX1: a SECOND derive cycle over an UNCHANGED style stream is a no-op (evidence_count does NOT double)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'),
      [styleRow(0, ID), styleRow(1, ID), styleRow(2, ID)]);

    const common = { projectRoot: repoRoot, host: 'claude', sessionId: 's2', log: () => {}, lockPath, env: ENV };

    const r1 = await profileDeriveStage(common);
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const afterCycle1 = readProfile().profile.global.style.terseness.evidence_count;
    assert.ok(afterCycle1 >= 1, 'cycle 1 folded the style rows');

    // SECOND cycle, NOTHING changed in the stream.
    const r2 = await profileDeriveStage(common);
    assert.equal(r2.ok, true, JSON.stringify(r2));
    const afterCycle2 = readProfile().profile.global.style.terseness.evidence_count;

    assert.equal(afterCycle2, afterCycle1,
      'evidence_count must NOT grow on a re-read of already-consumed rows (one-fold-per-row)');
  });
});

test('FIX1: axis EMA does NOT re-amplify on the 2nd cycle (anti-drift preserved)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    // Strongly terse rows; the EMA should move once, then hold on re-read.
    writeJsonl(join(ijfwDir, '.session-style.jsonl'),
      [styleRow(0, ID), styleRow(1, ID), styleRow(2, ID), styleRow(3, ID)]);
    const common = { projectRoot: repoRoot, host: 'claude', sessionId: 's3', log: () => {}, lockPath, env: ENV };

    await profileDeriveStage(common);
    const ema1 = readProfile().profile.global.style.terseness.ema;
    await profileDeriveStage(common);
    const ema2 = readProfile().profile.global.style.terseness.ema;

    assert.equal(ema2, ema1, 'EMA must not move on a no-op re-read cycle');
  });
});

test('FIX1: appending NEW rows makes the next cycle non-trivial; with no new rows it is a no-op', async () => {
  // The heuristic style FLOOR folds the CURRENT session metadata (the most-recent
  // unconsumed row) once per cycle, so a productive cycle advances evidence_count
  // by exactly 1. The load-bearing property is the CONTRAST: a cycle with fresh
  // rows advances (=1), a cycle with NO fresh rows does NOT (=0). Before the fix
  // BOTH advanced (the whole append-only file was re-folded every cycle).
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const stylePath = join(ijfwDir, '.session-style.jsonl');
    writeJsonl(stylePath, [styleRow(0, ID), styleRow(1, ID)]);
    const common = { projectRoot: repoRoot, host: 'claude', sessionId: 'sN', log: () => {}, lockPath, env: ENV };

    await profileDeriveStage(common);
    const ec1 = readProfile().profile.global.style.terseness.evidence_count;

    // Append genuinely NEW sessions (newer ts than the cursor) -> productive cycle.
    appendJsonl(stylePath, [styleRow(5, ID), styleRow(6, ID)]);
    await profileDeriveStage(common);
    const ec2 = readProfile().profile.global.style.terseness.evidence_count;
    assert.equal(ec2 - ec1, 1, 'a cycle with fresh rows folds the new metadata (advances by 1)');

    // No new rows appended -> the NEXT cycle must be a strict no-op (cursor holds).
    await profileDeriveStage(common);
    const ec3 = readProfile().profile.global.style.terseness.evidence_count;
    assert.equal(ec3, ec2, 'a cycle with no fresh rows does NOT re-fold already-consumed rows');
  });
});

test('FIX1: on merge FAILURE the cursor does NOT advance — rows are retried next cycle', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const stylePath = join(ijfwDir, '.session-style.jsonl');
    writeJsonl(stylePath, [styleRow(0, ID), styleRow(1, ID)]);

    // First cycle: force the merge to fail. Cursor must NOT advance.
    let calls = 0;
    const failingMerge = async () => { calls += 1; return { ok: false, code: 'ETEST' }; };
    const r1 = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1', log: () => {},
      lockPath, env: ENV, _mergeAndWrite: failingMerge,
    });
    assert.equal(r1.ok, false, 'forced merge failure surfaces');
    assert.equal(calls, 1, 'a merge was attempted (rows were present, not pre-filtered)');

    // Second cycle with the REAL merge: the same rows must STILL be folded (the
    // cursor never advanced past a failed merge), so the profile gains evidence.
    const r2 = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1', log: () => {}, lockPath, env: ENV,
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.ok(readProfile().profile.global.style.terseness.evidence_count >= 1,
      'rows un-consumed by the failed cycle are folded on retry (no data loss)');
  });
});

test('FIX1: feedback rows are also consumed exactly once across cycles', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [styleRow(0, ID), styleRow(1, ID)]);
    writeJsonl(join(ijfwDir, '.session-feedback.jsonl'), [
      { ts: new Date(Date.UTC(2026, 5, 2)).toISOString(), kind: 'correction',
        phrase: 'use tabs not spaces', context: '' },
    ]);
    const common = { projectRoot: repoRoot, host: 'claude', sessionId: 's1', log: () => {}, lockPath, env: ENV };

    await profileDeriveStage(common);
    const ec1 = readProfile().profile.global.dialectic.find((i) => /tabs/.test(i.subject)).evidence_count;
    await profileDeriveStage(common);
    const ec2 = readProfile().profile.global.dialectic.find((i) => /tabs/.test(i.subject)).evidence_count;

    assert.equal(ec2, ec1,
      'a feedback row already consumed must NOT re-accumulate evidence on the next cycle');
  });
});
