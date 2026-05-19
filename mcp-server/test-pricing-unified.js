/**
 * test-pricing-unified.js
 * H4.8 audit fix verification: three parallel pricing surfaces have been
 * unified onto mcp-server/src/cost/pricing.js. This test ensures they all
 * return the SAME rate for the same model -- if anyone re-introduces a
 * hardcoded table, this test fails fast.
 *
 * Zero deps. Node built-ins only.
 */

import {
  getPricing,
  getTierRatesPerMillion,
  getProviderInputRate,
  computeCost,
} from './src/cost/pricing.js';
import { estimateCost } from './src/cross-dispatcher.js';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('  ok ' + label);
    pass++;
  } else {
    console.error('  FAIL ' + label + (detail !== undefined ? ' -- ' + detail : ''));
    fail++;
  }
}

const M = 1_000_000;
const EPS = 1e-9;

function approxEqual(a, b, eps = EPS) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// 1. Canonical surface returns the expected canonical rates.
// ---------------------------------------------------------------------------

console.log('\n-- Canonical pricing.js (single source of truth) --');
{
  const opus = getPricing('claude-opus-4-1');
  ok('opus input is $15/M',  approxEqual(opus.in,  15e-6),  `got ${opus.in}`);
  ok('opus output is $75/M', approxEqual(opus.out, 75e-6),  `got ${opus.out}`);

  const sonnet = getPricing('claude-sonnet-4-5');
  ok('sonnet input is $3/M',  approxEqual(sonnet.in,  3e-6),    `got ${sonnet.in}`);
  ok('sonnet output is $15/M', approxEqual(sonnet.out, 15e-6),  `got ${sonnet.out}`);

  const haiku = getPricing('claude-haiku-4-5');
  // Haiku 4.5 canonical: $1/M input, $5/M output (NOT the stale $0.80/$4 from
  // the old hardcoded dashboard table -- that was Haiku 3.5).
  ok('haiku 4.5 input is $1/M',  approxEqual(haiku.in,  1e-6), `got ${haiku.in}`);
  ok('haiku 4.5 output is $5/M', approxEqual(haiku.out, 5e-6), `got ${haiku.out}`);

  const gpt5 = getPricing('gpt-5');
  ok('gpt-5 has a price entry (in > 0)',  gpt5.in > 0,  `got ${gpt5.in}`);
  ok('gpt-5 has a price entry (out > 0)', gpt5.out > 0, `got ${gpt5.out}`);
}

// ---------------------------------------------------------------------------
// 2. Dashboard tier view ($/M) matches the canonical /token rates.
//    This is the surface that parse-transcripts.js consumes.
// ---------------------------------------------------------------------------

console.log('\n-- Dashboard surface (getTierRatesPerMillion) --');
{
  const tiers = getTierRatesPerMillion();
  const opus   = getPricing('claude-opus-4-1');
  const sonnet = getPricing('claude-sonnet-4-5');
  const haiku  = getPricing('claude-haiku-4-5');

  // Cross-surface check: $/M view * 1e-6 must equal the canonical $/token.
  ok('opus tier matches canonical (in)',
    approxEqual(tiers.opus.in / M,  opus.in),
    `tier=${tiers.opus.in} canonical=${opus.in * M}`);
  ok('opus tier matches canonical (out)',
    approxEqual(tiers.opus.out / M, opus.out),
    `tier=${tiers.opus.out} canonical=${opus.out * M}`);
  ok('opus tier matches canonical (cache_read)',
    approxEqual(tiers.opus.cache_read / M, opus.cache_read));
  ok('opus tier matches canonical (cache_creation)',
    approxEqual(tiers.opus.cache_creation / M, opus.cache_create_5m));

  ok('sonnet tier matches canonical (in)',
    approxEqual(tiers.sonnet.in / M, sonnet.in));
  ok('sonnet tier matches canonical (out)',
    approxEqual(tiers.sonnet.out / M, sonnet.out));

  ok('haiku tier matches canonical (in)',
    approxEqual(tiers.haiku.in / M, haiku.in));
  ok('haiku tier matches canonical (out)',
    approxEqual(tiers.haiku.out / M, haiku.out));
}

