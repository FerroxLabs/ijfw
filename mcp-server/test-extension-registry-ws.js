/**
 * test-extension-registry-ws.js — IJFW v1.4.3 R12-L-01
 *
 * Exercises the SEC-H-02 security helpers in extension-registry-ws.js that
 * shipped with W9 but had no test coverage:
 *
 *   - resolveWsSource: explicit + origin/path binding + ambiguity refusal
 *   - verifyPushPayload: happy path + replay + source_url mismatch + bad sig
 *   - verifyHandshakeAccept: correct key + mismatch
 *
 * The handshake GUID is RFC 6455's "258EAFA5-E914-47DA-95CA-C5AB0DC85B11".
 *
 * Run: node --test test-extension-registry-ws.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';

import {
  resolveWsSource,
  verifyPushPayload,
  verifyHandshakeAccept,
  expectedAcceptValue,
  generateSecWebSocketKey,
  WS_GUID,
} from './src/extension-registry-ws.js';

// ---------------------------------------------------------------------------
// Helpers — duplicate the canonical-byte serialisation used by the module.
// pushPayloadCanonicalBytes is intentionally module-private; we replicate it
// here so the test isn't coupled to its export surface.
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

function canonicalBytes(payload) {
  const shallow = {};
  for (const k of Object.keys(payload)) {
    if (k === 'signature') continue;
    shallow[k] = payload[k];
  }
  return Buffer.from(JSON.stringify(sortKeysDeep(shallow)), 'utf8');
}

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { publicKey, privateKey, pubPem };
}

function signPayload(payload, privateKey) {
  const sig = cryptoSign(null, canonicalBytes(payload), privateKey);
  return { ...payload, signature: 'ed25519:' + sig.toString('base64') };
}

function makeSource(overrides = {}) {
  const kp = makeKeypair();
  return {
    name: overrides.name || 'test-source',
    url: overrides.url || 'https://registry.example/publishers/v1.json',
    priority: overrides.priority ?? 0,
    meta_key_pem: kp.pubPem,
    __privateKey: kp.privateKey,
  };
}

// ---------------------------------------------------------------------------
// resolveWsSource
// ---------------------------------------------------------------------------

test('resolveWsSource: IJFW_REGISTRY_WS_SOURCE matches by name', () => {
  const a = makeSource({ name: 'alpha', url: 'https://a.example/r/v1.json' });
  const b = makeSource({ name: 'beta', url: 'https://b.example/r/v1.json' });
  const r = resolveWsSource({ IJFW_REGISTRY_WS_SOURCE: 'alpha' }, [a, b]);
  assert.ok('source' in r, `expected source, got: ${JSON.stringify(r)}`);
  assert.equal(r.source.name, 'alpha');
});

test('resolveWsSource: host + path match returns the source (wss↔https pairing)', () => {
  // resolveWsSource matches on URL.host + path-prefix with TLS pairing
  // (wss↔https, ws↔http). Source registries publish over HTTPS; WS push
  // endpoints publish over WSS at the same host + path family. Cross-tier
  // (ws↔https) is refused to prevent downgrade attacks.
  const a = makeSource({ name: 'alpha', url: 'https://reg.example/publishers/v1.json' });
  const r = resolveWsSource(
    { IJFW_REGISTRY_WS_URL: 'wss://reg.example/publishers/live' },
    [a],
  );
  assert.ok('source' in r, `expected source, got: ${JSON.stringify(r)}`);
  assert.equal(r.source.name, 'alpha');
});

test('resolveWsSource: refuses host-only match when paths differ', () => {
  // Same host, DIFFERENT path-prefix → must NOT match (host-only is
  // explicitly forbidden per SEC-H-02).
  const a = makeSource({ name: 'alpha', url: 'https://reg.example/publishers/v1.json' });
  const r = resolveWsSource(
    { IJFW_REGISTRY_WS_URL: 'wss://reg.example/different-path/live' },
    [a],
  );
  assert.ok('error' in r, `expected error, got: ${JSON.stringify(r)}`);
  assert.ok(/no source binding/.test(r.error), `expected "no source binding", got: ${r.error}`);
});

test('resolveWsSource: refuses ambiguous host+path match', () => {
  const a = makeSource({ name: 'alpha', url: 'https://reg.example/publishers/v1.json' });
  const b = makeSource({ name: 'beta', url: 'https://reg.example/publishers/v2.json' });
  const r = resolveWsSource(
    { IJFW_REGISTRY_WS_URL: 'wss://reg.example/publishers/live' },
    [a, b],
  );
  assert.ok('error' in r, `expected ambiguity error, got: ${JSON.stringify(r)}`);
  assert.ok(
    /[Aa]mbiguous/.test(r.error),
    `expected "Ambiguous WS source binding", got: ${r.error}`,
  );
});

test('resolveWsSource: refuses cross-tier downgrade (ws → https)', () => {
  const a = makeSource({ name: 'alpha', url: 'https://reg.example/publishers/v1.json' });
  const r = resolveWsSource(
    { IJFW_REGISTRY_WS_URL: 'ws://reg.example/publishers/live' },  // plaintext WS against TLS registry
    [a],
  );
  assert.ok('error' in r, `expected error, got: ${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------------------
// verifyPushPayload
// ---------------------------------------------------------------------------

test('verifyPushPayload: valid signature + monotonic sequence → valid', () => {
  const source = makeSource({ name: 'src', url: 'https://reg.example/v1.json' });
  const payload = signPayload(
    {
      registry_version: '1.0',
      source_name: 'src',
      source_url: 'https://reg.example/v1.json',
      updated_at: '2026-05-17T00:00:00.000Z',
      revoked: [],
      sequence_number: 5,
    },
    source.__privateKey,
  );
  const v = verifyPushPayload(payload, source, 4);
  assert.equal(v.valid, true, `expected valid, got: ${JSON.stringify(v)}`);
});

test('verifyPushPayload: tampered signature → reject', () => {
  const source = makeSource({ name: 'src', url: 'https://reg.example/v1.json' });
  const payload = signPayload(
    {
      registry_version: '1.0',
      source_name: 'src',
      source_url: 'https://reg.example/v1.json',
      updated_at: '2026-05-17T00:00:00.000Z',
      revoked: [],
      sequence_number: 5,
    },
    source.__privateKey,
  );
  // Flip a byte in the signature to invalidate it.
  const sig = Buffer.from(payload.signature.slice('ed25519:'.length), 'base64');
  sig[0] ^= 0xff;
  const tampered = { ...payload, signature: 'ed25519:' + sig.toString('base64') };
  const v = verifyPushPayload(tampered, source, 4);
  assert.equal(v.valid, false);
  assert.ok(/signature/.test(v.reason), `expected signature error, got: ${v.reason}`);
});

test('verifyPushPayload: source_url mismatch → reject', () => {
  const source = makeSource({ name: 'src', url: 'https://reg.example/v1.json' });
  const payload = signPayload(
    {
      registry_version: '1.0',
      source_name: 'src',
      source_url: 'https://other.example/v1.json', // deliberate mismatch
      updated_at: '2026-05-17T00:00:00.000Z',
      revoked: [],
      sequence_number: 5,
    },
    source.__privateKey,
  );
  const v = verifyPushPayload(payload, source, 4);
  assert.equal(v.valid, false);
  assert.ok(
    /source_url mismatch/.test(v.reason),
    `expected source_url mismatch, got: ${v.reason}`,
  );
});

test('verifyPushPayload: replay (sequence <= last_seen) → reject', () => {
  const source = makeSource({ name: 'src', url: 'https://reg.example/v1.json' });
  const payload = signPayload(
    {
      registry_version: '1.0',
      source_name: 'src',
      source_url: 'https://reg.example/v1.json',
      updated_at: '2026-05-17T00:00:00.000Z',
      revoked: [],
      sequence_number: 7,
    },
    source.__privateKey,
  );
  // last_seen = 7 → equal triggers replay reject (`<=`).
  const v = verifyPushPayload(payload, source, 7);
  assert.equal(v.valid, false);
  assert.ok(/replay/.test(v.reason), `expected replay reject, got: ${v.reason}`);
});

// ---------------------------------------------------------------------------
// verifyHandshakeAccept (RFC 6455 GUID = 258EAFA5-E914-47DA-95CA-C5AB0DC85B11)
// ---------------------------------------------------------------------------

test('verifyHandshakeAccept: correct accept value → ok=true', () => {
  const key = generateSecWebSocketKey();
  // Independently compute the expected accept value to confirm GUID + sha1.
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
  // Sanity: module's expectedAcceptValue agrees with our independent compute.
  assert.equal(expectedAcceptValue(key), expected);
  const r = verifyHandshakeAccept(key, expected);
  assert.equal(r.ok, true);
});

test('verifyHandshakeAccept: mismatched accept value → ok=false', () => {
  const key = generateSecWebSocketKey();
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
  // Flip one base64 char in the middle to break it.
  const broken = expected.slice(0, 4) + (expected[4] === 'A' ? 'B' : 'A') + expected.slice(5);
  const r = verifyHandshakeAccept(key, broken);
  assert.equal(r.ok, false);
  assert.ok(/mismatch/i.test(r.reason), `expected mismatch reason, got: ${r.reason}`);
});
