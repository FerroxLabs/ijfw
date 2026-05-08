// --- Trident lens-health (C9.7) ---
//
// Lightweight liveness probes for the three Trident lineages.
//
//   codex  -- runs `codex --version` (no API call, fast).
//   gemini -- runs `gemini --version`.
//   claude -- always live: this code IS the Anthropic-lineage caller.
//
// Per C9.7 the probe must stay fast and cheap. We never gate on actual API
// reachability here -- a `--version` exit-0 means the CLI binary is on PATH
// and responsive. Quota / auth failures surface later in the dispatcher when
// the lens actually fires.
//
// Cache: results are memoised for 60s by default. Callers can force a fresh
// probe via { fresh: true } or change the TTL via { ttlMs }.
//
// Zero external deps. ESM. No emoji. LC_ALL=C.

import { spawn } from 'node:child_process';

// Per-process cache. Reset by tests via _resetCache().
const _cache = new Map(); // lens id -> { result, ts }

// Default cache TTL (ms). Overridable per-call.
export const DEFAULT_TTL_MS = 60_000;

// Default per-probe timeout (ms). `--version` for codex returns ~50-100ms;
// gemini's CLI cold-start can take 400-600ms before printing the version
// (Node startup + module load). 1500ms covers gemini cold-start with margin
// while staying ~80x cheaper than an actual audit call. Override per-call
// via { timeoutMs }.
export const PROBE_TIMEOUT_MS = 1500;

// Map a lens id to the binary + args used for liveness probing.
// `--version` is universal across CLI tools; exit 0 means alive.
const PROBE_COMMAND = {
  codex:  { bin: 'codex',  args: ['--version'] },
  gemini: { bin: 'gemini', args: ['--version'] },
};

// runProbe -- spawn a single probe child process with a hard timeout.
// Resolves with { live: bool, latency_ms: number, error: string|null }.
// Never throws; spawn errors / timeouts collapse into { live: false, error }.
function runProbe(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const settle = (val) => { if (settled) return; settled = true; resolve(val); };

    let proc;
    const timer = setTimeout(() => {
      if (proc) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        try { proc.stdout && proc.stdout.destroy(); } catch { /* ignore */ }
        try { proc.stderr && proc.stderr.destroy(); } catch { /* ignore */ }
      }
      settle({ live: false, latency_ms: Date.now() - t0, error: 'timeout' });
    }, timeoutMs);

    try {
      // LC_ALL=C: deterministic, locale-independent output. We don't read the
      // version string itself -- we only care about exit 0 -- but pinning the
      // locale costs nothing and matches the rest of the codebase.
      proc = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
    } catch (err) {
      clearTimeout(timer);
      settle({ live: false, latency_ms: Date.now() - t0, error: 'spawn_error: ' + (err && err.message ? err.message : String(err)) });
      return;
    }

    // Drain stdio so the child doesn't hang on a full pipe.
    proc.stdout.on('data', () => { /* discard */ });
    proc.stderr.on('data', () => { /* discard */ });

    proc.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT -> binary not on PATH. Treat as not live, not as a probe error.
      if (err && err.code === 'ENOENT') {
        settle({ live: false, latency_ms: Date.now() - t0, error: 'not_installed' });
      } else {
        settle({ live: false, latency_ms: Date.now() - t0, error: 'spawn_error: ' + (err && err.message ? err.message : String(err)) });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const latency_ms = Date.now() - t0;
      if (code === 0) {
        settle({ live: true, latency_ms, error: null });
      } else {
        settle({ live: false, latency_ms, error: `exit_${code}` });
      }
    });
  });
}

// probeOne -- public single-lens probe with cache.
//
//   lens     -- 'codex' | 'gemini' | 'claude'
//   opts     -- { fresh, ttlMs, timeoutMs }
//
// Returns the same shape stored in the cache.
export async function probeOne(lens, opts = {}) {
  if (lens === 'claude') {
    // We ARE the Anthropic lineage. No external probe needed; the dispatcher
    // is running in this process. Always live.
    const result = { live: true, latency_ms: 0, error: null, source: 'in_process' };
    return result;
  }

  const cmd = PROBE_COMMAND[lens];
  if (!cmd) {
    return { live: false, latency_ms: 0, error: 'unknown_lens', source: 'invalid' };
  }

  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_TTL_MS;
  const fresh = Boolean(opts.fresh);
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : PROBE_TIMEOUT_MS;
  const now = Date.now();

  if (!fresh) {
    const cached = _cache.get(lens);
    if (cached && (now - cached.ts) < ttlMs) {
      return { ...cached.result, source: 'cache', cached_age_ms: now - cached.ts };
    }
  }

  const result = await runProbe(cmd.bin, cmd.args, timeoutMs);
  _cache.set(lens, { result, ts: Date.now() });
  return { ...result, source: 'probe' };
}

