// Audit/forget + invocation-surface security tests (adversarial audit fixes).
//
// Covers:
//   HIGH-2  forget(pattern) ReDoS guard + exact/segment string matcher
//   M2      profile.forget / profile.audit verbs reachable via ijfw_brain
//
// node:test sets NODE_TEST_CONTEXT so the IJFW_PROFILE_DIR / _STATE_DIR
// overrides are honored verbatim by path-policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  forget, forgetAndWrite, validatePattern,
} from '../src/profile/audit.js';
import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta, mergeAndWrite } from '../src/profile/merge.js';
import { readProfile } from '../src/profile/store.js';
import { handleIjfwBrain } from '../src/handlers/brain-handler.js';

function profileWith() {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5 }),
      makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4 }),
      makeInference({ kind: 'preference', subject: 'editor', value: 'vim', confidence: 0.7, evidence_count: 4 }),
    ],
  });
  return p;
}

async function withDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-audsec-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-audsec-s-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  const prevS = process.env.IJFW_PROFILE_STATE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  process.env.IJFW_PROFILE_STATE_DIR = sdir;
  try {
    return await fn({ pdir, sdir, lockPath: join(sdir, '.profile.lock') });
  } finally {
    if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
    if (prevS === undefined) delete process.env.IJFW_PROFILE_STATE_DIR; else process.env.IJFW_PROFILE_STATE_DIR = prevS;
    rmSync(pdir, { recursive: true, force: true });
    rmSync(sdir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// HIGH-2 — ReDoS guard + safe string matcher.
// ---------------------------------------------------------------------------

test('HIGH-2 a pathological nested-quantifier regex is rejected by validatePattern', () => {
  const evil = /(a+)+$/;
  const v = validatePattern(evil);
  assert.equal(v.ok, false, 'nested quantifier rejected');
  assert.equal(v.code, 'EPATTERN_UNSAFE');
});

test('HIGH-2 an over-long regex source is rejected', () => {
  const long = new RegExp('a'.repeat(250));
  const v = validatePattern(long);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'EPATTERN_TOO_LONG');
});

test('HIGH-2 forgetAndWrite rejects an unsafe regex BEFORE the lock (no hang)', async () => {
  await withDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5 })],
    }, { lockPath });
    // The classic catastrophic-backtracking source. The guard must reject it
    // fast (well under any hang) rather than run .test() under the lock.
    const start = Date.now();
    const r = await forgetAndWrite(/(x+x+)+y$/, { lockPath });
    const elapsed = Date.now() - start;
    assert.equal(r.ok, false, 'unsafe regex rejected');
    assert.equal(r.code, 'EPATTERN_UNSAFE');
    assert.ok(elapsed < 1000, `rejection must be fast (was ${elapsed}ms)`);
    // The profile is untouched.
    const after = readProfile();
    assert.ok(after.profile.global.dialectic.some((x) => x.id === 'trait::comm'));
  });
});

test('HIGH-2 forget("e") does NOT delete every inference containing "e"', () => {
  const p = profileWith();
  // ids: trait::comm, preference::tests, preference::editor — all contain "e".
  const { removed } = forget(p, 'e');
  assert.equal(removed.length, 0, 'bare-letter substring no longer over-deletes');
});

test('HIGH-2 exact-id forget still works', () => {
  const p = profileWith();
  const { removed } = forget(p, 'preference::tests');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 'preference::tests');
});

test('HIGH-2 kind-prefix forget removes all of that kind', () => {
  const p = profileWith();
  const { removed } = forget(p, 'preference');
  const ids = removed.map((r) => r.id).sort();
  assert.deepEqual(ids, ['preference::editor', 'preference::tests']);
});

test('HIGH-2 subject-segment forget matches the ::subject tail', () => {
  const p = profileWith();
  const { removed } = forget(p, 'editor');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 'preference::editor');
});

test('HIGH-2 a safe RegExp pattern still matches', () => {
  const p = profileWith();
  const { removed } = forget(p, /^preference::/);
  assert.equal(removed.length, 2, 'both preference inferences');
});

// ---------------------------------------------------------------------------
// M2 — profile.forget / profile.audit invocation surface.
// ---------------------------------------------------------------------------

test('M2 profile.audit verb lists inferences with provenance', async () => {
  await withDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [
        makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5, source_sessions: ['s1'], source_hosts: ['claude'] }),
      ],
    }, { lockPath });
    const r = await handleIjfwBrain({ verb: 'profile.audit', args: {} });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.inferences));
    assert.equal(r.inferences.length, 1);
    const row = r.inferences[0];
    assert.equal(row.id, 'trait::comm');
    assert.ok(row.scope, 'provenance scope present');
    assert.ok(Array.isArray(row.source_sessions));
    assert.ok(Array.isArray(row.source_hosts));
  });
});

test('M2 profile.forget verb removes a matching inference', async () => {
  await withDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [
        makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5 }),
        makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4 }),
      ],
    }, { lockPath });
    const r = await handleIjfwBrain({ verb: 'profile.forget', args: { id: 'trait::comm' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.removedCount, 1);
    assert.equal(r.removed[0].id, 'trait::comm');
    // Persisted.
    const after = readProfile();
    assert.ok(!after.profile.global.dialectic.some((x) => x.id === 'trait::comm'), 'removed from disk');
    assert.ok(after.profile.global.dialectic.some((x) => x.id === 'preference::tests'), 'other survived');
  });
});

test('M2 profile.forget verb reports egressRemoved (purges the egress ledger too)', async () => {
  await withDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'preference', subject: 'leak', value: { phrase: 'served then forgotten' }, confidence: 0.9, evidence_count: 5, sensitivity: 'low' })],
    }, { lockPath });
    // Serve a brief so the field lands in the egress ledger.
    const served = await handleIjfwBrain({ verb: 'profile.brief', args: { context: { host: 'h' } }, env: process.env });
    assert.ok(served.fields.includes('preference::leak'));
    // Forget it -> its egress entry is purged.
    const r = await handleIjfwBrain({ verb: 'profile.forget', args: { id: 'preference::leak' } });
    assert.equal(r.ok, true);
    assert.equal(r.removedCount, 1);
    assert.equal(r.egressRemoved, 1, 'egress entry that leaked the forgotten id is purged');
  });
});

test('M2 profile.forget verb rejects an unsafe regex (ReDoS guard at the verb)', async () => {
  await withDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5 })],
    }, { lockPath });
    const r = await handleIjfwBrain({ verb: 'profile.forget', args: { regex: '(a+)+$' } });
    assert.equal(r.ok, false, 'unsafe regex rejected at the verb boundary');
    assert.equal(r.error, 'EPATTERN_UNSAFE');
  });
});

test('M2 profile.forget verb with no pattern returns missing-pattern', async () => {
  const r = await handleIjfwBrain({ verb: 'profile.forget', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing-pattern');
});

test('M2 profile.audit cold start (no profile) returns empty, no error', async () => {
  await withDirs(async () => {
    const r = await handleIjfwBrain({ verb: 'profile.audit', args: {} });
    assert.equal(r.ok, true);
    assert.deepEqual(r.inferences, []);
  });
});
