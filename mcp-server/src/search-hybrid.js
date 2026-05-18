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
    const queryVec = await embedder.embed(query);
    const vectorScores = new Map();
    for (const r of ranked) {
      const docVec = await embedder.embed(r.snippet || '');
      // Cosine over L2-normalized vectors === dot product.
      let dot = 0;
      const n = Math.min(queryVec.length, docVec.length);
      for (let i = 0; i < n; i++) dot += queryVec[i] * docVec[i];
      vectorScores.set(r.id, dot);
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
