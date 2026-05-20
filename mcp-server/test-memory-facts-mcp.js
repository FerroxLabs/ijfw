// mcp-server/test-memory-facts-mcp.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openTemporalDbSync, applySchema, storeFactBitemporal,
} from './src/memory/temporal.js';
import { handleMemoryFacts } from './src/memory-facts-handler.js';

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-facts-'));
  const db = openTemporalDbSync(join(dir, 'memory.db'));
  applySchema(db);
  storeFactBitemporal(db, {
    subject: 'v1.5.0', predicate: 'ship_date', object: '2026-05-19',
    confidence: 0.9, source: 'test',
  }, new Date(1700000000000));
  storeFactBitemporal(db, {
    subject: 'v1.5.0', predicate: 'ship_date', object: '2026-05-20',
    confidence: 0.95, source: 'test',
  }, new Date(1700100000000));
  return { db, dir };
}

test('handleMemoryFacts current-only returns latest object', async () => {
  const { db, dir } = seed();
  try {
    const out = await handleMemoryFacts(
      { subject: 'v1.5.0', predicate: 'ship_date' },
      { dbOverride: db },
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].object, '2026-05-20');
    assert.equal(out.rows[0].valid_to, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handleMemoryFacts history=true returns full timeline', async () => {
  const { db, dir } = seed();
  try {
    const out = await handleMemoryFacts(
      { subject: 'v1.5.0', predicate: 'ship_date', history: true },
      { dbOverride: db },
    );
    assert.equal(out.rows.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('handleMemoryFacts valid_at=<midpoint> returns the older row', async () => {
  const { db, dir } = seed();
  try {
    const out = await handleMemoryFacts(
      {
        subject: 'v1.5.0', predicate: 'ship_date',
        valid_at: new Date(1700050000000).toISOString(), // midpoint between the two seeds
      },
      { dbOverride: db },
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].object, '2026-05-19');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
