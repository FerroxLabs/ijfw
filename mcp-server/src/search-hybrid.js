// r17 (cold-tier wire-up): hybrid BM25+vector rerank step for searchMemory.
//
// Pure module, no side effects on import. server.js imports the rerank
// helper; test-search-hybrid.js imports the same helper without dragging in
// the MCP server's stdio bootstrap (which would hang the test runner).
//
// Behavior:
//   - When IJFW_VECTORS is off (default) OR no opts.embedder is injected,
//     this is a pure no-op and returns the input `ranked` array unchanged.
//   - When IJFW_VECTORS=on AND the embedder is available (either via
//     @xenova/transformers installed OR via opts.embedder injection), the
//     BM25 top-K is reranked using cosine similarity over each result's
//     snippet, blended with the BM25 score via vectors.hybridRerank.
//   - Any failure during embedding falls back to BM25 with a single
//     stderr warning per distinct reason. Never throws into the caller.

import { vectorsEnabled, getEmbedder, hybridRerank } from './vectors.js';
// v1.5.0 wire-W1.C: persistent embedding cache so repeated queries over a
// stable corpus don't pay the per-snippet embed cost twice. Cache is keyed
// on sha256(snippet) + model_id; falls back to live re-embed on any miss
// or when opts.db is absent.
import {
  cacheKeyFor,
  getCachedEmbedding,
  setCachedEmbedding,
  hasVectorCache,
} from './memory/embedding-cache.js';

// Throttle stderr noise — single warning per distinct failure reason.
let _vectorWarnedReason = null;

/**
 * Optional hybrid rerank step. Returns the input `ranked` unchanged when
 * vectors are disabled or the embedder cannot be loaded. On success, returns
 * the merged ranking from `hybridRerank` (BM25 score + cosine similarity).
 *
 * @param {string} query
 * @param {Array<{id, score, snippet, meta}>} ranked  - BM25 top-K
 * @param {object} opts
 * @param {object} [opts.embedder]  - injected for tests; defaults to getEmbedder()
 * @param {number} [opts.wBm25]     - BM25 weight (default 0.6 via vectors.js)
 * @param {number} [opts.wVec]      - vector weight (default 0.4 via vectors.js)
 * @returns {Promise<Array>} reranked list (or `ranked` on no-op)
 */
export async function maybeRerankWithVectors(query, ranked, opts = {}) {
  // Skip the embedder load entirely when vectors are off — env check is the
  // cheap path. Tests can force the embedder path by passing opts.embedder.
  if (!opts.embedder && !vectorsEnabled()) return ranked;

  let embedder = opts.embedder;
  if (!embedder) {
    try {
      embedder = await getEmbedder();
    } catch (err) {
      // getEmbedder shouldn't throw (it returns {available:false}), but defend.
      embedder = { available: false, reason: `getEmbedder-threw: ${err.message}` };
    }
  }
  if (!embedder || !embedder.available) {
    const reason = embedder?.reason || 'unavailable';
    if (_vectorWarnedReason !== reason) {
      _vectorWarnedReason = reason;
      // Stderr only; stdout is the JSON-RPC framing channel.
      process.stderr.write(
        `IJFW: cold-tier vectors requested (IJFW_VECTORS=on) but embedder unavailable (${reason}). Falling back to BM25.\n`
      );
    }
    return ranked;
  }

  try {
    // v1.5.0 audit MED #6 (memory-engine.md F-SPD-1): batch-embed the
    // query + all snippets in parallel via Promise.all. The previous
    // sequential `for (... await embedder.embed)` loop serialised K+1
    // calls -- when `embedder.embed` is an HTTP round-trip (e.g. a
    // remote inference server) p99 was ~600ms for the top-K=10 case.
    // Concurrent dispatch drops that to ~80ms (single-round-trip cost
    // plus per-call overhead). For the local @xenova/transformers
    // pipeline the calls still resolve serially under the hood, but
    // Promise.all is no worse than the sequential await and lets future
    // batch-aware embedders win without further changes.
    //
    // v1.5.0 wire-W1.C: when opts.db + opts.modelId are supplied AND the
    // memory_entry_vectors table exists, route each embed through the
    // persistent cache. The cache is keyed on sha256(text), so a second
    // call with the same query + corpus serves entirely from SQLite —
    // zero embedder calls, zero re-embed cost. The query embedding is
    // also cached (queries repeat in long sessions / dashboard polls).
    //
    // cacheReady flips to false when the table is missing OR no db is
    // passed; the rerank then degrades to the existing live-embed path
    // with no observable behavior change.
    const snippets = ranked.map((r) => r.snippet || '');
    const cacheDb = opts.db || null;
    const modelId = opts.modelId || embedder.modelId || null;
    const cacheReady = cacheDb && typeof modelId === 'string' && modelId.length > 0 && hasVectorCache(cacheDb);

    const embedWithCache = async (text) => {
      if (!cacheReady) return embedder.embed(text);
      const key = cacheKeyFor(text);
      if (key === null) return embedder.embed(text);
      const hit = getCachedEmbedding(cacheDb, key, modelId);
      if (hit) return hit;
      const vec = await embedder.embed(text);
      setCachedEmbedding(cacheDb, key, modelId, vec);
      return vec;
    };

    const [queryVec, ...docVecs] = await Promise.all([
      embedWithCache(query),
      ...snippets.map((s) => embedWithCache(s)),
    ]);
    const vectorScores = new Map();
    for (let i = 0; i < ranked.length; i++) {
      const docVec = docVecs[i] || [];
      // Cosine over L2-normalized vectors === dot product.
      let dot = 0;
      const n = Math.min(queryVec.length, docVec.length);
      for (let j = 0; j < n; j++) dot += queryVec[j] * docVec[j];
      vectorScores.set(ranked[i].id, dot);
    }
    return hybridRerank(ranked, vectorScores, {
      wBm25: opts.wBm25,
      wVec: opts.wVec,
    });
  } catch (err) {
    const reason = `embed-failed: ${err.message}`;
    if (_vectorWarnedReason !== reason) {
      _vectorWarnedReason = reason;
      process.stderr.write(
        `IJFW: cold-tier vectors hit an error mid-pipeline (${reason}). Falling back to BM25 for this query.\n`
      );
    }
    return ranked;
  }
}

// Test seam — reset the once-per-process warning gate.
export function _resetVectorWarnGate() { _vectorWarnedReason = null; }
