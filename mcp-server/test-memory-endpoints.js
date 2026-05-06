#!/usr/bin/env node
/**
 * Tests: /api/memory, /api/memory/search, /api/memory/recall-stats, /api/memory/file
 * Run: node mcp-server/test-memory-endpoints.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixture memory under fake HOME
const FAKE_HOME = join(tmpdir(), 'ijfw-ep-test-' + Date.now());
const MEM_DIR   = join(FAKE_HOME, '.ijfw', 'memory');
mkdirSync(MEM_DIR, { recursive: true });
writeFileSync(join(MEM_DIR, 'test-fact.md'), `---
title: Test Fact
description: A fixture memory file
type: observation
---
# Test Fact
This is a fixture memory entry for endpoint testing.
`);
process.env.HOME = FAKE_HOME;

const { startServer } = await import('./src/dashboard-server.js');
const BASE_PORT = 37960;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 200);
  return res.json();
}

test('GET /api/memory returns file list', async () => {
  const { port, server } = await startServer({ port: BASE_PORT });
  try {
    const d = await fetchJson(`http://localhost:${port}/api/memory`);
    assert.ok(Array.isArray(d.files), 'files should be array');
    assert.ok(typeof d.total === 'number', 'total should be number');
    const f = d.files.find(x => x.title === 'Test Fact');
    assert.ok(f, 'Test Fact should be in file list');
    assert.ok('recall_count' in f, 'recall_count field should exist');
    assert.ok('preview' in f, 'preview field should exist');
  } finally { server.close(); }
});

test('GET /api/memory/search?q= returns results', async () => {
  const { port, server } = await startServer({ port: BASE_PORT + 1 });
  try {
    const d = await fetchJson(`http://localhost:${port}/api/memory/search?q=fixture`);
    assert.ok(Array.isArray(d.results), 'results should be array');
    assert.ok(typeof d.count === 'number', 'count should be number');
    // fixture appears in the test file
    assert.ok(d.results.length > 0, 'should find fixture in test file');
    const r = d.results[0];
    assert.ok('path' in r, 'result should have path');
    assert.ok('snippet' in r, 'result should have snippet');
    assert.ok('score' in r, 'result should have score');
  } finally { server.close(); }
});

test('GET /api/memory/search?q= empty returns empty', async () => {
  const { port, server } = await startServer({ port: BASE_PORT + 2 });
  try {
    const d = await fetchJson(`http://localhost:${port}/api/memory/search?q=xyzzy_never_found`);
    assert.equal(d.count, 0);
    assert.deepEqual(d.results, []);
  } finally { server.close(); }
});

test('GET /api/memory/recall-stats returns shape', async () => {
  const { port, server } = await startServer({ port: BASE_PORT + 3 });
  try {
    const d = await fetchJson(`http://localhost:${port}/api/memory/recall-stats`);
    assert.ok(Array.isArray(d.top_recalled), 'top_recalled should be array');
    assert.ok(typeof d.total_recalls_this_week === 'number', 'total_recalls_this_week should be number');
  } finally { server.close(); }
});

test('GET /api/memory/file denies path outside memory root', async () => {
  const { port, server } = await startServer({ port: BASE_PORT + 4 });
  try {
    const res = await fetch(
      `http://localhost:${port}/api/memory/file?path=/etc/passwd`,
      { signal: AbortSignal.timeout(3000) }
    );
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('GET /api/memory/file returns body for valid path', async () => {
  const { port, server } = await startServer({ port: BASE_PORT + 5 });
  try {
    const list = await fetchJson(`http://localhost:${port}/api/memory`);
    const f    = list.files[0];
    assert.ok(f, 'should have at least one file');
    const d = await fetchJson(`http://localhost:${port}/api/memory/file?path=` + encodeURIComponent(f.path));
    assert.ok(typeof d.body === 'string' && d.body.length > 0, 'body should be non-empty string');
  } finally { server.close(); }
});

test('GET /api/memory/file denies symlink escaping memory root', async () => {
  // Creates a real symlink inside the memory dir pointing OUTSIDE the allowed root.
  // realpathSync resolves the symlink target, which isUnder() then rejects with 403.
  // Note: on Windows this requires Developer Mode or admin privileges -- test will
  // fail loud (EPERM) rather than be skipped, so Windows CI surfaces the gap clearly.
  const { port, server } = await startServer({ port: BASE_PORT + 6 });
  const outsideDir = join(tmpdir(), 'ijfw-ep-outside-' + Date.now());
  const outsideFile = join(outsideDir, 'secret.txt');
  const symlink = join(MEM_DIR, 'escape-link.md');
  try {
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsideFile, 'secret content');
    symlinkSync(outsideFile, symlink);
    const res = await fetch(
      `http://localhost:${port}/api/memory/file?path=` + encodeURIComponent(symlink),
      { signal: AbortSignal.timeout(3000) }
    );
    assert.equal(res.status, 403, 'symlink escaping memory root must be denied');
  } finally {
    server.close();
    try { rmSync(symlink); } catch {}
    try { rmSync(outsideDir, { recursive: true }); } catch {}
  }
});

process.on('exit', () => {
  try { rmSync(FAKE_HOME, { recursive: true }); } catch {}
});
