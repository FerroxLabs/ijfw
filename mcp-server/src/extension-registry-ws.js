/**
 * extension-registry-ws.js — IJFW v1.4.3/B17 WebSocket revocation client (stub).
 *
 * Dormant by default. Imported via `await import(...)` ONLY when
 * `process.env.IJFW_REGISTRY_WS_URL` is set at startup. Listening on the
 * registry meta-key for live revocation push messages.
 *
 * Frozen contract (SEC-H-02):
 *   - Source binding is explicit. Prefer `IJFW_REGISTRY_WS_SOURCE=<name>`
 *     for an exact match in registries.json. If only `IJFW_REGISTRY_WS_URL`
 *     is set, map to a source by origin + pathname-prefix (NEVER host-only).
 *     Zero matches → refuse. Multiple matches → refuse with "set
 *     IJFW_REGISTRY_WS_SOURCE".
 *   - Signed-payload schema:
 *       { registry_version: "1.0", source_name, source_url, updated_at,
 *         revoked: [...], sequence_number, signature: "ed25519:<b64>" }
 *     Canonical bytes = sorted-keys JSON minus `signature`. Replay defense:
 *     reject any `sequence_number <= last_seen_sequence`.
 *   - Handshake (ARCH-L-02): in the `node:net` fallback, generate a random
 *     16-byte Sec-WebSocket-Key (base64). Expect
 *     `Sec-WebSocket-Accept = base64(sha1(key + GUID))`. Refuse on mismatch.
 *
 * Zero new prod deps. Uses node:net + node:crypto + node:url.
 *
 * The SERVER infrastructure ships in v1.5.0; v1.4.3 only ships this CLIENT
 * stub.
 */

import { createHash, randomBytes, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { URL } from 'node:url';

import {
  loadRegistrySources,
  withSourceCache,
  perSourceCachePath,
  perSourceLockPath,
} from './extension-registry.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// Source binding (SEC-H-02)
// ---------------------------------------------------------------------------

/**
 * Resolve which source the WS client should bind to.
 *
 * @param {object} env — { IJFW_REGISTRY_WS_URL, IJFW_REGISTRY_WS_SOURCE }
 * @param {Array} sources — list from loadRegistrySources()
 * @returns {{ source: object } | { error: string }}
 */
export function resolveWsSource(env, sources) {
  const explicit = env.IJFW_REGISTRY_WS_SOURCE;
  if (typeof explicit === 'string' && explicit !== '') {
    const found = sources.find((s) => s.name === explicit);
    if (!found) {
      return {
        error: `[ijfw] IJFW_REGISTRY_WS_SOURCE='${explicit}' has no matching entry in registries.json`,
      };
    }
    return { source: found };
  }

  const wsUrl = env.IJFW_REGISTRY_WS_URL;
  if (typeof wsUrl !== 'string' || wsUrl === '') {
    return { error: '[ijfw] neither IJFW_REGISTRY_WS_SOURCE nor IJFW_REGISTRY_WS_URL set' };
  }

  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    return { error: `[ijfw] IJFW_REGISTRY_WS_URL '${wsUrl}' is not a valid URL` };
  }

  // The WS scheme and the source's HTTPS scheme differ by protocol, so we
  // match on host + path-prefix (NOT origin — origin includes scheme). We do
  // however enforce TLS pairing: wss ↔ https, ws ↔ http. Cross-tier (e.g.
  // ws:// WS endpoint paired to an https:// registry) is refused to prevent
  // downgrade attacks where an attacker proxies plaintext push traffic for
  // an otherwise-TLS registry.
  const SCHEME_PAIRS = { 'wss:': 'https:', 'ws:': 'http:' };
  const requiredSourceProto = SCHEME_PAIRS[parsed.protocol];
  if (!requiredSourceProto) {
    return {
      error: `[ijfw] IJFW_REGISTRY_WS_URL '${wsUrl}' must use ws:// or wss:// scheme`,
    };
  }
  const wsHost = parsed.host;
  const wsPathPrefix = parsed.pathname.split('/').slice(0, -1).join('/');

  const matches = [];
  for (const source of sources) {
    try {
      const su = new URL(source.url);
      if (su.protocol !== requiredSourceProto) continue;  // refuse cross-tier
      const sourcePathPrefix = su.pathname.split('/').slice(0, -1).join('/');
      if (su.host === wsHost && sourcePathPrefix === wsPathPrefix) {
        matches.push(source);
      }
    } catch {
      // skip unparseable source URLs
    }
  }

  if (matches.length === 0) {
    return {
      error: `[ijfw] IJFW_REGISTRY_WS_URL '${wsUrl}' has no source binding; set IJFW_REGISTRY_WS_SOURCE=<name> explicitly`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `[ijfw] Ambiguous WS source binding for '${wsUrl}' (matches: ${matches.map((s) => s.name).join(', ')}); set IJFW_REGISTRY_WS_SOURCE=<name>`,
    };
  }
  return { source: matches[0] };
}

