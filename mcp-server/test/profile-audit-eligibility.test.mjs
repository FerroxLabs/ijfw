// S3 — human-in-the-loop inject-eligibility + right-to-be-forgotten completeness.
//
// An atom is NOT inject-eligible until a human APPROVES it (the gate Cursor
// abandoned). listInferences surfaces each atom with its citation + an
// inject_eligible flag; injectEligibleIds() is the single source of truth that
// render-brief/serve (S5) consult. forget purges the atom AND its egress AND its
// approval record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listInferences,
  injectEligibleIds,
  setApprovalState,
  setApprovalAndWrite,
  approveAndWrite,
  rejectAndWrite,
  readApprovals,
  approvalsPath,
  forgetAndWrite,
} from '../src/profile/audit.js';
import { appendEgress, readEgress } from '../src/profile/egress.js';
import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta, mergeAndWrite } from '../src/profile/merge.js';
import { readProfile } from '../src/profile/store.js';

function profileWithInferences() {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s1'], source_hosts: ['claude'] }),
      makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5, source_sessions: ['s2'], source_hosts: ['cursor'] }),
    ],
  });
  return p;
}

// --- pure: eligibility gate ---

test('a newly-derived atom is NOT inject-eligible until approved (fail-closed)', () => {
  const p = profileWithInferences();
  // No registry -> every atom pending, none eligible.
  const rows = listInferences(p);
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.approval_state, 'pending', `${r.id} defaults to pending`);
    assert.equal(r.inject_eligible, false, `${r.id} not eligible without approval`);
    assert.ok(r.citation, 'citation surfaced');
    assert.ok(r.citation.has_locator, 'these atoms carry a session/host locator');
  }
  assert.equal(injectEligibleIds(p).size, 0, 'nothing eligible by default');
});

test('approving an atom makes ONLY that atom inject-eligible', () => {
  const p = profileWithInferences();
  const reg = setApprovalState({}, 'preference::tests', 'approved');
  const rows = listInferences(p, reg);
  const tests = rows.find((r) => r.id === 'preference::tests');
  const comm = rows.find((r) => r.id === 'trait::comm');
  assert.equal(tests.approval_state, 'approved');
  assert.equal(tests.inject_eligible, true);
  assert.equal(comm.inject_eligible, false, 'unapproved atom stays ineligible');
  const ids = injectEligibleIds(p, reg);
  assert.deepEqual([...ids], ['preference::tests']);
});

test('a REJECTED atom is not inject-eligible', () => {
  const p = profileWithInferences();
  const reg = setApprovalState({}, 'preference::tests', 'rejected');
  const ids = injectEligibleIds(p, reg);
  assert.equal(ids.has('preference::tests'), false);
  const row = listInferences(p, reg).find((r) => r.id === 'preference::tests');
  assert.equal(row.approval_state, 'rejected');
  assert.equal(row.inject_eligible, false);
});

test('a citation-less atom can NEVER be inject-eligible, even if approved', () => {
  // An atom with no source session/host has no locator -> cite-or-drop.
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [makeInference({ kind: 'preference', subject: 'orphan', value: 'x', confidence: 0.9, evidence_count: 9 })],
  });
  const reg = setApprovalState({}, 'preference::orphan', 'approved');
  const row = listInferences(p, reg).find((r) => r.id === 'preference::orphan');
  assert.equal(row.citation.has_locator, false, 'no session/host -> no locator');
  assert.equal(row.inject_eligible, false, 'approval cannot override a missing citation');
  assert.equal(injectEligibleIds(p, reg).size, 0);
});

test('citation surfaces a verbatim span only when the atom carries one (never fabricated)', () => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [makeInference({ kind: 'preference', subject: 'spanned', value: 'x', confidence: 0.7, evidence_count: 3, source_sessions: ['s1'] })],
  });
  // Atom with no cite field -> span null.
  let row = listInferences(p).find((r) => r.id === 'preference::spanned');
  assert.equal(row.citation.span, null, 'no cite field -> null span, not invented');
  // Forward-compat: an atom that DOES carry a cite span surfaces it.
  p.global.dialectic[0].cite = 'no, use httpx not requests';
  row = listInferences(p).find((r) => r.id === 'preference::spanned');
  assert.equal(row.citation.span, 'no, use httpx not requests');
});

