// Regression tests for audit-v1.5.0 observability HIGH findings.
// H3.1 — esc() must escape single quotes (XSS via onclick inner-string break)
// H3.2 — every dashboard HTML response must set a strict Content-Security-Policy
// H3.3 — /api/memory-file must redact secrets in raw transcript/memory content
//        and refuse files larger than 5 MiB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf8');
const serverJs  = readFileSync(join(__dirname, 'server.js'),  'utf8');

// ---------------------------------------------------------------------------
// H3.1 — esc() escapes single quotes
// ---------------------------------------------------------------------------

test('H3.1: esc() definition in index.html escapes single quotes', () => {
  // Extract the esc() body. We look for the replace chain on the same/next line.
  const escBlock = indexHtml.match(/function esc\(s\)\{[\s\S]{0,800}?\n\}/);
  assert.ok(escBlock, 'esc() function must be present in index.html');
  assert.match(
    escBlock[0],
    /\.replace\(\s*\/'\/g\s*,\s*['"]&#39;['"]\s*\)/,
    'esc() must escape single quotes to &#39;',
  );
});

test('H3.1: simulated esc() neutralizes the XSS payload from the audit', () => {
  // Re-implement esc() locally to verify behaviour matches the spec.
  function esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const attacker = "evil');alert(1);//.md";
  const escaped  = esc(attacker);
  // After escaping the bare single quotes are gone — the JS-string boundary
  // inside onclick="toggleMemCard('...','...','...')" cannot be broken.
  assert.ok(!/(^|[^&#0-9a-z])'/.test(escaped), `single quotes still present: ${escaped}`);
  assert.match(escaped, /&#39;/);
});

// ---------------------------------------------------------------------------
// H3.2 — Content-Security-Policy on every HTML response
// ---------------------------------------------------------------------------

test('H3.2: server.js defines a strict CSP constant', () => {
  assert.match(serverJs, /const CSP_HEADER\s*=\s*["']/);
  assert.match(serverJs, /default-src 'self'/);
  assert.match(serverJs, /script-src 'self' 'unsafe-inline'/);
  assert.match(serverJs, /style-src 'self' 'unsafe-inline'/);
  assert.match(serverJs, /img-src 'self' data:/);
  assert.match(serverJs, /connect-src 'self'/);
});

test('H3.2: every text/html writeHead in server.js includes Content-Security-Policy', () => {
  // Match each `res.writeHead(... 'text/html ... )` invocation and assert it
  // carries the CSP_HEADER. We bound the regex to a single writeHead call by
  // requiring a closing `})` no further than ~400 chars away.
  const headRe = /res\.writeHead\(\s*\d+\s*,\s*\{[^}]*'Content-Type':\s*'text\/html[^']*'[^}]*\}\s*\)/g;
  const hits = serverJs.match(headRe) || [];
  assert.ok(hits.length >= 4, `expected at least 4 text/html responses, got ${hits.length}`);
  for (const h of hits) {
    assert.match(
      h,
      /'Content-Security-Policy':\s*CSP_HEADER/,
      `text/html writeHead missing CSP header: ${h}`,
    );
  }
});

// ---------------------------------------------------------------------------
// H3.3 — /api/memory-file redacts secrets + enforces size cap
// ---------------------------------------------------------------------------

test('H3.3: server.js imports redactSecrets from the canonical redactor', () => {
  assert.match(
    serverJs,
    /import\s*\{\s*redactSecrets\s*\}\s*from\s*['"]\.\.\/\.\.\/mcp-server\/src\/redactor\.js['"]/,
  );
});

test('H3.3: serveMemoryContent runs file content through redactSecrets', () => {
  // The call site must redact BEFORE the result is JSON-stringified.
  const serveBlock = serverJs.match(/function serveMemoryContent\([^)]*\)\s*\{[\s\S]+?\n    \}/);
  assert.ok(serveBlock, 'serveMemoryContent function not found');
  assert.match(serveBlock[0], /redactSecrets\s*\(/, 'serveMemoryContent must call redactSecrets()');
  // And the redaction must happen on the raw read result, not on something else.
  assert.match(
    serveBlock[0],
    /readFileSync\([^)]*\)[\s\S]{0,400}?redactSecrets\(/,
    'redactSecrets must wrap the readFileSync output',
  );
});

test('H3.3: serveMemoryContent enforces a 5 MiB max via 413', () => {
  assert.match(serverJs, /const MEMORY_FILE_MAX_BYTES\s*=\s*5\s*\*\s*1024\s*\*\s*1024/);
  // The 413 path must exist inside the memory-file handler.
  const handler = serverJs.match(/if \(url === '\/api\/memory-file'\)[\s\S]+?\n  \}/);
  assert.ok(handler, '/api/memory-file handler not found');
  assert.match(handler[0], /writeHead\(413\b/);
  assert.match(handler[0], /MEMORY_FILE_MAX_BYTES/);
});

test('H3.3: end-to-end — redactSecrets actually strips a synthetic OpenAI key', async () => {
  // Use the real redactor to prove the contract holds.
  const { redactSecrets } = await import('../../mcp-server/src/redactor.js');
  const fake = 'sk-proj-' + 'a'.repeat(40);
  const txt  = `before ${fake} after`;
  const out  = redactSecrets(txt);
  assert.ok(!out.includes(fake), `key not redacted: ${out}`);
  assert.match(out, /\[REDACTED:openai\]/);
});
