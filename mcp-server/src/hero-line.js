// hero-line.js -- one-line summary renderer for cross-run receipts.
// Codex U1 caveat: delta is NEVER fabricated. If real data is insufficient,
// the delta suffix is omitted entirely.

import { getPricing, getPricesTable } from './cost/pricing.js';

// Format duration in whole seconds (or ms if <1000ms total).
function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 1000)}s`;
}

// Normalize receipt findings into { total, consensus } counts regardless of
// whether the receipt came from audit/critique (findings.items), research
// (findings.consensus / findings.contested / findings.unique as arrays), or
// a legacy numeric shape ({ consensus: N, contested: N, unique: N }).
function countFindings(f) {
  if (!f) return { total: 0, consensus: 0 };
  if (Array.isArray(f.items)) return { total: f.items.length, consensus: 0 };
  // Array-shape (research output)
  if (Array.isArray(f.consensus)) {
    const consensus = f.consensus.length;
    const contested = Array.isArray(f.contested) ? f.contested.length : 0;
    const unique = Object.values(f.unique || {}).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0);
    return { total: consensus + contested + unique, consensus };
  }
  // Legacy numeric shape
  const consensus = typeof f.consensus === 'number' ? f.consensus : 0;
  const contested = typeof f.contested === 'number' ? f.contested : 0;
  const unique    = typeof f.unique    === 'number' ? f.unique    : 0;
  return { total: consensus + contested + unique, consensus };
}

// Anthropic cache-read savings rate FALLBACK (Sonnet): full input $3/M,
// cache-read $0.30/M -> $2.70/M saved. Used when a receipt has no model id
// (or its model is unknown). Per-receipt rates come from cost/pricing.js so
// Opus/Haiku users see the correct dollar figure.
const SONNET_FALLBACK_SAVINGS_PER_TOKEN = 2.70 / 1_000_000;

// Known-model detector: mirrors pricing.js's match-then-fuzzy-then-family
// logic but answers a yes/no question instead of returning a price entry.
// We need this because getPricing() silently falls back to Sonnet for unknown
// ids, so we cannot tell "Opus matched" from "garbage -> Sonnet fallback" by
// looking at the returned rate alone.
function isKnownModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  let table;
  try {
    table = getPricesTable()?.models || {};
  } catch {
    return false;
  }
  const id = modelId.toLowerCase().trim();
  if (table[id] || table[modelId]) return true;
  for (const key of Object.keys(table)) {
    const k = key.toLowerCase();
    if (k.startsWith(id) || id.startsWith(k)) return true;
  }
  // Family prefixes (must mirror pricing.js fallbacks table).
  const familyPrefixes = [
    'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4',
    'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus',
    'gpt-5', 'gpt-4o', 'o3', 'o4', 'gemini-2', 'gemini-1.5',
  ];
  for (const prefix of familyPrefixes) {
    if (id.includes(prefix)) return true;
  }
  return false;
}

// Compute per-token cache-read savings for a given model id by consulting
// the vendored pricing table. Returns { perToken, isFallback, model }.
// Falls back to Sonnet rate when the model is missing/unknown.
function cacheSavingsForModel(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return { perToken: SONNET_FALLBACK_SAVINGS_PER_TOKEN, isFallback: true, model: modelId || null };
  }
  if (!isKnownModel(modelId)) {
    return { perToken: SONNET_FALLBACK_SAVINGS_PER_TOKEN, isFallback: true, model: modelId };
  }
  try {
    const p = getPricing(modelId);
    const perToken = Math.max(0, (p?.in || 0) - (p?.cache_read || 0));
    if (perToken > 0) {
      return { perToken, isFallback: false, model: modelId };
    }
    return { perToken: SONNET_FALLBACK_SAVINGS_PER_TOKEN, isFallback: true, model: modelId };
  } catch {
    return { perToken: SONNET_FALLBACK_SAVINGS_PER_TOKEN, isFallback: true, model: modelId };
  }
}

// One-time-per-session stderr advisory for unknown-model fallbacks.
// Reset only by reloading the module, which matches "per session" semantics
// for the CLI entrypoint and MCP server.
let _unknownModelWarned = false;
export function _resetUnknownModelWarningForTests() {
  _unknownModelWarned = false;
}
function warnUnknownModelOnce(modelId) {
  if (_unknownModelWarned) return;
  _unknownModelWarned = true;
  try {
    const label = modelId ? `"${modelId}"` : '(missing)';
    process.stderr.write(
      `[ijfw hero-line] unknown model ${label} on receipt -- falling back to Sonnet cache-savings rate. ` +
      `Set receipt.model to a known id for accurate dollar figures.\n`
    );
  } catch {
    // stderr write failures are non-fatal.
  }
}

// renderHeroLine(receipts, sessions?)
//   receipts -- array of cross-runs.jsonl records
//   sessions -- array of sessions.jsonl v3 records (optional, default [])
//
// Returns a one-line string. Delta is only appended when:
//   - receipts have real input_tokens (sum > 0)
//   - sessions has >=3 entries with non-null input_tokens (Claude baseline)
//   - baseline sum > 0
// Cache savings suffix appended when last receipt has cache_read_input_tokens > 0.
export function renderHeroLine(receipts, sessions = []) {
  if (!receipts || receipts.length === 0) {
    return 'No cross-audit runs yet -- fire the Trident at any file with `ijfw cross audit <file>`. First run in ~20s.';
  }

  // Aggregate auditor IDs (unique across all receipts).
  const auditorIds = new Set();
  let totalMs = 0;
  let totalFindings = 0;
  let totalConsensus = 0;
  let receiptsInputTokens = 0;
  let hasReceiptsTokens = true;
  let totalCacheSavings = 0; // dollars, computed per-receipt using its model

  for (const r of receipts) {
    if (Array.isArray(r.auditors)) {
      for (const a of r.auditors) {
        if (a && a.id) auditorIds.add(a.id);
      }
    }
    totalMs += (typeof r.duration_ms === 'number') ? r.duration_ms : 0;
    const counts = countFindings(r.findings);
    totalFindings += counts.total;
    totalConsensus += counts.consensus;
    if (r.input_tokens == null) {
      hasReceiptsTokens = false;
    } else {
      receiptsInputTokens += r.input_tokens;
    }
    const crt = r.cache_stats?.cache_read_input_tokens;
    if (typeof crt === 'number' && crt > 0) {
      const { perToken, isFallback } = cacheSavingsForModel(r.model);
      if (isFallback) warnUnknownModelOnce(r.model);
      totalCacheSavings += crt * perToken;
    }
  }

  // Value statement (Sutherland lens): what was delivered, not what was done.
  const baseline = `${auditorIds.size} AIs surfaced ${totalFindings} findings (${totalConsensus} consensus-critical) in ${fmtDuration(totalMs)}`;

  // Cache savings suffix (10D.4): append only when cache reads produced a
  // visible saving (>= $0.01). A sub-cent figure reads as anti-value.
  const rawSaved = totalCacheSavings;
  const cacheSuffix = rawSaved >= 0.01
    ? ` (prompt cache hit -- ~$${rawSaved.toFixed(2)} saved)`
    : '';

  // Codex U1: only compute delta when all guards pass.
  if (!hasReceiptsTokens || receiptsInputTokens <= 0) {
    return baseline + cacheSuffix;
  }

  // Filter sessions: must be Claude-only entries with real input_tokens.
  const claudeSessions = (sessions || []).filter(
    s => s && s.input_tokens != null && s.input_tokens > 0
  );

  const MIN_SAMPLES = 3;
  if (claudeSessions.length < MIN_SAMPLES) {
    return baseline + cacheSuffix;
  }

  const sessionBaseline = claudeSessions.reduce((sum, s) => sum + s.input_tokens, 0);
  if (sessionBaseline <= 0) {
    return baseline + cacheSuffix;
  }

  const delta = 1 - (receiptsInputTokens / sessionBaseline);
  const pct = Math.round(Math.abs(delta) * 100);
  const sign = delta >= 0 ? '-' : '+';
  const n = claudeSessions.length;

  return `${baseline} -- measured delta: ${sign}${pct}% tokens vs solo Claude ${n}x${cacheSuffix}`;
}
