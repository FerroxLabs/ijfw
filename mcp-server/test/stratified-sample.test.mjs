// Tests for the seeded, dimension-stratified sampler (T12 frontier pilot).
// The pilot draws ~1% of TEST stratified by dimension so every dimension is
// represented (an unstratified first-N slice would over-weight whichever dim
// the dataset happens to list first, biasing the synth-independence gate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stratifiedSample } from '../scripts/bench/stratified-sample.mjs';

function makeQueries() {
  const q = [];
  for (let i = 0; i < 100; i++) q.push({ id: `t${i}`, dim: 'temporal' });
  for (let i = 0; i < 50; i++) q.push({ id: `s${i}`, dim: 'single-hop' });
  for (let i = 0; i < 10; i++) q.push({ id: `m${i}`, dim: 'multi-hop' });
  return q;
}

const dimOf = (q) => q.dim;

test('is deterministic: same seed → identical selection', () => {
  const q = makeQueries();
  const a = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v1', dimOf });
  const b = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v1', dimOf });
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
});

test('every dimension is represented (at least 1 per stratum)', () => {
  const q = makeQueries();
  const out = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v1', dimOf });
  const dims = new Set(out.map(dimOf));
  assert.deepEqual([...dims].sort(), ['multi-hop', 'single-hop', 'temporal']);
  // 10% of the 10-item multi-hop stratum rounds up to >=1.
  assert.ok(out.filter((x) => x.dim === 'multi-hop').length >= 1);
});

test('approximately frac of the whole, via per-stratum ceil', () => {
  const q = makeQueries(); // 160 total
  const out = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v1', dimOf });
  // ceil(0.1*100)=10 + ceil(0.1*50)=5 + ceil(0.1*10)=1 = 16
  assert.equal(out.length, 16);
});

test('different seed generally changes the selection', () => {
  const q = makeQueries();
  const a = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v1', dimOf }).map((x) => x.id).join(',');
  const b = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v2', dimOf }).map((x) => x.id).join(',');
  assert.notEqual(a, b);
});

test('output preserves original dataset order (not shuffled)', () => {
  const q = makeQueries();
  const out = stratifiedSample(q, { frac: 0.1, seed: 'pilot-v1', dimOf });
  const idx = out.map((x) => q.indexOf(x));
  const sorted = [...idx].sort((m, n) => m - n);
  assert.deepEqual(idx, sorted, 'selected rows appear in dataset order');
});
