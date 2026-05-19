#!/usr/bin/env node
/**
 * IJFW design iframe-bridge tests.
 *
 * Covers:
 *   1. hasVercelSandbox() returns false in a clean env (no CLI, no env var)
 *   2. createPreviewSandbox() returns null when bridge is unavailable
 *   3. With a 127.0.0.1 stub provisioner + env var set, createPreviewSandbox()
 *      returns { iframeUrl, sandboxId }
 *   4. design-companion buildMockupViewer renders static srcdoc fallback when
 *      iframeUrl is absent
 *   5. design-companion buildMockupViewer renders <iframe src="..."> when
 *      iframeUrl is present (live path)
 *   6. renderMockupViewerWithBridge() honors the createSandbox seam
 *
 * Run: node --test mcp-server/test-design-iframe.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  hasVercelSandbox,
  createPreviewSandbox,
  destroySandbox,
  __internals,
} from './src/design/iframe-bridge.js';
import {
  buildMockupViewer,
  renderMockupViewerWithBridge,
  escHtml,
} from './src/design-companion.js';

// Snapshot env so we can restore between tests
const ORIGINAL_ENV = process.env[__internals.SANDBOX_URL_ENV];
const ORIGINAL_PATH = process.env.PATH;

function cleanEnv() {
  delete process.env[__internals.SANDBOX_URL_ENV];
  // Force `which vercel` to fail by stripping PATH. Cross-platform: on Windows
  // we also clear PATHEXT to be safe but the empty PATH is enough.
  process.env.PATH = '';
}
function restoreEnv() {
  if (ORIGINAL_ENV === undefined) delete process.env[__internals.SANDBOX_URL_ENV];
  else process.env[__internals.SANDBOX_URL_ENV] = ORIGINAL_ENV;
  process.env.PATH = ORIGINAL_PATH;
}

// ---------- 1. hasVercelSandbox in clean env ----------
test('hasVercelSandbox returns false when no CLI and no env var', () => {
  cleanEnv();
  try {
    assert.equal(hasVercelSandbox(), false);
  } finally {
    restoreEnv();
  }
});

// ---------- 2. createPreviewSandbox returns null when bridge unavailable ----------
test('createPreviewSandbox returns null when bridge unavailable', async () => {
  cleanEnv();
  try {
    const r = await createPreviewSandbox({ html: '<p>hi</p>', name: 'demo' });
    assert.equal(r, null);
  } finally {
    restoreEnv();
  }
});

// ---------- 3. createPreviewSandbox via 127.0.0.1 stub ----------
test('createPreviewSandbox returns iframeUrl when stubbed provisioner responds', async () => {
  // Spin a local HTTP server that mimics the provisioner shape.
  let receivedBody = null;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sandboxes') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          iframeUrl: 'https://example.test/preview/abc123',
          sandboxId: 'stub-abc',
        }));
      });
      return;
    }
    if (req.method === 'DELETE' && req.url.startsWith('/sandboxes/')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stubUrl = `http://127.0.0.1:${port}`;
  process.env[__internals.SANDBOX_URL_ENV] = stubUrl;

  try {
    const r = await createPreviewSandbox({ html: '<p>hi from test</p>', name: 'option-a' });
    assert.ok(r, 'expected a result object');
    assert.equal(r.iframeUrl, 'https://example.test/preview/abc123');
    assert.ok(typeof r.sandboxId === 'string' && r.sandboxId.length > 0, 'sandboxId is non-empty');

    // Request payload should include the html
    const parsed = JSON.parse(receivedBody);
    assert.ok(parsed.html.includes('hi from test'), 'provisioner must receive html');
    assert.equal(parsed.name, 'option-a');

    // destroySandbox is best-effort; should not throw
    await destroySandbox(r.sandboxId);
  } finally {
    server.close();
    restoreEnv();
  }
});

// ---------- 4. buildMockupViewer static fallback ----------
test('buildMockupViewer renders static srcdoc when iframeUrl is null', () => {
  const viewer = buildMockupViewer({
    mockups: [
      { name: 'option-a', html: '<p>OPTION-A-CONTENT</p>', iframeUrl: null },
    ],
  });
  assert.match(viewer, /<!DOCTYPE html>/i);
  assert.match(viewer, /<iframe[^>]+srcdoc=/, 'must use srcdoc when no live URL');
  // v1.5.0 Trident r19: dropped allow-same-origin (sandbox escape risk).
  assert.match(viewer, /sandbox=&quot;allow-scripts&quot;|sandbox="allow-scripts"/);
  // option-a name appears as tab and pane header
  assert.match(viewer, /option-a/);
  // Static badge wording
  assert.match(viewer, /STATIC/);
});

// ---------- 5. buildMockupViewer live iframe ----------
test('buildMockupViewer renders <iframe src> when iframeUrl is present', () => {
  const viewer = buildMockupViewer({
    mockups: [
      { name: 'option-b', html: '<p>x</p>', iframeUrl: 'https://example.test/preview/x' },
    ],
  });
  assert.match(viewer, /<iframe[^>]+src="https:\/\/example\.test\/preview\/x"/);
  // v1.5.0 Trident r19: dropped allow-same-origin (sandbox escape risk).
  assert.match(viewer, /sandbox="allow-scripts"/);
  assert.match(viewer, /LIVE/);
  // Must NOT use srcdoc when we have a live URL
  assert.doesNotMatch(viewer, /<iframe[^>]+srcdoc=/);
});

// ---------- 5b. XSS hardening ----------
test('buildMockupViewer escapes hostile names and urls', () => {
  const viewer = buildMockupViewer({
    mockups: [
      {
        name: '"><script>alert(1)</script>',
        html: '<p>safe</p>',
        iframeUrl: 'https://example.test/x"><img src=x onerror=alert(1)>',
      },
    ],
  });
  // Raw script tag must not appear (any breakout requires an unescaped `<`)
  assert.doesNotMatch(viewer, /<script>alert\(1\)<\/script>/);
  // Raw <img onerror=...> tag must not appear -- escaping the `<` defuses it
  assert.doesNotMatch(viewer, /<img[^>]+onerror=/i);
  // And the hostile chars must have been HTML-encoded
  assert.match(viewer, /&quot;/);
  assert.match(viewer, /&lt;script&gt;/);
});

// ---------- 6. renderMockupViewerWithBridge honors seam ----------
test('renderMockupViewerWithBridge: per-mockup fallback when bridge returns null', async () => {
  const calls = [];
  const fakeCreate = async ({ html, name }) => {
    calls.push({ name, htmlLen: html.length });
    return null; // simulate unavailable bridge
  };

  const { html, sandboxIds } = await renderMockupViewerWithBridge({
    mockups: [
      { name: 'a', html: '<p>A</p>' },
      { name: 'b', html: '<p>B</p>' },
    ],
    createSandbox: fakeCreate,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(sandboxIds, []);
  assert.match(html, /<iframe[^>]+srcdoc=/);
  assert.doesNotMatch(html, /<iframe[^>]+src="https?:\/\//);
});

test('renderMockupViewerWithBridge: uses live URL when bridge returns one', async () => {
  const fakeCreate = async ({ name }) => ({
    iframeUrl: `https://example.test/${name}`,
    sandboxId: `sb-${name}`,
  });
  const { html, sandboxIds } = await renderMockupViewerWithBridge({
    mockups: [
      { name: 'opt-a', html: '<p>A</p>' },
      { name: 'opt-b', html: '<p>B</p>' },
    ],
    createSandbox: fakeCreate,
  });
  assert.deepEqual(sandboxIds.sort(), ['sb-opt-a', 'sb-opt-b']);
  assert.match(html, /src="https:\/\/example\.test\/opt-a"/);
  assert.match(html, /src="https:\/\/example\.test\/opt-b"/);
  // Live path should NOT fall back to srcdoc
  assert.doesNotMatch(html, /<iframe[^>]+srcdoc=/);
});

test('renderMockupViewerWithBridge: swallows bridge throws as static fallback', async () => {
  const fakeCreate = async () => { throw new Error('boom'); };
  const { html, sandboxIds } = await renderMockupViewerWithBridge({
    mockups: [{ name: 'a', html: '<p>A</p>' }],
    createSandbox: fakeCreate,
  });
  assert.deepEqual(sandboxIds, []);
  assert.match(html, /srcdoc=/);
});

// ---------- 7. escHtml correctness ----------
test('escHtml escapes &, <, >, ", and \'', () => {
  assert.equal(escHtml(`&<>"'`), `&amp;&lt;&gt;&quot;&#39;`);
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

console.log('design-iframe tests loaded -- running with node --test');
