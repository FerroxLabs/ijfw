/**
 * dashboard-aggregator.js — IJFW v1.4.3 W9-C (B19)
 *
 * Server-side aggregation of ~/.ijfw/state/permission-events.jsonl for the
 * dashboard's per-tool audit charts. Reads only the last TAIL_CHUNK bytes
 * (same 2MB cap as the events endpoint) so this is bounded-memory even
 * across rotations.
 *
 * Cache: 60s OR until the events file mtime changes, whichever first.
 * Malformed JSONL lines are dropped silently — never crash the dashboard
 * on a partial write.
 *
 * Returned shape:
 *   {
 *     hourly:        { [hourISO]: count },
 *     by_extension:  { [ext]:    { allowed: number, denied: number } },
 *     by_tool_denied:{ [tool]:   count }
 *   }
 *
 * Helper `computeWarnBashBypass(manifest)` implements ARCH-M-01: an extension
 * with `tool:bash` or `tool:exec` in writes AND a strict files/bytes quota
 * declared in the manifest gets a warning chip in the dashboard. The chip is
 * an information channel — quota enforcement still applies, but bash content
 * bypasses per-file accounting at the API surface.
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Match dashboard-server's TAIL_CHUNK. Kept here so this module is
// self-contained for the test harness.
export const TAIL_CHUNK = 2 * 1024 * 1024; // 2MB
const CACHE_TTL_MS = 60_000;

// Module-level cache. Key = canonical path; value = { mtimeMs, builtAt, result }.
const _cache = new Map();

export function _resetAggregatorCacheForTest() {
  _cache.clear();
}

function _readTailLines(eventsPath) {
  if (!existsSync(eventsPath)) return { lines: [], mtimeMs: 0 };
  let st;
  try { st = statSync(eventsPath); } catch { return { lines: [], mtimeMs: 0 }; }
  if (!st.size) return { lines: [], mtimeMs: st.mtimeMs };
  let buf;
  try { buf = readFileSync(eventsPath); } catch { return { lines: [], mtimeMs: st.mtimeMs }; }
  const slice = buf.subarray(Math.max(0, buf.length - TAIL_CHUNK));
  let lines = slice.toString('utf8').split('\n').filter(Boolean);
  // If we sliced mid-line, drop the partial leading element.
  if (buf.length > TAIL_CHUNK) lines = lines.slice(1);
  return { lines, mtimeMs: st.mtimeMs };
}

function _hourBucket(tsMs) {
  const d = new Date(tsMs);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/**
 * Aggregate permission events within `windowMs` of `now`.
 *
 * @param {string} eventsPath  absolute path to permission-events.jsonl
 * @param {{ windowMs?: number, now?: number }} [opts]
 */
export async function aggregateEvents(eventsPath, opts = {}) {
  const windowMs = (opts && typeof opts.windowMs === 'number') ? opts.windowMs : 24 * 3600 * 1000;
  const now      = (opts && typeof opts.now      === 'number') ? opts.now      : Date.now();

  const { lines, mtimeMs } = _readTailLines(eventsPath);

  const cached = _cache.get(eventsPath);
  if (cached
      && cached.mtimeMs === mtimeMs
      && (now - cached.builtAt) < CACHE_TTL_MS
      && cached.windowMs === windowMs) {
    return cached.result;
  }

  const cutoff = now - windowMs;
  const hourly         = Object.create(null);
  const byExt          = Object.create(null);
  const byToolDenied   = Object.create(null);

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const t = typeof obj.ts === 'string' ? Date.parse(obj.ts) : (typeof obj.ts === 'number' ? obj.ts : NaN);
    if (!Number.isFinite(t)) continue;
    if (t < cutoff) continue;

    const ext     = (typeof obj.extension === 'string' && obj.extension) ? obj.extension : '<unknown>';
    const tool    = (typeof obj.tool === 'string' && obj.tool) ? obj.tool : (typeof obj.action === 'string' ? obj.action : '<unknown>');
    const allowed = obj.allowed !== false; // anything other than explicit false is allowed.

    // hourly
    const hk = _hourBucket(t);
    hourly[hk] = (hourly[hk] || 0) + 1;

    // by_extension
    if (!byExt[ext]) byExt[ext] = { allowed: 0, denied: 0 };
    if (allowed) byExt[ext].allowed += 1;
    else         byExt[ext].denied  += 1;

    // by_tool_denied
    if (!allowed) {
      byToolDenied[tool] = (byToolDenied[tool] || 0) + 1;
    }
  }

  const result = { hourly, by_extension: byExt, by_tool_denied: byToolDenied };
  _cache.set(eventsPath, { mtimeMs, builtAt: now, windowMs, result });
  return result;
}

/**
 * ARCH-M-01: compute whether an extension's manifest combines a bash/exec
 * write permission with a strict files/bytes quota.
 *
 * Returns true iff:
 *   manifest.permissions.writes includes "tool:bash" or "tool:exec"
 *   AND (quotas.max_files_written OR quotas.max_bytes_written is set)
 */
export function computeWarnBashBypass(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  const perms = manifest.permissions || {};
  const writes = Array.isArray(perms.writes) ? perms.writes : [];
  const hasBashOrExec = writes.some((w) => w === 'tool:bash' || w === 'tool:exec');
  if (!hasBashOrExec) return false;
  const q = manifest.quotas || {};
  const hasStrictQuota =
    (typeof q.max_files_written === 'number' && Number.isFinite(q.max_files_written)) ||
    (typeof q.max_bytes_written === 'number' && Number.isFinite(q.max_bytes_written));
  return Boolean(hasStrictQuota);
}

/**
 * Resolve `<scope>/<name>/manifest.json` and read it. Returns the parsed
 * manifest object or `null` if the file is missing/unreadable/malformed.
 *
 * Scope→path map mirrors `active-extension-writer.js`:
 *   project: <projectRoot>/.ijfw/extensions/<name>/manifest.json
 *   org:     <home>/.ijfw/extensions-org/<name>/manifest.json
 *   user:    <home>/.ijfw/extensions-user/<name>/manifest.json
 */
export function readActiveManifest({ scope, name, home, projectRoot }) {
  if (!scope || !name) return null;
  let path = null;
  if (scope === 'project' && projectRoot) {
    path = join(projectRoot, '.ijfw', 'extensions', name, 'manifest.json');
  } else if (scope === 'org' && home) {
    path = join(home, '.ijfw', 'extensions-org', name, 'manifest.json');
  } else if (scope === 'user' && home) {
    path = join(home, '.ijfw', 'extensions-user', name, 'manifest.json');
  }
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
