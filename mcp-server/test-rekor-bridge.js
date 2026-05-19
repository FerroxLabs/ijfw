/**
 * test-rekor-bridge.js — IJFW v1.5.0 audit-H5.7 Sigstore Rekor bridge tests.
 *
 * Covers:
 *   - clean env (no peer, no stub) returns null/false
 *   - stub injection round-trips submit + verify
 *   - registry roundtrip embeds + cross-checks `rekor` field
 *   - tampered registry rejected by cross-check
 *
 * Run: node --test test-rekor-bridge.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';

import {
  hasRekorClient,
  submitToRekor,
  verifyRekorEntry,
  __setRekorClientForTest,
} from './src/lib/rekor-bridge.js';

import {
  verifyRegistry,
  crossCheckRekor,
  signRegistry,
  keygenMeta,
  _registryCanonicalBytesForTest,
} from './src/extension-registry.js';

// Silence stderr advisories during tests.
process.env.IJFW_REKOR_QUIET = '1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal in-memory stub Rekor client. Keeps a payload-hash table
 * indexed by uuid so getEntry can return the original payload hash.
 */
function makeStubClient(options = {}) {
  const entries = new Map();
  let counter = 1;
  return {
    async createEntry({ payload }) {
      if (options.throwOnCreate) throw new Error('mock create failure');
      if (options.malformedCreate) return { uuid: 'x' }; // missing logIndex/integratedTime
      const uuid = `stub-uuid-${counter++}`;
      const hash = createHash('sha256').update(payload).digest('hex');
      entries.set(uuid, hash);
      return {
        uuid,
        logIndex: counter * 100,
        integratedTime: Math.floor(Date.now() / 1000),
      };
    },
    async getEntry({ uuid }) {
      if (options.throwOnGet) throw new Error('mock get failure');
      if (!entries.has(uuid)) return null;
      // Optionally tamper with returned hash to simulate Rekor disagreement.
      if (options.tamperedHashFor === uuid) {
        return { payloadHash: createHash('sha256').update('tampered').digest('hex') };
      }
      return { payloadHash: entries.get(uuid) };
    },
    _entries: entries,
  };
}

// ---------------------------------------------------------------------------
// 1. Clean env (no peer dep, no stub)
// ---------------------------------------------------------------------------

test('hasRekorClient returns false in clean env', async () => {
  __setRekorClientForTest(null);
  // In a clean test env the optional peer dep `@sigstore/rekor` is absent.
  const r = await hasRekorClient();
  assert.equal(r, false, 'expected no client when peer dep absent and no stub');
});

test('submitToRekor returns null when no client', async () => {
  __setRekorClientForTest(null);
  const result = await submitToRekor({
    payload: Buffer.from('hello'),
    signature: 'ed25519:fake',
    publicKey: 'PEM',
  });
  assert.equal(result, null);
});

