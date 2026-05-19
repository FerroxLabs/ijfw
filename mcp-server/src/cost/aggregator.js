/**
 * IJFW cost/aggregator.js
 * Combines Claude, Codex, Gemini readers. Groups by day/platform/session/model.
 * Returns { costs, savings, breakdowns, series } for dashboard endpoints.
 * Never throws -- failed readers log and return empty.
 */

import { readClaudeSessions } from './readers/claude.js';
import { readCodexSessions }  from './readers/codex.js';
import { readGeminiSessions } from './readers/gemini.js';
import { computeCost }        from './pricing.js';
import { computeSavings, getSavingsMethodology } from './savings.js';

const MS_PER_DAY = 86400000;

/**
 * Read all turns across all platforms, optionally filtered to recent N days.
 */
function readAllTurns(days) {
  const readers = [
    { fn: readClaudeSessions, label: 'claude' },
    { fn: readCodexSessions,  label: 'codex'  },
    { fn: readGeminiSessions, label: 'gemini' },
  ];

  const cutoff = days ? Date.now() - days * MS_PER_DAY : null;
  let turns = [];

  for (const { fn, label } of readers) {
    try {
      const raw = fn();
      for (const t of raw) {
        if (cutoff && t.timestamp) {
          const ts = new Date(t.timestamp).getTime();
          if (!isNaN(ts) && ts < cutoff) continue;
        }
        turns.push(t);
      }
    } catch (err) {
      // reader failed -- log and continue
      process.stderr.write(`[ijfw-cost] ${label} reader error: ${err.message}\n`);
    }
  }

  return turns;
}

/**
 * Annotate each turn with its USD cost and return enriched turns.
 *
 * `theoretical_cost_usd` is what equivalent paid-API usage would cost.
 * `cost_usd` is what the user actually paid: 0 for Max-subscription Claude
 * sessions, equal to theoretical_cost_usd for paid-API sessions and for
 * other platforms.
 */
function annotateCosts(turns) {
  return turns.map(t => {
    const theoretical = computeCost(t.model, t);
    const real = t.billing_mode === 'max' ? 0 : theoretical;
    return { ...t, cost_usd: real, theoretical_cost_usd: theoretical };
  });
}

/**
 * Build the main cost + savings response.
 * @param {number|null} days - rolling window in days (null = all-time)
 * @param {Array} observations - observation records for savings context
 */
export function buildCostReport(days, observations = []) {
  const raw   = readAllTurns(days);
  const turns = annotateCosts(raw);
  const savings = computeSavings(turns, observations);

  // Split measured (real API data) vs estimated (Codex/Gemini char-heuristic)
  const measuredTurns  = turns.filter(t => !t.estimated);
  const estimatedTurns = turns.filter(t =>  t.estimated);

  const measuredCost  = measuredTurns.reduce((s, t) => s + t.cost_usd, 0);
  const estimatedCost = estimatedTurns.reduce((s, t) => s + t.cost_usd, 0);
  const totalCost     = measuredCost + estimatedCost;

  // Theoretical totals: what equivalent paid-API usage would cost.
  // For Max sessions this is the value captured by the subscription.
  const measuredTheoretical  = measuredTurns.reduce((s, t) => s + (t.theoretical_cost_usd || 0), 0);
  const estimatedTheoretical = estimatedTurns.reduce((s, t) => s + (t.theoretical_cost_usd || 0), 0);
  const theoreticalTotal     = measuredTheoretical + estimatedTheoretical;
  const valueCaptured        = theoreticalTotal - totalCost;

  // Token counts from measured turns only (estimated tokens are unreliable)
  const totalIn        = measuredTurns.reduce((s, t) => s + (t.input_tokens || 0), 0);
  const totalOut       = measuredTurns.reduce((s, t) => s + (t.output_tokens || 0), 0);
  const totalCacheRead = measuredTurns.reduce((s, t) => s + (t.cache_read_tokens || 0), 0);

  // Cache hit rate: cache_read / (input + cache_read), measured turns only
  const denominator = totalIn + totalCacheRead;
  const cacheHitRate = denominator > 0 ? totalCacheRead / denominator : 0;

  // baseline_cost: what measured turns would have cost without prompt caching
  const baselineCost = measuredCost + (savings.cache ? savings.cache.value : 0);

  return {
    measuredCost,
    estimatedCost,
    totalCost,
    // What paid-API equivalent would have cost; for Max users the gap
    // (theoreticalTotal - totalCost) is the subscription's captured value.
    theoreticalCost: theoreticalTotal,
    valueCaptured,
    estimationConfidence: estimatedTurns.length > 0 ? 'low' : null,
    // Legacy field kept for callers that haven't migrated yet
    cost: totalCost,
    baseline_cost: baselineCost,
    savings: {
      ...savings,
      // Honest framing: cache discount is automatic in Claude Code -- IJFW measures it
      labelShort: 'Cache efficiency (Claude Code automatic caching)',
      labelLong: `Cache hit rate: ${(cacheHitRate * 100).toFixed(1)}% of context served from cache. Claude Code caches automatically; IJFW measures the effect.`,
    },
    tokens: { input: totalIn, output: totalOut, cache_read: totalCacheRead },
    cacheHitRate,
    turnCount: turns.length,
    measuredTurnCount: measuredTurns.length,
    estimatedTurnCount: estimatedTurns.length,
  };
}

