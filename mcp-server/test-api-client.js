import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runViaApi } from './src/api-client.js';

// Helper: build a minimal pick object matching ROSTER shape.
function makePick(provider, authEnv, model = 'test-model') {
  return {
    id: provider === 'openai' ? 'codex' : provider === 'google' ? 'gemini' : 'claude',
    invoke: provider,
    apiFallback: {
      provider,
      model,
      authEnv,
      endpoint: provider === 'google'
        ? 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
        : null,
    },
  };
}

// Capture the last fetch call without actually hitting the network.
function mockFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return calls;
}

function restoreFetch() {
  delete globalThis.fetch;
}

// --- OpenAI ---

test('openai: sets Bearer auth header and correct body shape', async () => {
  const calls = mockFetch(200, {
    choices: [{ message: { content: 'found issues' } }],
  });

  const pick = makePick('openai', 'OPENAI_API_KEY');
  const env = { OPENAI_API_KEY: 'sk-test' };
  const result = await runViaApi(pick, 'audit', 'general', 'function foo(){}', env);

  assert.equal(result.status, 'ok');
  assert.equal(result.raw, 'found issues');
  assert.equal(calls.length, 1);

  const { opts } = calls[0];
  assert.equal(opts.headers['Authorization'], 'Bearer sk-test');
  assert.equal(opts.headers['Content-Type'], 'application/json');

  const body = JSON.parse(opts.body);
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');

  restoreFetch();
});

// --- Gemini ---

test('gemini: uses x-goog-api-key header and systemInstruction shape', async () => {
  const calls = mockFetch(200, {
    candidates: [{ content: { parts: [{ text: 'gemini response' }] } }],
  });

  const pick = makePick('google', 'GEMINI_API_KEY');
  const env = { GEMINI_API_KEY: 'gk-test' };
  const result = await runViaApi(pick, 'audit', 'general', 'some target', env);

  assert.equal(result.status, 'ok');
  assert.equal(result.raw, 'gemini response');

  const { opts } = calls[0];
  assert.equal(opts.headers['x-goog-api-key'], 'gk-test');

  const body = JSON.parse(opts.body);
  assert.ok(body.systemInstruction, 'systemInstruction field must exist');
  assert.ok(Array.isArray(body.systemInstruction.parts));
  assert.ok(Array.isArray(body.contents));
  assert.equal(body.contents[0].role, 'user');

  restoreFetch();
});

// --- Anthropic ---

test('anthropic: uses x-api-key header; short prompt skips cache_control', async () => {
  const calls = mockFetch(200, {
    content: [{ type: 'text', text: 'anthropic response' }],
    usage: {},
  });

  const pick = makePick('anthropic', 'ANTHROPIC_API_KEY');
  const env = { ANTHROPIC_API_KEY: 'ak-test' };
  // 'some target' is short - total tokens well below 1024 threshold.
  const result = await runViaApi(pick, 'audit', 'general', 'some target', env);

  assert.equal(result.status, 'ok');
  assert.equal(result.raw, 'anthropic response');

  const { opts } = calls[0];
  assert.equal(opts.headers['x-api-key'], 'ak-test');
  assert.equal(opts.headers['anthropic-version'], '2023-06-01');

  const body = JSON.parse(opts.body);
  // Short prompt: system is a plain string (no cache_control block).
  assert.equal(typeof body.system, 'string', 'short prompt: system must be a plain string');
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.messages[0].role, 'user');

  // cache_stats must indicate ineligible.
  assert.ok(result.cache_stats, 'cache_stats must be present on Anthropic result');
  assert.equal(result.cache_stats.cache_eligible, false);
  assert.ok(result.cache_stats.cache_eligible_reason);

  restoreFetch();
});

