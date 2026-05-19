// v1.5.0 audit MED #7 -- persistent embedding cache (memory_entry_vectors).
// Tests encode/decode round trip + schema gate so callers can run against a
// pre-migration db without crashing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeVector,
  decodeVector,
  hasVectorCache,
  getCachedVector,
  setCachedVector,
  countCachedVectors,
} from './src/memory/embedding-cache.js';

let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  // No better-sqlite3 available -- skip the schema-bound tests below. The
  // pure-JS encode/decode tests still run.
}

test('encodeVector / decodeVector: round trip preserves values to f32 precision', () => {
  const vec = [0.0, 1.0, -1.0, 0.5, -0.25, 1e-3, 12345.678];
  const buf = encodeVector(vec);
  assert.ok(buf, 'encode returns a Buffer');
  assert.equal(buf.length, vec.length * 4);
  const out = decodeVector(buf);
  assert.equal(out.length, vec.length);
  for (let i = 0; i < vec.length; i++) {
    assert.ok(Math.abs(out[i] - vec[i]) < 1e-3, `idx ${i}: ${out[i]} vs ${vec[i]}`);
  }
});

test('encodeVector: null / empty input returns null', () => {
  assert.equal(encodeVector(null), null);
  assert.equal(encodeVector(undefined), null);
  assert.equal(encodeVector([]), null);
});

test('decodeVector: malformed buffer length returns null', () => {
  assert.equal(decodeVector(Buffer.from([1, 2, 3])), null);
  assert.equal(decodeVector(null), null);
  assert.equal(decodeVector(Buffer.alloc(0)), null);
});

test('hasVectorCache: db without the table returns false', { skip: !Database }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-embed-cache-'));
  try {
    const db = new Database(join(dir, 'mem.db'));
    assert.equal(hasVectorCache(db), false, 'fresh db with no table -> false');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema v5: hasVectorCache / set / get / count cycle', { skip: !Database }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-embed-cache-'));
  try {
    const db = new Database(join(dir, 'mem.db'));
    // Apply migration 005 inline (kept short; full DDL lives in 005-vector-cache.js).
    db.exec(
      'CREATE TABLE memory_entry_vectors (' +
        'memory_id INTEGER NOT NULL,' +
        'model_id TEXT NOT NULL,' +
        'embedding BLOB NOT NULL,' +
        "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))," +
        'PRIMARY KEY (memory_id, model_id))'
    );

    assert.equal(hasVectorCache(db), true);
    assert.equal(countCachedVectors(db), 0);

    const vec = [0.1, 0.2, -0.3, 0.4];
    assert.equal(setCachedVector(db, 42, 'mock-model', vec), true);
    assert.equal(countCachedVectors(db), 1);
    assert.equal(countCachedVectors(db, 'mock-model'), 1);
    assert.equal(countCachedVectors(db, 'other-model'), 0);

    const out = getCachedVector(db, 42, 'mock-model');
    assert.equal(out.length, vec.length);
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(out[i] - vec[i]) < 1e-3);
    }

    assert.equal(getCachedVector(db, 42, 'unknown'), null);
    assert.equal(getCachedVector(db, 999, 'mock-model'), null);

    // INSERT OR REPLACE on model-bump: no duplicate row, replaced value.
    setCachedVector(db, 42, 'mock-model', [9.0, 9.0, 9.0, 9.0]);
    assert.equal(countCachedVectors(db), 1, 'replacement does not duplicate');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema v5: setCachedVector is a no-op when the table is missing', { skip: !Database }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-embed-cache-'));
  try {
    const db = new Database(join(dir, 'mem.db'));
    // No migration applied.
    assert.equal(setCachedVector(db, 1, 'm', [1, 2, 3, 4]), false);
    assert.equal(getCachedVector(db, 1, 'm'), null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
