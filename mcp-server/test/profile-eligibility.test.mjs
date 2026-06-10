// FIX 3 (HIGH-3) — global eligibility must be FAIL-CLOSED and identity-bound.
//
// Before the fix, profileDeriveStage admitted any row whose
// `global_eligible !== false` (absent / "false" / 0 all passed) and trusted the
// row's self-asserted `identity`. A hand-written / injected JSONL row could
// therefore poison the cross-machine GLOBAL profile.
//
// After the fix a row reaches the GLOBAL merge ONLY if:
//   (a) global_eligible === true   (strict boolean — absent/non-bool excluded), AND
//   (b) row.identity === computeIdentity({env}).identity of the merging machine.
// Every exclusion is COUNTED + LOGGED (mirrors SEAM-2), never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profileDeriveStage } from '../src/dream/runner.mjs';
import { readProfile } from '../src/profile/store.js';
import { computeIdentity } from '../src/profile/capture.js';

function withFixtures(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ijfw-elig-repo-'));
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-elig-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-elig-s-'));
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
  return Promise.resolve(fn({ repoRoot, ijfwDir, lockPath: join(sdir, '.profile.lock') })).finally(restore);
}
function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const ENV = { USER: 'elig-tester', IJFW_IDENTITY_SALT: 'elig-salt' };
const ID = computeIdentity({ env: ENV }).identity;

function row(i, over = {}) {
  return {
    session_id: `s${i}`, host: 'claude',
    ts: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
    avg_msg_chars: 38, emoji_rate: 0, code_block_ratio: 0.6,
    formality_markers: 0.2, turn_cadence_s: 12, msg_count: 18,
    global_eligible: true, profile_influenced: false,
    identity: ID, trust_weight: 1.0, delta_cap: 0.25,
    ...over,
  };
}

test('FIX3: a clean eligible+matching-identity row IS admitted to the global merge', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [row(0), row(1)]);
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1', log: () => {}, lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(readProfile().profile.global.style.terseness.evidence_count >= 1,
      'clean, matching-identity rows were folded');
  });
});

test('FIX3: a row with global_eligible OMITTED is EXCLUDED (fail-closed default)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const r = row(0);
    delete r.global_eligible; // absent -> must NOT default to eligible
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [r]);
    const logs = [];
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's0',
      log: (m) => logs.push(m), lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(readProfile().profile.global.style.terseness.evidence_count, 0,
      'absent global_eligible must be excluded, not admitted');
    assert.ok(logs.some((l) => /exclud/i.test(l)), 'exclusion was LOGGED (not silent)');
  });
});

test('FIX3: a row with a non-boolean global_eligible ("true"/1) is EXCLUDED', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [
      row(0, { global_eligible: 'true' }), row(1, { global_eligible: 1 }),
    ]);
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1', log: () => {}, lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(readProfile().profile.global.style.terseness.evidence_count, 0,
      'a forgeable non-boolean global_eligible must not pass the strict gate');
  });
});

test('FIX3: a row with a FOREIGN/mismatched identity is EXCLUDED (cannot poison cross-machine)', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [
      row(0, { identity: 'deadbeefdeadbeefdeadbeef' }),
      row(1, { identity: ID }), // one matching control
    ]);
    const logs = [];
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's1',
      log: (m) => logs.push(m), lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    // Exactly the matching row contributes evidence (1), not the foreign one.
    assert.equal(readProfile().profile.global.style.terseness.evidence_count, 1,
      'only the matching-identity row is folded; the foreign row is excluded');
    assert.ok(logs.some((l) => /identit/i.test(l)), 'identity-mismatch exclusion was LOGGED');
  });
});

test('FIX3: a row missing identity entirely is EXCLUDED', async () => {
  await withFixtures(async ({ repoRoot, ijfwDir, lockPath }) => {
    const r = row(0);
    delete r.identity;
    writeJsonl(join(ijfwDir, '.session-style.jsonl'), [r]);
    const res = await profileDeriveStage({
      projectRoot: repoRoot, host: 'claude', sessionId: 's0', log: () => {}, lockPath, env: ENV,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(readProfile().profile.global.style.terseness.evidence_count, 0,
      'a row with no identity cannot be bound to the merging machine -> excluded');
  });
});