// v1.5.0 audit-LOW-tok-L3: memoize buildBreakdown per (dim, days, bucket).
// Dashboards call this endpoint repeatedly on a 10s tick across four
// dimensions; each call re-reads ~3 platforms of transcript JSON. Within
// a 60-second time bucket the result is functionally identical, so cache
// it. TTL is short enough that newly-arriving turns surface within one
// dashboard refresh interval.
const BREAKDOWN_CACHE_TTL_MS = 60_000;
const _breakdownCache = new Map();

function _bucketKey(dim, days, now = Date.now()) {
  const bucket = Math.floor(now / BREAKDOWN_CACHE_TTL_MS);
  return `${dim}|${days ?? 'all'}|${bucket}`;
}

// Test helper: clear the memoization cache.
export function _resetBreakdownCache() { _breakdownCache.clear(); }

/**
 * Build a breakdown grouped by a dimension.
 * dim: 'platform' | 'session' | 'model' | 'tool'
 */
export function buildBreakdown(dim, days, _observations = []) {
  const key = _bucketKey(dim, days);
  const cached = _breakdownCache.get(key);
  if (cached) return cached;

  const raw   = readAllTurns(days);
  const turns = annotateCosts(raw);

  const groups = {};
  for (const t of turns) {
    const k = t[dim] || 'unknown';
    if (!groups[k]) groups[k] = { key: k, cost_usd: 0, theoretical_cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, count: 0 };
    groups[k].cost_usd             += t.cost_usd;
    groups[k].theoretical_cost_usd += t.theoretical_cost_usd || 0;
    groups[k].input_tokens         += t.input_tokens || 0;
    groups[k].output_tokens        += t.output_tokens || 0;
    groups[k].cache_read_tokens    += t.cache_read_tokens || 0;
    groups[k].count++;
  }

  // Sort by theoretical cost so Max-session breakdowns still rank by usage
  // intensity even when cost_usd is uniformly zero.
  const result = Object.values(groups).sort((a, b) => b.theoretical_cost_usd - a.theoretical_cost_usd);

  // Bound the cache: keep at most 32 entries (4 dims * 8 window/bucket combos).
  // Eviction is opportunistic on insert -- O(1) amortised.
  if (_breakdownCache.size >= 32) {
    const firstKey = _breakdownCache.keys().next().value;
    if (firstKey !== undefined) _breakdownCache.delete(firstKey);
  }
  _breakdownCache.set(key, result);
  return result;
}

/**
 * Build daily series for sparkline (last N days).
 */
export function buildDailySeries(days = 30) {
  const raw   = readAllTurns(days);
  const turns = annotateCosts(raw);

  const byDay = {};
  for (const t of turns) {
    if (!t.timestamp) continue;
    const d = t.timestamp.slice(0, 10); // YYYY-MM-DD
    if (!byDay[d]) byDay[d] = { date: d, cost_usd: 0, theoretical_cost_usd: 0, input_tokens: 0, output_tokens: 0 };
    byDay[d].cost_usd             += t.cost_usd;
    byDay[d].theoretical_cost_usd += t.theoretical_cost_usd || 0;
    byDay[d].input_tokens         += t.input_tokens || 0;
    byDay[d].output_tokens        += t.output_tokens || 0;
  }

  // Fill in zeros for missing days
  const now = new Date();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * MS_PER_DAY).toISOString().slice(0, 10);
    series.push(byDay[d] || { date: d, cost_usd: 0, theoretical_cost_usd: 0, input_tokens: 0, output_tokens: 0 });
  }
  return series;
}

/**
 * Compute the current 5-hour usage block (Anthropic rolling window).
 * Returns usage within the last 5 hours from Claude turns only.
 */
export function buildBlockUsage() {
  const fiveHoursMs = 5 * 3600000;
  const cutoff = Date.now() - fiveHoursMs;

  const raw   = readAllTurns(1); // last 24h is enough
  const turns = annotateCosts(raw.filter(t => t.platform === 'claude'));

  const blockTurns = turns.filter(t => {
    if (!t.timestamp) return false;
    return new Date(t.timestamp).getTime() >= cutoff;
  });

  const usedCost        = blockTurns.reduce((s, t) => s + t.cost_usd, 0);
  const usedTheoretical = blockTurns.reduce((s, t) => s + (t.theoretical_cost_usd || 0), 0);
  const usedTok         = blockTurns.reduce((s, t) => s + (t.input_tokens || 0) + (t.output_tokens || 0), 0);
  const start           = new Date(cutoff).toISOString();
  const end             = new Date(Date.now()).toISOString();

  return {
    start,
    end,
    window_minutes: 300,
    used_tok: usedTok,
    used_usd: usedCost,
    used_usd_theoretical: usedTheoretical,
  };
}

/**
 * Top tools by token burn.
 */
export function buildTopTools(days, limit = 5) {
  return buildBreakdown('tool_name', days).slice(0, limit);
}

/**
 * Alias used by tests and CLI: getPeriodReport(days, observations?)
 */
export function getPeriodReport(days, observations = []) {
  return buildCostReport(days, observations);
}

/**
 * Returns the savings methodology doc for /api/savings/methodology.
 */
export { getSavingsMethodology };
