// v1.5.0 audit MED #9 -- bounded LRU eviction on gate-receipts/.
// Validates that evictOldReceipts keeps newest N files, appends older
// ones to .archive.jsonl, and never throws on bad inputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evictOldReceipts, RECEIPTS_ARCHIVE } from './src/gate-result.js';

function makeReceiptsDir(count) {
  const dir = mkdtempSync(join(tmpdir(), 'ijfw-receipts-evict-'));
  for (let i = 0; i < count; i++) {
    const path = join(dir, `gate-${String(i).padStart(4, '0')}.json`);
    writeFileSync(path, JSON.stringify({ idx: i, gate: 'test', status: 'pass' }, null, 2) + '\n');
    // Stamp mtime so newest is largest idx; use 1s spacing so sort is deterministic.
    const t = (1_700_000_000 + i) * 1000;
    utimesSync(path, t / 1000, t / 1000);
  }
  return dir;
}

test('evictOldReceipts: under-cap is a no-op', async () => {
  const dir = makeReceiptsDir(5);
  try {
    const r = await evictOldReceipts(dir, { keep: 10 });
    assert.equal(r.evicted, 0);
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 5);
    assert.equal(existsSync(join(dir, RECEIPTS_ARCHIVE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evictOldReceipts: at-cap is a no-op (boundary case)', async () => {
  const dir = makeReceiptsDir(10);
  try {
    const r = await evictOldReceipts(dir, { keep: 10 });
    assert.equal(r.evicted, 0);
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evictOldReceipts: over-cap moves oldest to .archive.jsonl', async () => {
  const dir = makeReceiptsDir(15);
  try {
    const r = await evictOldReceipts(dir, { keep: 10 });
    assert.equal(r.evicted, 5, 'evicted = total - keep');
    const remaining = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 10);

    // Newest 10 (indices 5..14) should remain.
    const remainingIdx = remaining
      .map((f) => parseInt(f.match(/(\d+)/)[1], 10))
      .sort((a, b) => a - b);
    assert.deepEqual(remainingIdx, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);

    // Archive holds the 5 oldest as JSONL.
    const archivePath = join(dir, RECEIPTS_ARCHIVE);
    assert.ok(existsSync(archivePath), '.archive.jsonl created');
    const lines = readFileSync(archivePath, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 5);
    const archivedIdx = lines.map((l) => JSON.parse(l).idx).sort((a, b) => a - b);
    assert.deepEqual(archivedIdx, [0, 1, 2, 3, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evictOldReceipts: subsequent eviction round appends, not overwrites', async () => {
  const dir = makeReceiptsDir(15);
  try {
    await evictOldReceipts(dir, { keep: 10 });
    // Add 5 more older receipts (in real life new gate runs are newer, but
    // testing the append-not-overwrite property is what matters here).
    for (let i = 100; i < 105; i++) {
      const p = join(dir, `gate-old-${i}.json`);
      writeFileSync(p, JSON.stringify({ idx: i, second_round: true }) + '\n');
      const t = (1_690_000_000 + i) * 1000; // older than the first batch
      utimesSync(p, t / 1000, t / 1000);
    }
    const r = await evictOldReceipts(dir, { keep: 10 });
    assert.equal(r.evicted, 5, 'second round evicts the new older entries');
    const archivePath = join(dir, RECEIPTS_ARCHIVE);
    const lines = readFileSync(archivePath, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 10, 'archive accumulates across rounds');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evictOldReceipts: nonexistent dir returns evicted=0 without throwing', async () => {
  const r = await evictOldReceipts('/nonexistent/path/that/should-not-exist-ever');
  assert.equal(r.evicted, 0);
});
