// mcp-server/test-llm-call.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmCall, parseLlmJsonResponse } from './src/lib/llm-call.js';

test('llmCall short-circuits when IJFW_AUTOLINK_OFF=1', async () => {
  const orig = process.env.IJFW_AUTOLINK_OFF;
  process.env.IJFW_AUTOLINK_OFF = '1';
  try {
    const out = await llmCall({ system: 's', user: 'u' });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'autolink_off');
  } finally {
    if (orig === undefined) delete process.env.IJFW_AUTOLINK_OFF;
    else process.env.IJFW_AUTOLINK_OFF = orig;
  }
});

test('parseLlmJsonResponse handles fenced JSON', () => {
  const raw = 'Sure. ```json\n{"links":["a","b"]}\n```';
  const out = parseLlmJsonResponse(raw);
  assert.deepEqual(out, { links: ['a', 'b'] });
});

test('parseLlmJsonResponse handles bare JSON', () => {
  assert.deepEqual(parseLlmJsonResponse('{"x":1}'), { x: 1 });
});

test('parseLlmJsonResponse throws on garbage', () => {
  assert.throws(() => parseLlmJsonResponse('not json at all'), /parse/i);
});

test('llmCall honours IJFW_AUTOLINK_BUDGET_USD=0', async () => {
  const orig = process.env.IJFW_AUTOLINK_BUDGET_USD;
  process.env.IJFW_AUTOLINK_BUDGET_USD = '0';
  try {
    const out = await llmCall({ system: 's', user: 'u' });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'budget_exhausted');
  } finally {
    if (orig === undefined) delete process.env.IJFW_AUTOLINK_BUDGET_USD;
    else process.env.IJFW_AUTOLINK_BUDGET_USD = orig;
  }
});
