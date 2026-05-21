// model-refresh.js — 24h-cached latest-model resolver for audit-roster's
// HTTP API fallback path.
//
// Why: CLI dispatch (codex exec, gemini, claude -p) inherits whatever the
// CLI defaults to, so the model ID is always fresh on the CLI path. But
// when the CLI is NOT installed and we fall back to direct HTTP, the model
// name is OURS to pick. Hardcoded strings rot. This module caches the
// latest non-preview model per provider and refreshes once every 24 hours.
//
// Design:
//   - getLatestModel(family) is SYNCHRONOUS — returns cached value (or
//     hardcoded fallback) immediately. Never blocks on network.
//   - When the cache is stale or missing, we kick off a non-blocking
//     refresh via queueMicrotask. The CURRENT call still returns the
//     last-known-good value. The fresh value lands by the next call.
//   - Each provider probe is wrapped in try/catch. Probe failure leaves
//     the previous cache entry in place.
//   - Atomic writes: tmp-file + rename. No partial-write corruption.
//   - Zero new deps. Node 18+ global fetch.
//
// Cache file shape:
//   {
//     "schema": 1,
//     "updated_at": "2026-05-18T16:00:00.000Z",
//     "models": {
//       "openai":    { "id": "gpt-5.5",                  "checked_at": "..." },
//       "google":    { "id": "gemini-3.1-pro",           "checked_at": "..." },
//       "anthropic": { "id": "claude-haiku-4-5-20251001","checked_at": "..." }
//     }
//   }

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const CACHE_SCHEMA = 1;
export const TTL_MS = 24 * 60 * 60 * 1000;

// Last-known-good defaults, kept in source so offline / no-API-key users
// get a working answer. Bumped 2026-05-18 to v1.5.0-major flagships.
export const HARDCODED_FALLBACKS = Object.freeze({
  openai:    'gpt-5.5',
  google:    'gemini-3.1-pro',
  anthropic: 'claude-haiku-4-5-20251001',
});

// Resolve cache dir lazily so tests can override via env.
export function cachePath(env = process.env) {
  const root = env.IJFW_CACHE_DIR || join(homedir(), '.ijfw', 'cache');
  return join(root, 'model-roster.json');
}

// Returns true if `tsISO` is within `ttlMs` of `now`.
export function isCacheFresh(tsISO, now = Date.now(), ttlMs = TTL_MS) {
  if (!tsISO) return false;
  const t = Date.parse(tsISO);
  if (!Number.isFinite(t)) return false;
  return (now - t) < ttlMs;
}

