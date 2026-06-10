// P0.5 — read-merge-write applyDelta (CRDT-ish, never clobber).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyDelta, wilsonLowerBound, mergeAndWrite } from '../src/profile/merge.js';
import { makeProfile, makeInference } from '../src/profile/schema.js';
import { readProfile } from '../src/profile/store.js';

// --- pure applyDelta ---

test('applyDelta EMA-folds a style sample and updates Beta', () => {
  const p = makeProfile();
  const before = p.global.style.terseness.ema; // 0.5
  const next = applyDelta(p, { style: { terseness: { sample: 1.0, weight: 1 } } });
  const a = next.global.style.terseness;
  assert.ok(a.ema > before && a.ema < 1.0, 'EMA moves toward the sample, bounded');
  assert.ok(a.evidence_count >= 1);
  assert.ok(a.alpha + a.beta > 2, 'Beta mass increased');
  // input profile is not mutated (pure)
  assert.equal(p.global.style.terseness.ema, before);
});

test('applyDelta evidence-accumulates inferences (sum counts, union sources, max recency)', () => {
  let p = makeProfile();
  p = applyDelta(p, {
    inferences: [makeInference({
      kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.6,
      evidence_count: 2, source_sessions: ['s1'], source_hosts: ['claude'],
      last_confirmed: '2026-06-01T00:00:00.000Z',
    })],
  });
  p = applyDelta(p, {
    inferences: [makeInference({
      kind: 'trait', subject: 'comm', value: 'terse', confidence: 0.8,
      evidence_count: 3, source_sessions: ['s2'], source_hosts: ['cursor'],
      last_confirmed: '2026-06-05T00:00:00.000Z',
    })],
  });
  assert.equal(p.global.dialectic.length, 1, 'same id deduped to one atom');
  const inf = p.global.dialectic[0];
  assert.equal(inf.evidence_count, 5, 'evidence_count summed');
  assert.deepEqual([...inf.source_sessions].sort(), ['s1', 's2']);
  assert.deepEqual([...inf.source_hosts].sort(), ['claude', 'cursor']);
  assert.equal(inf.last_confirmed, '2026-06-05T00:00:00.000Z', 'max recency wins');
  assert.equal(inf.confidence, 0.8, 'max confidence retained');
});

test('applyDelta accumulates expertise and recomputes Wilson lower bound', () => {
  let p = makeProfile();
  p = applyDelta(p, { expertise: { rust: { accepts: 4, n: 5 } } });
  p = applyDelta(p, { expertise: { rust: { accepts: 4, n: 5 } } });
  const e = p.expertise.rust;
  assert.equal(e.accepts, 8);
  assert.equal(e.n, 10);
  assert.ok(Math.abs(e.wilsonLB - wilsonLowerBound(8, 10)) < 1e-9);
  assert.ok(e.wilsonLB > 0 && e.wilsonLB < 0.8);
});

test('applyDelta merges overlays without touching the global layer', () => {
  let p = makeProfile();
  const globalBefore = p.global.style.terseness.ema;
  p = applyDelta(p, { overlays: { 'project:ijfw': { style: { terseness: { sample: 1, weight: 1 } } } } });
  assert.ok(p.overlays['project:ijfw'], 'overlay created');
  assert.ok(p.overlays['project:ijfw'].style.terseness.ema > 0.5);
  assert.equal(p.global.style.terseness.ema, globalBefore, 'global untouched');
});

test('merge is commutative on disjoint fields', () => {
  const base = makeProfile();
  const dStyle = { style: { formality: { sample: 0.9, weight: 1 } } };
  const dExp = { expertise: { go: { accepts: 3, n: 4 } } };
  const ab = applyDelta(applyDelta(base, dStyle), dExp);
  const ba = applyDelta(applyDelta(base, dExp), dStyle);
  assert.deepEqual(ab.global.style.formality, ba.global.style.formality);
  assert.deepEqual(ab.expertise, ba.expertise);
  // provenance.updated must ALSO be order-independent (option a): it is the MAX
  // (most-recent) content-derived recency signal, never a wall-clock stamp —
  // otherwise two disjoint merges in different orders differ on this field,
  // violating the module's "commutative on disjoint fields" guarantee.
  assert.equal(ab.provenance.updated, ba.provenance.updated,
    'provenance.updated is commutative (content-derived MAX recency, not wall-clock)');
});

test('provenance.updated is the MAX recency of delta provenance + inference confirmations', () => {
  const base = makeProfile(); // provenance.updated defaults to epoch
  const tEarly = '2026-06-01T00:00:00.000Z';
  const tLate = '2026-06-05T00:00:00.000Z';
  // A delta carrying an explicit provenance.updated and an inference whose
  // last_confirmed is MORE recent: the inference recency must win.
  const next = applyDelta(base, {
    provenance: { updated: tEarly },
    inferences: [makeInference({
      kind: 'trait', subject: 'comm', value: 'terse', last_confirmed: tLate,
    })],
  });
  assert.equal(next.provenance.updated, tLate, 'most-recent confirmation drives updated');
  // An older delta provenance must NOT regress an already-newer profile value.
  const back = applyDelta(next, { provenance: { updated: tEarly } });
  assert.equal(back.provenance.updated, tLate, 'updated never moves backward (monotonic MAX)');
});

test('wilsonLowerBound is conservative (below the naive ratio) and bounded', () => {
  assert.ok(wilsonLowerBound(8, 10) < 0.8);
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(10, 10) < 1 && wilsonLowerBound(10, 10) > 0.6);
});

// --- mergeAndWrite (read-merge-write under the lock) ---

function freshDirs(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-merge-p-'));
  const sdir = mkdtempSync(join(tmpdir(), 'ijfw-merge-s-'));
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

test('mergeAndWrite persists a delta to disk under the lock', async () => {
  await freshDirs(async ({ lockPath }) => {
    const res = await mergeAndWrite({ expertise: { rust: { accepts: 4, n: 5 } } }, { lockPath });
    assert.equal(res.ok, true, JSON.stringify(res));
    const r = readProfile();
    assert.equal(r.ok, true);
    assert.equal(r.profile.expertise.rust.n, 5);
  });
});

test('two concurrent mergeAndWrite deltas from 2 sessions BOTH land (no lost update)', async () => {
  await freshDirs(async ({ lockPath }) => {
    await Promise.all([
      mergeAndWrite({ expertise: { rust: { accepts: 1, n: 1 } } }, { lockPath }),
      mergeAndWrite({ expertise: { go: { accepts: 1, n: 1 } } }, { lockPath }),
    ]);
    const r = readProfile();
    assert.equal(r.ok, true);
    assert.ok(r.profile.expertise.rust, 'rust delta landed');
    assert.ok(r.profile.expertise.go, 'go delta landed');
  });
});

test('concurrent deltas to the SAME field accumulate (read-merge-write, not clobber)', async () => {
  await freshDirs(async ({ lockPath }) => {
    await Promise.all([
      mergeAndWrite({ expertise: { rust: { accepts: 1, n: 1 } } }, { lockPath }),
      mergeAndWrite({ expertise: { rust: { accepts: 1, n: 1 } } }, { lockPath }),
      mergeAndWrite({ expertise: { rust: { accepts: 1, n: 1 } } }, { lockPath }),
    ]);
    const r = readProfile();
    assert.equal(r.profile.expertise.rust.n, 3, 'all three accumulated, none lost');
  });
});
