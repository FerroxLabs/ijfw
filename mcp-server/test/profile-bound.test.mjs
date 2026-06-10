// P0.6 — Bounded store + eviction + decay-to-archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enforceBounds, DEFAULT_BOUNDS, applyDelta } from '../src/profile/merge.js';
import { makeProfile, makeInference } from '../src/profile/schema.js';
import { archiveDir } from '../src/profile/store.js';

function withTmpProfileDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-bound-'));
  const prev = process.env.IJFW_PROFILE_DIR;
  process.env.IJFW_PROFILE_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.IJFW_PROFILE_DIR;
    else process.env.IJFW_PROFILE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const RECENT = new Date().toISOString();

test('store size stays <= cap as N inferences grow (eviction)', () => {
  withTmpProfileDir(() => {
    const bounds = { ...DEFAULT_BOUNDS, maxDialectic: 10 };
    let p = makeProfile();
    // 50 high-evidence, recent inferences (not decay-eligible) with varying confidence
    for (let i = 0; i < 50; i += 1) {
      p.global.dialectic.push(makeInference({
        kind: 'trait', subject: `s${i}`, value: 'v', confidence: i / 100,
        evidence_count: 10, last_confirmed: RECENT,
      }));
    }
    const bounded = enforceBounds(p, bounds);
    assert.equal(bounded.global.dialectic.length, 10, 'capped to maxDialectic');
    // the survivors are the HIGHEST confidence (lowest-confidence evicted)
    const minKept = Math.min(...bounded.global.dialectic.map((x) => x.confidence));
    assert.ok(minKept >= 0.40 - 1e-9, `kept the top-confidence band, min kept=${minKept}`);
  });
});

test('stale, low-evidence inference is decayed then archived (not hard-deleted)', () => {
  withTmpProfileDir(() => {
    const oldTs = new Date(Date.now() - DEFAULT_BOUNDS.staleMs - 1000).toISOString();
    let p = makeProfile();
    p.global.dialectic.push(makeInference({
      kind: 'trait', subject: 'stale-one', value: 'v',
      confidence: 0.15, evidence_count: 1, last_confirmed: oldTs,
    }));
    // a fresh, well-evidenced one that must survive
    p.global.dialectic.push(makeInference({
      kind: 'trait', subject: 'keeper', value: 'v',
      confidence: 0.9, evidence_count: 20, last_confirmed: RECENT,
    }));
    const bounded = enforceBounds(p, DEFAULT_BOUNDS);
    const subjects = bounded.global.dialectic.map((x) => x.subject);
    assert.ok(subjects.includes('keeper'), 'high-evidence recent inference kept');
    assert.ok(!subjects.includes('stale-one'), 'stale low-evidence inference removed from live set');
    // archived, not hard-deleted: the archive JSONL exists and references it
    const file = join(archiveDir(), 'archived-inferences.jsonl');
    assert.ok(existsSync(file), 'archive file written');
    const body = readFileSync(file, 'utf8');
    assert.match(body, /stale-one/, 'archived entry recorded (recoverable)');
  });
});

test('decay halves confidence of a stale low-evidence inference above the archive floor', () => {
  const oldTs = new Date(Date.now() - DEFAULT_BOUNDS.staleMs - 1000).toISOString();
  let p = makeProfile();
  p.global.dialectic.push(makeInference({
    kind: 'trait', subject: 'fading', value: 'v',
    confidence: 0.4, evidence_count: 1, last_confirmed: oldTs,
  }));
  const bounded = enforceBounds(p, DEFAULT_BOUNDS);
  const inf = bounded.global.dialectic.find((x) => x.subject === 'fading');
  assert.ok(inf, 'still live (0.2 >= archiveBelow 0.1)');
  assert.ok(Math.abs(inf.confidence - 0.2) < 1e-9, 'confidence decayed by decayFactor');
});

test('cold-start inference (default makeInference) is NOT archived on first enforceBounds', () => {
  // Regression: a freshly-derived trait (P2) defaults last_confirmed=epoch,
  // confidence=0, evidence_count=0. The epoch is a deliberate "never confirmed"
  // sentinel — it must NOT read as ~56-years-stale and get silently archived on
  // the very first mergeAndWrite/enforceBounds (that is data loss for derived
  // traits). A never-confirmed inference is brand-new, not stale.
  withTmpProfileDir(() => {
    let p = makeProfile();
    p.global.dialectic.push(makeInference({ kind: 'trait', subject: 'fresh-derived', value: 'v' }));
    const bounded = enforceBounds(p, DEFAULT_BOUNDS);
    const subjects = bounded.global.dialectic.map((x) => x.subject);
    assert.ok(subjects.includes('fresh-derived'), 'cold-start inference must stay live, not be archived');
  });
});

test('high-evidence inference does NOT decay even when stale', () => {
  const oldTs = new Date(Date.now() - DEFAULT_BOUNDS.staleMs - 1000).toISOString();
  let p = makeProfile();
  p.global.dialectic.push(makeInference({
    kind: 'trait', subject: 'entrenched', value: 'v',
    confidence: 0.8, evidence_count: 50, last_confirmed: oldTs,
  }));
  const bounded = enforceBounds(p, DEFAULT_BOUNDS);
  const inf = bounded.global.dialectic.find((x) => x.subject === 'entrenched');
  assert.equal(inf.confidence, 0.8, 'high-evidence is immune to decay');
});

test('expertise domains are capped by lowest Wilson LB', () => {
  const bounds = { ...DEFAULT_BOUNDS, maxExpertiseDomains: 2 };
  let p = makeProfile();
  p = applyDelta(p, { expertise: { a: { accepts: 9, n: 10 }, b: { accepts: 5, n: 10 }, c: { accepts: 1, n: 10 } } });
  const bounded = enforceBounds(p, bounds);
  const domains = Object.keys(bounded.expertise);
  assert.equal(domains.length, 2);
  assert.ok(domains.includes('a'), 'highest-LB domain kept');
  assert.ok(!domains.includes('c'), 'lowest-LB domain dropped');
});

test('enforceBounds does not mutate its input', () => {
  let p = makeProfile();
  p.global.dialectic.push(makeInference({ kind: 'trait', subject: 'x', value: 'v', confidence: 0.5, evidence_count: 10, last_confirmed: RECENT }));
  const snapshot = JSON.stringify(p);
  enforceBounds(p, { ...DEFAULT_BOUNDS, maxDialectic: 0 });
  assert.equal(JSON.stringify(p), snapshot, 'input unchanged');
});