// ---------------------------------------------------------------------------
// 3. Cross-dispatcher surface (provider input rate) matches canonical.
// ---------------------------------------------------------------------------

console.log('\n-- Cross-dispatcher surface (getProviderInputRate) --');
{
  const claudeRate   = getProviderInputRate('claude');
  const sonnetRate   = getPricing('claude-sonnet-4-5').in;
  ok('claude provider rate matches sonnet input',
    approxEqual(claudeRate, sonnetRate),
    `provider=${claudeRate} sonnet=${sonnetRate}`);

  const codexRate = getProviderInputRate('codex');
  const gpt5Rate  = getPricing('gpt-5').in;
  ok('codex provider rate matches gpt-5 input',
    approxEqual(codexRate, gpt5Rate),
    `provider=${codexRate} gpt5=${gpt5Rate}`);

  const geminiRate = getProviderInputRate('gemini');
  ok('gemini provider rate is positive', geminiRate > 0, `got ${geminiRate}`);

  const copilotRate = getProviderInputRate('copilot');
  ok('copilot provider rate is positive', copilotRate > 0, `got ${copilotRate}`);

  // Unknown provider returns null so the caller can fall back.
  ok('unknown provider returns null',
    getProviderInputRate('not-a-real-provider') === null);
}

// ---------------------------------------------------------------------------
// 4. estimateCost() (cross-dispatcher) uses canonical rates end-to-end.
//    This catches the case where someone swaps the implementation but
//    forgets to update getProviderInputRate's mapping.
// ---------------------------------------------------------------------------

console.log('\n-- estimateCost() end-to-end --');
{
  // 4000 chars / 4 = 1000 tokens. With sonnet input at $3/M = 3e-6/token,
  // one claude pick should cost ~$0.003.
  const target = 'x'.repeat(4000);
  const sonnetExpected = 1000 * getPricing('claude-sonnet-4-5').in;
  const result = estimateCost(target, [{ id: 'claude' }]);
  ok('estimateCost(claude) routes through canonical sonnet rate',
    approxEqual(result, sonnetExpected),
    `got ${result}, expected ${sonnetExpected}`);

  // Codex must use gpt-5 canonical rate.
  const codexExpected = 1000 * getPricing('gpt-5').in;
  const codexResult = estimateCost(target, [{ id: 'codex' }]);
  ok('estimateCost(codex) routes through canonical gpt-5 rate',
    approxEqual(codexResult, codexExpected),
    `got ${codexResult}, expected ${codexExpected}`);
}

// ---------------------------------------------------------------------------
// 5. computeCost() (canonical) and the dashboard's per-tier calculation
//    must agree on the SAME usage for the SAME model.
//    This is the drift hazard the audit flagged: dashboard tile vs receipts.
// ---------------------------------------------------------------------------

console.log('\n-- Cross-surface receipt consistency --');
{
  const usage = {
    input_tokens: 10_000,
    output_tokens: 2_000,
    cache_create_tokens_5m: 5_000,
    cache_read_tokens: 8_000,
  };

  for (const model of ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
    const canonicalCost = computeCost(model, usage);

    // Reproduce the dashboard's per-tier formula using the canonical $/M view.
    const tiers = getTierRatesPerMillion();
    const tier =
      model.includes('opus')   ? 'opus'   :
      model.includes('sonnet') ? 'sonnet' :
      model.includes('haiku')  ? 'haiku'  : null;
    const p = tiers[tier];
    const dashboardCost =
      usage.input_tokens          / M * p.in +
      usage.output_tokens         / M * p.out +
      usage.cache_read_tokens     / M * p.cache_read +
      usage.cache_create_tokens_5m / M * p.cache_creation;

    ok(`${model}: dashboard $/M view agrees with canonical computeCost`,
      approxEqual(canonicalCost, dashboardCost, 1e-7),
      `canonical=${canonicalCost} dashboard=${dashboardCost}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
