// IJFW v1.5.2 -- brain tiered LLM router.
//
// Two tiers used by the dream-cycle pipeline:
//   - extract: cheap, high-volume fact extraction (default: claude-haiku-4-5-20251001)
//   - synth:   mid-tier reconciliation / page synthesis (default: claude-sonnet-4-6)
//
// When IJFW_BRAIN_LOCAL_URL is set, we try the local endpoint first (Ollama-
// compatible /api/generate). On any local-call error, we fall back to the
// Anthropic API. This makes "local-first" cost discipline opt-in via env.
//
// Tests inject custom callers via opts._callers to avoid hitting real APIs.

const DEFAULTS = {
  extract: 'claude-haiku-4-5-20251001',
  synth: 'claude-sonnet-4-6',
};

const DEFAULT_MAX_TOKENS = {
  extract: 512,
  synth: 1500,
};

export function resolveTierModel(tier, env = process.env) {
  if (tier === 'extract') return env.IJFW_BRAIN_EXTRACT_MODEL || DEFAULTS.extract;
  if (tier === 'synth') return env.IJFW_BRAIN_SYNTH_MODEL || DEFAULTS.synth;
  throw new Error(`tiered-llm: unknown tier '${tier}'`);
}

function defaultCallers() {
  return {
    async local({ url, model, prompt, maxTokens }) {
      // Ollama-compatible /api/generate -- streamless single-response mode.
      const res = await fetch(url.replace(/\/$/, '') + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: maxTokens } }),
      });
      if (!res.ok) throw new Error(`local LLM HTTP ${res.status}`);
      const data = await res.json();
      return { text: data.response || '', usage: { input: data.prompt_eval_count, output: data.eval_count }, model, via: 'local' };
    },
    async anthropic({ model, prompt, maxTokens, apiKey }) {
      if (!apiKey) throw new Error('tiered-llm: ANTHROPIC_API_KEY (or IJFW_BRAIN_API_KEY) required for Anthropic fallback');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
      const data = await res.json();
      const text = (data.content || []).map((b) => b.text || '').join('');
      return { text, usage: data.usage, model, via: 'anthropic' };
    },
  };
}

export async function callTiered(tier, prompt, opts = {}) {
  const env = opts.env || process.env;
  const model = resolveTierModel(tier, env);
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS[tier] || 512;
  const callers = opts._callers || defaultCallers();
  if (env.IJFW_BRAIN_LOCAL_URL) {
    try {
      return await callers.local({ url: env.IJFW_BRAIN_LOCAL_URL, model, prompt, maxTokens });
    } catch {
      // fall through to Anthropic
    }
  }
  return callers.anthropic({
    model,
    prompt,
    maxTokens,
    apiKey: env.IJFW_BRAIN_API_KEY || env.ANTHROPIC_API_KEY,
  });
}
