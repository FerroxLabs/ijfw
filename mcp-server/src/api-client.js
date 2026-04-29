// api-client.js -- API-key fallback for cross-audit/research/critique.
//
// Uses Node 19+ native fetch (Undici). Zero external deps.
// Each provider gets its own request builder; the caller treats the
// returned text like CLI stdout.

import { getTemplate } from './cross-dispatcher.js';

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Provider request builders
// ---------------------------------------------------------------------------

// Optional `endpoint` argument lets OpenAI-compatible providers (Qwen via
// DashScope, Together, Groq, etc.) reuse the same request/response shape
// while pointing at their own URL. When omitted, falls back to OpenAI's
// canonical chat-completions endpoint.
function buildOpenAI(system, user, model, key, timeoutMs, endpoint) {
  return {
    url: endpoint || 'https://api.openai.com/v1/chat/completions',
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  };
}

function buildGemini(system, user, model, key, timeoutMs, endpoint) {
  const url = endpoint.replace('{model}', model) + `?key=${key}`;
  return {
    url,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  };
}

// Sonnet 4.5 prompt-caching threshold: 1024 tokens (rough: chars / 4).
const CACHE_TOKEN_THRESHOLD = 1024;

function buildAnthropic(system, user, model, key, timeoutMs) {
  const promptChars = system.length + user.length;
  const estimatedTokens = Math.floor(promptChars / 4);
  const cacheEligible = estimatedTokens >= CACHE_TOKEN_THRESHOLD;

  const systemBlock = cacheEligible
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  return {
    url: 'https://api.anthropic.com/v1/messages',
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemBlock,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
    _cacheEligible: cacheEligible,
  };
}

// ---------------------------------------------------------------------------
// Text extractor -- normalises the three provider response shapes
// ---------------------------------------------------------------------------

function extractText(provider, json) {
  // openai-compat (Qwen via DashScope, Together, Groq, etc.) reuses the
  // OpenAI chat-completions response shape, so the extractor is shared.
  if (provider === 'openai' || provider === 'openai-compat') {
    return json?.choices?.[0]?.message?.content ?? '';
  }
  if (provider === 'google') {
    return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
  if (provider === 'anthropic') {
    const block = (json?.content ?? []).find(b => b.type === 'text');
    return block?.text ?? '';
  }
  return '';
}

function extractCacheStats(json, cacheEligible) {
  if (!cacheEligible) {
    return {
      cache_eligible: false,
      cache_eligible_reason: 'prompt < 1024 tokens',
    };
  }
  const usage = json?.usage ?? {};
  return {
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_eligible: true,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

// runViaApi(pick, mode, angle, target, env, timeoutMs?, abortSignal?)
// Returns { status: 'ok', raw, model } or { status: 'failed', error, model }.
export async function runViaApi(pick, mode, angle, target, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal = null) {
  const fb = pick.apiFallback;
  if (!fb) return { status: 'failed', error: 'no API fallback configured', model: '' };

  const key = env[fb.authEnv];
  if (!key) return { status: 'failed', error: `${fb.authEnv} not set`, model: fb.model };

  const { system, format } = getTemplate(mode, angle);
  const user = `${format}\n\n## Target\n\n${target}`;

  // Combine caller abort signal with our per-call timeout signal.
  const timeoutSig = AbortSignal.timeout(timeoutMs);
  const combinedSignal = abortSignal ? AbortSignal.any([timeoutSig, abortSignal]) : timeoutSig;

  let req;
  if (fb.provider === 'openai') {
    req = buildOpenAI(system, user, fb.model, key, timeoutMs);
  } else if (fb.provider === 'openai-compat') {
    // OpenAI-compatible endpoints (Qwen via DashScope, Together, Groq, etc.)
    // share the chat-completions request/response shape and only differ on URL.
    req = buildOpenAI(system, user, fb.model, key, timeoutMs, fb.endpoint);
  } else if (fb.provider === 'google') {
    req = buildGemini(system, user, fb.model, key, timeoutMs, fb.endpoint);
  } else if (fb.provider === 'anthropic') {
    req = buildAnthropic(system, user, fb.model, key, timeoutMs);
  } else {
    return { status: 'failed', error: `unknown provider: ${fb.provider}`, model: fb.model };
  }
  // Override signal to use the combined abort signal.
  req.options.signal = combinedSignal;

  try {
    const res = await fetch(req.url, req.options);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { status: 'failed', error: `HTTP ${res.status}: ${body.slice(0, 300)}`, model: fb.model };
    }
    const json = await res.json();
    const raw = extractText(fb.provider, json);
    if (fb.provider === 'anthropic') {
      const cache_stats = extractCacheStats(json, req._cacheEligible);
      return { status: 'ok', raw, model: fb.model, cache_stats };
    }
    return { status: 'ok', raw, model: fb.model };
  } catch (err) {
    return { status: 'failed', error: err.message ?? String(err), model: fb.model };
  }
}
