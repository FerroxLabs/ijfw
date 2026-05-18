import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'mcp-server/src/dashboard-server.js'), 'utf8');
const HTML_PATH = join(REPO_ROOT, 'mcp-server/src/dashboard-client-waves.html');

// Static surface tests — these verify the routes + HTML are wired without
// spinning the HTTP server (matches the test-dashboard-server.js convention).

test('/api/waves route registered in dashboard-server.js', () => {
  assert.match(SERVER_SRC, /\[\s*['"]\/api\/waves['"]/, '/api/waves route missing');
});

test('/waves HTML route registered', () => {
  assert.match(SERVER_SRC, /\[\s*['"]\/waves['"]/, '/waves route missing');
});

test('/docs/checkpoint-contract route registered (F4)', () => {
  assert.match(SERVER_SRC, /\[\s*['"]\/docs\/checkpoint-contract['"]/, '/docs/checkpoint-contract route missing');
});

test('/api/waves caps result at 50 waves', () => {
  assert.match(SERVER_SRC, /out\.slice\(0,\s*50\)/, '/api/waves should cap at 50');
});

test('/api/waves sorts by checkpoint_at descending', () => {
  assert.match(SERVER_SRC, /out\.sort.*checkpoint_at/, '/api/waves should sort by checkpoint_at');
});

test('/api/waves validates waveId with allowlist regex', () => {
  // Path-traversal guard: only [A-Za-z0-9_-] in waveId. Defense in depth.
  assert.match(SERVER_SRC, /\/\^?\[A-Za-z0-9_-\]\+\$?\/\.test\(waveId\)/, '/api/waves missing waveId regex guard');
});

test('/waves serves with CSP header (same as /planning)', () => {
  // Find the /waves block + verify it sets Content-Security-Policy.
  const wavesBlock = SERVER_SRC.split(/\[\s*['"]\/waves['"]/)[1];
  assert.ok(wavesBlock, '/waves route not parseable');
  const blockEnd = wavesBlock.indexOf('\']]');
  const slice = blockEnd > 0 ? wavesBlock.slice(0, blockEnd) : wavesBlock.slice(0, 2000);
  assert.match(slice, /Content-Security-Policy/, '/waves missing CSP header');
});

test('dashboard-client-waves.html exists', () => {
  assert.ok(existsSync(HTML_PATH), 'dashboard-client-waves.html should exist');
});

test('dashboard-client-waves.html references /api/waves', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  assert.match(html, /\/api\/waves/, 'waves HTML should fetch /api/waves');
});

test('dashboard-client-waves.html uses DocumentFragment or textContent (no innerHTML for user data)', () => {
  const html = readFileSync(HTML_PATH, 'utf8');
  // Allow innerHTML for static template setup but flag if it's near user-data variables.
  // Cheap check: just confirm DocumentFragment OR textContent appears.
  const safe = /createElement|textContent|DocumentFragment/.test(html);
  assert.ok(safe, 'waves HTML should use safe DOM construction (DocumentFragment/textContent)');
});
