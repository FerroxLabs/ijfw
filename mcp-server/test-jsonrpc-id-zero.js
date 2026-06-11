/**
 * test-jsonrpc-id-zero.js -- audit fix: JSON-RPC id 0 / "" treated as falsy.
 *
 * Spec: a server MUST respond to every request, and the response id MUST
 * equal the request id. The MCP TypeScript SDK numbers requests from 0, so
 * id 0 is reachable in the wild. Previously an unknown method with id 0 got
 * NO response (client hangs) because the default branch used `if (id)`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, 'src', 'server.js');

// Send raw JSON-RPC lines to a fresh server process and collect responses
// until `expected` lines arrive (or timeout).
function exchange(lines, expected, timeoutMs = 15000) {
  return new Promise((res, reject) => {
    const sandbox = mkdtempSync(join(tmpdir(), 'ijfw-idzero-'));
    const proc = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, IJFW_PROJECT_DIR: sandbox },
    });
    const out = [];
    let buf = '';
    const finish = (err) => {
      clearTimeout(timer);
      proc.kill();
      rmSync(sandbox, { recursive: true, force: true });
      if (err) reject(err); else res(out);
    };
    const timer = setTimeout(
      () => finish(new Error(`timeout: got ${out.length}/${expected} responses: ${JSON.stringify(out)}`)),
      timeoutMs,
    );
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch { /* ignore non-JSON noise */ }
        if (out.length >= expected) return finish();
      }
    });
    proc.on('error', finish);
    proc.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

test('unknown method with id 0 gets a -32601 response with id 0', async () => {
  const [resp] = await exchange(
    [{ jsonrpc: '2.0', id: 0, method: 'totally/unknown' }],
    1,
  );
  assert.equal(resp.id, 0);
  assert.equal(resp.error.code, -32601);
});

test('unknown method with id "" gets a -32601 response with id ""', async () => {
  const [resp] = await exchange(
    [{ jsonrpc: '2.0', id: '', method: 'totally/unknown' }],
    1,
  );
  assert.equal(resp.id, '');
  assert.equal(resp.error.code, -32601);
});

test('unknown-method NOTIFICATION (no id) gets no response; next request still answered', async () => {
  const [resp] = await exchange(
    [
      { jsonrpc: '2.0', method: 'totally/unknown' },
      { jsonrpc: '2.0', id: 7, method: 'ping' },
    ],
    1,
  );
  // The only response must be for the ping -- the notification stays silent.
  assert.equal(resp.id, 7);
  assert.equal(resp.error, undefined);
});