// Read the cache file. Returns null on any error (missing / malformed).
export function readCache(env = process.env) {
  try {
    const raw = readFileSync(cachePath(env), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schema !== CACHE_SCHEMA) return null;
    if (!parsed.models || typeof parsed.models !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Atomic write — tmp file + rename. Creates parent dir if needed.
export function writeCache(payload, env = process.env) {
  const p = cachePath(env);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, p);
}

// Track in-flight refresh so concurrent calls don't fire N probes.
let inflightRefresh = null;

// Semver-aware comparison for model IDs.
//
// Why: Lexical sort breaks once a family hits double-digit majors:
// `gemini-10.0` sorts BEFORE `gemini-2.0` because "1" < "2" before
// length is considered. This compares dot-separated segments numerically
// (highest first when used as a max-picker), falling back to lexical
// for non-numeric tail segments like `-flash`, `-pro`, `-thinking`.
//
// Returns negative if a < b, positive if a > b, 0 if equal.
// Inputs are full model IDs, e.g. 'gemini-2.5-pro', 'gemini-10.0-pro'.
export function compareModelIds(a, b) {
  // Split on hyphens AND dots so 'gemini-2.5-pro' → ['gemini','2','5','pro'].
  const segs = (s) => String(s).split(/[-.]/);
  const A = segs(a);
  const B = segs(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const sa = A[i];
    const sb = B[i];
    if (sa === sb) continue;
    if (sa === undefined) return -1;   // shorter is "less than"
    if (sb === undefined) return 1;
    const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : NaN;
    const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : NaN;
    const aIsNum = Number.isFinite(na);
    const bIsNum = Number.isFinite(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
      continue;
    }
    // Numeric segments beat non-numeric at the same position (so
    // 'gemini-2.5-pro' < 'gemini-2.5-pro-thinking' falls out via the
    // length rule above; here we just need deterministic ordering for
    // mixed types).
    if (aIsNum !== bIsNum) return aIsNum ? 1 : -1;
    // Both non-numeric — lexical fallback.
    return sa < sb ? -1 : 1;
  }
  return 0;
}

// Synchronous resolver. Returns the cached model id, or the hardcoded
// fallback, NEVER null. Triggers a background refresh if stale.
//   family: 'openai' | 'google' | 'anthropic'
//   opts.now    — inject for tests
//   opts.env    — inject for tests
//   opts.fetch  — inject for tests (defaults to globalThis.fetch)
export function getLatestModel(family, opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now || Date.now();
  const cache = readCache(env);
  const cached = cache?.models?.[family]?.id;
  const fresh = isCacheFresh(cache?.updated_at, now);

  if (!fresh && !inflightRefresh) {
    // Fire-and-forget refresh. Never throw out of the sync call.
    inflightRefresh = refreshModelCache({ env, now, fetch: opts.fetch })
      .catch(() => null)
      .finally(() => { inflightRefresh = null; });
  }

  return cached || HARDCODED_FALLBACKS[family] || null;
}

// Per-provider model-list probe. Each returns either { id } on success or
// null on failure (network / auth / unexpected shape). NEVER throws.
//
// All three providers expose a list-models endpoint. We pick the latest
// non-preview, non-deprecated entry that looks like a current reasoning
// model. Heuristic, intentionally conservative.
//
// v1.5.0 audit-LOW-tok-L2: every probe is wrapped in an AbortController
// with a hard timeout so a hung TLS handshake / TCP half-open can't keep
// the event loop alive past process exit. Without this the Node runtime
// would leak open sockets when getLatestModel() schedules a background
// refresh and the host process tries to exit before the probes resolve.

const PROBE_TIMEOUT_MS = 5000;

// makeAbortable -> { signal, cancel } pair. Caller MUST call cancel() in
// a finally{} so we always clear the timer (cancel() is a no-op once the
// timeout has fired; we use it primarily to release the unref'd timer).
function makeAbortable(timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // unref so the timer alone never keeps the event loop alive.
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function probeOpenAI(env, fetchImpl) {
  const key = env.OPENAI_API_KEY;
  if (!key) return null;
  const { signal, cancel } = makeAbortable();
  try {
    const r = await fetchImpl('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
      signal,
    });
    if (!r.ok) return null;
    const json = await r.json();
    const list = Array.isArray(json.data) ? json.data : [];
    const candidates = list
      .filter(m => typeof m.id === 'string')
      .filter(m => /^gpt-[5-9]/.test(m.id))          // gpt-5+ family
      .filter(m => !/preview|deprecated|alpha/i.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    return candidates[0] ? { id: candidates[0].id } : null;
  } catch {
    return null;
  } finally {
    cancel();
  }
}

async function probeAnthropic(env, fetchImpl) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const { signal, cancel } = makeAbortable();
  try {
    const r = await fetchImpl('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal,
    });
    if (!r.ok) return null;
    const json = await r.json();
    const list = Array.isArray(json.data) ? json.data : [];
    // Pick latest haiku (lowest-cost fallback for API path; quality is
    // bounded by the use case — apiFallback is for short audit JSON).
    const candidates = list
      .filter(m => typeof m.id === 'string' && /haiku/i.test(m.id))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return candidates[0] ? { id: candidates[0].id } : null;
  } catch {
    return null;
  } finally {
    cancel();
  }
}

async function probeGoogle(env, fetchImpl) {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;
  const { signal, cancel } = makeAbortable();
  try {
    const r = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { signal },
    );
    if (!r.ok) return null;
    const json = await r.json();
    const list = Array.isArray(json.models) ? json.models : [];
    const candidates = list
      .map(m => typeof m.name === 'string' ? m.name.replace(/^models\//, '') : '')
      .filter(Boolean)
      .filter(n => n.startsWith('gemini-'))
      .filter(n => /-pro\b/.test(n))                  // prefer pro tier
      .filter(n => !/preview|exp|deprecated/i.test(n))
      .sort(compareModelIds);                         // semver-aware: gemini-10.0 > gemini-2.5
    const pick = candidates[candidates.length - 1];
    return pick ? { id: pick } : null;
  } catch {
    return null;
  } finally {
    cancel();
  }
}

// Refresh all three families. Preserves existing entries when a probe
// fails so a transient outage doesn't wipe a good cache. Returns the
// updated cache payload.
export async function refreshModelCache({ env = process.env, now = Date.now(), fetch: fetchImpl } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') {
    // Older node without global fetch — keep prior cache intact.
    return readCache(env);
  }

  const prior = readCache(env) || { schema: CACHE_SCHEMA, updated_at: null, models: {} };
  const next  = { schema: CACHE_SCHEMA, updated_at: new Date(now).toISOString(), models: { ...prior.models } };
  const ts = next.updated_at;

  const probes = await Promise.all([
    probeOpenAI(env, fetcher).then(r => ({ family: 'openai', r })),
    probeAnthropic(env, fetcher).then(r => ({ family: 'anthropic', r })),
    probeGoogle(env, fetcher).then(r => ({ family: 'google', r })),
  ]);

  for (const { family, r } of probes) {
    if (r && r.id) {
      next.models[family] = { id: r.id, checked_at: ts };
    }
    // else: leave prior entry in place (or absent — caller falls back to
    // HARDCODED_FALLBACKS via getLatestModel).
  }

  writeCache(next, env);
  return next;
}

// Test helper — reset the in-flight guard so unit tests can drive refreshes
// back-to-back without leak.
export function _resetInflight() { inflightRefresh = null; }
