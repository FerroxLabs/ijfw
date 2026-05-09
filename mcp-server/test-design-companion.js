#!/usr/bin/env node
/**
 * IJFW design companion tests.
 * Tests: GET /design placeholder, GET /design serves newest html,
 *        GET /design/stream SSE connect, ijfw design push, ijfw design clear.
 * Run: node mcp-server/test-design-companion.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Redirect HOME so design-companion dir is isolated
const TEST_HOME = join(tmpdir(), 'ijfw-design-test-' + Date.now());
mkdirSync(join(TEST_HOME, '.ijfw'), { recursive: true });
process.env.HOME        = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const CONTENT_DIR = join(TEST_HOME, '.ijfw', 'design-companion', 'content');

const { startServer } = await import('./src/dashboard-server.js');

const BASE_PORT = 37960;

async function fetchOk(url, ms = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}

// 1. GET /design returns placeholder when content dir is empty
test('GET /design returns placeholder when no files pushed', async () => {
  const { port, server } = await startServer({ port: BASE_PORT });
  try {
    const res  = await fetchOk(`http://localhost:${port}/design`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('ijfw design push'), 'placeholder must mention push command');
  } finally {
    server.close();
  }
});

// 2. GET /design serves the newest .html file
test('GET /design serves newest html file', async () => {
  mkdirSync(CONTENT_DIR, { recursive: true });
  writeFileSync(join(CONTENT_DIR, 'old.html'), '<html><body>old</body></html>', 'utf8');
  // 10ms gap so mtime differs
  await new Promise(r => setTimeout(r, 15));
  writeFileSync(join(CONTENT_DIR, 'new.html'), '<html><body>newest-design</body></html>', 'utf8');

  const { port, server } = await startServer({ port: BASE_PORT + 1 });
  try {
    const res  = await fetchOk(`http://localhost:${port}/design`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('newest-design'), 'should serve newest file content');
  } finally {
    server.close();
    rmSync(CONTENT_DIR, { recursive: true, force: true });
  }
});

// 3. GET /design/stream responds with SSE headers and connected comment
test('GET /design/stream returns SSE headers', async () => {
  mkdirSync(CONTENT_DIR, { recursive: true });
  const { port, server } = await startServer({ port: BASE_PORT + 2 });
  try {
    const ctrl = new AbortController();
    const res  = await fetch(`http://localhost:${port}/design/stream`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').startsWith('text/event-stream'), 'must be SSE');
    // Read first chunk (the ': connected' comment)
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = Buffer.from(value).toString('utf8');
    assert.ok(text.includes(': connected'), 'first chunk must include connected comment');
    ctrl.abort();
  } finally {
    server.close();
    rmSync(CONTENT_DIR, { recursive: true, force: true });
  }
});

// 4. ijfw design push copies file to content dir
test('ijfw design push copies file to content dir', async () => {
  const srcFile = join(TEST_HOME, 'mydesign.html');
  writeFileSync(srcFile, '<html><body>pushed</body></html>', 'utf8');

  const ijfwBin = resolve(__dirname, '..', 'installer', 'src', 'ijfw.js');
  const r = spawnSync(process.execPath, [ijfwBin, 'design', 'push', srcFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'push should exit 0');

  const dest = join(TEST_HOME, '.ijfw', 'design-companion', 'content', 'mydesign.html');
  const { existsSync, readFileSync } = await import('node:fs');
  assert.ok(existsSync(dest), 'file must exist in content dir');
  assert.ok(readFileSync(dest, 'utf8').includes('pushed'));
});

// 5. ijfw design clear removes all files from content dir
test('ijfw design clear empties content dir', async () => {
  const destDir = join(TEST_HOME, '.ijfw', 'design-companion', 'content');
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, 'a.html'), '<html/>', 'utf8');
  writeFileSync(join(destDir, 'b.html'), '<html/>', 'utf8');

  const ijfwBin = resolve(__dirname, '..', 'installer', 'src', 'ijfw.js');
  const r = spawnSync(process.execPath, [ijfwBin, 'design', 'clear'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'clear should exit 0');

  const { readdirSync } = await import('node:fs');
  const remaining = readdirSync(destDir);
  assert.equal(remaining.length, 0, 'content dir must be empty after clear');
});

// Cleanup
test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

console.log('design-companion tests loaded -- running with node --test');
