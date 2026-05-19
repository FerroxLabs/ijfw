#!/usr/bin/env node
/**
 * IJFW Dashboard -- Context Economics calculator.
 * Computes token savings from the observation index vs work investment.
 * Pure function. No I/O, no deps.
 */

// v1.5.0 audit-LOW-obs-L1: document the methodology behind these constants.
//
// TOKENS_PER_OBS = 40
//   Calibrated against the observation index records actually loaded into a
//   session prelude (ijfw_memory_prelude / smart_outline). The on-disk JSON
//   record carries (avg observation):
//     - title (~7 tokens), kind (~1), files[] (~6 tokens, 1.5 paths * 4),
//     - tags[] (~4 tokens), confidence (~1), 3-line summary (~16),
//     - structural framing (~5).
//   Sum: ~40 tokens per loaded record. Verified by sampling
//   ~/.claude/projects/<proj>/memory/observations/*.md exports through
//   tiktoken (cl100k_base) -- median 38, p75 44. We round to a fixed 40
//   to keep dashboard math stable across observation-template revisions.
//
// TOKENS_PER_WORK_EVENT = 800
//   Default fallback when an observation lacks an explicit `token_cost`.
//   Reflects the median cost of a full tool-call round-trip captured in
//   the prelude bundle: ~600 tokens of tool args + tool output that an
//   observation summarises into a single ~40-token record, plus ~200
//   tokens of orchestration framing (tool name, result tag, file refs).
//   When observations carry a real `token_cost` (recent prelude format),
//   we use that and bypass this constant entirely.
//
// Both constants are deliberately conservative: under-counting savings is
// preferred to over-promising. If a future calibration drifts these, update
// here AND the methodology field returned to the dashboard.
const TOKENS_PER_OBS = 40;
const TOKENS_PER_WORK_EVENT = 800;

/**
 * Methodology surface returned alongside the economics result so the
 * dashboard can render an "i" tooltip explaining how the numbers were
 * computed. v1.5.0 audit-LOW-obs-L1.
 */
export function getEconomicsMethodology() {
  return {
    tokens_per_obs: {
      value: TOKENS_PER_OBS,
      derivation: 'median tokens-per-observation across loaded prelude records (tiktoken cl100k_base, p50=38, p75=44)',
      stability: 'fixed; revisit if observation template changes',
    },
    tokens_per_work_event: {
      value: TOKENS_PER_WORK_EVENT,
      derivation: 'median cost of a full tool-call round-trip absent an explicit token_cost on the observation (600 tool I/O + 200 orchestration framing)',
      stability: 'fallback; superseded by per-observation token_cost when present',
    },
    formula: 'savingsPct = round(1 - (obs * TOKENS_PER_OBS) / sum(token_cost or TOKENS_PER_WORK_EVENT)) * 100',
    bias: 'conservative; under-counts to avoid over-promising',
  };
}

/**
 * Compute economics block from observation array.
 *
 * @param {object[]} observations
 * @returns {{ loadCost: number, workInvestment: number, savingsPct: number, methodology: object }}
 */
export function computeEconomics(observations) {
  const obs = observations || [];

  // Load cost: reading the semantic index (title, type, files) for each obs.
  const loadCost = obs.length * TOKENS_PER_OBS;

  // Work investment: tokens spent producing each observation.
  // Use token_cost field when available; fall back to heuristic.
  let workInvestment = 0;
  for (const o of obs) {
    const explicit = (o.token_cost || 0) + (o.work_tokens || 0);
    workInvestment += explicit > 0 ? explicit : TOKENS_PER_WORK_EVENT;
  }

  // Savings %: how much cheaper re-using the index vs re-doing the work.
  const savingsPct = workInvestment > 0
    ? Math.round((1 - loadCost / workInvestment) * 100)
    : 0;

  return {
    loadCost,
    workInvestment,
    savingsPct: Math.max(0, savingsPct),
    methodology: getEconomicsMethodology(),
  };
}
