// S3 — repeat-correction telemetry: the no-judge behavioral proof.
//
// Per-slug re-correction counts bucketed by SESSION-AGE, and a drop curve that
// bends toward zero when injecting a learned preference works (3x in week 1 ->
// 0x by week 4). Pure compute (bucketByAge / dropCurve) is IO-free; the
// append/read ledger mirrors egress.js discipline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bucketByAge,
  dropCurve,
  recordRecorrection,
  readRecorrections,
  recorrectionsLogPath,
  DEFAULT_BUCKET_DAYS,
} from '../src/profile/telemetry.js';

// --- pure: bucketByAge ---

test('bucketByAge buckets per-slug re-corrections by age, dense + zero-filled', () => {
  const events = [
    { slug: 'httpx-over-requests', age_days: 0 },   // week 0
    { slug: 'httpx-over-requests', age_days: 1 },   // week 0
    { slug: 'httpx-over-requests', age_days: 8 },   // week 1
    { slug: 'httpx-over-requests', age_days: 22 },  // week 3
    { slug: 'terse-commits', age_days: 2 },         // week 0
  ];
  const { perSlug, totals, bucketDays } = bucketByAge(events, { bucketDays: 7 });
  assert.equal(bucketDays, 7);
  // httpx: 2 in week0, 1 in week1, 0 in week2, 1 in week3.
  assert.deepEqual(perSlug['httpx-over-requests'], [2, 1, 0, 1]);
  assert.deepEqual(perSlug['terse-commits'], [1, 0, 0, 0], 'ragged arrays zero-filled to common length');
  assert.deepEqual(totals, [3, 1, 0, 1]);
});

test('bucketByAge defaults to a 7-day bucket', () => {
  const { bucketDays } = bucketByAge([{ slug: 'x', age_days: 0 }]);
  assert.equal(bucketDays, DEFAULT_BUCKET_DAYS);
  assert.equal(DEFAULT_BUCKET_DAYS, 7);
});

test('bucketByAge derives age from learnedAt + ts when age_days is absent', () => {
  const learnedAt = { 'httpx-over-requests': '2026-01-01T00:00:00.000Z' };
  const events = [
    { slug: 'httpx-over-requests', ts: '2026-01-02T00:00:00.000Z' }, // 1 day -> week0
    { slug: 'httpx-over-requests', ts: '2026-01-25T00:00:00.000Z' }, // 24 days -> week3
  ];
  const { perSlug } = bucketByAge(events, { bucketDays: 7, learnedAt });
  assert.deepEqual(perSlug['httpx-over-requests'], [1, 0, 0, 1]);
});

test('bucketByAge tallies un-ageable events into `undated`, never silently drops them', () => {
  const events = [
    { slug: 'x', age_days: 0 },
    { slug: 'x' },               // no age_days, no learnedAt -> undated
    { slug: 'x', ts: '2026-01-01T00:00:00.000Z' }, // no learnedAt for x -> undated
  ];
  const { perSlug, undated } = bucketByAge(events, { bucketDays: 7 });
  assert.equal(undated, 2);
  assert.deepEqual(perSlug['x'], [1]);
});

test('bucketByAge ignores entries without a slug', () => {
  const { perSlug, totals } = bucketByAge([{ age_days: 0 }, { slug: '', age_days: 0 }, { slug: 'k', age_days: 0 }]);
  assert.deepEqual(Object.keys(perSlug), ['k']);
  assert.deepEqual(totals, [1]);
});

// --- pure: dropCurve ---

test('dropCurve computes a downward drop ratio (the curve bends toward zero)', () => {
  // 3 re-corrections in week 1, 0 by week 4 -> drop 1.0.
  const events = [
    { slug: 's', age_days: 1 }, { slug: 's', age_days: 2 }, { slug: 's', age_days: 3 },
    // weeks 1-3 silent, week 4 silent.
  ];
  const out = dropCurve(events, { bucketDays: 7, lateBucket: 4 });
  const s = out.perSlug['s'];
  assert.equal(s.early, 3);
  assert.equal(s.late, 0);
  assert.equal(s.drop, 1.0, 'all re-corrections vanished -> drop 1.0');
  assert.equal(s.trend, 'down');
});

