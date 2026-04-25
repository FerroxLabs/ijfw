import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'ijfw-caps-'));
process.env.IJFW_PROJECT_DIR = sandbox;
const { CAP_CONTENT, CAP_WHY, CAP_HOW, CAP_SUMMARY, applyCaps } = await import('./src/caps.js');

test('CAP_CONTENT is 4096', () => assert.equal(CAP_CONTENT, 4096));
test('CAP_WHY is 1024', () => assert.equal(CAP_WHY, 1024));
test('CAP_HOW is 1024', () => assert.equal(CAP_HOW, 1024));
test('CAP_SUMMARY is 120', () => assert.equal(CAP_SUMMARY, 120));

test('content cap truncates with marker', () => {
  const capped = applyCaps({ content: 'a'.repeat(10_000) });
  assert.ok(capped.content.length <= CAP_CONTENT);
  assert.ok(capped.content.endsWith('…[truncated]'));
});

test('why cap truncates at 1024', () => {
  const capped = applyCaps({ content: 'ok', why: 'b'.repeat(5_000) });
  assert.ok(capped.why.length <= CAP_WHY);
  assert.ok(capped.why.endsWith('…[truncated]'));
});

test('how_to_apply cap truncates at 1024', () => {
  const capped = applyCaps({ content: 'ok', how_to_apply: 'c'.repeat(5_000) });
  assert.ok(capped.how_to_apply.length <= CAP_HOW);
});

test('summary cap truncates at 120', () => {
  const capped = applyCaps({ content: 'ok', summary: 'd'.repeat(500) });
  assert.ok(capped.summary.length <= CAP_SUMMARY);
});

test('under-cap values pass through untouched', () => {
  const r = applyCaps({ content: 'small', why: 'w', how_to_apply: 'h', summary: 's' });
  assert.equal(r.content, 'small');
  assert.equal(r.why, 'w');
  assert.equal(r.how_to_apply, 'h');
  assert.equal(r.summary, 's');
});

test('missing fields become empty strings', () => {
  const r = applyCaps({});
  assert.equal(r.content, '');
  assert.equal(r.why, '');
  assert.equal(r.how_to_apply, '');
  assert.equal(r.summary, '');
});

test('non-string inputs become empty', () => {
  const r = applyCaps({ content: 42, why: null, how_to_apply: {}, summary: undefined });
  assert.equal(r.content, '');
  assert.equal(r.why, '');
  assert.equal(r.how_to_apply, '');
  assert.equal(r.summary, '');
});

test('truncation is codepoint-safe for emoji (no dangling surrogate)', () => {
  // Fill past the summary cap with a 4-byte emoji so the boundary falls
  // inside a surrogate pair. Caps are codepoint-counted, so the output
  // codepoint count must respect the limit and contain no lone surrogate.
  const content = '🎉'.repeat(200); // 200 codepoints, 400 UTF-16 code units
  const r = applyCaps({ summary: content });
  const cps = Array.from(r.summary);
  assert.ok(cps.length <= CAP_SUMMARY, `got ${cps.length} codepoints`);
  // No lone surrogates in the output (well-formed UTF-16).
  for (let i = 0; i < r.summary.length; i++) {
    const code = r.summary.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate - next unit must be a low surrogate.
      const next = r.summary.charCodeAt(i + 1);
      assert.ok(next >= 0xDC00 && next <= 0xDFFF, `lone high surrogate at ${i}`);
      i++; // skip low
    } else {
      assert.ok(code < 0xDC00 || code > 0xDFFF, `lone low surrogate at ${i}`);
    }
  }
  assert.ok(r.summary.endsWith('…[truncated]'));
});

test('truncation is codepoint-safe for CJK content', () => {
  const content = '日本語'.repeat(5000); // 15000 codepoints, 1 UTF-16 unit each
  const r = applyCaps({ content });
  const cps = Array.from(r.content);
  assert.ok(cps.length <= CAP_CONTENT, `got ${cps.length} codepoints`);
  assert.ok(r.content.endsWith('…[truncated]'));
});

test('under-cap emoji strings pass through intact', () => {
  const hello = 'hello 🎉 world';
  const r = applyCaps({ summary: hello });
  assert.equal(r.summary, hello);
});
