/**
 * IJFW design iframe bridge -- optional vercel:vercel-sandbox composition.
 *
 * IJFW core has zero runtime deps and ships a static viewer for design mockups.
 * When the peer `vercel:vercel-sandbox` skill is present (or the user has set
 * `IJFW_VERCEL_SANDBOX_URL` to a provisioner endpoint), this bridge upgrades
 * the static viewer to live iframes running each mockup in an isolated
 * Firecracker microVM via the vercel-sandbox skill.
 *
 * **Every entrypoint graceful-fails.** A missing CLI, an unset env var, a
 * malformed response, or a network error all return null/false rather than
 * throwing. The caller MUST fall back to the static-srcdoc viewer in that case.
 *
 * Why composition over a hard dep: IJFW is a meta-tool. Pinning vercel-sandbox
 * would import sandboxing concerns into IJFW's trust model. Peer-skill detection
 * keeps the boundary clean (and keeps the npm install size at zero).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const SANDBOX_URL_ENV = 'IJFW_VERCEL_SANDBOX_URL';
const PROVISION_TIMEOUT_MS = 15_000;
const DESTROY_TIMEOUT_MS = 5_000;

/** In-process registry of sandbox ids → provisioner URL for destroySandbox(). */
const _sandboxRegistry = new Map();

/**
 * Returns true when EITHER the `vercel` CLI is on PATH OR
 * `IJFW_VERCEL_SANDBOX_URL` env var is set.
 *
 * Cheap. Safe to call repeatedly (a few ms `which` shell-out worst case).
 */
export function hasVercelSandbox() {
  if (process.env[SANDBOX_URL_ENV]) return true;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(which, ['vercel'], { encoding: 'utf8', timeout: 2_000 });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return true;
  } catch {
    // graceful: missing `which`/`where` is the same as no CLI
  }
  return false;
}

/**
 * Provision a sandbox preview for an HTML mockup. Returns
 *   { iframeUrl, sandboxId }   on success
 *   null                       when bridge unavailable OR any failure
 *
 * The function is never expected to throw. All errors are logged advisory
 * to stderr so the user understands why fallback kicked in, then null is
 * returned and the caller renders the static-srcdoc viewer.
 *
 * @param {{ html: string, name?: string }} args
 * @returns {Promise<{iframeUrl: string, sandboxId: string} | null>}
 */
export async function createPreviewSandbox({ html, name } = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    _advise('createPreviewSandbox: html missing -- skipping');
    return null;
  }
  if (!hasVercelSandbox()) return null;

  const safeName = String(name || 'mockup').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'mockup';
  const sandboxId = `ijfw-${safeName}-${randomUUID().slice(0, 8)}`;

  // Write the html to a temp file so the provisioner can read it.
  let tmpFile = null;
  try {
    const dir = join(tmpdir(), 'ijfw-design-sandboxes');
    mkdirSync(dir, { recursive: true });
    tmpFile = join(dir, `${sandboxId}.html`);
    writeFileSync(tmpFile, html, 'utf8');
  } catch (err) {
    _advise(`createPreviewSandbox: temp write failed -- ${err.message}`);
    return null;
  }

  // Prefer the env-configured HTTP provisioner when present (test-friendly,
  // matches how the vercel-sandbox MCP skill exposes its provisioning API).
  const url = process.env[SANDBOX_URL_ENV];
  if (url) {
    const result = await _provisionViaHttp(url, { html, name: safeName, sandboxId });
    if (result) {
      _sandboxRegistry.set(sandboxId, { mode: 'http', url });
      return result;
    }
    return null;
  }

  // Fall back to shell-out to `vercel sandbox` CLI. Best-effort: the CLI
  // surface for vercel-sandbox is evolving; we accept any JSON line that
  // contains a `url` field.
  try {
    const r = spawnSync('vercel', ['sandbox', 'create', '--file', tmpFile, '--name', sandboxId], {
      encoding: 'utf8',
      timeout: PROVISION_TIMEOUT_MS,
    });
    if (r.status !== 0) {
      _advise(`createPreviewSandbox: vercel CLI exit ${r.status} -- falling back to static`);
      return null;
    }
    const iframeUrl = _extractUrl(r.stdout);
    if (!iframeUrl) {
      _advise('createPreviewSandbox: vercel CLI produced no URL -- falling back to static');
      return null;
    }
    _sandboxRegistry.set(sandboxId, { mode: 'cli' });
    return { iframeUrl, sandboxId };
  } catch (err) {
    _advise(`createPreviewSandbox: CLI invocation failed -- ${err.message}`);
    return null;
  }
}