test('anthropic: long prompt enables cache_control block', async () => {
  const calls = mockFetch(200, {
    content: [{ type: 'text', text: 'cached response' }],
    usage: { cache_creation_input_tokens: 1200, cache_read_input_tokens: 0 },
  });

  const pick = makePick('anthropic', 'ANTHROPIC_API_KEY');
  const env = { ANTHROPIC_API_KEY: 'ak-test' };
  // Pad target to force system+user > 1024*4=4096 chars.
  const longTarget = 'x'.repeat(5000);
  const result = await runViaApi(pick, 'audit', 'general', longTarget, env);

  assert.equal(result.status, 'ok');

  const body = JSON.parse(calls[0].opts.body);
  // Long prompt: system must be an array with cache_control.
  assert.ok(Array.isArray(body.system), 'long prompt: system must be an array');
  assert.equal(body.system[0].type, 'text');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });

  // cache_stats must indicate eligible.
  assert.equal(result.cache_stats.cache_eligible, true);
  assert.equal(result.cache_stats.cache_creation_input_tokens, 1200);
  assert.equal(result.cache_stats.cache_read_input_tokens, 0);

  restoreFetch();
});

test('anthropic: cache_read_input_tokens captured from API response', async () => {
  mockFetch(200, {
    content: [{ type: 'text', text: 'hit response' }],
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 1100 },
  });

  const pick = makePick('anthropic', 'ANTHROPIC_API_KEY');
  const env = { ANTHROPIC_API_KEY: 'ak-test' };
  const longTarget = 'y'.repeat(5000);
  const result = await runViaApi(pick, 'audit', 'general', longTarget, env);

  assert.equal(result.cache_stats.cache_eligible, true);
  assert.equal(result.cache_stats.cache_read_input_tokens, 1100);

  restoreFetch();
});

// --- Non-2xx ---

test('non-2xx response returns status: failed', async () => {
  mockFetch(429, { error: { message: 'rate limited' } });

  const pick = makePick('openai', 'OPENAI_API_KEY');
  const env = { OPENAI_API_KEY: 'sk-test' };
  const result = await runViaApi(pick, 'audit', 'general', 'target', env);

  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('429'));

  restoreFetch();
});

// --- Missing env key ---

test('missing auth env key returns status: failed without network call', async () => {
  const calls = mockFetch(200, {});

  const pick = makePick('openai', 'OPENAI_API_KEY');
  const result = await runViaApi(pick, 'audit', 'general', 'target', {});

  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 0, 'should not call fetch when key is missing');

  restoreFetch();
});

// --- No apiFallback ---

test('pick with null apiFallback returns status: failed', async () => {
  const pick = { id: 'opencode', invoke: 'opencode', apiFallback: null };
  const result = await runViaApi(pick, 'audit', 'general', 'target', {});
  assert.equal(result.status, 'failed');
});

// --- AbortSignal timeout fires ---

test('network timeout returns status: failed with timeout error', async () => {
  // Simulate fetch throwing AbortError (what AbortSignal.timeout does).
  globalThis.fetch = async () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    throw err;
  };

  const pick = makePick('openai', 'OPENAI_API_KEY');
  const env = { OPENAI_API_KEY: 'sk-test' };
  const result = await runViaApi(pick, 'audit', 'general', 'target', env, 1);

  assert.equal(result.status, 'failed');
  assert.ok(result.error.length > 0);

  restoreFetch();
});

// --- OpenAI-compat (Qwen/DashScope, Together, Groq, etc.) ---
// Verifies the new openai-compat provider added in 1.2.4: shares the OpenAI
// chat-completions request/response shape but routes to a custom endpoint.

test('openai-compat: posts to custom endpoint with Bearer auth + OpenAI body', async () => {
  const calls = mockFetch(200, {
    choices: [{ message: { content: 'qwen findings here' } }],
  });

  const pick = {
    id: 'qwen',
    invoke: 'qwen -p',
    apiFallback: {
      provider: 'openai-compat',
      model: 'qwen3-coder-plus',
      authEnv: 'DASHSCOPE_API_KEY',
      endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    },
  };
  const env = { DASHSCOPE_API_KEY: 'sk-dashscope-test' };
  const result = await runViaApi(pick, 'audit', 'general', 'def foo(): pass', env);

  assert.equal(result.status, 'ok');
  assert.equal(result.raw, 'qwen findings here');
  assert.equal(calls.length, 1);

  // Custom endpoint, NOT api.openai.com
  assert.equal(calls[0].url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  // Same auth + body shape as canonical openai
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer sk-dashscope-test');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'qwen3-coder-plus');
  assert.ok(Array.isArray(body.messages));

  restoreFetch();
});
