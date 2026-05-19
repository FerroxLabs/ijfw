// v1.5.0 audit-MED-tok-M2 — Cache-keepalive heartbeat.
//
// Anthropic's ephemeral prompt cache has a 5-minute TTL. A long Trident
// wave (5+ minutes of sequential calls separated by network/CLI latency)
// can therefore start LOSING cache hits mid-wave even though every call
// re-sends the same cache-eligible prefix. A "keepalive" heartbeat keeps
// the cache warm by sending a tiny dummy request to the same prefix on
// a configurable interval.
//
// This module is OPT-IN and OFF by default. Enable via env:
//
//     IJFW_CACHE_KEEPALIVE_MS=60000   # 60s -> fire heartbeat every minute
//
// Set to 0 or unset to disable (default).
//
// The heartbeat is a NO-OP when:
//   - env is unset, empty, or non-numeric
//   - parsed value is ≤ 0 or > 300_000 (5 min cap matches the cache TTL)
//   - no callback is supplied
//   - process.env.IJFW_DISABLE_CACHE_KEEPALIVE is truthy (override)
//
// Callers receive a `cancel()` function. The cancel is idempotent: calling
// it twice (or after the heartbeat already finished) is safe.
//
// The CALLER supplies the actual "send a tiny request" logic via the
// `onTick` callback. This keeps the lib zero-dep on api-client.js and lets
// tests inject a deterministic stub.

// Lower bound is intentionally generous: 1s minimum so a fat-fingered "1"
// env var doesn't spin the loop tighter than the runtime needs.
const MIN_INTERVAL_MS = 1_000;
// Upper bound matches the Anthropic ephemeral-cache TTL. Beyond 5 min the
// next request would be a fresh-cache call regardless, so the heartbeat
// has no effect.
const MAX_INTERVAL_MS = 300_000;

/**
 * Parse the keepalive interval from env. Returns 0 (disabled) when the env
 * var is missing, unparseable, or out of bounds — never throws.
 *
 * @param {object} [env] - defaults to process.env
 * @returns {number}      - interval in ms; 0 means disabled
 */
export function parseKeepaliveInterval(env = process.env) {
  if (env.IJFW_DISABLE_CACHE_KEEPALIVE && env.IJFW_DISABLE_CACHE_KEEPALIVE !== 'false' && env.IJFW_DISABLE_CACHE_KEEPALIVE !== '0') {
    return 0;
  }
  const raw = env.IJFW_CACHE_KEEPALIVE_MS;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < MIN_INTERVAL_MS) return 0;
  if (n > MAX_INTERVAL_MS) return MAX_INTERVAL_MS;
  return Math.floor(n);
}

/**
 * Start a keepalive heartbeat. Returns a cancel function (idempotent).
 *
 * Contract:
 *   - When `intervalMs === 0` or `onTick` is not a function, returns a
 *     no-op cancel so the caller never has to branch on enable/disable.
 *   - The heartbeat NEVER throws back to the caller; onTick errors are
 *     swallowed (and optionally surfaced via `onError`) so a transient
 *     network blip during keepalive can't crash the Trident wave.
 *   - The timer is `.unref()`'d so it never holds the event loop open.
 *
 * @param {object} args
 * @param {number} args.intervalMs           - 0 = disabled, else MIN..MAX
 * @param {() => Promise<void>|void} args.onTick   - sender; runs each interval
 * @param {(err: Error) => void} [args.onError]    - optional error sink
 * @param {AbortSignal} [args.signal]              - external cancel propagation
 * @returns {{ cancel: () => void, isActive: () => boolean, ticks: () => number }}
 */
export function startKeepalive({ intervalMs, onTick, onError, signal } = {}) {
  const noop = { cancel: () => {}, isActive: () => false, ticks: () => 0 };

  if (typeof intervalMs !== 'number' || intervalMs <= 0) return noop;
  if (typeof onTick !== 'function') return noop;
  if (signal && signal.aborted) return noop;

  let tickCount = 0;
  let cancelled = false;
  let timer = null;
  let running = false;

  const fire = async () => {
    if (cancelled) return;
    if (running) return; // overlap guard — if the previous tick still in flight, skip
    running = true;
    tickCount++;
    try {
      await onTick();
    } catch (err) {
      if (typeof onError === 'function') {
        try { onError(err); } catch { /* swallow */ }
      }
    } finally {
      running = false;
    }
  };

  // Use setInterval (not setTimeout chain) so a slow onTick can't drift the
  // schedule indefinitely; combined with the `running` overlap guard, the
  // worst case is "skipped tick" rather than "overlapping ticks".
  timer = setInterval(fire, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  if (signal) {
    if (signal.aborted) {
      cancel();
    } else {
      signal.addEventListener('abort', cancel, { once: true });
    }
  }

  return {
    cancel,
    isActive: () => !cancelled,
    ticks: () => tickCount,
  };
}

/**
 * Convenience wrapper for the common Trident-wave case: read env, start
 * keepalive (or no-op), and return the cancel handle.
 *
 * @param {object} args
 * @param {() => Promise<void>|void} args.onTick
 * @param {(err: Error) => void} [args.onError]
 * @param {AbortSignal} [args.signal]
 * @param {object} [args.env]
 * @returns {{ cancel: () => void, isActive: () => boolean, ticks: () => number }}
 */
export function startKeepaliveFromEnv({ onTick, onError, signal, env = process.env } = {}) {
  const intervalMs = parseKeepaliveInterval(env);
  return startKeepalive({ intervalMs, onTick, onError, signal });
}

// Constants exported for tests + docs.
export const KEEPALIVE_BOUNDS = { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS };
