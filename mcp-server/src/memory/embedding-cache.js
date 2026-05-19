// v1.5.0 audit MED #7 (memory-engine.md F-PRF-4): persistent embedding
// cache. Thin read/write surface over the memory_entry_vectors table
// (migration 005). All functions are sync to match the rest of the
// memory tier (better-sqlite3 is synchronous) and tolerate a db that
// hasn't reached schema v5 -- callers see "miss" rather than a throw,
// so hybrid rerank degrades to live re-embed without flooding stderr.
//
// Format: Float32Array <-> Buffer at the SQLite boundary. Each float
// is 4 bytes little-endian. Decode is endian-agnostic via DataView.

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
  const out = new Array(n);
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
 * getCachedVector(db, memoryId, modelId) -> number[] | null
 * Returns the stored embedding for the (memory_id, model_id) pair, or
 * null on miss / when the table is absent.
 */
export function getCachedVector(db, memoryId, modelId) {
  if (!hasVectorCache(db)) return null;
  try {
    const row = db.prepare(
      'SELECT embedding FROM memory_entry_vectors WHERE memory_id = ? AND model_id = ?'
    ).get(memoryId, modelId);
    if (!row || !row.embedding) return null;
    return decodeVector(row.embedding);
  } catch {
    return null;
  }
}

/**
 * setCachedVector(db, memoryId, modelId, vec) -> boolean (success).
 * INSERT OR REPLACE so re-embed after a model change overwrites the
 * stale row. No-op if the table is missing or the vector encoding fails.
 */
export function setCachedVector(db, memoryId, modelId, vec) {
  if (!hasVectorCache(db)) return false;
  const blob = encodeVector(vec);
  if (!blob) return false;
  try {
    db.prepare(
      'INSERT OR REPLACE INTO memory_entry_vectors(memory_id, model_id, embedding) VALUES (?, ?, ?)'
    ).run(memoryId, modelId, blob);
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