test('setApprovalState is pure and rejects an unknown state', () => {
  const reg0 = {};
  const reg1 = setApprovalState(reg0, 'preference::tests', 'approved');
  assert.deepEqual(reg0, {}, 'input registry not mutated');
  assert.equal(reg1['preference::tests'].state, 'approved');
  assert.ok(reg1['preference::tests'].ts, 'timestamp stamped');
  assert.throws(() => setApprovalState({}, 'x', 'maybe'), /state must be one of/);
  assert.throws(() => setApprovalState({}, '', 'approved'), /non-empty/);
});

// --- persisted: approve/reject + forget purges approvals ---

function freshDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-elig-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-elig-s-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  return Promise.resolve(fn({ pdir, sdir, lockPath: join(sdir, '.profile.lock') }))
    .finally(() => {
      if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
      if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
      rmSync(pdir, { recursive: true, force: true });
      rmSync(sdir, { recursive: true, force: true });
    });
}

test('approveAndWrite persists the approval; the atom then reads inject-eligible from disk', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s1'], source_hosts: ['claude'] })],
    }, { lockPath });

    const res = await approveAndWrite('preference::tests', { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));

    const reg = readApprovals().registry;
    assert.equal(reg['preference::tests'].state, 'approved');

    const ids = injectEligibleIds(readProfile().profile, reg);
    assert.ok(ids.has('preference::tests'), 'persisted approval grants eligibility');
  });
});

test('setApprovalAndWrite refuses to approve an id that does not exist in the profile', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s1'] })],
    }, { lockPath });
    const res = await approveAndWrite('preference::forged', { lockPath });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ENOATOM', JSON.stringify(res));
    assert.equal(existsSync(approvalsPath()), false, 'no registry written for a forged id');
  });
});

test('setApprovalAndWrite refuses to APPROVE a citation-less atom (cite-or-drop)', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'orphan', value: 'x', confidence: 0.9, evidence_count: 9 })],
    }, { lockPath });
    const res = await approveAndWrite('preference::orphan', { lockPath });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'ENOCITATION', JSON.stringify(res));
  });
});

test('rejectAndWrite persists a rejection (and is allowed even without a citation locator)', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'orphan', value: 'x', confidence: 0.9, evidence_count: 9 })],
    }, { lockPath });
    const res = await rejectAndWrite('preference::orphan', { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(readApprovals().registry['preference::orphan'].state, 'rejected');
  });
});

test('forget purges the atom, its egress entries, AND its approval record', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [
        makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s1'], source_hosts: ['claude'] }),
        makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5, source_sessions: ['s2'], source_hosts: ['claude'] }),
      ],
    }, { lockPath });

    // Approve the atom (creates an approval record) and log an egress entry that
    // leaked it (creates an egress record referencing it).
    await approveAndWrite('preference::tests', { lockPath });
    appendEgress({ host: 'cursor', session: 'sX', fields: ['preference::tests', 'style:formality'] });

    assert.equal(readApprovals().registry['preference::tests'].state, 'approved');
    assert.equal(readEgress().entries.length, 1);

    const res = await forgetAndWrite('preference::tests', { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.removed.length, 1, 'one inference removed');
    assert.equal(res.egressRemoved, 1, 'the leaking egress entry purged');
    assert.equal(res.approvalsRemoved, 1, 'the approval record purged');

    // Atom gone from profile.
    assert.ok(!readProfile().profile.global.dialectic.some((x) => x.id === 'preference::tests'));
    // Approval record gone.
    assert.equal(readApprovals().registry['preference::tests'], undefined, 'no stale approval left behind');
    // Egress entry gone.
    assert.equal(readEgress().entries.length, 0, 'egress trail of the forgotten atom expunged');
    // The other atom + its (absent) records are untouched.
    assert.ok(readProfile().profile.global.dialectic.some((x) => x.id === 'trait::comm'));
  });
});

test('a re-derived id does NOT inherit a stale approval after forget', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s1'] })],
    }, { lockPath });
    await approveAndWrite('preference::tests', { lockPath });
    await forgetAndWrite('preference::tests', { lockPath });

    // Re-derive the SAME id.
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s9'] })],
    }, { lockPath });

    const reg = readApprovals().registry;
    const ids = injectEligibleIds(readProfile().profile, reg);
    assert.equal(ids.has('preference::tests'), false, 're-derived atom is pending again, not silently approved');
  });
});
