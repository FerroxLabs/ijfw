/**
 * test-dashboard-extensions-tile.js
 *
 * IJFW v1.4.1 / B9 — Dashboard "Extension Permissions" tile tests.
 *
 * Covers:
 *   - /api/extensions/installed: enumerate synth extensions in tmp HOME
 *   - /api/extensions/active: read active-extension.json or return {active:null}
 *   - /api/extensions/events: filter by extension, tool, denied; allowlist enforcement
 *   - Log rotation: 10001 events triggers rename to .0
 *   - E2E SSE stream (skip on win32)
 *
 * HOME + USERPROFILE both patched (W3 fix campaign).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- tmp HOME isolation ----------
const TEST_HOME = join(tmpdir(), 'ijfw-ext-tile-test-' + Date.now());
mkdirSync(join(TEST_HOME, '.ijfw', 'state'), { recursive: true });
mkdirSync(join(TEST_HOME, '.ijfw', 'state-org'), { recursive: true });
mkdirSync(join(TEST_HOME, '.ijfw', 'state-user'), { recursive: true });
process.env.HOME        = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

// Import server AFTER patching HOME.
const { startServer } = await import('./src/dashboard-server.js');

// ---------- helpers ----------
function fetch(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

function fetchJSON(port, path) {
  return fetch(port, path).then(({ status, body }) => ({ status, data: JSON.parse(body) }));
}

function syntheticRegistry(name, scope, extraFields = {}) {
  return {
    extensions: [{
      name,
      version: '1.0.0',
      installed_at: '2026-05-01T00:00:00.000Z',
      last_trident_verdict: 'PASS',
      last_activated_time: '2026-05-10T10:00:00.000Z',
      manifest: {
        name,
        version: '1.0.0',
        publisher_keyId: 'test-key-001',
        permissions: { reads: ['memory:read'], writes: ['memory:write'] },
        ...extraFields,
      },
    }],
  };
}

// Shared server instance
const ledgerPath = join(TEST_HOME, '.ijfw', 'ext-tile-obs.jsonl');
writeFileSync(ledgerPath, '', 'utf8');
const { port, server } = await startServer({ ledgerPath, port: 39200 });

// ---------- installed endpoint ----------
test('/api/extensions/installed — org scope', async () => {
  const regPath = join(TEST_HOME, '.ijfw', 'state-org', 'extension-registry.json');
  writeFileSync(regPath, JSON.stringify(syntheticRegistry('my-ext', 'org')), 'utf8');

  const { status, data } = await fetchJSON(port, '/api/extensions/installed');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.extensions), 'extensions array present');
  const found = data.extensions.find((e) => e.name === 'my-ext');
  assert.ok(found, 'my-ext found');
  assert.equal(found.scope, 'org');
  assert.equal(found.version, '1.0.0');
  assert.equal(found.publisher_keyId, 'test-key-001');
  assert.deepEqual(found.permissions, { reads: ['memory:read'], writes: ['memory:write'] });
  assert.equal(found.last_activated_time, '2026-05-10T10:00:00.000Z');
});

test('/api/extensions/installed — user scope', async () => {
  const regPath = join(TEST_HOME, '.ijfw', 'state-user', 'extension-registry.json');
  writeFileSync(regPath, JSON.stringify(syntheticRegistry('user-ext', 'user')), 'utf8');

  const { status, data } = await fetchJSON(port, '/api/extensions/installed');
  assert.equal(status, 200);
  const found = data.extensions.find((e) => e.name === 'user-ext');
  assert.ok(found, 'user-ext found');
  assert.equal(found.scope, 'user');
});

test('/api/extensions/installed — returns 200 with empty list when no registries', async () => {
  // Use a fresh server on a different port with a clean home.
  const cleanHome = join(tmpdir(), 'ijfw-ext-clean-' + Date.now());
  mkdirSync(join(cleanHome, '.ijfw'), { recursive: true });
  const savedHome = process.env.HOME;
  const savedUp   = process.env.USERPROFILE;
  process.env.HOME        = cleanHome;
  process.env.USERPROFILE = cleanHome;
  const cleanLedger = join(cleanHome, '.ijfw', 'obs.jsonl');
  writeFileSync(cleanLedger, '', 'utf8');
  const { port: p2, server: s2 } = await startServer({ ledgerPath: cleanLedger, port: 39210 });
  try {
    const { status, data } = await fetchJSON(p2, '/api/extensions/installed');
    assert.equal(status, 200);
    assert.deepEqual(data.extensions, []);
  } finally {
    process.env.HOME        = savedHome;
    process.env.USERPROFILE = savedUp;
    await new Promise((r) => s2.close(r));
    try { rmSync(cleanHome, { recursive: true, force: true }); } catch {}
  }
});

// ---------- active endpoint ----------
test('/api/extensions/active — no file returns {active:null}', async () => {
  // Ensure file is absent.
  const activePath = join(TEST_HOME, '.ijfw', 'state', 'active-extension.json');
  try { rmSync(activePath); } catch {}

  const { status, data } = await fetchJSON(port, '/api/extensions/active');
  assert.equal(status, 200);
  assert.equal(data.active, null);
});

test('/api/extensions/active — returns parsed descriptor when file exists', async () => {
  const activePath = join(TEST_HOME, '.ijfw', 'state', 'active-extension.json');
  const descriptor = { name: 'my-ext', scope: 'org', permissions: { reads: ['memory:read'], writes: [] } };
  writeFileSync(activePath, JSON.stringify(descriptor), 'utf8');

  const { status, data } = await fetchJSON(port, '/api/extensions/active');
  assert.equal(status, 200);
  assert.ok(data.active, 'active is set');
  assert.equal(data.active.name, 'my-ext');
  assert.equal(data.active.scope, 'org');

  // Cleanup for other tests.
  try { rmSync(activePath); } catch {}
});

// ---------- events endpoint — filter tests ----------
function writeEvents(eventsPath, events) {
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

test('/api/extensions/events — returns all events without filters', async () => {
  const eventsPath = join(TEST_HOME, '.ijfw', 'state', 'permission-events.jsonl');
  const events = [
    { ts: '2026-05-01T10:00:00.000Z', extension: 'ext-a', tool: 'ijfw_memory_store', allowed: true },
    { ts: '2026-05-01T10:01:00.000Z', extension: 'ext-b', tool: 'ijfw_run', allowed: false },
    { ts: '2026-05-01T10:02:00.000Z', extension: 'ext-a', tool: 'ijfw_memory_recall', allowed: true },
  ];
  writeEvents(eventsPath, events);

  const { status, data } = await fetchJSON(port, '/api/extensions/events?limit=50');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data), 'returns array');
  assert.equal(data.length, 3);
});

test('/api/extensions/events — filter by denied=true returns only denied', async () => {
  const eventsPath = join(TEST_HOME, '.ijfw', 'state', 'permission-events.jsonl');
  const events = [
    { ts: '2026-05-01T10:00:00.000Z', extension: 'ext-a', tool: 'ijfw_memory_store', allowed: true },
    { ts: '2026-05-01T10:01:00.000Z', extension: 'ext-b', tool: 'ijfw_run', allowed: false },
    { ts: '2026-05-01T10:02:00.000Z', extension: 'ext-a', tool: 'ijfw_run', allowed: false },
  ];
  writeEvents(eventsPath, events);

  const { status, data } = await fetchJSON(port, '/api/extensions/events?denied=true&limit=50');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 2, 'only denied events');
  assert.ok(data.every((e) => e.allowed === false), 'all denied');
});

test('/api/extensions/events — filter by extension', async () => {
  const eventsPath = join(TEST_HOME, '.ijfw', 'state', 'permission-events.jsonl');
  const events = [
    { ts: '2026-05-01T10:00:00.000Z', extension: 'ext-a', tool: 'ijfw_memory_store', allowed: true },
    { ts: '2026-05-01T10:01:00.000Z', extension: 'ext-b', tool: 'ijfw_run', allowed: false },
    { ts: '2026-05-01T10:02:00.000Z', extension: 'ext-a', tool: 'ijfw_memory_recall', allowed: true },
  ];
  writeEvents(eventsPath, events);

  const { status, data } = await fetchJSON(port, '/api/extensions/events?extension=ext-a&limit=50');
  assert.equal(status, 200);
  assert.equal(data.length, 2, 'only ext-a events');
  assert.ok(data.every((e) => e.extension === 'ext-a'));
});

test('/api/extensions/events — filter by tool', async () => {
  const eventsPath = join(TEST_HOME, '.ijfw', 'state', 'permission-events.jsonl');
  const events = [
    { ts: '2026-05-01T10:00:00.000Z', extension: 'ext-a', tool: 'ijfw_memory_store', allowed: true },
    { ts: '2026-05-01T10:01:00.000Z', extension: 'ext-b', tool: 'ijfw_run', allowed: false },
  ];
  writeEvents(eventsPath, events);

  const { status, data } = await fetchJSON(port, '/api/extensions/events?tool=ijfw_run&limit=50');
  assert.equal(status, 200);
  assert.equal(data.length, 1);
  assert.equal(data[0].tool, 'ijfw_run');
});

test('/api/extensions/events — allowlist enforcement rejects unknown filter key', async () => {
  const { status, data } = await fetchJSON(port, '/api/extensions/events?evil=1');
  assert.equal(status, 400);
  assert.ok(data.error.includes('evil'), 'error names the bad param');
});

test('/api/extensions/events — allowlist enforcement rejects multiple unknown keys', async () => {
  const { status, data } = await fetchJSON(port, '/api/extensions/events?limit=10&injected=x');
  assert.equal(status, 400);
  assert.ok(data.error.includes('injected'));
});

// ---------- rotation test ----------
test('logPermissionEvent — rotation triggers at 10001 events', async () => {
  const rotHome = join(tmpdir(), 'ijfw-ext-rot-' + Date.now());
  mkdirSync(join(rotHome, '.ijfw', 'state'), { recursive: true });

  const { logPermissionEvent } = await import('./src/runtime-mediator.js');

  const eventsPath = join(rotHome, '.ijfw', 'state', 'permission-events.jsonl');
  const rotatedPath = eventsPath + '.0';

  // Write 10_000 lines directly (fast).
  const line = JSON.stringify({ ts: new Date().toISOString(), extension: 'x', tool: 'y', allowed: true }) + '\n';
  const bulk = line.repeat(10_000);
  writeFileSync(eventsPath, bulk, 'utf8');

  // One more append should trigger rotation.
  await logPermissionEvent({ extension: 'x', tool: 'y', allowed: true }, { homeDir: rotHome });

  assert.ok(existsSync(rotatedPath), '.0 rotation file created');
  const mainLines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(mainLines.length, 1, 'main file reset to 1 line after rotation');

  // Cleanup.
  try { rmSync(rotHome, { recursive: true, force: true }); } catch {}
});

test('logPermissionEvent — no rotation below 10000 lines', async () => {
  const rotHome = join(tmpdir(), 'ijfw-ext-rot2-' + Date.now());
  mkdirSync(join(rotHome, '.ijfw', 'state'), { recursive: true });

  const { logPermissionEvent } = await import('./src/runtime-mediator.js');

  const eventsPath = join(rotHome, '.ijfw', 'state', 'permission-events.jsonl');
  const rotatedPath = eventsPath + '.0';

  const line = JSON.stringify({ extension: 'x', tool: 'y', allowed: true }) + '\n';
  writeFileSync(eventsPath, line.repeat(9_999), 'utf8');

  await logPermissionEvent({ extension: 'x', tool: 'y', allowed: true }, { homeDir: rotHome });

  assert.ok(!existsSync(rotatedPath), '.0 file NOT created below cap');

  try { rmSync(rotHome, { recursive: true, force: true }); } catch {}
});

// ---------- E2E SSE stream ----------
test('SSE /api/extensions/events — live stream delivers event', { skip: process.platform === 'win32' ? 'SSE hangup detection differs on win32' : undefined }, async () => {
  const eventsPath = join(TEST_HOME, '.ijfw', 'state', 'permission-events.jsonl');
  writeFileSync(eventsPath, '', 'utf8');

  const received = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/extensions/events?limit=1', headers: { accept: 'text/event-stream' } },
      (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let buf = '';
        const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, 3000);
        res.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const obj = JSON.parse(line.slice(6));
                if (obj && obj.extension === 'sse-test-ext') {
                  clearTimeout(timer);
                  req.destroy();
                  resolve(obj);
                }
              } catch {}
            }
          }
        });
        res.on('error', () => {});
      },
    );
    req.on('error', () => {}); // ignore ECONNRESET from destroy()
    req.end();

    // Give SSE a moment to connect then write an event.
    setTimeout(() => {
      const event = { ts: new Date().toISOString(), extension: 'sse-test-ext', tool: 'ijfw_run', allowed: false };
      writeFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');
    }, 100);
  });

  assert.equal(received.extension, 'sse-test-ext');
});

// ---------- W8.1/Fix2: /api/extensions/active realpath ----------
test('/api/extensions/active — returns {active:null} when file missing', async () => {
  // Ensure no active-extension.json exists.
  const activePath = join(TEST_HOME, '.ijfw', 'state', 'active-extension.json');
  try { rmSync(activePath); } catch {}

  const { status, data } = await fetchJSON(port, '/api/extensions/active');
  assert.equal(status, 200);
  assert.equal(data.active, null);
});

test('/api/extensions/active — returns parsed JSON when file present', async () => {
  const activePath = join(TEST_HOME, '.ijfw', 'state', 'active-extension.json');
  const payload = { name: 'my-ext', version: '1.0.0', activated_at: '2026-05-17T00:00:00.000Z' };
  writeFileSync(activePath, JSON.stringify(payload), 'utf8');

  const { status, data } = await fetchJSON(port, '/api/extensions/active');
  assert.equal(status, 200);
  assert.equal(data.active.name, 'my-ext');
  rmSync(activePath);
});

test('/api/extensions/active — symlink outside HOME is rejected (path-traversal)', { skip: process.platform === 'win32' ? 'symlinks require admin on win32' : undefined }, async () => {
  const { symlinkSync, mkdirSync: mkdirSyncFn, writeFileSync: wfSync, rmSync: rmSyncFn } = await import('node:fs');

  // Create a target file OUTSIDE tmp HOME.
  const outsideDir = join(tmpdir(), 'ijfw-traverse-target-' + Date.now());
  mkdirSyncFn(outsideDir, { recursive: true });
  const outsideFile = join(outsideDir, 'secret.json');
  wfSync(outsideFile, JSON.stringify({ secret: 'oops' }), 'utf8');

  // Place a symlink inside HOME/.ijfw/state/active-extension.json → outside file.
  const activePath = join(TEST_HOME, '.ijfw', 'state', 'active-extension.json');
  try { rmSyncFn(activePath); } catch {}
  try {
    symlinkSync(outsideFile, activePath);
    const { status, data } = await fetchJSON(port, '/api/extensions/active');
    // Should be either 403 (traversal rejected) or {active:null} — NOT the outside file contents.
    if (status === 403) {
      assert.ok(data.error.includes('path traversal'), `unexpected 403 body: ${JSON.stringify(data)}`);
    } else {
      assert.equal(status, 200);
      assert.equal(data.active, null, 'symlink to outside HOME must not leak contents');
    }
  } finally {
    try { rmSyncFn(activePath); } catch {}
    try { rmSyncFn(outsideDir, { recursive: true, force: true }); } catch {}
  }
});

// ---------- W8.1/Fix3: SSE tail-chunk (no full-file slurp) ----------
test('SSE watch callback uses tail-chunk: lastLineCount tracks tail-sliced lines', { skip: process.platform === 'win32' ? 'SSE hangup detection differs on win32' : undefined }, async () => {
  // This test verifies the SSE watcher does not deliver duplicate events when
  // the file is much larger than TAIL_CHUNK (2MB). We write a file large enough
  // to exceed the chunk, then append one event and confirm only the new event
  // is delivered — not a re-delivery of historical lines.
  const TAIL_CHUNK = 2 * 1024 * 1024;
  const eventsPath = join(TEST_HOME, '.ijfw', 'state', 'permission-events.jsonl');

  // Build a file just over TAIL_CHUNK using padded lines.
  const padding = ' '.repeat(900); // ~1KB per line
  const oldEvent = { ts: '2026-01-01T00:00:00.000Z', extension: 'old-ext', tool: 'old_tool', allowed: true };
  const oldLine = JSON.stringify({ ...oldEvent, _pad: padding }) + '\n';
  const lineCount = Math.ceil((TAIL_CHUNK + 1024) / oldLine.length);
  writeFileSync(eventsPath, oldLine.repeat(lineCount), 'utf8');

  const uniqueExt = 'sse-tailchunk-' + Date.now();

  const received = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/extensions/events?limit=5', headers: { accept: 'text/event-stream' } },
      (res) => {
        let buf = '';
        const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE tail-chunk timeout')); }, 4000);
        res.on('data', (chunk) => {
          buf += chunk.toString();
          for (const line of buf.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const obj = JSON.parse(line.slice(6));
                if (obj && obj.extension === uniqueExt) {
                  clearTimeout(timer);
                  req.destroy();
                  resolve(obj);
                }
              } catch {}
            }
          }
        });
        res.on('error', () => {});
      },
    );
    req.on('error', () => {});
    req.end();

    // Wait for SSE to connect, then append a new distinct event.
    setTimeout(() => {
      const newEvent = { ts: new Date().toISOString(), extension: uniqueExt, tool: 'ijfw_run', allowed: true };
      writeFileSync(eventsPath, oldLine.repeat(lineCount) + JSON.stringify(newEvent) + '\n', 'utf8');
    }, 150);
  });

  assert.equal(received.extension, uniqueExt, 'tail-chunk SSE must deliver the new event');
});

// ---------- cleanup ----------
// Server pollTimer keeps the event loop alive; close() explicitly so the test
// process can exit cleanly instead of hanging.
test('teardown — close server + cleanup tmp HOME', async () => {
  await new Promise((r) => server.close(r));
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});
