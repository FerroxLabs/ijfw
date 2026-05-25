// IJFW v1.5.2 -- brain budget guard (Trident F-B5).
//
// Two budget envelopes: per-cycle (IJFW_DREAM_BUDGET_USD, default 0.50) and
// per-day (IJFW_DREAM_BUDGET_DAY_USD, default 5.00). Spend is appended as
// JSONL to .ijfw/metrics/brain-spend.jsonl -- one line per LLM call.
//
// Separate from IJFW_AUTOLINK_BUDGET_USD (the legacy A-Mem gate) -- the
// brain budget never starves the auto-linker and vice versa.

import { existsSync, mkdirSync, readFileSync, appendFileSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { validateSafeRepoPath } from './path-guard.js';

const SPEND_LOG_REL = ['.ijfw', 'metrics', 'brain-spend.jsonl'];
const DEFAULT_CYCLE_USD = 0.50;
const DEFAULT_DAY_USD = 5.00;
const MIN_TOKENS = 1;
const MAX_TOKENS_CAP = 8000;

export function deriveMaxTokens({ remainingUsd, outputPricePerMtok }) {
  if (!Number.isFinite(remainingUsd) || remainingUsd <= 0) return MIN_TOKENS;
  if (!Number.isFinite(outputPricePerMtok) || outputPricePerMtok <= 0) return MAX_TOKENS_CAP;
  const raw = Math.floor((remainingUsd / outputPricePerMtok) * 1_000_000);
  return Math.max(MIN_TOKENS, Math.min(MAX_TOKENS_CAP, raw));
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function readSpend(repoRoot, cycleId) {
  const p = join(repoRoot, ...SPEND_LOG_REL);
  if (!existsSync(p)) return { day: 0, cycle: 0 };
  const today = todayKey();
  let day = 0, cycle = 0;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec.usd !== 'number') continue;
    if (rec.day === today) day += rec.usd;
    if (rec.cycleId === cycleId) cycle += rec.usd;
  }
  return { day, cycle };
}

export function BudgetGuard({ repoRoot, cycleId, cycleUsd, dayUsd, env = process.env } = {}) {
  // F1 fix: Number('0') is 0 (falsy), so `Number(env.X) || DEFAULT` silently
  // dropped a zero cap and fell through to the default. Use isFinite checks
  // so the caller's "$0 means off" intent is respected.
  const cycleEnv = env.IJFW_DREAM_BUDGET_USD != null ? Number(env.IJFW_DREAM_BUDGET_USD) : NaN;
  const dayEnv = env.IJFW_DREAM_BUDGET_DAY_USD != null ? Number(env.IJFW_DREAM_BUDGET_DAY_USD) : NaN;
  const cycleCap = Number.isFinite(cycleUsd) ? cycleUsd
    : (Number.isFinite(cycleEnv) ? cycleEnv : DEFAULT_CYCLE_USD);
  const dayCap = Number.isFinite(dayUsd) ? dayUsd
    : (Number.isFinite(dayEnv) ? dayEnv : DEFAULT_DAY_USD);
  const id = cycleId || `cycle-${Date.now()}`;
  let spent = readSpend(repoRoot, id);

  function remaining() {
    return { cycle: Math.max(0, cycleCap - spent.cycle), day: Math.max(0, dayCap - spent.day) };
  }
  function guardCall({ outputPricePerMtok, requestedMaxTokens }) {
    const r = remaining();
    const usable = Math.min(r.cycle, r.day);
    if (usable <= 0) return { allowed: false, maxTokens: 0, remaining: r };
    const derived = deriveMaxTokens({ remainingUsd: usable, outputPricePerMtok });
    const maxTokens = Math.min(requestedMaxTokens || MAX_TOKENS_CAP, derived);
    return { allowed: maxTokens >= MIN_TOKENS, maxTokens, remaining: r };
  }
  function record(usd) {
    const p = join(repoRoot, ...SPEND_LOG_REL);
    // F-LENS2-05/11: containment + symlink-follow refusal before the append.
    // A symlink at .ijfw/metrics/brain-spend.jsonl pointing outside the repo
    // would otherwise let appendFileSync write attacker-controlled bytes to
    // an arbitrary path. lstat (NOT stat) so we see the link itself.
    const guard = validateSafeRepoPath(repoRoot, p);
    if (!guard.ok) return; // silent drop — spend log is best-effort
    try {
      const lst = lstatSync(p);
      if (lst.isSymbolicLink()) return; // F-LENS2-11: refuse symlink follow
    } catch { /* file doesn't exist yet — ok to create */ }
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ day: todayKey(), cycleId: id, usd, ts: Date.now() }) + '\n');
    spent.cycle += usd; spent.day += usd;
  }
  return { guardCall, record, remaining, _cycleId: id, _caps: { cycle: cycleCap, day: dayCap } };
}
