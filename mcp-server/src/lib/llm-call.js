// mcp-server/src/lib/llm-call.js
// IJFW v1.5.0 -- minimal LLM-call wrapper for the M2 auto-linker.
//
// Defaults to Claude Haiku 4.5 (claude-haiku-4-5-20251001). Env overrides:
//   IJFW_AUTOLINK_OFF=1                 -> never call; return skipped.
//   IJFW_AUTOLINK_BUDGET_USD=<float>    -> per-day cap; 0 disables.
//   IJFW_AUTOLINK_MODEL=<model-id>      -> override default.
//   IJFW_AUTOLINK_API_KEY=<key>         -> if absent, falls back to
//                                          ANTHROPIC_API_KEY; if both
//                                          absent, returns skipped=no_key.
//
// Budget tracking is a simple JSONL spend log at
// `<repoRoot>/.ijfw/.llm-spend.jsonl` rolled by day. Approximate USD per
// call uses Haiku pricing.

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_PRICE_IN = 0.80;
const DEFAULT_PRICE_OUT = 4.00;

function isoDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function spendPath(root) {
  return join(root, '.ijfw', '.llm-spend.jsonl');
}

function todaySpend(root) {
  const p = spendPath(root);
  if (!existsSync(p)) return 0;
  const day = isoDay();
  let usd = 0;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.day === day && typeof row.usd === 'number') usd += row.usd;
    } catch { /* skip corrupt */ }
  }
  return usd;
}

function recordSpend(root, usd, model, inTok, outTok) {
  const p = spendPath(root);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(
    p,
    JSON.stringify({
      day: isoDay(),
      ts: new Date().toISOString(),
      model,
      input_tokens: inTok,
      output_tokens: outTok,
      usd,
    }) + '\n',
  );
}

export async function llmCall({
  system,
  user,
  maxTokens = 512,
  root = process.cwd(),
  model,
  apiKey,
} = {}) {
  if (process.env.IJFW_AUTOLINK_OFF === '1') {
    return { skipped: true, reason: 'autolink_off' };
  }
  const budget = process.env.IJFW_AUTOLINK_BUDGET_USD;
  if (budget !== undefined && Number(budget) <= 0) {
    return { skipped: true, reason: 'budget_exhausted' };
  }
  if (budget !== undefined && todaySpend(root) >= Number(budget)) {
    return { skipped: true, reason: 'budget_exhausted' };
  }
  const key = apiKey || process.env.IJFW_AUTOLINK_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return { skipped: true, reason: 'no_key' };
  const m = model || process.env.IJFW_AUTOLINK_MODEL || DEFAULT_MODEL;
  const priceIn = Number(process.env.IJFW_AUTOLINK_PRICE_IN_PER_MTOK || DEFAULT_PRICE_IN);
  const priceOut = Number(process.env.IJFW_AUTOLINK_PRICE_OUT_PER_MTOK || DEFAULT_PRICE_OUT);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: m,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) return { skipped: true, reason: `http_${res.status}` };
  const json = await res.json();
  const text = (json.content || []).map((c) => c.text || '').join('');
  const inTok = json.usage?.input_tokens || 0;
  const outTok = json.usage?.output_tokens || 0;
  const usd = (inTok / 1e6) * priceIn + (outTok / 1e6) * priceOut;
  recordSpend(root, usd, m, inTok, outTok);
  return { skipped: false, text, usd, model: m, input_tokens: inTok, output_tokens: outTok };
}

export function parseLlmJsonResponse(raw) {
  if (typeof raw !== 'string') throw new Error('parseLlmJsonResponse: input not a string');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : raw.trim();
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`parseLlmJsonResponse: parse failed -- ${e.message}`);
  }
}

export default { llmCall, parseLlmJsonResponse };
