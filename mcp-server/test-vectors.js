// Vectors module tests. The transformer backend is a user opt-in dependency,
// so default installs stay BM25-only and audit-clean.
// The test never downloads the model - embedder availability is probed only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorsEnabled, getEmbedder, cosine, hybridRerank } from './src/vectors.js';

test('vectorsEnabled reads env var correctly', () => {
  const save = process.env.IJFW_VECTORS;
  process.env.IJFW_VECTORS = 'off';
  assert.equal(vectorsEnabled(), false);
  process.env.IJFW_VECTORS = 'on';
  assert.equal(vectorsEnabled(), true);
  delete process.env.IJFW_VECTORS;
  assert.equal(vectorsEnabled(), false); // default off
  if (save === undefined) delete process.env.IJFW_VECTORS;
  else process.env.IJFW_VECTORS = save;
});

test('vectorsEnabled respects 0/false/off variants', () => {
  const save = process.env.IJFW_VECTORS;
  for (const v of ['0', 'false', 'OFF', 'False']) {
    process.env.IJFW_VECTORS = v;
    assert.equal(vectorsEnabled(), false, `expected ${v} → disabled`);
  }
  if (save === undefined) delete process.env.IJFW_VECTORS;
  else process.env.IJFW_VECTORS = save;
});

test('vectorsEnabled respects 1/true/on variants', () => {
  const save = process.env.IJFW_VECTORS;
  for (const v of ['1', 'true', 'ON', 'True']) {
    process.env.IJFW_VECTORS = v;
    assert.equal(vectorsEnabled(), true, `expected ${v} to enable vectors`);
  }
  if (save === undefined) delete process.env.IJFW_VECTORS;
  else process.env.IJFW_VECTORS = save;
});

test('getEmbedder returns unavailable when disabled', async () => {
  const save = process.env.IJFW_VECTORS;
  process.env.IJFW_VECTORS = 'off';
  const e = await getEmbedder();
  assert.equal(e.available, false);
  assert.match(e.reason, /disabled/);
  if (save === undefined) delete process.env.IJFW_VECTORS;
  else process.env.IJFW_VECTORS = save;
});

test('cosine on identical normalized vectors ≈ 1', () => {
  const v = [0.6, 0.8]; // L2 norm = 1
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-9);
});

test('cosine on orthogonal vectors = 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('cosine on mismatched lengths returns 0', () => {
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
});

test('cosine on empty/null inputs returns 0', () => {
  assert.equal(cosine(null, [1]), 0);
  assert.equal(cosine([], []), 0);
});

test('hybridRerank merges BM25 and vector scores with weights', () => {
  const bm25 = [
    { id: 'a', score: 10 },
    { id: 'b', score: 5  },
    { id: 'c', score: 2  },
  ];
  // Vector says 'c' is most semantically similar.
  const vec = new Map([['a', 0.3], ['b', 0.4], ['c', 0.9]]);
  const r = hybridRerank(bm25, vec, { wBm25: 0.5, wVec: 0.5 });
  // c has low bm25 but high vector → may rank up.
  assert.equal(r[0].id, 'a'); // BM25 10/10 = 1.0, vec 0.3 → 0.65
  // b: 5/10=0.5, vec 0.4 → 0.45; c: 2/10=0.2, vec 0.9 → 0.55 → c > b
  assert.equal(r[1].id, 'c');
  assert.equal(r[2].id, 'b');
});

test('hybridRerank preserves bm25_score + vector_score diagnostics', () => {
  const bm25 = [{ id: 'a', score: 10 }];
  const vec = new Map([['a', 0.5]]);
  const r = hybridRerank(bm25, vec);
  assert.equal(r[0].bm25_score, 10);
  assert.equal(r[0].vector_score, 0.5);
});

test('hybridRerank handles empty bm25 without dividing by zero', () => {
  assert.deepEqual(hybridRerank([], new Map()), []);
});
