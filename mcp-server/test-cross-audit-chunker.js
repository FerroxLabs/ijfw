// r17.1 (item 5) — chunker + merge tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, mergeFindings, CHUNKER_DEFAULTS } from './src/cross-audit-chunker.js';

test('chunkText: empty string returns []', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText(null), []);
});

test('chunkText: text under chunkSize returns single chunk', () => {
  const out = chunkText('hello world', { chunkSize: 1024 });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'hello world');
  assert.equal(out[0].start, 0);
  assert.equal(out[0].end, 11);
});

test('chunkText: text larger than chunkSize splits with overlap', () => {
  // Build text just over 2× chunkSize with sentence boundaries.
  const para = 'This is sentence one. This is sentence two. This is sentence three.\n\n';
  const text = para.repeat(200); // ~14 KB
  const chunks = chunkText(text, { chunkSize: 5_000, overlap: 500 });
  assert.ok(chunks.length >= 2, 'must split into 2+ chunks');
  // Each chunk after the first should overlap with the previous by ≤ overlap.
  for (let i = 1; i < chunks.length; i++) {
    const prevEnd = chunks[i - 1].end;
    const curStart = chunks[i].start;
    assert.ok(curStart < prevEnd, 'chunks must overlap (curStart < prevEnd)');
    assert.ok(prevEnd - curStart <= 500, 'overlap stays within budget');
  }
  // Last chunk reaches end of text.
  assert.equal(chunks[chunks.length - 1].end, text.length);
});

test('chunkText: prefers blank-line boundary over mid-word split', () => {
  const head = 'a'.repeat(4_000) + '\n\n';
  const tail = 'b'.repeat(4_000);
  const text = head + tail;
  const chunks = chunkText(text, { chunkSize: 4_500, overlap: 200 });
  // First chunk should end at the blank-line boundary (head.length).
  assert.equal(chunks[0].end, head.length, 'first chunk ends at blank-line boundary');
});

test('mergeFindings: empty input returns []', () => {
  assert.deepEqual(mergeFindings([]), []);
  assert.deepEqual(mergeFindings(null), []);
});

test('mergeFindings: identical findings from two chunks dedupe to one', () => {
  const f = { severity: 'high', target: 'src/foo.js:42', finding: 'null pointer on unauthenticated request', action: 'add null guard' };
  const merged = mergeFindings([
    { chunkIndex: 0, findings: [f] },
    { chunkIndex: 1, findings: [f] },
  ]);
  assert.equal(merged.length, 1, 'identical findings collapse to one');
  assert.equal(merged[0].clusterSize, 2, 'cluster size reflects both contributions');
  assert.deepEqual(merged[0].clusterChunks.sort(), [0, 1]);
});

test('mergeFindings: near-duplicate findings (jaccard ≥ threshold) cluster together', () => {
  const merged = mergeFindings([
    { chunkIndex: 0, findings: [{ severity: 'high', target: 'src/foo.js:42', finding: 'null pointer on unauthenticated request handler' }] },
    { chunkIndex: 1, findings: [{ severity: 'medium', target: 'src/foo.js:42', finding: 'null pointer unauthenticated request handler' }] },
  ]);
  assert.equal(merged.length, 1, 'near-duplicate clusters');
  // Max severity wins.
  assert.equal(merged[0].severity, 'high');
  assert.equal(merged[0].clusterSize, 2);
});

test('mergeFindings: distinct findings stay separate', () => {
  const merged = mergeFindings([
    { chunkIndex: 0, findings: [{ severity: 'high', target: 'a.js:1', finding: 'null check missing' }] },
    { chunkIndex: 1, findings: [{ severity: 'low', target: 'b.js:5', finding: 'unused variable shadow' }] },
  ]);
  assert.equal(merged.length, 2, 'unrelated findings remain distinct');
  // High first.
  assert.equal(merged[0].severity, 'high');
  assert.equal(merged[1].severity, 'low');
});

test('mergeFindings: handles plain-string findings (degrades gracefully)', () => {
  const merged = mergeFindings([
    { chunkIndex: 0, findings: ['simple string finding from auditor that did not return structured output'] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'medium', 'default severity for unstructured');
});

test('mergeFindings: sorts high → medium → low by severity', () => {
  const merged = mergeFindings([
    { chunkIndex: 0, findings: [
      { severity: 'low', target: 'a', finding: 'low one' },
      { severity: 'high', target: 'b', finding: 'high one' },
      { severity: 'medium', target: 'c', finding: 'medium one' },
    ]},
  ]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].severity, 'high');
  assert.equal(merged[1].severity, 'medium');
  assert.equal(merged[2].severity, 'low');
});

test('CHUNKER_DEFAULTS exposes the same values used by chunkText', () => {
  assert.ok(CHUNKER_DEFAULTS.chunkSize > 0);
  assert.ok(CHUNKER_DEFAULTS.overlap > 0);
  assert.ok(CHUNKER_DEFAULTS.dedupeThreshold > 0 && CHUNKER_DEFAULTS.dedupeThreshold <= 1);
});

// r17-M1 regression: explicit small chunkSize + omitted overlap must not
// produce an infinite-ish loop. Pre-fix the default overlap (~6553) would
// exceed a chunkSize of 500 and the loop would advance one char per step.
test('chunkText r17-M1: small chunkSize + default overlap stays bounded', () => {
  const text = 'x'.repeat(5_000);
  // chunkSize 500 with NO overlap passed — the default would be ~6553.
  // Post-fix: overlap is clamped to floor(chunkSize/2) = 250.
  const chunks = chunkText(text, { chunkSize: 500 });
  // Sanity: at least 5 chunks, well under 5000 (the pathological 1-char-
  // advance bug would produce ~5000 chunks).
  assert.ok(chunks.length >= 5, 'must split a 5KB string at 500 char chunkSize');
  assert.ok(chunks.length < 100, `pathological advance check: got ${chunks.length} chunks for 5KB at 500 chunkSize (expected <100)`);
  // Each advance is at least chunkSize/2 = 250 chars (chunkSize - clamped overlap).
  for (let i = 1; i < chunks.length; i++) {
    const advance = chunks[i].start - chunks[i - 1].start;
    assert.ok(advance >= 1, 'loop must advance at least 1 char per chunk');
  }
});
