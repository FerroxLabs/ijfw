/**
 * test-dashboard-planning.js
 *
 * IJFW v1.4.4 / N8 — /api/planning + /planning endpoints.
 *
 * Covers:
 *   - allowed roots (.planning/, .ijfw/memory/, and .ijfw/wave-* subtrees)
 *   - path-traversal rejection (.., absolute paths)
 *   - 404 for missing files
 *   - /planning HTML viewer served
 *
 * Uses IJFW_PROJECT_ROOT override to point REPO_ROOT at a tmpdir per test session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import http from 'node:http';

// ---------- tmp REPO_ROOT isolation ----------
const TEST_ROOT = join(tmpdir(), 'ijfw-planning-test-' + Date.now());
mkdirSync(join(TEST_ROOT, '.planning', '1.4.4'), { recursive: true });
mkdirSync(join(TEST_ROOT, '.ijfw', 'memory'), { recursive: true });
mkdirSync(join(TEST_ROOT, '.ijfw', 'wave-W10-A0'), { recursive: true });

writeFileSync(join(TEST_ROOT, '.planning', '1.4.4', 'HANDOFF.md'), '# Handoff\n\nbody');
writeFileSync(join(TEST_ROOT, '.ijfw', 'memory', 'note.md'), '# Note\n\nhi');
writeFileSync(join(TEST_ROOT, '.ijfw', 'wave-W10-A0', 'STATE.md'), '---\nwave_id: W10-A0\n---\n\nstate body');
writeFileSync(join(TEST_ROOT, '.ijfw', 'wave-W10-A0', 'SUMMARY.md'), '# summary');
// A file that is NOT under any allowed root (should be rejected)
writeFileSync(join(TEST_ROOT, 'secret.md'), 'top secret');

process.env.IJFW_PROJECT_ROOT = TEST_ROOT;
// Patch HOME too so unrelated dashboard endpoints don't crash on missing ~/.ijfw
const TEST_HOME = join(tmpdir(), 'ijfw-planning-home-' + Date.now());
mkdirSync(join(TEST_HOME, '.ijfw'), { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

// Import server AFTER env patching.
const { startServer } = await import('./src/dashboard-server.js');

const { port, server } = await startServer({
  ledgerPath: join(TEST_HOME, '.ijfw', 'observations.jsonl'),
  port: 39220,
});

function fetch(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

function fetchJSON(path) {
  return fetch(path).then(({ status, body }) => {
    let data = null;
    try { data = JSON.parse(body); } catch {}
    return { status, data, raw: body };
  });
}

// ---------- /api/planning ----------

test('/api/planning returns doc under .planning/', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('.planning/1.4.4/HANDOFF.md'));
  assert.equal(r.status, 200);
  assert.match(r.data.body, /# Handoff/);
});

test('/api/planning returns doc under .ijfw/memory/', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('.ijfw/memory/note.md'));
  assert.equal(r.status, 200);
  assert.match(r.data.body, /# Note/);
});

test('/api/planning returns doc under .ijfw/wave-*/STATE.md', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('.ijfw/wave-W10-A0/STATE.md'));
  assert.equal(r.status, 200);
  assert.match(r.data.body, /wave_id: W10-A0/);
});

test('/api/planning rejects ../ path traversal with 400', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('../etc/passwd'));
  assert.equal(r.status, 400);
  assert.ok(r.data.error);
});

test('/api/planning rejects absolute path with 400', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('/etc/passwd'));
  assert.equal(r.status, 400);
});

test('/api/planning rejects path NOT under any allowed root with 403', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('secret.md'));
  assert.equal(r.status, 403);
});

test('/api/planning returns 404 for missing file under allowed root', async () => {
  const r = await fetchJSON('/api/planning?path=' + encodeURIComponent('.planning/missing.md'));
  assert.equal(r.status, 404);
});

test('/api/planning rejects empty path with 400', async () => {
  const r = await fetchJSON('/api/planning?path=');
  assert.equal(r.status, 400);
});

// ---------- /planning viewer ----------

test('/planning returns HTML 200', async () => {
  const r = await fetch('/planning');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'] || '', /text\/html/);
  assert.match(r.body, /<title>IJFW · Planning Docs<\/title>/);
});

// ---------- teardown ----------

test('cleanup: close server', () => {
  server.close();
});