/**
 * Tear down a sandbox by id. Never throws. Best-effort.
 */
export async function destroySandbox(sandboxId) {
  if (!sandboxId) return;
  const entry = _sandboxRegistry.get(sandboxId);
  if (!entry) return;
  _sandboxRegistry.delete(sandboxId);

  try {
    if (entry.mode === 'http') {
      await _httpRequest(
        'DELETE',
        `${entry.url.replace(/\/$/, '')}/sandboxes/${encodeURIComponent(sandboxId)}`,
        null,
        DESTROY_TIMEOUT_MS,
      );
      return;
    }
    if (entry.mode === 'cli') {
      spawnSync('vercel', ['sandbox', 'delete', sandboxId], { encoding: 'utf8', timeout: DESTROY_TIMEOUT_MS });
      return;
    }
  } catch (err) {
    _advise(`destroySandbox(${sandboxId}): ${err.message}`);
  }
}

// ---------- internals ----------

async function _provisionViaHttp(baseUrl, { html, name, sandboxId }) {
  try {
    const payload = JSON.stringify({ html, name, sandboxId });
    const res = await _httpRequest(
      'POST',
      `${baseUrl.replace(/\/$/, '')}/sandboxes`,
      payload,
      PROVISION_TIMEOUT_MS,
    );
    if (!res || res.status < 200 || res.status >= 300) {
      _advise(`HTTP provisioner returned ${res ? res.status : 'no response'}`);
      return null;
    }
    let body;
    try { body = JSON.parse(res.body); } catch {
      _advise('HTTP provisioner returned non-JSON');
      return null;
    }
    const iframeUrl = body && (body.iframeUrl || body.url);
    if (!iframeUrl) {
      _advise('HTTP provisioner response missing url field');
      return null;
    }
    return { iframeUrl: String(iframeUrl), sandboxId: String(body.sandboxId || sandboxId) };
  } catch (err) {
    _advise(`HTTP provisioner failed -- ${err.message}`);
    return null;
  }
}

/**
 * Minimal http(s) client using node:http / node:https. Avoids `fetch`
 * because we want deterministic timeouts and zero-dep behavior on every
 * supported Node version.
 */
function _httpRequest(method, url, body, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const opts = {
        method,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: body
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
        timeout: timeoutMs,
      };
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        try { req.destroy(); } catch {}
        resolve(null);
      });
      if (body) req.write(body);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function _extractUrl(text) {
  if (!text) return null;
  // JSON-encoded url field
  const jsonMatch = String(text).match(/"(?:iframeUrl|url)"\s*:\s*"(https?:\/\/[^"\s]+)"/);
  if (jsonMatch) return jsonMatch[1];
  // Bare URL printed by the CLI
  const bare = String(text).match(/(https?:\/\/[^\s"]+\.vercel\.app[^\s"]*)/);
  return bare ? bare[1] : null;
}

function _advise(msg) {
  try {
    process.stderr.write(`[ijfw design] ${msg}\n`);
  } catch {
    // never throw from advisory log
  }
}

// Exported for tests
export const __internals = { _extractUrl, _sandboxRegistry, SANDBOX_URL_ENV };
