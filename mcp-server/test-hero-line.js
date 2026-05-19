// test-hero-line.js -- model-aware cache-savings tests for hero-line.js
//
// Audit-H4.6 (MED): hero-line cost constant was hardcoded at Sonnet pricing,
// printing wrong dollar amounts for Opus and Haiku users. This file pins
// the model-aware behaviour:
//   1. Opus session uses Opus rate ($13.50/M cache-read savings).
//   2. Haiku session uses Haiku rate ($0.90/M cache-read savings).
//   3. Unknown model falls back to Sonnet rate AND emits one stderr advisory
//      per session (subsequent unknown-model receipts in the same session
//      stay silent).

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderHeroLine, _resetUnknownModelWarningForTests } from './src/hero-line.js';

// Minimal receipt factory -- matches test-receipts.js shape but with a model.
function makeReceipt(overrides = {}) {
  return {
    v: 1,
    timestamp: new Date().toISOString(),
    run_stamp: 'hero-line-test',
    mode: 'audit',
    auditors: [{ id: 'codex', family: 'openai', model: '' }],
    findings: { consensus: 1, contested: 0, unique: 0 },
    duration_ms: 1000,
    input_tokens: 1000,
    cost_usd: 0,
    model: null,
    ...overrides,
  };
}

// Capture stderr writes so we can assert on the unknown-model advisory.
let stderrBuffer = '';
let originalWrite;

before(() => {
  originalWrite = process.stderr.write.bind(process.stderr);
});

beforeEach(() => {
  stderrBuffer = '';
  process.stderr.write = (chunk, ...rest) => {
    stderrBuffer += String(chunk);
    // Don't forward to the real stderr -- keeps test output clean.
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  _resetUnknownModelWarningForTests();
});

function restoreStderr() {
  if (originalWrite) process.stderr.write = originalWrite;
}

// 1) Opus session (claude-4-opus-20250514): input $15/M, cache-read $1.50/M
//    -> $13.50/M saved. 1,000,000 cache-read tokens => $13.50 saved.
test('hero-line: Opus session uses Opus cache-savings rate', () => {
  try {
    const r = makeReceipt({
      model: 'claude-4-opus-20250514',
      cache_stats: { cache_eligible: true, cache_read_input_tokens: 1_000_000 },
    });
    const out = renderHeroLine([r], []);
    assert.ok(out.includes('prompt cache hit'), `expected cache suffix in: ${out}`);
    assert.ok(out.includes('$13.50 saved'), `expected $13.50 (Opus rate), got: ${out}`);
    assert.ok(!out.includes('$2.70 saved'), `must NOT use Sonnet fallback, got: ${out}`);
    assert.ok(!stderrBuffer.includes('unknown model'), `Opus is a known model; no advisory expected. stderr: ${stderrBuffer}`);
  } finally {
    restoreStderr();
  }
});

// 2) Haiku session: input $1/M, cache-read $0.10/M -> $0.90/M saved.
// 1,000,000 cache-read tokens => $0.90 saved.
test('hero-line: Haiku session uses Haiku cache-savings rate', () => {
  try {
    const r = makeReceipt({
      model: 'claude-haiku-4-5',
      cache_stats: { cache_eligible: true, cache_read_input_tokens: 1_000_000 },
    });
    const out = renderHeroLine([r], []);
    assert.ok(out.includes('prompt cache hit'), `expected cache suffix in: ${out}`);
    assert.ok(out.includes('$0.90 saved'), `expected $0.90 (Haiku rate), got: ${out}`);
    assert.ok(!out.includes('$2.70 saved'), `must NOT use Sonnet fallback, got: ${out}`);
    assert.ok(!stderrBuffer.includes('unknown model'), `Haiku is a known model; no advisory expected. stderr: ${stderrBuffer}`);
  } finally {
    restoreStderr();
  }
});

// 3) Unknown model -> Sonnet fallback + one-time stderr advisory.
test('hero-line: unknown model falls back to Sonnet rate and warns once per session', () => {
  try {
    const r1 = makeReceipt({
      model: 'totally-bogus-model-id',
      cache_stats: { cache_eligible: true, cache_read_input_tokens: 1_000_000 },
    });
    const out1 = renderHeroLine([r1], []);
    assert.ok(out1.includes('$2.70 saved'), `unknown model must fall back to Sonnet ($2.70), got: ${out1}`);
    assert.ok(stderrBuffer.includes('unknown model'), `expected stderr advisory, got: "${stderrBuffer}"`);
    assert.ok(stderrBuffer.includes('totally-bogus-model-id'), `advisory should name the offending model, got: "${stderrBuffer}"`);

    // Second call with another unknown model in the SAME session: no second warning.
    const firstWarningLength = stderrBuffer.length;
    const r2 = makeReceipt({
      model: 'another-bogus-id',
      cache_stats: { cache_eligible: true, cache_read_input_tokens: 1_000_000 },
    });
    const out2 = renderHeroLine([r2], []);
    assert.ok(out2.includes('$2.70 saved'), `second unknown model still falls back to Sonnet, got: ${out2}`);
    assert.equal(stderrBuffer.length, firstWarningLength,
      `advisory must fire ONCE per session; stderr grew from ${firstWarningLength} to ${stderrBuffer.length}`);
  } finally {
    restoreStderr();
  }
});

// Bonus regression: legacy receipts with model: null still work (Sonnet rate,
// no crash) and trigger the advisory exactly once.
test('hero-line: legacy model:null receipts still produce Sonnet-rate savings', () => {
  try {
    const r = makeReceipt({
      // model defaults to null in makeReceipt
      cache_stats: { cache_eligible: true, cache_read_input_tokens: 1_000_000 },
    });
    const out = renderHeroLine([r], []);
    assert.ok(out.includes('$2.70 saved'), `legacy null-model -> Sonnet rate, got: ${out}`);
  } finally {
    restoreStderr();
  }
});
