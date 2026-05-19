/**
 * IJFW cost/pricing.js
 * Loads vendored model_prices.json and computes per-turn USD cost.
 * Source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 * Zero deps -- node:fs only.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICES_PATH = join(__dirname, '../../data/model_prices.json');

let _prices = null;

function loadPrices() {
  if (_prices) return _prices;
  try {
    const raw = readFileSync(PRICES_PATH, 'utf8');
    const data = JSON.parse(raw);
    _prices = data.models || data;
  } catch {
    _prices = {};
  }
  return _prices;
}

/**
 * Resolve price entry for a model id. Tries exact match, then common aliases.
 * Returns { in, out, cache_create_5m, cache_create_1h, cache_read } all in USD/token.
 */
export function getPricing(modelId) {
  const prices = loadPrices();
  const id = (modelId || '').toLowerCase().trim();

  // Exact match
  let entry = prices[id] || prices[modelId];

  // Fuzzy: strip date suffixes and try again
  if (!entry) {
    for (const key of Object.keys(prices)) {
      if (key.toLowerCase().startsWith(id) || id.startsWith(key.toLowerCase())) {
        entry = prices[key];
        break;
      }
    }
  }

  // Model family fallbacks for common Claude Code models
  if (!entry) {
    const fallbacks = {
      'claude-opus-4': 'claude-4-opus-20250514',
      'claude-sonnet-4': 'claude-4-sonnet-20250514',
      'claude-haiku-4': 'claude-haiku-4-5',
      'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
      'claude-3-opus': 'claude-3-opus-20240229',
      'gpt-5': 'gpt-4o',
      'gpt-4o': 'gpt-4o',
      'o3': 'o3',
      'o4': 'o4-mini',
      'gemini-2': 'gemini/gemini-2.0-flash',
      'gemini-1.5': 'gemini/gemini-1.5-pro',
    };
    for (const [prefix, fallback] of Object.entries(fallbacks)) {
      if (id.includes(prefix.toLowerCase())) {
        entry = prices[fallback];
        if (entry) break;
      }
    }
  }

  if (!entry) {
    // Unknown model: use claude-sonnet-4 rates as conservative estimate
    entry = prices['claude-4-sonnet-20250514'] || {
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_creation_input_token_cost: 3.75e-6,
      cache_read_input_token_cost: 3e-7,
    };
  }

  const inCost = entry.input_cost_per_token || 0;
  const outCost = entry.output_cost_per_token || 0;
  // cache_create_5m: 1.25x input price; cache_create_1h: 2.0x input price
  // Use vendored values if present, else compute from multipliers
  const cacheCreate5m = entry.cache_creation_input_token_cost ?? (inCost * 1.25);
  const cacheCreate1h = inCost * 2.0; // always 2x; LiteLLM doesn't split this
  const cacheRead = entry.cache_read_input_token_cost ?? (inCost * 0.1);

  return { in: inCost, out: outCost, cache_create_5m: cacheCreate5m, cache_create_1h: cacheCreate1h, cache_read: cacheRead };
}

/**
 * Compute cost in USD for a single turn's usage object.
 * usage: { input_tokens, output_tokens, cache_create_tokens_5m, cache_create_tokens_1h, cache_read_tokens }
 * Uses correct split for 5m vs 1h cache creation (fixes ccusage bug #899).
 */
export function computeCost(modelId, usage) {
  const p = getPricing(modelId);
  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_create_tokens_5m = 0,
    cache_create_tokens_1h = 0,
    cache_read_tokens = 0,
  } = usage || {};

  return (
    input_tokens          * p.in +
    output_tokens         * p.out +
    cache_create_tokens_5m * p.cache_create_5m +
    cache_create_tokens_1h * p.cache_create_1h +
    cache_read_tokens     * p.cache_read
  );
}

/**
 * Per-tier dashboard view ($/M tokens).
 * Single source of truth for any UI that wants to show Anthropic family
 * rates without hardcoding numbers. Derived from the canonical model_prices
 * table via the same getPricing() resolver everything else uses, so it
 * cannot drift from receipt cost computation.
 *
 * Tiers are keyed by lowercase family name -- callers tier-match on
 * model id substring (opus | sonnet | haiku). Values are USD per million
 * tokens for input/output/cache_read/cache_creation.
 */
export function getTierRatesPerMillion() {
  const M = 1_000_000;
  const tiers = {
    opus:   'claude-opus-4-1',
    sonnet: 'claude-sonnet-4-5',
    haiku:  'claude-haiku-4-5',
  };
  const out = {};
  for (const [tier, modelId] of Object.entries(tiers)) {
    const p = getPricing(modelId);
    out[tier] = {
      in:             p.in * M,
      out:            p.out * M,
      cache_read:     p.cache_read * M,
      cache_creation: p.cache_create_5m * M,
    };
  }
  return out;
}

/**
 * Per-provider USD/token estimate for budget pre-flight (cross-dispatcher).
 * One representative model per provider, resolved through the canonical
 * pricing table so this cannot drift from receipt billing.
 *
 * Returns USD per *input* token (output is typically priced separately;
 * pre-flight uses the conservative input-only estimate).
 */
const PROVIDER_DEFAULT_MODEL = {
  claude:    'claude-sonnet-4-5',
  anthropic: 'claude-sonnet-4-5',
  codex:     'gpt-5',
  opencode:  'gpt-5',
  aider:     'gpt-5',
  copilot:   'gpt-4o',
  gemini:    'gemini/gemini-1.5-flash',
};

export function getProviderInputRate(providerId) {
  const id = (providerId || '').toLowerCase().trim();
  const modelId = PROVIDER_DEFAULT_MODEL[id];
  if (!modelId) return null;
  const p = getPricing(modelId);
  return p.in;
}

/** Return the raw prices table for /api/prices transparency endpoint. */
export function getPricesTable() {
  const prices = loadPrices();
  return {
    _source: 'https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json',
    _refreshed: '2026-04-16',
    formulas: {
      turn_cost: 'input_tokens*in + output_tokens*out + cache_create_5m*cache_create_5m_price + cache_create_1h*cache_create_1h_price + cache_read*cache_read_price',
      cache_savings: 'cache_read_tokens (measured, non-estimated only) * in_price * 0.9',
      memory_savings: 'unique_first_recalls_per_session * 800_tokens * in_price',
      trident_savings: '$5 per unique HIGH finding pre-ship (capped at 20/week)',
      terse_savings: 'REMOVED -- prior 1.4x multiplier had no empirical basis',
    },
    models: prices,
  };
}
