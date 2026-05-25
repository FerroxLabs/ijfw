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
