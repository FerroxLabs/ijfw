/**
 * test-cross-cli-chunk.js — coverage for the v1.5.1 H1.6 `--chunk` wire-up
 * helpers in cross-orchestrator-cli.js.
 *
 * Audit findings closed by this commit (2/2 consensus):
 * - token-optimization.md HIGH-H4: chunker module never wired into cmdCross
 * - trident.md HIGH-1: `--chunk` flag advertised at cli:967 but unimplemented
 *
 * The actual dispatch path (`runCrossOp` × N chunks) requires real auditors
 * and is exercised by the existing trident integration suite. This file
 * covers the deterministic helpers: shouldChunkFile (decision) and
 * buildChunkedTargets (chunk text + annotations).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldChunkFile, buildChunkedTargets } from './src/cross-orchestrator-cli.js';

function mkdir() {
  const dir = mkdtempSync(join(tmpdir(), 'cross-chunk-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// shouldChunkFile
// ---------------------------------------------------------------------------

test('shouldChunkFile: tiny file is below threshold → no chunk', () => {
  const { dir, cleanup } = mkdir();
  try {
    const f = join(dir, 'tiny.md');
    writeFileSync(f, 'hello');
    assert.equal(shouldChunkFile(f), false);
  } finally { cleanup(); }
});

test('shouldChunkFile: explicit threshold honored', () => {
  const { dir, cleanup } = mkdir();
  try {
    const f = join(dir, 'med.md');
    writeFileSync(f, 'x'.repeat(2000));
    assert.equal(shouldChunkFile(f, { threshold: 1000 }), true);
    assert.equal(shouldChunkFile(f, { threshold: 5000 }), false);
  } finally { cleanup(); }
});

test('shouldChunkFile: missing path → false', () => {
  assert.equal(shouldChunkFile('/this/path/does/not/exist.md'), false);
});

test('shouldChunkFile: directory → false', () => {
  const { dir, cleanup } = mkdir();
  try {
    assert.equal(shouldChunkFile(dir), false);
  } finally { cleanup(); }
});

test('shouldChunkFile: large file → true under default threshold', () => {
  const { dir, cleanup } = mkdir();
  try {
    const f = join(dir, 'big.md');
    writeFileSync(f, 'y'.repeat(80 * 1024)); // 80 KB (above default 64 KB cap)
    assert.equal(shouldChunkFile(f), true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// buildChunkedTargets
// ---------------------------------------------------------------------------

test('buildChunkedTargets: small file → single chunk wrapped in target envelope', () => {
  const { dir, cleanup } = mkdir();
  try {
    const f = join(dir, 'small.md');
    writeFileSync(f, 'hello world');
    const chunks = buildChunkedTargets(f, 'small.md');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].chunkIndex, 0);
    assert.equal(chunks[0].total, 1);
    assert.match(chunks[0].target, /^File: small\.md \[chunk 1\/1, bytes 0-11\]/);
    assert.match(chunks[0].target, /hello world/);
  } finally { cleanup(); }
});

test('buildChunkedTargets: large content → multiple chunks with overlap', () => {
  const { dir, cleanup } = mkdir();
  try {
    const f = join(dir, 'large.md');
    // Build content with sentence-ish boundaries so chunkText finds split points.
    const para = 'This is sentence one. This is sentence two. This is sentence three.\n\n';
    writeFileSync(f, para.repeat(500)); // ~35 KB
    const chunks = buildChunkedTargets(f, 'large.md', { chunkSize: 5_000, overlap: 500 });
    assert.ok(chunks.length >= 2, 'expected multiple chunks');
    // Each carries the right metadata.
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].chunkIndex, i);
      assert.equal(chunks[i].total, chunks.length);
      assert.match(
        chunks[i].target,
        new RegExp(`^File: large\\.md \\[chunk ${i + 1}/${chunks.length}, bytes \\d+-\\d+\\]`),
      );
    }
    // Last chunk reaches end of file.
    assert.equal(chunks[chunks.length - 1].bytesEnd, para.repeat(500).length);
  } finally { cleanup(); }
});

test('buildChunkedTargets: each chunk envelope contains the chunk text body', () => {
  const { dir, cleanup } = mkdir();
  try {
    const f = join(dir, 'body.md');
    const para = 'alpha beta gamma. ';
    writeFileSync(f, para.repeat(1000));
    const chunks = buildChunkedTargets(f, 'body.md', { chunkSize: 4_000, overlap: 400 });
    // Verify each target has SOME of the expected text inside.
    for (const c of chunks) {
      assert.match(c.target, /alpha beta gamma/);
    }
  } finally { cleanup(); }
});
