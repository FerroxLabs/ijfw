// P0.7 — Audit + forget. List inferences with provenance; forget(id|pattern)
// purges an inference (and, when the egress log exists in P4, its egress
// entries). P0 tests the inference removal; the egress purge is a designed-in
// no-op stub until the egress log lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listInferences,
  forget,
  forgetAndWrite,
} from '../src/profile/audit.js';
import { makeProfile, makeInference } from '../src/profile/schema.js';
import { applyDelta, mergeAndWrite } from '../src/profile/merge.js';
import { readProfile } from '../src/profile/store.js';

function profileWithInferences() {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [
      makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5, source_sessions: ['s1'], source_hosts: ['claude'] }),
      makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4, source_sessions: ['s2'], source_hosts: ['cursor'] }),
    ],
    overlays: { 'project:ijfw': { inferences: [makeInference({ kind: 'trait', subject: 'tooling', value: 'cli', confidence: 0.6, evidence_count: 3, source_sessions: ['s3'], source_hosts: ['hermes'] })] } },
  });
  return p;
}

test('listInferences returns every inference with provenance + scope', () => {
  const p = profileWithInferences();
  const rows = listInferences(p);
  assert.equal(rows.length, 3, 'global (2) + overlay (1)');
  for (const r of rows) {
    assert.ok(r.id);
    assert.ok(typeof r.confidence === 'number');
    assert.ok(Array.isArray(r.source_sessions));
    assert.ok(Array.isArray(r.source_hosts));
    assert.ok(r.scope, 'scope present (global or overlay:<key>)');
  }
  const scopes = rows.map((r) => r.scope);
  assert.ok(scopes.includes('global'));
  assert.ok(scopes.some((s) => s.startsWith('overlay:')));
});

test('forget by exact id removes that inference (and reports the removals)', () => {
  const p = profileWithInferences();
  const targetId = 'trait::comm';
  const { profile: next, removed } = forget(p, targetId);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, targetId);
  assert.ok(!listInferences(next).some((r) => r.id === targetId), 'gone from live set');
  // the other two survive
  assert.equal(listInferences(next).length, 2);
  // input not mutated
  assert.equal(listInferences(p).length, 3);
});

test('forget by RegExp pattern removes all matching inferences across scopes', () => {
  const p = profileWithInferences();
  const { profile: next, removed } = forget(p, /trait::/);
  assert.equal(removed.length, 2, 'both trait inferences (global + overlay) removed');
  const ids = removed.map((r) => r.id).sort();
  assert.deepEqual(ids, ['trait::comm', 'trait::tooling']);
  assert.equal(listInferences(next).length, 1, 'only the preference survives');
});

test('forget by substring pattern matches on id', () => {
  const p = profileWithInferences();
  const { removed } = forget(p, 'tests');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, 'preference::tests');
});

test('forget on a non-matching pattern removes nothing', () => {
  const p = profileWithInferences();
  const { profile: next, removed } = forget(p, 'no-such-thing');
  assert.equal(removed.length, 0);
  assert.equal(listInferences(next).length, 3);
});

// --- persisted forget ---

function freshDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-audit-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-audit-s-'));
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

test('forgetAndWrite persists the removal to disk under the lock', async () => {
  await freshDirs(async ({ lockPath }) => {
    await mergeAndWrite({
      inferences: [
        makeInference({ kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8, evidence_count: 5 }),
        makeInference({ kind: 'preference', subject: 'tests', value: 'TDD', confidence: 0.7, evidence_count: 4 }),
      ],
    }, { lockPath });

    const res = await forgetAndWrite('trait::comm', { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.removed.length, 1);

    const r = readProfile();
    assert.ok(!r.profile.global.dialectic.some((x) => x.id === 'trait::comm'), 'persisted removal');
    assert.ok(r.profile.global.dialectic.some((x) => x.id === 'preference::tests'), 'other survived');
  });
});

test('forget purges egress entries when an egress log exists (P0 stub: no-op)', () => {
  // P4 lands the egress log; in P0 forget must be DESIGNED to also remove egress
  // entries. With no egress log present, egressRemoved is 0 and forget still
  // removes the inference — proving the hook exists without depending on P4.
  const p = profileWithInferences();
  const { removed, egressRemoved } = forget(p, 'trait::comm');
  assert.equal(removed.length, 1);
  assert.equal(egressRemoved, 0, 'no egress log yet -> nothing to purge (stub)');
});
