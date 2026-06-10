import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTierModel, callTiered } from '../../src/brain/tiered-llm.js';

test('resolveTierModel: defaults to claude-haiku-4-5 for extract', () => {
  assert.equal(resolveTierModel('extract', {}), 'claude-haiku-4-5-20251001');
});

test('resolveTierModel: defaults to claude-sonnet-4-6 for synth', () => {
  assert.equal(resolveTierModel('synth', {}), 'claude-sonnet-4-6');
});

test('resolveTierModel: env override for extract', () => {
  assert.equal(resolveTierModel('extract', { IJFW_BRAIN_EXTRACT_MODEL: 'llama3:8b' }), 'llama3:8b');
});

test('resolveTierModel: env override for synth', () => {
  assert.equal(resolveTierModel('synth', { IJFW_BRAIN_SYNTH_MODEL: 'mixtral:8x7b' }), 'mixtral:8x7b');
});

test('resolveTierModel: unknown tier throws', () => {
  assert.throws(() => resolveTierModel('mystery', {}), /unknown tier/);
});

test('callTiered: when no IJFW_BRAIN_LOCAL_URL, calls anthropic directly', async () => {
  const calls = [];
  const _callers = {
    local: async (args) => { calls.push({ via: 'local', args }); return { text: 'local' }; },
    anthropic: async (args) => { calls.push({ via: 'anthropic', args }); return { text: 'anthropic-result' }; },
  };
  const res = await callTiered('extract', 'hi', {
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    _callers,
  });
  assert.equal(res.text, 'anthropic-result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].via, 'anthropic');
  assert.equal(calls[0].args.model, 'claude-haiku-4-5-20251001');
  assert.equal(calls[0].args.maxTokens, 512);
});

test('callTiered: when IJFW_BRAIN_LOCAL_URL set, tries local first', async () => {
  const calls = [];
  const _callers = {
    local: async (args) => { calls.push({ via: 'local', args }); return { text: 'local-result' }; },
    anthropic: async () => { calls.push({ via: 'anthropic' }); return { text: 'should-not-reach' }; },
  };
  const res = await callTiered('synth', 'hi', {
    env: { IJFW_BRAIN_LOCAL_URL: 'http://localhost:11434' },
    _callers,
  });
  assert.equal(res.text, 'local-result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].via, 'local');
  assert.equal(calls[0].args.url, 'http://localhost:11434');
  assert.equal(calls[0].args.maxTokens, 1500);
});

test('callTiered: local failure falls back to anthropic', async () => {
  const calls = [];
  const _callers = {
    local: async () => { calls.push('local'); throw new Error('connect ECONNREFUSED'); },
    anthropic: async () => { calls.push('anthropic'); return { text: 'fallback-ok' }; },
  };
  const res = await callTiered('extract', 'hi', {
    env: { IJFW_BRAIN_LOCAL_URL: 'http://localhost:11434', ANTHROPIC_API_KEY: 'sk-test' },
    _callers,
  });
  assert.equal(res.text, 'fallback-ok');
  assert.deepEqual(calls, ['local', 'anthropic']);
});

test('callTiered: IJFW_BENCH_SYNTH_URL routes to openaiLocal with resolved model + temperature + maxTokens', async () => {
  const calls = [];
  const _callers = {
    local: async () => { calls.push('local'); return { text: 'should-not-reach' }; },
    anthropic: async () => { calls.push('anthropic'); return { text: 'should-not-reach' }; },
    openaiLocal: async (args) => { calls.push({ via: 'openaiLocal', args }); return { text: 'synth-result', usage: { input: 11, output: 22 } }; },
  };
  const res = await callTiered('synth', 'hi', {
    env: { IJFW_BENCH_SYNTH_URL: 'http://localhost:8000/v1', IJFW_BRAIN_SYNTH_MODEL: 'qwen3.6-35b-a3b' },
    temperature: 0,
    _callers,
  });
  assert.equal(res.text, 'synth-result');
  assert.deepEqual(res.usage, { input: 11, output: 22 });
  assert.deepEqual(calls.map((c) => (typeof c === 'string' ? c : c.via)), ['openaiLocal']);
  const args = calls[0].args;
  assert.equal(args.url, 'http://localhost:8000/v1');
  assert.equal(args.model, 'qwen3.6-35b-a3b');
  assert.equal(args.temperature, 0);
  assert.equal(args.maxTokens, 1500);
});

test('callTiered: openaiLocal failure PROPAGATES (no anthropic fallback)', async () => {
  const calls = [];
  const _callers = {
    local: async () => { calls.push('local'); return { text: 'x' }; },
    anthropic: async () => { calls.push('anthropic'); return { text: 'should-not-reach' }; },
    openaiLocal: async () => { calls.push('openaiLocal'); throw new Error('vLLM HTTP 500'); },
  };
  await assert.rejects(
    callTiered('synth', 'hi', {
      env: { IJFW_BENCH_SYNTH_URL: 'http://localhost:8000/v1', ANTHROPIC_API_KEY: 'sk-test' },
      _callers,
    }),
    /vLLM HTTP 500/,
  );
  assert.deepEqual(calls, ['openaiLocal']);
});

test('openaiLocal caller: posts to {url}/chat/completions with enable_thinking:false and parses choices[0].message.content', async () => {
  const captured = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (urlArg, init) => {
    captured.url = urlArg;
    captured.body = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: 'the answer' } }],
          usage: { prompt_tokens: 7, completion_tokens: 13 },
        };
      },
    };
  };
  try {
    const { defaultCallers } = await import('../../src/brain/tiered-llm.js');
    const callers = defaultCallers();
    const out = await callers.openaiLocal({ url: 'http://localhost:8000/v1', model: 'qwen3.6-35b-a3b', prompt: 'q?', maxTokens: 256, temperature: 0 });
    assert.equal(captured.url, 'http://localhost:8000/v1/chat/completions');
    assert.equal(captured.body.model, 'qwen3.6-35b-a3b');
    assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'q?' }]);
    assert.equal(captured.body.max_tokens, 256);
    assert.equal(captured.body.temperature, 0);
    assert.deepEqual(captured.body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(out.text, 'the answer');
    assert.deepEqual(out.usage, { input: 7, output: 13 });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('openaiLocal caller: throws on non-ok response (no empty return)', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, async json() { return {}; } });
  try {
    const { defaultCallers } = await import('../../src/brain/tiered-llm.js');
    const callers = defaultCallers();
    await assert.rejects(
      callers.openaiLocal({ url: 'http://localhost:8000/v1', model: 'm', prompt: 'p', maxTokens: 8 }),
      /502/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('openaiLocal caller: throws on missing choice', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return { choices: [] }; } });
  try {
    const { defaultCallers } = await import('../../src/brain/tiered-llm.js');
    const callers = defaultCallers();
    await assert.rejects(
      callers.openaiLocal({ url: 'http://localhost:8000/v1', model: 'm', prompt: 'p', maxTokens: 8 }),
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('callTiered: maxTokens override wins over defaults', async () => {
  let captured;
  const _callers = {
    local: async () => ({ text: '' }),
    anthropic: async (args) => { captured = args; return { text: '' }; },
  };
  await callTiered('extract', 'hi', {
    env: { ANTHROPIC_API_KEY: 'sk-test' },
    maxTokens: 99,
    _callers,
  });
  assert.equal(captured.maxTokens, 99);
});
