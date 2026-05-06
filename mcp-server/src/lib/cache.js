// Lightweight TTL cache with mtime-based invalidation. Zero deps.
//
// ttlCache(key, ttlMs, mtimeKeyFn, computeFn) -> value
//   mtimeKeyFn is a FUNCTION called lazily -- only invoked when TTL has elapsed or cache is cold.
//   Cache hits within TTL return immediately without invoking mtimeKeyFn or computeFn.
//   mtimeKey: a string-quantizable invalidator (e.g. "<latest mtime>:<file count>").
//   If mtimeKey changes after TTL expiry, cache is busted; if unchanged, cachedAt is refreshed.

const store = new Map(); // key -> { value, cachedAt, mtimeKey }

export function ttlCache(key, ttlMs, mtimeKeyFn, computeFn) {
  if (process.env.IJFW_DASHBOARD_NO_CACHE === '1') return computeFn();
  const now = Date.now();
  const entry = store.get(key);
  if (entry && (now - entry.cachedAt) < ttlMs) {
    // Inside TTL -- fast path: no fs walk, no invalidator check.
    return entry.value;
  }
  // TTL expired or cache miss -- now invoke the invalidator lazily.
  const mtimeKey = mtimeKeyFn();
  if (entry && entry.mtimeKey === mtimeKey) {
    // Same data -- just refresh cachedAt, skip recompute.
    entry.cachedAt = now;
    return entry.value;
  }
  const value = computeFn();
  store.set(key, { value, cachedAt: now, mtimeKey });
  return value;
}

export function clearCache() {
  store.clear();
}
