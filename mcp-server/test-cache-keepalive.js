// v1.5.0 audit-MED-tok-M2 — tests for cache-keepalive heartbeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKeepaliveInterval,
  startKeepalive,
  startKeepaliveFromEnv,
  KEEPALIVE_BOUNDS,
} from './src/lib/cache-keepalive.js';

// ---------------------------------------------------------------------------
// parseKeepaliveInterval — env parsing edge cases.
// ---------------------------------------------------------------------------

test('parseKeepaliveInterval: missing env → 0 (disabled)', () => {
  assert.equal(parseKeepaliveInterval({}), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: undefined }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: null }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '' }), 0);
});

test('parseKeepaliveInterval: non-numeric / NaN / Infinity → 0', () => {
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: 'abc' }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: 'NaN' }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: 'Infinity' }), 0);
});

test('parseKeepaliveInterval: below min (1000ms) → 0', () => {
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '1' }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '999' }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '0' }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '-5000' }), 0);
});

test('parseKeepaliveInterval: above max clamps to MAX_INTERVAL_MS', () => {
  const max = KEEPALIVE_BOUNDS.maxIntervalMs;
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: String(max + 1) }), max);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '99999999' }), max);
});

test('parseKeepaliveInterval: valid in-range value preserved', () => {
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '60000' }), 60000);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '120000' }), 120000);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '1000' }), 1000);
});

test('parseKeepaliveInterval: IJFW_DISABLE_CACHE_KEEPALIVE override beats any value', () => {
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '60000', IJFW_DISABLE_CACHE_KEEPALIVE: '1' }), 0);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '60000', IJFW_DISABLE_CACHE_KEEPALIVE: 'true' }), 0);
  // "0" or "false" do NOT count as a disable.
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '60000', IJFW_DISABLE_CACHE_KEEPALIVE: '0' }), 60000);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '60000', IJFW_DISABLE_CACHE_KEEPALIVE: 'false' }), 60000);
});

test('parseKeepaliveInterval: fractional values floor down', () => {
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '60000.7' }), 60000);
  assert.equal(parseKeepaliveInterval({ IJFW_CACHE_KEEPALIVE_MS: '1500.9' }), 1500);
});

// ---------------------------------------------------------------------------
// startKeepalive — no-op cases.
// ---------------------------------------------------------------------------

test('startKeepalive: intervalMs=0 returns no-op handle', () => {
  let called = 0;
  const h = startKeepalive({ intervalMs: 0, onTick: () => { called++; } });
  assert.equal(h.isActive(), false);
  assert.equal(h.ticks(), 0);
  h.cancel(); // idempotent
  h.cancel();
  assert.equal(called, 0);
});

test('startKeepalive: missing onTick returns no-op handle', () => {
  const h = startKeepalive({ intervalMs: 1000 });
  assert.equal(h.isActive(), false);
  h.cancel();
});

test('startKeepalive: pre-aborted signal returns no-op', () => {
  const ac = new AbortController();
  ac.abort();
  const h = startKeepalive({ intervalMs: 1000, onTick: () => {}, signal: ac.signal });
  assert.equal(h.isActive(), false);
});

// ---------------------------------------------------------------------------
// startKeepalive — active timer behaviour (uses a fast interval for speed).
// ---------------------------------------------------------------------------

test('startKeepalive: fires onTick on each interval (active path)', async () => {
  let ticks = 0;
  const h = startKeepalive({
    intervalMs: 1000,    // min allowed in production; we'll wait < 3.5s
    onTick: () => { ticks++; },
  });
  assert.equal(h.isActive(), true);
  // Wait long enough for ~3 ticks.
  await new Promise((r) => setTimeout(r, 3300));
  h.cancel();
  assert.ok(ticks >= 2, `expected ≥2 ticks in ~3.3s, got ${ticks}`);
  assert.equal(h.ticks(), ticks, 'handle.ticks() reflects actual count');
  assert.equal(h.isActive(), false, 'handle inactive after cancel');
});

test('startKeepalive: cancel() stops further ticks', async () => {
  let ticks = 0;
  const h = startKeepalive({
    intervalMs: 1000,
    onTick: () => { ticks++; },
  });
  await new Promise((r) => setTimeout(r, 1200));
  const ticksBeforeCancel = ticks;
  h.cancel();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ticks, ticksBeforeCancel, 'no ticks fire after cancel');
});

test('startKeepalive: onTick errors are swallowed and routed to onError', async () => {
  let errors = 0;
  const h = startKeepalive({
    intervalMs: 1000,
    onTick: () => { throw new Error('boom'); },
    onError: () => { errors++; },
  });
  await new Promise((r) => setTimeout(r, 2200));
  h.cancel();
  assert.ok(errors >= 1, `onError must be called at least once, got ${errors}`);
});

test('startKeepalive: onError throwing is swallowed (no uncaught)', async () => {
  // If we don't swallow the onError error, this test would crash the runner.
  const h = startKeepalive({
    intervalMs: 1000,
    onTick: () => { throw new Error('boom'); },
    onError: () => { throw new Error('error sink also explodes'); },
  });
  await new Promise((r) => setTimeout(r, 1200));
  h.cancel();
  // If we made it here, no uncaught.
  assert.ok(true);
});

test('startKeepalive: overlap guard skips re-entrant ticks', async () => {
  let starts = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const h = startKeepalive({
    intervalMs: 1000,
    onTick: async () => {
      starts++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Slow tick: longer than interval to force overlap attempts.
      await new Promise((r) => setTimeout(r, 1500));
      inFlight--;
    },
  });
  await new Promise((r) => setTimeout(r, 3500));
  h.cancel();
  // Even though interval=1000ms but tick takes 1500ms, max-inflight must stay 1.
  assert.equal(maxInFlight, 1, `overlap guard must keep maxInFlight=1, got ${maxInFlight}`);
});

test('startKeepalive: signal abort cancels the heartbeat', async () => {
  const ac = new AbortController();
  let ticks = 0;
  const h = startKeepalive({
    intervalMs: 1000,
    onTick: () => { ticks++; },
    signal: ac.signal,
  });
  await new Promise((r) => setTimeout(r, 1200));
  ac.abort();
  const ticksAtAbort = ticks;
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(ticks, ticksAtAbort, 'no ticks fire after signal abort');
  assert.equal(h.isActive(), false, 'handle reports inactive after signal abort');
});

// ---------------------------------------------------------------------------
// startKeepaliveFromEnv — convenience wrapper.
// ---------------------------------------------------------------------------

test('startKeepaliveFromEnv: env-disabled returns no-op', () => {
  const h = startKeepaliveFromEnv({ onTick: () => {}, env: {} });
  assert.equal(h.isActive(), false);
  h.cancel();
});

test('startKeepaliveFromEnv: env-enabled returns active handle', () => {
  const h = startKeepaliveFromEnv({
    onTick: () => {},
    env: { IJFW_CACHE_KEEPALIVE_MS: '5000' },
  });
  assert.equal(h.isActive(), true);
  h.cancel();
});

test('KEEPALIVE_BOUNDS: exposes sensible min/max', () => {
  assert.ok(KEEPALIVE_BOUNDS.minIntervalMs > 0);
  assert.ok(KEEPALIVE_BOUNDS.maxIntervalMs >= KEEPALIVE_BOUNDS.minIntervalMs);
  // Max should match the Anthropic ephemeral cache TTL (5 min).
  assert.equal(KEEPALIVE_BOUNDS.maxIntervalMs, 300_000);
});