// ---------------------------------------------------------------------------
// Signed-payload schema verification (SEC-H-02)
// ---------------------------------------------------------------------------

function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = sortKeysDeep(v[k]);
    }
    return out;
  }
  return v;
}

function pushPayloadCanonicalBytes(payload) {
  const shallow = {};
  for (const k of Object.keys(payload)) {
    if (k === 'signature') continue;
    shallow[k] = payload[k];
  }
  return Buffer.from(JSON.stringify(sortKeysDeep(shallow)), 'utf8');
}

/**
 * Verify a WS push message.
 *
 * @param {object} payload
 * @param {object} source — bound source (provides meta_key_pem, name, url)
 * @param {number} lastSeenSequence
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyPushPayload(payload, source, lastSeenSequence) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, reason: 'payload must be a JSON object' };
  }
  if (payload.registry_version !== '1.0') {
    return { valid: false, reason: `unsupported registry_version: ${payload.registry_version}` };
  }
  if (typeof payload.source_name !== 'string' || payload.source_name !== source.name) {
    return {
      valid: false,
      reason: `source_name mismatch (expected '${source.name}', got '${payload.source_name}')`,
    };
  }
  if (typeof payload.source_url !== 'string' || payload.source_url !== source.url) {
    return {
      valid: false,
      reason: `source_url mismatch (expected '${source.url}', got '${payload.source_url}')`,
    };
  }
  if (typeof payload.updated_at !== 'string') {
    return { valid: false, reason: 'updated_at must be a string' };
  }
  if (!Array.isArray(payload.revoked)) {
    return { valid: false, reason: 'revoked must be an array' };
  }
  if (typeof payload.sequence_number !== 'number' || !Number.isFinite(payload.sequence_number)) {
    return { valid: false, reason: 'sequence_number must be a finite number' };
  }
  if (payload.sequence_number <= lastSeenSequence) {
    return {
      valid: false,
      reason: `replay rejected (sequence_number ${payload.sequence_number} <= last_seen ${lastSeenSequence})`,
    };
  }
  if (typeof payload.signature !== 'string' || !payload.signature.startsWith('ed25519:')) {
    return { valid: false, reason: 'signature must be "ed25519:<base64>"' };
  }

  let metaKey;
  try {
    metaKey = createPublicKey(source.meta_key_pem);
  } catch (err) {
    return { valid: false, reason: `meta-key parse failed: ${err.message}` };
  }
  const sigBuf = Buffer.from(payload.signature.slice('ed25519:'.length), 'base64');
  const bytes = pushPayloadCanonicalBytes(payload);
  let ok;
  try {
    ok = cryptoVerify(null, bytes, metaKey, sigBuf);
  } catch (err) {
    return { valid: false, reason: `signature verify threw: ${err.message}` };
  }
  if (!ok) {
    return { valid: false, reason: 'signature does not verify against source meta-key' };
  }
  return { valid: true };
}

/**
 * Apply a verified push payload to the bound source's per-source cache.
 * Merges `revoked` entries (de-dup by keyId) inside withFsLock.
 */
