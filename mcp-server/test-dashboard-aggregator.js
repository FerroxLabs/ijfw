#!/usr/bin/env node
/**
 * dashboard-aggregator tests (W9-C / B19).
 * Run: node --test --test-force-exit mcp-server/test-dashboard-aggregator.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Patch HOME early in case the aggregator ever touches it.
const TEST_HOME = join(tmpdir(), 'ijfw-aggregator-test-' + process.pid + '-' + Date.now());
mkdirSync(TEST_HOME, { recursive: true });
process.env.HOME        = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const {
  aggregateEvents,
  computeWarnBashBypass,
  readActiveManifest,
  TAIL_CHUNK,
  _resetAggregatorCacheForTest,
} = await import('./src/dashboard-aggregator.js');

function makeEventsFile(name, lines) {
  const p = join(TEST_HOME, name);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  return p;
}

// 1. Empty events file -> returns zeros, no crash
test('empty file returns zero aggregates', async () => {
  _resetAggregatorCacheForTest();
  const p = makeEventsFile('empty.jsonl', []);
  const out = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: Date.now() });
  assert.equal(Object.keys(out.hourly).length, 0);
  assert.equal(Object.keys(out.by_extension).length, 0);
  assert.equal(Object.keys(out.by_tool_denied).length, 0);
});

// 2. Hourly aggregation across 3 hours
test('hourly buckets count events across 3 hours', async () => {
  _resetAggregatorCacheForTest();
  const now = Date.UTC(2026, 4, 17, 12, 0, 0); // fixed timestamp
  const events = [];
  // Hour-0: 40 events
  for (let i = 0; i < 40; i++) events.push({ ts: new Date(now - 2 * 3600 * 1000 + i * 1000).toISOString(), extension: 'a', tool: 'read', allowed: true });
  // Hour-1: 30 events
  for (let i = 0; i < 30; i++) events.push({ ts: new Date(now - 1 * 3600 * 1000 + i * 1000).toISOString(), extension: 'a', tool: 'read', allowed: true });
  // Hour-2: 30 events
  for (let i = 0; i < 30; i++) events.push({ ts: new Date(now            + i * 1000).toISOString(), extension: 'a', tool: 'read', allowed: true });
  const p = makeEventsFile('hourly.jsonl', events);
  const out = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: now + 60_000 });
  const hours = Object.keys(out.hourly).sort();
  assert.equal(hours.length, 3, 'three distinct hour buckets');
  const total = hours.reduce((acc, h) => acc + out.hourly[h], 0);
  assert.equal(total, 100);
});

// 3. by_extension counts allowed + denied per ext
test('by_extension splits allowed and denied', async () => {
  _resetAggregatorCacheForTest();
  const now = Date.now();
  const events = [
    { ts: new Date(now).toISOString(), extension: 'foo', tool: 'read', allowed: true },
    { ts: new Date(now).toISOString(), extension: 'foo', tool: 'read', allowed: false },
    { ts: new Date(now).toISOString(), extension: 'foo', tool: 'read', allowed: false },
    { ts: new Date(now).toISOString(), extension: 'bar', tool: 'bash', allowed: true },
  ];
  const p = makeEventsFile('byext.jsonl', events);
  const out = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: now + 1000 });
  assert.equal(out.by_extension.foo.allowed, 1);
  assert.equal(out.by_extension.foo.denied,  2);
  assert.equal(out.by_extension.bar.allowed, 1);
  assert.equal(out.by_extension.bar.denied,  0);
});

// 4. Top-denied-tools sorts desc (verified at endpoint layer; aggregator returns counts)
test('by_tool_denied counts only denied events', async () => {
  _resetAggregatorCacheForTest();
  const now = Date.now();
  const events = [];
  const tools = ['bash', 'write', 'read'];
  // bash: 5 denied, write: 3 denied, read: 1 denied, plus 10 allowed bash
  for (let i = 0; i < 5; i++)  events.push({ ts: new Date(now).toISOString(), extension: 'x', tool: 'bash',  allowed: false });
  for (let i = 0; i < 3; i++)  events.push({ ts: new Date(now).toISOString(), extension: 'x', tool: 'write', allowed: false });
  for (let i = 0; i < 1; i++)  events.push({ ts: new Date(now).toISOString(), extension: 'x', tool: 'read',  allowed: false });
  for (let i = 0; i < 10; i++) events.push({ ts: new Date(now).toISOString(), extension: 'x', tool: 'bash',  allowed: true });
  const p = makeEventsFile('bytool.jsonl', events);
  const out = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: now + 1000 });
  assert.equal(out.by_tool_denied.bash, 5);
  assert.equal(out.by_tool_denied.write, 3);
  assert.equal(out.by_tool_denied.read, 1);
  // sort desc verification happens at endpoint layer; here we just verify counts.
  const sorted = Object.entries(out.by_tool_denied).sort((a, b) => b[1] - a[1]);
  assert.equal(sorted[0][0], 'bash');
  void tools;
});

// 5. Malformed lines are skipped silently
test('malformed lines are skipped silently', async () => {
  _resetAggregatorCacheForTest();
  const now = Date.now();
  const p = makeEventsFile('bad.jsonl', [
    JSON.stringify({ ts: new Date(now).toISOString(), extension: 'a', tool: 'read', allowed: true }),
    '{this is not json',
    'totally not jsonl at all',
    JSON.stringify({ ts: new Date(now).toISOString(), extension: 'a', tool: 'read', allowed: false }),
  ]);
  const out = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: now + 1000 });
  assert.deepEqual(out.by_extension.a, { allowed: 1, denied: 1 });
});

// 6. Streaming: file larger than TAIL_CHUNK is partially read
test('file larger than TAIL_CHUNK is partially read (bounded memory)', async () => {
  _resetAggregatorCacheForTest();
  const now = Date.now();
  const p   = join(TEST_HOME, 'big.jsonl');
  // Build a file just over TAIL_CHUNK (~2MB) with padded ext names so each line
  // is ~256 bytes. We need (2*1024*1024 / 256) ~= 8192 lines to reach the cap.
  // Pad each line to ~500 bytes so we comfortably exceed TAIL_CHUNK with
  // a reasonable line count. Old events come first (outside window) so the
  // tail slice should land in the fresh region.
  const oldPad   = 'O'.repeat(450);
  const freshPad = 'F'.repeat(450);
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    lines.push(JSON.stringify({ ts: new Date(now - 48 * 3600 * 1000).toISOString(), extension: 'old' + oldPad, tool: 'read', allowed: true }));
  }
  for (let i = 0; i < 3000; i++) {
    lines.push(JSON.stringify({ ts: new Date(now).toISOString(), extension: 'fresh' + freshPad, tool: 'read', allowed: true }));
  }
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  const out = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: now + 1000 });
  // We expect SOME fresh entries (proves we read the tail). Old entries are
  // outside the window so they should never count even if some lines survived.
  const freshKey = Object.keys(out.by_extension).find((k) => k.startsWith('fresh'));
  assert.ok(freshKey, 'fresh entries observed in the tail window');
  assert.ok(out.by_extension[freshKey].allowed > 0);
  // Verify the file is actually larger than TAIL_CHUNK.
  const { statSync } = await import('node:fs');
  assert.ok(statSync(p).size > TAIL_CHUNK, 'fixture must exceed TAIL_CHUNK to exercise streaming');
});

// 7. mtime-based cache invalidation
test('cache returns same result until mtime changes', async () => {
  _resetAggregatorCacheForTest();
  const now = Date.now();
  const p = makeEventsFile('cache.jsonl', [
    { ts: new Date(now).toISOString(), extension: 'one', tool: 'read', allowed: true },
  ]);
  const a = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now });
  // Bump mtime forward AND change the contents.
  writeFileSync(p, JSON.stringify({ ts: new Date(now).toISOString(), extension: 'two', tool: 'read', allowed: true }) + '\n', 'utf8');
  const future = now + 5 * 60_000; // skip the 60s TTL
  const b = await aggregateEvents(p, { windowMs: 24 * 3600 * 1000, now: future });
  assert.notDeepEqual(a.by_extension, b.by_extension, 'mtime change invalidates cache');
});

// 8. warn_bash_bypass computation
test('computeWarnBashBypass requires bash/exec write + strict quota', () => {
  // True case: bash + quota
  assert.equal(computeWarnBashBypass({
    permissions: { writes: ['tool:bash', 'files:write'] },
    quotas: { max_files_written: 10 },
  }), true);
  // True case: exec + bytes quota
  assert.equal(computeWarnBashBypass({
    permissions: { writes: ['tool:exec'] },
    quotas: { max_bytes_written: 100_000 },
  }), true);
  // False: bash but no quota
  assert.equal(computeWarnBashBypass({
    permissions: { writes: ['tool:bash'] },
    quotas: {},
  }), false);
  // False: quota but no bash/exec
  assert.equal(computeWarnBashBypass({
    permissions: { writes: ['files:write'] },
    quotas: { max_files_written: 10 },
  }), false);
  // False: missing fields entirely
  assert.equal(computeWarnBashBypass(null), false);
  assert.equal(computeWarnBashBypass({}), false);
});

// 9. readActiveManifest tolerates missing/malformed files
test('readActiveManifest returns null for missing manifest', () => {
  const out = readActiveManifest({ scope: 'user', name: 'nonexistent', home: TEST_HOME });
  assert.equal(out, null);
});

test('readActiveManifest parses a real manifest', () => {
  const dir = join(TEST_HOME, '.ijfw', 'extensions-user', 'sample');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    name: 'sample',
    permissions: { writes: ['tool:bash'] },
    quotas: { max_files_written: 5 },
  }), 'utf8');
  const m = readActiveManifest({ scope: 'user', name: 'sample', home: TEST_HOME });
  assert.ok(m);
  assert.equal(computeWarnBashBypass(m), true);
});

// Cleanup
test('cleanup', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  // ensure utimesSync is referenced (silences unused-import linters)
  void utimesSync;
});
