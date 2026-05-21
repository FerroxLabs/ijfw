// v1.5.0 audit MED #7 (memory-engine.md F-PRF-4): persistent embedding
// cache. Thin read/write surface over the memory_entry_vectors table
// (migration 005). All functions are sync to match the rest of the
// memory tier (better-sqlite3 is synchronous) and tolerate a db that
// hasn't reached schema v5 -- callers see "miss" rather than a throw,
// so hybrid rerank degrades to live re-embed without flooding stderr.
//
// v1.5.0 wire-W1.C: PK is content-hash (sha256(text)) so the cache
// works for ANY repeated snippet, not just rows that carry a stable
// memory_entry id. The high-level helpers `cacheKeyFor(text)`,
// `getCachedEmbedding(db, key, modelId)`, and `setCachedEmbedding(...)`
// are the production wire surface for search-hybrid's
// maybeRerankWithVectors path.
//
// Format: Float32Array <-> Buffer at the SQLite boundary. Each float
// is 4 bytes little-endian. Decode is endian-agnostic via DataView.

import { createHash } from 'node:crypto';

/**
 * Stable content-hash key for the cache. Lowercase hex sha256 over the
 * literal snippet bytes. Whitespace and case are preserved -- the caller
 * is expected to pass the same exact text on every lookup.
 *
 * @param {string} text
 * @returns {string|null}   null when text is not a non-empty string
 */
export function cacheKeyFor(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * encodeVector(vec) -- Float32Array | number[] -> Buffer
 * Returns null on bad input.
 */
export function encodeVector(vec) {
  if (!vec || typeof vec.length !== 'number' || vec.length === 0) return null;
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(Number(vec[i]) || 0, i * 4);
  }
  return buf;
}

/**
 * decodeVector(buf) -- Buffer | Uint8Array -> number[]
 * Returns null when the input length is not a multiple of 4.
 */
export function decodeVector(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length === 0) return null;
  if (buf.length % 4 !== 0) return null;
  const n = buf.length / 4;
  const out = Array.from({ length: n });
  // Work via DataView so we accept Uint8Array (better-sqlite3 BLOB return)
  // and a plain Buffer interchangeably.
  const view = ArrayBuffer.isView(buf)
    ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    : new DataView(buf);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, /*LE*/ true);
  return out;
}

/** True iff the memory db has migration 005 applied (table exists). */
export function hasVectorCache(db) {
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    const row = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entry_vectors'"
    ).get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * getCachedEmbedding(db, cacheKey, modelId) -> number[] | null
 * Returns the stored embedding for the (cache_key, model_id) pair, or
 * null on miss / when the table is absent / when cacheKey is invalid.
 */
export function getCachedEmbedding(db, cacheKey, modelId) {
  if (!hasVectorCache(db)) return null;
  if (typeof cacheKey !== 'string' || cacheKey.length === 0) return null;
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  try {
    const row = db.prepare(
      'SELECT embedding FROM memory_entry_vectors WHERE cache_key = ? AND model_id = ?'
    ).get(cacheKey, modelId);
    if (!row || !row.embedding) return null;
    return decodeVector(row.embedding);
  } catch {
    return null;
  }
}

/**
 * setCachedEmbedding(db, cacheKey, modelId, vec) -> boolean (success).
 * INSERT OR REPLACE so re-embed after a model change overwrites the
 * stale row. No-op if the table is missing or the vector encoding fails.
 */
export function setCachedEmbedding(db, cacheKey, modelId, vec) {
  if (!hasVectorCache(db)) return false;
  if (typeof cacheKey !== 'string' || cacheKey.length === 0) return false;
  if (typeof modelId !== 'string' || modelId.length === 0) return false;
  const blob = encodeVector(vec);
  if (!blob) return false;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO memory_entry_vectors(cache_key, model_id, embedding) VALUES (?, ?, ?)'
    ).run(cacheKey, modelId, blob);
    return true;
  } catch {
    return false;
  }
}

/**
 * countCachedVectors(db, modelId?) -> number
 * Debug helper; tests assert that re-running search doesn't re-write rows.
 */
export function countCachedVectors(db, modelId) {
  if (!hasVectorCache(db)) return 0;
  try {
    if (modelId) {
      const row = db.prepare(
        'SELECT COUNT(*) AS n FROM memory_entry_vectors WHERE model_id = ?'
      ).get(modelId);
      return row ? Number(row.n) : 0;
    }
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_entry_vectors').get();
    return row ? Number(row.n) : 0;
  } catch {
    return 0;
  }
}
