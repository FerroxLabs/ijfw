// Tests for the JSONL rotation helper (audit-MED-teams-#10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROTATE_SIZE, rotateJsonlIfNeeded } from './src/lib/jsonl-rotation.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ijfw-jsonl-rot-test-'));
}
function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

test('DEFAULT_ROTATE_SIZE is 4MB', () => {
  assert.equal(DEFAULT_ROTATE_SIZE, 4 * 1024 * 1024);
});

test('rotateJsonlIfNeeded skips files under the threshold', () => {
  const dir = makeTmp();
  try {
    const path = join(dir, 'events.jsonl');
    writeFileSync(path, '{"x":1}\n');
    const result = rotateJsonlIfNeeded(path);
    assert.equal(result.rotated, false);
    assert.equal(result.reason, 'under-threshold');
    // Original still has the line; no archive emitted.
    assert.equal(readFileSync(path, 'utf8'), '{"x":1}\n');
    const archives = readdirSync(dir).filter((f) => f.endsWith('.jsonl.gz'));
    assert.equal(archives.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('rotateJsonlIfNeeded rotates files over the threshold', () => {
  const dir = makeTmp();
  try {
    const path = join(dir, 'events.jsonl');
    const payload = `${'a'.repeat(120)}\n`.repeat(64); // ~8KB
    writeFileSync(path, payload);
    const result = rotateJsonlIfNeeded(path, { maxBytes: 1024 });
    assert.equal(result.rotated, true);
    assert.ok(result.archive.endsWith('.jsonl.gz'));
    assert.ok(existsSync(result.archive));
    // Live file is truncated.
    assert.equal(statSync(path).size, 0);
    // Archive decompresses to the original bytes.
    const restored = gunzipSync(readFileSync(result.archive)).toString('utf8');
    assert.equal(restored, payload);
  } finally {
    cleanup(dir);
  }
});

test('rotateJsonlIfNeeded uniquifies same-day archive names', () => {
  const dir = makeTmp();
  try {
    const path = join(dir, 'events.jsonl');
    const payload = 'x'.repeat(4096) + '\n';
    const now = new Date('2026-05-19T12:00:00Z');
    writeFileSync(path, payload);
    const r1 = rotateJsonlIfNeeded(path, { maxBytes: 256, now });
    assert.equal(r1.rotated, true);
    writeFileSync(path, payload);
    const r2 = rotateJsonlIfNeeded(path, { maxBytes: 256, now });
    assert.equal(r2.rotated, true);
    assert.notEqual(r1.archive, r2.archive);
    // Both archives exist.
    assert.ok(existsSync(r1.archive));
    assert.ok(existsSync(r2.archive));
  } finally {
    cleanup(dir);
  }
});

test('rotateJsonlIfNeeded returns missing for non-existent files', () => {
  const dir = makeTmp();
  try {
    const result = rotateJsonlIfNeeded(join(dir, 'never-existed.jsonl'));
    assert.equal(result.rotated, false);
    assert.equal(result.reason, 'missing');
  } finally {
    cleanup(dir);
  }
});
