#!/usr/bin/env node
/**
 * test-embedding-cache.js -- v1.5.0 wire-W1.C.
 *
 * Validates that `mcp-server/src/memory/embedding-cache.js` is wired into the
 * hybrid rerank path. Before W1.C this module had no production callers — the
 * migration created an empty table and the cold-tier rerank re-embedded every
 * snippet on every query. These tests prove the wire is live:
 *
 *   1. The migration creates the memory_entry_vectors table with the
 *      content-keyed schema (cache_key TEXT, model_id TEXT, embedding BLOB).
 *   2. cacheKeyFor(text) yields a stable lowercase-hex sha256.
 *   3. set / get / count round-trip a Float32 vector unchanged.
 *   4. maybeRerankWithVectors with opts.db + opts.modelId caches the embeds:
 *      the SECOND call with the same snippets calls the mock embedder ZERO
 *      times (every result served from cache).
 *   5. With no db (or db missing the table), the rerank still works but the
 *      embedder is called on every invocation -- proving the cache is the
 *      thing that skipped the work in test 4, not the lib changing behavior.
 *
 * Uses better-sqlite3 directly (already a hard dep) to avoid pulling the
 * full memory store wiring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKeyFor,
  encodeVector,
  decodeVector,
  hasVectorCache,
  getCachedEmbedding,
  setCachedEmbedding,
  countCachedVectors,
} from './src/memory/embedding-cache.js';
import migration005 from './src/memory/migrations/005-vector-cache.js';
import { maybeRerankWithVectors, _resetVectorWarnGate } from './src/search-hybrid.js';

// Open an in-memory sqlite db with migration 005 applied.
async function openMigratedDb() {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  migration005.up(db);
  return db;
}

// Deterministic mock embedder (same shape as test-search-hybrid.js).
function makeCountingEmbedder() {
  let calls = 0;
  return {
    available: true,
    modelId: 'mock-v1',
    get calls() { return calls; },
    reset() { calls = 0; },
    async embed(text) {
      calls += 1;
      const v = new Array(8).fill(0);
      for (const ch of String(text)) v[ch.charCodeAt(0) % 8] += 1;
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return v.map(x => x / norm);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Migration creates the table
// ---------------------------------------------------------------------------

test('wire-W1.C: migration 005 creates memory_entry_vectors with content-keyed schema', async () => {
  const db = await openMigratedDb();
  try {
    assert.equal(hasVectorCache(db), true);
    const cols = db.prepare("PRAGMA table_info(memory_entry_vectors)").all();
    const names = cols.map(c => c.name).sort();
    assert.deepEqual(names, ['cache_key', 'created_at', 'embedding', 'model_id']);
    // PK is composite (cache_key, model_id) — both flagged pk>0.
    const pk = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    assert.deepEqual(pk, ['cache_key', 'model_id']);
  } finally { db.close(); }
});

test('wire-W1.C: hasVectorCache returns false on a db missing the table', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  try {
    assert.equal(hasVectorCache(db), false);
    // get / set silently no-op when the table is missing.
    assert.equal(getCachedEmbedding(db, 'k', 'm'), null);
    assert.equal(setCachedEmbedding(db, 'k', 'm', [1, 2, 3]), false);
    assert.equal(countCachedVectors(db), 0);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// 2. cacheKeyFor is stable + content-derived
// ---------------------------------------------------------------------------

test('wire-W1.C: cacheKeyFor is stable lowercase-hex sha256', () => {
  const k1 = cacheKeyFor('the quick brown fox');
  const k2 = cacheKeyFor('the quick brown fox');
  assert.equal(k1, k2);
  assert.match(k1, /^[0-9a-f]{64}$/);
  // Different text → different key.
  assert.notEqual(k1, cacheKeyFor('the QUICK brown fox'));
  // Empty / non-string → null.
  assert.equal(cacheKeyFor(''), null);
  assert.equal(cacheKeyFor(null), null);
  assert.equal(cacheKeyFor(42), null);
});

// ---------------------------------------------------------------------------
// 3. set/get/count round-trip
// ---------------------------------------------------------------------------

test('wire-W1.C: set/get round-trip preserves Float32 vector', async () => {
  const db = await openMigratedDb();
  try {
    const text = 'cache me';
    const key = cacheKeyFor(text);
    const vec = [0.1, -0.2, 0.3, 0.4, -0.5, 0.6, 0.7, 0.8];
    const ok = setCachedEmbedding(db, key, 'mdl', vec);
    assert.equal(ok, true);

    const got = getCachedEmbedding(db, key, 'mdl');
    assert.ok(got);
    assert.equal(got.length, vec.length);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(got[i] - vec[i]) < 1e-6, `float roundtrip @ ${i}`);
    }
    assert.equal(countCachedVectors(db), 1);
    assert.equal(countCachedVectors(db, 'mdl'), 1);
    assert.equal(countCachedVectors(db, 'other'), 0);

    // Miss path
    assert.equal(getCachedEmbedding(db, key, 'wrong-model'), null);
    assert.equal(getCachedEmbedding(db, 'wrong-key', 'mdl'), null);

    // Re-insert with same key overwrites (INSERT OR REPLACE)
    setCachedEmbedding(db, key, 'mdl', vec);
    assert.equal(countCachedVectors(db), 1);
  } finally { db.close(); }
});

test('wire-W1.C: invalid args reject cleanly (no throw, no row)', async () => {
  const db = await openMigratedDb();
  try {
    assert.equal(setCachedEmbedding(db, '', 'm', [1]), false);
    assert.equal(setCachedEmbedding(db, 'k', '', [1]), false);
    assert.equal(setCachedEmbedding(db, 'k', 'm', []), false);
    assert.equal(setCachedEmbedding(db, 'k', 'm', null), false);
    assert.equal(getCachedEmbedding(db, null, 'm'), null);
    assert.equal(getCachedEmbedding(db, 'k', null), null);
    assert.equal(countCachedVectors(db), 0);
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// 4 + 5: end-to-end wire — rerank cache hits skip embedder calls
// ---------------------------------------------------------------------------

const BM25 = [
  { id: 'a', score: 10, snippet: 'apples are red fruit',                meta: { source: 'team' } },
  { id: 'b', score:  8, snippet: 'bananas are yellow fruit',            meta: { source: 'team' } },
  { id: 'c', score:  5, snippet: 'carrots are orange vegetables',       meta: { source: 'team' } },
];

test('wire-W1.C: second rerank call with same db hits cache (0 new embedder calls)', async () => {
  const db = await openMigratedDb();
  const embedder = makeCountingEmbedder();
  _resetVectorWarnGate();
  try {
    const opts1 = { embedder, db, modelId: 'mock-v1' };
    const out1 = await maybeRerankWithVectors('fruit', BM25, opts1);
    assert.equal(out1.length, 3);
    // First call: 1 query embed + 3 snippet embeds = 4
    assert.equal(embedder.calls, 4, 'first call embeds query + 3 snippets');
    // The cache should now have 4 rows (1 query text + 3 snippets, same model).
    assert.equal(countCachedVectors(db, 'mock-v1'), 4);

    // Second call: every text already cached → 0 embedder calls.
    embedder.reset();
    const out2 = await maybeRerankWithVectors('fruit', BM25, opts1);
    assert.equal(out2.length, 3);
    assert.equal(embedder.calls, 0, 'second call serves entirely from cache');
    // Cache row count unchanged (no new writes).
    assert.equal(countCachedVectors(db, 'mock-v1'), 4);
  } finally { db.close(); }
});

test('wire-W1.C: no db → rerank still works, embedder called every time', async () => {
  const embedder = makeCountingEmbedder();
  _resetVectorWarnGate();
  // No db, no modelId → cacheReady=false in search-hybrid, every call lives.
  await maybeRerankWithVectors('fruit', BM25, { embedder });
  assert.equal(embedder.calls, 4);
  embedder.reset();
  await maybeRerankWithVectors('fruit', BM25, { embedder });
  assert.equal(embedder.calls, 4, 'no cache → re-embed on every call');
});

test('wire-W1.C: changing modelId invalidates cache (new model = new rows)', async () => {
  const db = await openMigratedDb();
  const embedder = makeCountingEmbedder();
  _resetVectorWarnGate();
  try {
    await maybeRerankWithVectors('fruit', BM25, { embedder, db, modelId: 'mock-v1' });
    assert.equal(embedder.calls, 4);
    assert.equal(countCachedVectors(db, 'mock-v1'), 4);

    embedder.reset();
    await maybeRerankWithVectors('fruit', BM25, { embedder, db, modelId: 'mock-v2' });
    // Different model → no cache hits → 4 fresh embeds + 4 new rows.
    assert.equal(embedder.calls, 4);
    assert.equal(countCachedVectors(db, 'mock-v2'), 4);
    // Old model rows still around.
    assert.equal(countCachedVectors(db, 'mock-v1'), 4);
    assert.equal(countCachedVectors(db), 8);
  } finally { db.close(); }
});
