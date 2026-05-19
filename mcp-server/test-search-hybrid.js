// r17: hybrid BM25+vector search wire-up tests.
//
// These tests verify the cold-tier integration without requiring
// @xenova/transformers to be installed: we inject a mock embedder via the
// opts seam. There is one optional integration test below that ONLY runs
// when @xenova/transformers is actually installed — it skips otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maybeRerankWithVectors, _resetVectorWarnGate } from './src/search-hybrid.js';

// Build a deterministic mock embedder. Each input string gets a small unique
// vector based on character codes; vectors are L2-normalized so cosine =
// dot product (matching vectors.js' normalize:true contract).
function mockEmbedder({ available = true, reason = null, throwOnEmbed = false } = {}) {
  if (!available) return { available: false, reason: reason || 'mock-unavailable' };
  return {
    available: true,
    model: 'mock',
    async embed(text) {
      if (throwOnEmbed) throw new Error('mock-embed-boom');
      // 8-dim vector built from character-frequency buckets.
      const v = new Array(8).fill(0);
      for (const ch of String(text)) {
        v[ch.charCodeAt(0) % 8] += 1;
      }
      // L2-normalize.
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map(x => x / norm);
    },
  };
}

const BM25 = [
  { id: 'a', score: 10, snippet: 'apples are red fruit',  meta: { source: 'team' } },
  { id: 'b', score:  8, snippet: 'bananas are yellow fruit', meta: { source: 'team' } },
  { id: 'c', score:  5, snippet: 'carrots are orange vegetables', meta: { source: 'team' } },
];

test('BM25-only path: no opts.embedder + IJFW_VECTORS unset → ranking unchanged', async () => {
  delete process.env.IJFW_VECTORS;
  _resetVectorWarnGate();
  const out = await maybeRerankWithVectors('fruit', BM25);
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c'], 'returns input ranking unchanged');
});

test('Hybrid path: mock embedder injected → reranked list includes vector_score', async () => {
  _resetVectorWarnGate();
  const out = await maybeRerankWithVectors('fruit', BM25, {
    embedder: mockEmbedder(),
  });
  assert.equal(out.length, 3, 'all candidates preserved');
  for (const r of out) {
    assert.ok(typeof r.bm25_score === 'number', 'bm25_score present');
    assert.ok(typeof r.vector_score === 'number', 'vector_score present');
    assert.ok(typeof r.score === 'number', 'merged score present');
  }
});

test('Hybrid: wVec=1, wBm25=0 → pure vector ranking (deterministic from mock)', async () => {
  _resetVectorWarnGate();
  const out = await maybeRerankWithVectors('fruit', BM25, {
    embedder: mockEmbedder(),
    wBm25: 0,
    wVec: 1,
  });
  // With pure-cosine ranking the order is determined by character-bucket
  // similarity to "fruit". The merged score must equal vector_score
  // (since wBm25=0).
  for (const r of out) {
    assert.equal(r.score, r.vector_score, 'pure-cosine merge: score === vector_score');
  }
  // And the result must be sorted descending by score.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].score >= out[i].score, 'descending order');
  }
});

test('Hybrid: wBm25=1, wVec=0 → BM25-only blending (vector ignored)', async () => {
  _resetVectorWarnGate();
  const out = await maybeRerankWithVectors('fruit', BM25, {
    embedder: mockEmbedder(),
    wBm25: 1,
    wVec: 0,
  });
  // With pure-BM25 the order is the input order normalized by max BM25.
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c'], 'pure-BM25 order preserved');
});

test('Embedder unavailable → falls back to BM25 silently (one warning per reason)', async () => {
  _resetVectorWarnGate();
  const out = await maybeRerankWithVectors('fruit', BM25, {
    embedder: mockEmbedder({ available: false, reason: 'mock-down' }),
  });
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c'], 'BM25 ranking returned');
});

test('Embedder throws mid-pipeline → caught, returns BM25 ranking', async () => {
  _resetVectorWarnGate();
  const out = await maybeRerankWithVectors('fruit', BM25, {
    embedder: mockEmbedder({ throwOnEmbed: true }),
  });
  assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c'], 'BM25 ranking returned on embed failure');
});

test('IJFW_VECTORS=on + no opts.embedder → calls getEmbedder() (no-op if transformers absent)', async () => {
  // Without injecting an embedder, the code path calls getEmbedder() which
  // returns {available:false, reason:"transformers-not-installed"} unless
  // the user has installed @xenova/transformers. Either outcome is acceptable
  // here — what we're testing is that the function does NOT crash and DOES
  // return a usable list when vectors are turned on without the dep.
  process.env.IJFW_VECTORS = 'on';
  _resetVectorWarnGate();
  try {
    const out = await maybeRerankWithVectors('fruit', BM25);
    assert.equal(out.length, 3, 'returns same number of results');
    // IDs preserved (order may differ if transformers happens to be loadable).
    const ids = out.map(r => r.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
  } finally {
    delete process.env.IJFW_VECTORS;
  }
});

// ---------------------------------------------------------------------------
// v1.5.0 audit MED #6 (memory-engine.md F-SPD-1): parallel batch embedding.
// The old sequential `for (...await embed)` loop fired K+1 round-trips
// strictly in series. Promise.all lets them dispatch concurrently. We
// verify this by making each embed() resolve only AFTER all expected
// calls have started -- a sequential implementation would deadlock.
// ---------------------------------------------------------------------------

test('Batch embed: query + K snippets dispatched in parallel (no sequential await)', async () => {
  _resetVectorWarnGate();
  const expectedCalls = 1 + BM25.length; // 1 query + K snippets
  let startedCalls = 0;
  let allStartedResolve;
  const allStartedPromise = new Promise((res) => { allStartedResolve = res; });

  const parallelEmbedder = {
    available: true,
    model: 'parallel-mock',
    async embed(text) {
      startedCalls++;
      if (startedCalls === expectedCalls) allStartedResolve();
      // Block until every expected call has begun. A sequential awaiter
      // would never reach this satisfaction condition for call #2, so this
      // test would hang and the runner would time it out.
      await allStartedPromise;
      const v = new Array(8).fill(0);
      for (const ch of String(text)) v[ch.charCodeAt(0) % 8] += 1;
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    },
  };

  const out = await maybeRerankWithVectors('fruit', BM25, { embedder: parallelEmbedder });
  assert.equal(startedCalls, expectedCalls, 'all embed calls were dispatched');
  assert.equal(out.length, BM25.length);
});

// ---------------------------------------------------------------------------
// Optional integration test: only runs when @xenova/transformers is installed.
// Verifies the real embedder path end-to-end. Skipped otherwise so CI without
// the optional dep stays green.
// ---------------------------------------------------------------------------

let transformersInstalled = false;
try {
  await import('@xenova/transformers');
  transformersInstalled = true;
} catch { /* not installed — integration test will skip */ }

test('integration: real @xenova/transformers embedder reranks BM25 candidates', { skip: !transformersInstalled }, async () => {
  process.env.IJFW_VECTORS = 'on';
  _resetVectorWarnGate();
  try {
    const out = await maybeRerankWithVectors('a sweet yellow fruit you peel', BM25);
    assert.equal(out.length, 3, 'all candidates preserved');
    // We don't assert a specific order because real embeddings depend on the
    // model and could shift between minor releases. We assert that each entry
    // has both bm25_score and vector_score populated, proving the merge ran.
    for (const r of out) {
      assert.ok(typeof r.bm25_score === 'number', 'bm25_score present');
      assert.ok(typeof r.vector_score === 'number', 'vector_score present');
    }
  } finally {
    delete process.env.IJFW_VECTORS;
  }
});