test('verifyRekorEntry returns null when no client', async () => {
  __setRekorClientForTest(null);
  const result = await verifyRekorEntry({ uuid: 'x', payload: Buffer.from('hi') });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 2. With injected stub
// ---------------------------------------------------------------------------

test('submitToRekor returns proper shape with stub client', async () => {
  const stub = makeStubClient();
  __setRekorClientForTest(stub);
  try {
    const result = await submitToRekor({
      payload: Buffer.from('hello world'),
      signature: 'ed25519:abc',
      publicKey: '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----',
    });
    assert.ok(result, 'submit should return a non-null entry handle');
    assert.equal(typeof result.uuid, 'string');
    assert.equal(typeof result.logIndex, 'number');
    assert.equal(typeof result.integratedTime, 'number');
  } finally {
    __setRekorClientForTest(null);
  }
});

test('submitToRekor returns null when stub createEntry throws', async () => {
  const stub = makeStubClient({ throwOnCreate: true });
  __setRekorClientForTest(stub);
  try {
    const result = await submitToRekor({
      payload: Buffer.from('hello'),
      signature: 'ed25519:x',
      publicKey: 'PEM',
    });
    assert.equal(result, null, 'submit must never throw — should return null');
  } finally {
    __setRekorClientForTest(null);
  }
});

test('submitToRekor returns null on malformed stub response', async () => {
  const stub = makeStubClient({ malformedCreate: true });
  __setRekorClientForTest(stub);
  try {
    const result = await submitToRekor({
      payload: Buffer.from('hello'),
      signature: 'ed25519:x',
      publicKey: 'PEM',
    });
    assert.equal(result, null, 'malformed Rekor response must yield null');
  } finally {
    __setRekorClientForTest(null);
  }
});

test('verifyRekorEntry returns true for matching payload', async () => {
  const stub = makeStubClient();
  __setRekorClientForTest(stub);
  try {
    const payload = Buffer.from('canonical body');
    const entry = await submitToRekor({
      payload,
      signature: 'ed25519:x',
      publicKey: 'PEM',
    });
    const ok = await verifyRekorEntry({ uuid: entry.uuid, payload });
    assert.equal(ok, true, 'matching payload should verify');
  } finally {
    __setRekorClientForTest(null);
  }
});

test('verifyRekorEntry returns false for mismatched payload', async () => {
  const stub = makeStubClient();
  __setRekorClientForTest(stub);
  try {
    const payload = Buffer.from('original body');
    const entry = await submitToRekor({
      payload,
      signature: 'ed25519:x',
      publicKey: 'PEM',
    });
    const ok = await verifyRekorEntry({ uuid: entry.uuid, payload: Buffer.from('TAMPERED body') });
    assert.equal(ok, false, 'mismatched payload must verify false');
  } finally {
    __setRekorClientForTest(null);
  }
});

test('verifyRekorEntry returns null when stub getEntry throws', async () => {
  const stub = makeStubClient({ throwOnGet: true });
  __setRekorClientForTest(stub);
  try {
    const result = await verifyRekorEntry({ uuid: 'any', payload: Buffer.from('x') });
    assert.equal(result, null, 'getEntry throw must yield null');
  } finally {
    __setRekorClientForTest(null);
  }
});

// ---------------------------------------------------------------------------
// 3. Registry roundtrip
// ---------------------------------------------------------------------------

test('registry roundtrip: sign embeds rekor, verify + crossCheckRekor pass', async (t) => {
  const stub = makeStubClient();
  __setRekorClientForTest(stub);

  // Isolated HOME so keygen-meta + signRegistry don't touch real ~/.ijfw.
  const home = await mkdtemp(join(tmpdir(), 'ijfw-rekor-roundtrip-'));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(async () => {
    process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    __setRekorClientForTest(null);
    await rm(home, { recursive: true, force: true });
  });

  // 1. keygen-meta — generates the meta keypair in $HOME/.ijfw/keys/<id>/.
  const kg = await keygenMeta('test-author');
  assert.equal(typeof kg.keyId, 'string');

  // 2. Write an unsigned registry file under cwd (signRegistry enforces
  //    path-under-cwd to prevent traversal).
  const regPath = join(process.cwd(), `test-rekor-registry-${process.pid}.json`);
  const unsigned = {
    registry_version: '1.0',
    updated_at: new Date(0).toISOString(),
    publishers: {},
    revoked: [],
    signature: null,
  };
  await writeFile(regPath, JSON.stringify(unsigned, null, 2), 'utf8');
  t.after(async () => { await rm(regPath, { force: true }); });

  // 3. Sign — should anchor to stub Rekor and embed rekor field.
  const signResult = await signRegistry(regPath);
  assert.equal(signResult.ok, true, `sign failed: ${signResult.error || ''}`);
  assert.ok(signResult.rekor, 'signRegistry must return embedded rekor handle');

  // 4. Read back the on-disk registry — confirm rekor field present.
  const raw = await readFile(regPath, 'utf8');
  const reg = JSON.parse(raw);
  assert.ok(reg.rekor, 'on-disk registry must have rekor field');
  assert.equal(typeof reg.rekor.uuid, 'string');
  assert.equal(typeof reg.rekor.logIndex, 'number');
  assert.equal(typeof reg.rekor.integratedTime, 'number');

  // 5. Local verify (Ed25519) — verify with the meta-key just generated.
  const meta = await readFile(
    join(home, '.ijfw', 'keys', kg.keyId, 'public.pem'),
    'utf8',
  );
  const v = verifyRegistry(raw, { metaKeyPem: meta });
  assert.equal(v.valid, true, `verifyRegistry failed: ${v.reason}`);

  // 6. crossCheckRekor must succeed (matching payload).
  const cc = await crossCheckRekor(v.registry);
  assert.equal(cc.ok, true, `crossCheckRekor failed: ${cc.reason}`);
});

test('tampered registry: crossCheckRekor REJECTS even with valid uuid', async (t) => {
  const stub = makeStubClient();
  __setRekorClientForTest(stub);
  t.after(() => { __setRekorClientForTest(null); });

  // Submit an entry for the "real" payload.
  const realPayload = Buffer.from('real canonical bytes');
  const realEntry = await submitToRekor({
    payload: realPayload,
    signature: 'ed25519:real',
    publicKey: 'PEM',
  });

  // Build a registry that LOOKS like it was anchored at realEntry.uuid but
  // whose canonical bytes are completely different (attacker swapped contents).
  const tamperedRegistry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    publishers: { ['a'.repeat(64)]: { publicKey: 'fake' } }, // injected publisher
    revoked: [],
    signature: 'ed25519:doesntmatterhere',
    rekor: {
      uuid: realEntry.uuid,
      logIndex: realEntry.logIndex,
      integratedTime: realEntry.integratedTime,
    },
  };

  const cc = await crossCheckRekor(tamperedRegistry);
  assert.equal(cc.ok, false, 'crossCheckRekor must REJECT tampered registry');
  assert.match(cc.reason, /rekor payload mismatch/);
});

test('crossCheckRekor: no rekor field → ok (backcompat)', async () => {
  __setRekorClientForTest(null);
  const registry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    publishers: {},
    revoked: [],
    signature: 'ed25519:x',
  };
  const cc = await crossCheckRekor(registry);
  assert.equal(cc.ok, true, 'pre-v1.5.0 registries (no rekor) must still verify ok');
  assert.match(cc.reason, /no rekor anchor/);
});

test('crossCheckRekor: rekor present but no client → accept on ed25519 alone', async () => {
  __setRekorClientForTest(null);
  const registry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    publishers: {},
    revoked: [],
    signature: 'ed25519:x',
    rekor: { uuid: 'stub-uuid-1', logIndex: 100, integratedTime: 1000 },
  };
  const cc = await crossCheckRekor(registry);
  assert.equal(cc.ok, true, 'offline clients accept Ed25519 alone (backcompat)');
  assert.match(cc.reason, /no rekor client/);
});

test('verifyRegistry: malformed rekor field rejected', () => {
  // Build a registry whose rekor field has the wrong shape (missing logIndex).
  // Even before checking the signature this should fail shape validation.
  const registry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    publishers: {},
    revoked: [],
    signature: null,
    rekor: { uuid: 'x' },
  };
  const r = verifyRegistry(JSON.stringify(registry), { allowSeed: true });
  assert.equal(r.valid, false, 'malformed rekor field must fail verifyRegistry');
  assert.match(r.reason, /rekor field malformed/);
});