export async function applyPushPayload(payload, source) {
  return withSourceCache(source, (cache) => {
    const existingKeyIds = new Set((cache.revoked || []).map((r) => r.keyId));
    const merged = [...(cache.revoked || [])];
    for (const entry of payload.revoked) {
      if (entry && entry.keyId && !existingKeyIds.has(entry.keyId)) {
        existingKeyIds.add(entry.keyId);
        merged.push({
          keyId: entry.keyId,
          revoked_at: entry.revoked_at || new Date().toISOString(),
          reason: entry.reason || '',
          superseded_by: entry.superseded_by || null,
        });
      }
    }
    return {
      ...cache,
      revoked: merged,
      revocation_fetched_at: new Date().toISOString(),
      source_name: source.name,
      source_url: source.url,
    };
  });
}

// ---------------------------------------------------------------------------
// Handshake helpers (ARCH-L-02)
// ---------------------------------------------------------------------------

/**
 * Generate a 16-byte random base64 Sec-WebSocket-Key.
 */
export function generateSecWebSocketKey() {
  return randomBytes(16).toString('base64');
}

/**
 * Compute the expected Sec-WebSocket-Accept value for a given key.
 */
export function expectedAcceptValue(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

/**
 * Verify a server response's Sec-WebSocket-Accept against our key.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyHandshakeAccept(key, accept) {
  if (typeof accept !== 'string' || accept === '') {
    return { ok: false, reason: 'Sec-WebSocket-Accept header missing' };
  }
  const expected = expectedAcceptValue(key);
  // constant-time compare via Buffer comparison
  const aBuf = Buffer.from(expected, 'utf8');
  const bBuf = Buffer.from(accept, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return { ok: false, reason: 'Sec-WebSocket-Accept length mismatch' };
  }
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) diff |= aBuf[i] ^ bBuf[i];
  if (diff !== 0) return { ok: false, reason: 'Sec-WebSocket-Accept mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Client controller (lightweight; tests drive parts in isolation).
// ---------------------------------------------------------------------------

/**
 * Construct a controller bound to a source. The controller exposes verify +
 * apply hooks for the test surface; the wire-level connect path uses native
 * `globalThis.WebSocket` when available, else `node:net`. v1.4.3 ships only
 * the stub; the active connect loop is gated behind an explicit `connect()`
 * call so MCP startup never accidentally opens a socket.
 */
export class WsRevocationClient {
  constructor({ source }) {
    if (!source || typeof source !== 'object') {
      throw new Error('WsRevocationClient: source is required');
    }
    this.source = source;
    this._lastSeenSequence = -Infinity;
    this._socket = null;
  }

  /**
   * Process an incoming JSON-text message. Returns { applied, reason }.
   */
  async handleMessage(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return { applied: false, reason: `parse_error:${err.message}` };
    }
    const verdict = verifyPushPayload(payload, this.source, this._lastSeenSequence);
    if (!verdict.valid) {
      return { applied: false, reason: verdict.reason };
    }
    await applyPushPayload(payload, this.source);
    this._lastSeenSequence = payload.sequence_number;
    return { applied: true, sequence_number: payload.sequence_number };
  }

  /**
   * Reset the replay-defense counter — test-only.
   */
  _resetSequenceForTest() {
    this._lastSeenSequence = -Infinity;
  }
}

/**
 * Initialise the WS client at MCP startup. Caller must check
 * `process.env.IJFW_REGISTRY_WS_URL` BEFORE importing this module.
 *
 * @param {object} [opts]
 * @param {object} [opts.env] — env override for tests
 * @param {Array} [opts.sources] — source list override for tests
 * @returns {Promise<{ ok: true, client: WsRevocationClient } | { ok: false, error: string }>}
 */
export async function initWsClient(opts = {}) {
  const env = opts.env || process.env;
  const sources = opts.sources || (await loadRegistrySources());
  const resolved = resolveWsSource(env, sources);
  if ('error' in resolved) {
    return { ok: false, error: resolved.error };
  }
  return { ok: true, client: new WsRevocationClient({ source: resolved.source }) };
}

// Re-export paths so callers can introspect cache locations.
export { perSourceCachePath, perSourceLockPath, WS_GUID };