test('dropCurve overall aggregates across slugs', () => {
  const events = [
    { slug: 'a', age_days: 0 }, { slug: 'a', age_days: 0 },
    { slug: 'b', age_days: 0 },
    { slug: 'a', age_days: 21 }, // week 3
  ];
  const out = dropCurve(events, { bucketDays: 7 });
  // overall week0 = 3, last non-empty bucket = week3 = 1 -> drop (3-1)/3.
  assert.equal(out.overall.early, 3);
  assert.equal(out.overall.late, 1);
  assert.ok(Math.abs(out.overall.drop - (2 / 3)) < 1e-9);
  assert.equal(out.overall.trend, 'down');
});

test('dropCurve reports a flat/up trend honestly (system NOT working)', () => {
  // Same rate week0 and the last bucket -> flat, drop 0.
  const flat = dropCurve([{ slug: 's', age_days: 0 }, { slug: 's', age_days: 21 }], { bucketDays: 7, earlyBucket: 0, lateBucket: 3 });
  assert.equal(flat.perSlug['s'].drop, 0);
  assert.equal(flat.perSlug['s'].trend, 'flat');
  // More re-corrections later than early -> up (regression), negative drop.
  const up = dropCurve([
    { slug: 's', age_days: 0 },
    { slug: 's', age_days: 21 }, { slug: 's', age_days: 22 },
  ], { bucketDays: 7, earlyBucket: 0, lateBucket: 3 });
  assert.ok(up.perSlug['s'].drop < 0, 'getting worse -> negative drop');
  assert.equal(up.perSlug['s'].trend, 'up');
});

test('dropCurve drop is null when there is no early baseline to improve on', () => {
  // No week-0 re-corrections -> no baseline.
  const out = dropCurve([{ slug: 's', age_days: 21 }], { bucketDays: 7, earlyBucket: 0 });
  assert.equal(out.perSlug['s'].early, 0);
  assert.equal(out.perSlug['s'].drop, null);
});

// --- IO: append-only ledger ---

function freshDir(fn) {
  const pdir = mkdtempSync(join(tmpdir(), 'ijfw-telem-p-'));
  const prevP = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = pdir;
  try {
    return fn({ pdir });
  } finally {
    if (prevP === undefined) delete process.env.IJFW_PROFILE_DIR; else process.env.IJFW_PROFILE_DIR = prevP;
    rmSync(pdir, { recursive: true, force: true });
  }
}

test('recordRecorrection appends a line; readRecorrections round-trips it', () => {
  freshDir(() => {
    const r1 = recordRecorrection({ slug: 'httpx', session: 's1', host: 'claude', age_days: 0 });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const r2 = recordRecorrection({ slug: 'httpx', session: 's2', host: 'cursor', age_days: 8 });
    assert.equal(r2.ok, true);

    const { ok, events } = readRecorrections();
    assert.equal(ok, true);
    assert.equal(events.length, 2);
    assert.equal(events[0].slug, 'httpx');
    assert.ok(events[0].ts, 'ts stamped');
    assert.equal(events[1].age_days, 8);

    // End-to-end: the persisted ledger feeds the pure curve.
    const curve = dropCurve(events, { bucketDays: 7 });
    assert.deepEqual(curve.perSlug['httpx'].counts, [1, 1]);
  });
});

test('recordRecorrection rejects a slug-less event (EBADSLUG)', () => {
  freshDir(() => {
    const r = recordRecorrection({ session: 's1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EBADSLUG');
  });
});

test('readRecorrections on a missing log returns an empty list', () => {
  freshDir(() => {
    const { ok, events } = readRecorrections();
    assert.equal(ok, true);
    assert.deepEqual(events, []);
  });
});

test('recordRecorrection refuses a symlinked ledger (anti-TOCTOU)', () => {
  freshDir(({ pdir }) => {
    const target = recorrectionsLogPath();
    symlinkSync(join(pdir, 'elsewhere'), target);
    const r = recordRecorrection({ slug: 'httpx', age_days: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'ERECORR_SYMLINK');
  });
});

test('readRecorrections skips a corrupt line (best-effort audit read)', () => {
  freshDir(() => {
    recordRecorrection({ slug: 'good', age_days: 0 });
    // Directly corrupt the file with a non-JSON line between valid records.
    appendFileSync(recorrectionsLogPath(), 'not json\n');
    recordRecorrection({ slug: 'good2', age_days: 1 });
    const { events } = readRecorrections();
    assert.equal(events.length, 2, 'two valid records survive, corrupt line skipped');
  });
});
