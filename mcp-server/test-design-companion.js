#!/usr/bin/env node
/**
 * IJFW design companion tests.
 * Tests: GET /design placeholder, GET /design serves newest html with live reload,
 *        GET /design/files support, GET /design/stream SSE connect,
 *        ijfw design start, push, clear.
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
    assert.ok(text.includes('__ijfwDesignLiveReload'), 'placeholder must include live reload hook');
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
    assert.ok(text.includes('__ijfwDesignLiveReload'), 'served design must include live reload hook');
  } finally {
    server.close();
    rmSync(CONTENT_DIR, { recursive: true, force: true });
  }
});

// 3. GET /design/stream responds with SSE headers and connected comment
test('GET /design/files serves pushed support files', async () => {
  mkdirSync(CONTENT_DIR, { recursive: true });
  writeFileSync(join(CONTENT_DIR, 'option-a.html'), '<html><body>option-a</body></html>', 'utf8');

  const { port, server } = await startServer({ port: BASE_PORT + 2 });
  try {
    const res  = await fetchOk(`http://localhost:${port}/design/files/option-a.html`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('option-a'), 'should serve requested support file');
    assert.ok(text.includes('__ijfwDesignLiveReload'), 'support file must include live reload hook');
  } finally {
    server.close();
    rmSync(CONTENT_DIR, { recursive: true, force: true });
  }
});

// 4. GET /design/stream responds with SSE headers and connected comment
test('GET /design/stream returns SSE headers', async () => {
  mkdirSync(CONTENT_DIR, { recursive: true });
  const { port, server } = await startServer({ port: BASE_PORT + 3 });
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

// 5. ijfw design start exposes /design through the dashboard server.
test('ijfw design start launches live companion URL', async () => {
  const ijfwBin = resolve(__dirname, '..', 'installer', 'src', 'ijfw.js');
  const start = spawnSync(process.execPath, [ijfwBin, 'design', 'start', '--no-open'], { encoding: 'utf8' });
  assert.equal(start.status, 0, 'design start should exit 0');
  assert.match(start.stdout, /Design companion running at http:\/\/localhost:\d+\/design/);

  const portMatch = start.stdout.match(/localhost:(\d+)\/design/);
  assert.ok(portMatch, 'start output should include design URL');
  const res = await fetchOk(`http://localhost:${portMatch[1]}/design`);
  assert.equal(res.status, 200);

  const stop = spawnSync(process.execPath, [ijfwBin, 'design', 'stop'], { encoding: 'utf8' });
  assert.equal(stop.status, 0, 'design stop should exit 0');
});

// 6. ijfw design push copies one or more files to content dir
test('ijfw design push copies html files to content dir', async () => {
  const srcFile = join(TEST_HOME, 'mydesign.html');
  const srcFile2 = join(TEST_HOME, 'option-b.html');
  writeFileSync(srcFile, '<html><body>pushed</body></html>', 'utf8');
  writeFileSync(srcFile2, '<html><body>pushed-b</body></html>', 'utf8');

  const ijfwBin = resolve(__dirname, '..', 'installer', 'src', 'ijfw.js');
  const r = spawnSync(process.execPath, [ijfwBin, 'design', 'push', srcFile, srcFile2], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'push should exit 0');

  const dest = join(TEST_HOME, '.ijfw', 'design-companion', 'content', 'mydesign.html');
  const dest2 = join(TEST_HOME, '.ijfw', 'design-companion', 'content', 'option-b.html');
  const { existsSync, readFileSync } = await import('node:fs');
  assert.ok(existsSync(dest), 'file must exist in content dir');
  assert.ok(existsSync(dest2), 'second file must exist in content dir');
  assert.ok(readFileSync(dest, 'utf8').includes('pushed'));
  assert.ok(readFileSync(dest2, 'utf8').includes('pushed-b'));
});

// 7. ijfw design push only accepts standalone HTML
test('ijfw design push rejects non-html files', async () => {
  const srcFile = join(TEST_HOME, 'not-html.txt');
  writeFileSync(srcFile, 'plain text', 'utf8');

  const ijfwBin = resolve(__dirname, '..', 'installer', 'src', 'ijfw.js');
  const r = spawnSync(process.execPath, [ijfwBin, 'design', 'push', srcFile], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'non-html push should exit non-zero');
  assert.match(r.stderr, /standalone \.html/);
});

// 8. ijfw design clear removes all files from content dir
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