// probeLenses -- run liveness checks across multiple lenses in parallel.
//
//   { codex: bool, gemini: bool, claude: bool }  -- which lenses to probe.
//   opts is forwarded to probeOne (fresh, ttlMs, timeoutMs).
//
// Default: probe all three. Returns:
//   {
//     codex:  { live, latency_ms, error, source }    (only if requested)
//     gemini: { live, latency_ms, error, source }    (only if requested)
//     claude: { live: true, ... }                    (only if requested)
//     summary: { live_count, total, live_lenses, dead_lenses, mode }
//   }
// where mode is one of: 'full' (3/3), 'partial' (2/3), 'degraded' (1/3),
// 'offline' (0/3).
export async function probeLenses(which = { codex: true, gemini: true, claude: true }, opts = {}) {
  const targets = [];
  if (which.codex)  targets.push('codex');
  if (which.gemini) targets.push('gemini');
  if (which.claude) targets.push('claude');

  const results = await Promise.all(targets.map(t => probeOne(t, opts)));

  const out = {};
  targets.forEach((t, i) => { out[t] = results[i]; });

  const live_lenses = targets.filter((t) => out[t] && out[t].live);
  const dead_lenses = targets.filter((t) => !(out[t] && out[t].live));
  const mode = computeMode(live_lenses.length, targets.length);

  out.summary = {
    live_count: live_lenses.length,
    total: targets.length,
    live_lenses,
    dead_lenses,
    mode,
    probed_at: Date.now(),
  };
  return out;
}

// Mode classifier. Used by dashboard tile + dispatcher gating.
function computeMode(live, total) {
  if (live === total && total >= 3) return 'full';
  if (live === total && total === 2) return 'partial';
  if (live === total && total === 1) return 'degraded';
  if (live === 0) return 'offline';
  if (live >= 2) return 'partial';
  if (live === 1) return 'degraded';
  return 'offline';
}

// Health-tile shape: per-lens last-probe, plus an alert flag if any lens
// has been dead for longer than alertThresholdMs (default 24h).
export function healthTileShape(probeResult, opts = {}) {
  const alertThresholdMs = typeof opts.alertThresholdMs === 'number'
    ? opts.alertThresholdMs
    : 24 * 60 * 60 * 1000; // 24h
  const now = Date.now();

  const lenses = ['codex', 'gemini', 'claude'].filter(l => probeResult[l]);
  const tile = {
    mode: probeResult.summary && probeResult.summary.mode,
    live_count: probeResult.summary && probeResult.summary.live_count,
    total: probeResult.summary && probeResult.summary.total,
    lenses: {},
    alert: false,
    alert_reason: null,
  };

  // Track dead-since timestamps in cache so we can compute duration.
  for (const l of lenses) {
    const r = probeResult[l];
    const live = !!(r && r.live);
    const deadSince = _deadSinceTracker.get(l);

    if (!live) {
      if (!deadSince) {
        _deadSinceTracker.set(l, now);
      }
      const since = _deadSinceTracker.get(l);
      const duration_ms = now - since;
      tile.lenses[l] = {
        live: false,
        latency_ms: r ? r.latency_ms : null,
        error: r ? r.error : null,
        dead_since_ms: since,
        dead_for_ms: duration_ms,
      };
      if (duration_ms >= alertThresholdMs) {
        tile.alert = true;
        tile.alert_reason = `${l} dead for ${Math.floor(duration_ms / 3_600_000)}h`;
      }
    } else {
      _deadSinceTracker.delete(l);
      tile.lenses[l] = {
        live: true,
        latency_ms: r.latency_ms,
        error: null,
      };
    }
  }
  return tile;
}

// Outage-duration tracker: lens id -> first-seen-dead timestamp.
const _deadSinceTracker = new Map();

// Test hooks. Not part of the stable API.
export function _resetCache() {
  _cache.clear();
  _deadSinceTracker.clear();
}
export function _setCache(lens, result, ts = Date.now()) {
  _cache.set(lens, { result, ts });
}
export function _setDeadSince(lens, ts) {
  _deadSinceTracker.set(lens, ts);
}
