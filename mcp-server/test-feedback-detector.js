import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFeedback } from './src/feedback-detector.js';

test("detects 'don't do that' as correction", () => {
  const r = detectFeedback("don't do that - always call via the MCP tool");
  assert.ok(r.some(h => h.kind === 'correction'));
});

test("detects 'stop doing X' as correction", () => {
  const r = detectFeedback('stop doing inline fallbacks');
  assert.ok(r.some(h => h.kind === 'correction'));
});

test("detects 'yes that was right' as confirmation", () => {
  const r = detectFeedback('yes that was right, keep it that way');
  assert.ok(r.some(h => h.kind === 'confirmation'));
});

test("detects 'perfect' as confirmation", () => {
  const r = detectFeedback('perfect - ship it');
  assert.ok(r.some(h => h.kind === 'confirmation'));
});

test("detects 'I prefer' as preference", () => {
  const r = detectFeedback('I prefer the ternary style for single-line returns');
  assert.ok(r.some(h => h.kind === 'preference'));
});

test("detects 'from now on' as preference", () => {
  const r = detectFeedback('from now on, use esbuild not webpack');
  assert.ok(r.some(h => h.kind === 'preference'));
});

test("detects 'always/never' as preference", () => {
  const r = detectFeedback('always use atomicWrite for memory files');
  assert.ok(r.some(h => h.kind === 'preference'));
});

test("detects generalization cue 'every time'", () => {
  const r = detectFeedback('every time we write a hook, add error log');
  assert.ok(r.some(h => h.kind === 'rule'));
});

test('deduplicates within kind', () => {
  const r = detectFeedback("don't do that, no not that, stop doing it");
  const corrections = r.filter(h => h.kind === 'correction');
  assert.equal(corrections.length, 1);
});

test('multiple kinds can coexist', () => {
  const r = detectFeedback("yes that was right - from now on always commit tests first");
  const kinds = new Set(r.map(h => h.kind));
  assert.ok(kinds.has('confirmation'));
  assert.ok(kinds.has('preference'));
});

test('ordinary prose returns empty', () => {
  assert.deepEqual(detectFeedback('fix the paginator bug'), []);
  assert.deepEqual(detectFeedback('what does this function do'), []);
});

test('empty/invalid input returns empty', () => {
  assert.deepEqual(detectFeedback(''), []);
  assert.deepEqual(detectFeedback(null), []);
  assert.deepEqual(detectFeedback(undefined), []);
});

test('snippet contains the matched phrase', () => {
  const r = detectFeedback('the fix is to, no wrong, revert that');
  const hit = r.find(h => h.kind === 'correction');
  assert.ok(hit.context.length > 0);
});
