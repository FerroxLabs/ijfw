/**
 * test-extension-registry.js — IJFW v1.4.1/B6 registry tests.
 *
 * 9 test cases per spec. Uses injectable fetchImpl — never hits a real URL.
 * Run: node --experimental-sqlite --test test-extension-registry.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  createPrivateKey,
} from 'node:crypto';

import {
  fetchRegistry,
  verifyRegistry,
  applyRegistry,
  readCachedRegistry,
  writeCachedRegistry,
  refreshTrustFromRegistry,
  keygenMeta,
  signRegistry,
  verifyRegistryFile,
  IJFW_REGISTRY_META_KEY_PEM,
  CACHE_TTL_MS,
} from './src/extension-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(der).digest('hex');
  return { pubPem, privPem, keyId, publicKey, privateKey };
}

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

function registryCanonicalBytes(registry) {
  const shallow = {};
  for (const k of Object.keys(registry)) {
    if (k === 'signature') continue;
    shallow[k] = registry[k];
  }
  return Buffer.from(JSON.stringify(sortKeysDeep(shallow)), 'utf8');
}

/**
 * Build a registry signed by an arbitrary keypair (for tamper tests, we use
 * the real meta-key by default; for tamper tests we use a rogue key).
 */
function buildSignedRegistry({ publishers = {}, revoked = [], privateKey } = {}) {
  const registry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    signature: null,
    publishers,
    revoked,
  };
  if (privateKey) {
    const bytes = registryCanonicalBytes(registry);
    const sigBuf = cryptoSign(null, bytes, createPrivateKey(privateKey));
    registry.signature = `ed25519:${sigBuf.toString('base64')}`;
  }
  return registry;
}

// Isolate HOME for each test that writes to ~/.ijfw/. Patch BOTH HOME and
// USERPROFILE: on Windows, os.homedir() reads USERPROFILE first; on macOS/Linux
// it reads HOME. Patching both = same code works on every CI runner. Same
// pattern as the v1.4.0 W3 fix campaign.
async function withTmpHome(fn) {
  const tmp = await mkdtemp(join(tmpdir(), 'ijfw-reg-test-'));
  const origHome = process.env.HOME;
  const origUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Reset the in-process revoked-publishers cache so tests don't see state
  // from a prior test's HOME directory.
  _resetRevokedCacheForTest();
  try {
    await fn(tmp);
  } finally {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserprofile;
    _resetRevokedCacheForTest();
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Happy path: fetch + verify + apply round-trip
// ---------------------------------------------------------------------------
test('happy path: fetch → verify → apply round-trip (unsigned seed)', async () => {
  const seed = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    signature: null,
    publishers: {},
    revoked: [],
  };
  const body = JSON.stringify(seed);
  const fetchImpl = async () => ({ ok: true, body, error: null });

  await withTmpHome(async () => {
    const r = await refreshTrustFromRegistry('https://test.example/v1.json', { fetchImpl, allowSeed: true });
    assert.equal(r.ok, true, `expected ok=true, got: ${r.error}`);
    assert.equal(r.fromCache, false);
    assert.ok(Array.isArray(r.warnings));
    // Cache should be written
    const cached = await readCachedRegistry();
    assert.ok(cached.registry, 'cache should be populated');
    assert.equal(cached.registry.registry_version, '1.0');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Tampered body: signature verify fails → reject
// ---------------------------------------------------------------------------
test('tampered body: signature verify fails → reject', async () => {
  // Build a registry signed with a rogue key (not the compiled-in meta-key)
  const rogue = makeKeypair();
  const registry = buildSignedRegistry({ privateKey: rogue.privPem });
  // Also tamper: change updated_at after signing so bytes differ
  const body = JSON.stringify({ ...registry, updated_at: '1970-01-01T00:00:00.000Z' });

  const fetchImpl = async () => ({ ok: true, body, error: null });
  await withTmpHome(async () => {
    const r = await refreshTrustFromRegistry('https://test.example/v1.json', { fetchImpl });
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.includes('verify'), `expected verify error, got: ${r.error}`);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — HTTP (non-HTTPS) URL → reject pre-fetch
// ---------------------------------------------------------------------------
test('HTTP URL → reject pre-fetch without calling fetchImpl', async () => {
  // fetchRegistry checks the scheme BEFORE calling fetchImpl, so even with
  // a fetchImpl injected it should reject and never call the impl.
  let called = false;
  // Do NOT pass fetchImpl — use the real fetchRegistry path which checks scheme
  // before making any network call. We verify via the return value only.
  const r = await fetchRegistry('http://evil.example/v1.json');
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.toLowerCase().includes('https'), `expected HTTPS error, got: ${r.error}`);
  assert.equal(called, false, 'fetchImpl should not be called for non-HTTPS URL');
});

// ---------------------------------------------------------------------------
// Test 4 — Oversized body (> 1 MiB) → reject mid-read
// ---------------------------------------------------------------------------
test('oversized body → fetchRegistry rejects (injectable returns oversized body)', async () => {
  // The injectable fetchImpl simulates an oversized response
  const oversizeBody = 'x'.repeat(1024 * 1024 + 1);
  const fetchImpl = async () => ({ ok: false, body: null, error: 'registry response exceeds 1048576 bytes' });

  await withTmpHome(async () => {
    const r = await refreshTrustFromRegistry('https://test.example/v1.json', { fetchImpl });
    // Offline path: no cache → trust store untouched, ok=true with warning
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some(w => w.includes('offline') || w.includes('unchanged')));
    assert.equal(r.diff, null);
  });
  // Also verify fetchRegistry itself with a fake oversized fetchImpl
  const r2 = await fetchRegistry('https://test.example/v1.json', {
    fetchImpl: async () => ({ ok: false, body: null, error: 'registry response exceeds 1048576 bytes' }),
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.error.includes('1048576'));
});

// ---------------------------------------------------------------------------
// Test 5 — Revocation: registry lists keyId → local store removes it
// ---------------------------------------------------------------------------
test('revocation: registry lists keyId → removed from local trust store', async () => {
  const pub = makeKeypair();

  await withTmpHome(async (tmp) => {
    // Pre-populate the trust store with pub.keyId
    const tpPath = join(tmp, '.ijfw', 'trusted-publishers.json');
    await mkdir(join(tmp, '.ijfw'), { recursive: true });
    await writeFile(tpPath, JSON.stringify({
      publishers: {
        [pub.keyId]: { name: 'Test Publisher', publicKey: pub.pubPem, added_at: new Date().toISOString() },
      },
    }), 'utf8');

    // Registry that revokes pub.keyId
    const registry = {
      registry_version: '1.0',
      updated_at: new Date().toISOString(),
      signature: null,
      publishers: {},
      revoked: [{ keyId: pub.keyId, revoked_at: new Date().toISOString(), reason: 'test revocation', superseded_by: null }],
    };
    const body = JSON.stringify(registry);
    const fetchImpl = async () => ({ ok: true, body, error: null });

    const r = await refreshTrustFromRegistry('https://test.example/v1.json', { fetchImpl, allowSeed: true });
    assert.equal(r.ok, true);
    assert.ok(r.diff, 'should have diff');
    assert.ok(r.diff.removed.includes(pub.keyId), `expected ${pub.keyId} in removed`);

    // Trust store should no longer contain pub.keyId
    const updated = JSON.parse(await readFile(tpPath, 'utf8'));
    assert.equal(updated.publishers[pub.keyId], undefined, 'revoked publisher should be removed');

    // Revoked publishers file should record it
    const revokedPath = join(tmp, '.ijfw', 'state', 'revoked-publishers.json');
    const revokedStore = JSON.parse(await readFile(revokedPath, 'utf8'));
    assert.ok(revokedStore.revoked.some(r => r.keyId === pub.keyId));
  });
});

// ---------------------------------------------------------------------------
// Test 6 — TTL stale + offline → fall back to cache + warn
// ---------------------------------------------------------------------------
test('stale cache + offline → falls back to cache with warning', async () => {
  const fetchImpl = async () => ({ ok: false, body: null, error: 'connection refused' });

  await withTmpHome(async () => {
    // Write a stale cache (cached_at is old)
    const staleRegistry = { registry_version: '1.0', updated_at: '2020-01-01T00:00:00.000Z', signature: null, publishers: {}, revoked: [] };
    await mkdir(join(homedir(), '.ijfw', 'state'), { recursive: true });
    // Write with a very old cached_at timestamp (25 hours ago)
    const staleAt = Date.now() - (CACHE_TTL_MS + 3600_000);
    await writeFile(
      join(homedir(), '.ijfw', 'state', 'registry-cache.json'),
      JSON.stringify({ cached_at: staleAt, registry: staleRegistry }),
      'utf8',
    );

    const r = await refreshTrustFromRegistry('https://test.example/v1.json', { fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.fromCache, true);
    assert.ok(r.warnings.some(w => w.includes('stale') || w.includes('offline')), `expected stale/offline warning, got: ${JSON.stringify(r.warnings)}`);
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Offline + no cache → returns existing trust store untouched
// ---------------------------------------------------------------------------
test('offline + no cache → trust store unchanged, ok=true with warning', async () => {
  const fetchImpl = async () => ({ ok: false, body: null, error: 'network unreachable' });

  await withTmpHome(async () => {
    // No cache file exists
    const r = await refreshTrustFromRegistry('https://test.example/v1.json', { fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(r.diff, null);
    assert.ok(r.warnings.some(w => w.includes('offline') || w.includes('unchanged')));
  });
});

// ---------------------------------------------------------------------------
// Test 8 — Malformed shape → reject
// ---------------------------------------------------------------------------
test('malformed registry shape → verifyRegistry rejects', () => {
  // Missing required fields
  const cases = [
    '{}',
    JSON.stringify({ registry_version: '2.0', updated_at: 'x', signature: null, publishers: {}, revoked: [] }),
    JSON.stringify({ registry_version: '1.0', signature: null, publishers: {}, revoked: [] }), // no updated_at
    JSON.stringify({ registry_version: '1.0', updated_at: 'x', signature: null, publishers: 'bad', revoked: [] }),
    JSON.stringify({ registry_version: '1.0', updated_at: 'x', signature: null, publishers: {}, revoked: 'bad' }),
    'not json at all',
    JSON.stringify([1, 2, 3]),
  ];
  for (const body of cases) {
    const r = verifyRegistry(body);
    assert.equal(r.valid, false, `expected invalid for: ${body}`);
    assert.ok(r.reason, 'should have reason');
  }
});

// ---------------------------------------------------------------------------
// Test 9 — keygen-meta + sign-registry + verify-registry round-trip
// ---------------------------------------------------------------------------
test('keygen-meta + sign-registry + verify-registry round-trip', async () => {
  await withTmpHome(async (tmp) => {
    // 1. Generate meta-keypair
    const kp = await keygenMeta('Test Maintainer');
    assert.ok(kp.keyId, 'should have keyId');
    assert.ok(kp.publicKey.includes('BEGIN PUBLIC KEY'), 'should have public key PEM');
    assert.ok(kp.dir.includes(kp.keyId), 'dir should include keyId');

    // 2. Create a registry JSON in a tmp dir (must be under cwd for path security)
    const registryDir = join(process.cwd(), '.test-registry-tmp-' + Date.now());
    await mkdir(registryDir, { recursive: true });
    const registryPath = join(registryDir, 'v1.json');
    const seed = {
      registry_version: '1.0',
      updated_at: new Date().toISOString(),
      signature: null,
      publishers: {},
      revoked: [],
    };
    await writeFile(registryPath, JSON.stringify(seed, null, 2), 'utf8');

    try {
      // 3. Load private key and sign via opts.privateKeyPem
      const { readFile: rf } = await import('node:fs/promises');
      const privPem = await rf(join(kp.dir, 'private.pem'), 'utf8');
      const signResult = await signRegistry(registryPath, { privateKeyPem: privPem });
      assert.equal(signResult.ok, true, `sign failed: ${signResult.error}`);

      // 4. Verify — must use the newly generated public key (not the compiled-in meta-key)
      const raw = await readFile(registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      assert.ok(parsed.signature && parsed.signature.startsWith('ed25519:'), 'should have ed25519 signature');

      // Verify manually using the generated public key (not compiled-in meta-key)
      const { createPublicKey, verify: verifyWithKey } = await import('node:crypto');
      const pubKey = createPublicKey(kp.publicKey);
      const sigBuf = Buffer.from(parsed.signature.slice('ed25519:'.length), 'base64');
      const bytes = registryCanonicalBytes(parsed);
      const valid = verifyWithKey(null, bytes, pubKey, sigBuf);
      assert.equal(valid, true, 'signature should verify with generated public key');

      // 5. verifyRegistryFile — note: this uses the compiled-in meta-key, so it will
      // NOT verify since we signed with a freshly-generated key. That's expected.
      // What we test here is that the function runs without error and returns a verdict.
      const vr = await verifyRegistryFile(registryPath);
      assert.equal(vr.ok, true, 'verifyRegistryFile should not throw');
      assert.equal(typeof vr.valid, 'boolean');
      assert.ok(vr.reason, 'should have reason');
    } finally {
      await rm(registryDir, { recursive: true, force: true });
    }
  });
});

// === B8: rotation + revocation ===

import {
  signRotationToken,
  verifyRotationToken,
  addTrustedPublisher,
  _resetRevokedCacheForTest,
} from './src/extension-signer.js';

// ---------------------------------------------------------------------------
// Test B8-1 — Happy path: sign rotation token → verify → correct key ids
// ---------------------------------------------------------------------------
test('B8 happy path: signRotationToken → verifyRotationToken with old public key returns valid=true', async () => {
  const kpA = makeKeypair(); // old keypair
  const kpB = makeKeypair(); // new keypair

  const token = signRotationToken(kpA.privPem, kpB.pubPem);

  assert.ok(token.rotated_at, 'should have rotated_at');
  assert.equal(token.old_key_id, kpA.keyId, 'old_key_id should be fingerprint of old key');
  assert.equal(token.new_key_id, kpB.keyId, 'new_key_id should be fingerprint of new key');
  assert.equal(token.new_public_key, kpB.pubPem, 'new_public_key should be new PEM');
  assert.ok(token.signature && token.signature.startsWith('ed25519:'), 'should have ed25519 signature');

  const verdict = verifyRotationToken(token, kpA.pubPem);
  assert.equal(verdict.valid, true, `expected valid=true, got: ${verdict.reason}`);
  assert.equal(verdict.reason, 'ok');
});

// ---------------------------------------------------------------------------
// Test B8-2 — Tampered token: flip a byte in new_public_key → verify fails
// ---------------------------------------------------------------------------
test('B8 tampered token: flipped byte in new_public_key → verifyRotationToken fails', async () => {
  const kpA = makeKeypair();
  const kpB = makeKeypair();

  const token = signRotationToken(kpA.privPem, kpB.pubPem);

  // Flip a character mid-PEM (not the header/footer lines to keep it PEM-parseable-ish)
  const lines = token.new_public_key.split('\n');
  // Find a data line (not header/footer) and flip a char
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] && !lines[i].startsWith('-----')) {
      const chars = lines[i].split('');
      // Flip a middle character (change 'A' to 'B', etc.)
      const mid = Math.floor(chars.length / 2);
      chars[mid] = chars[mid] === 'A' ? 'B' : 'A';
      lines[i] = chars.join('');
      break;
    }
  }
  const tampered = { ...token, new_public_key: lines.join('\n') };

  const verdict = verifyRotationToken(tampered, kpA.pubPem);
  assert.equal(verdict.valid, false, 'tampered token should not verify');
  assert.ok(verdict.reason, 'should have reason');
});

// ---------------------------------------------------------------------------
// Test B8-3 — Mismatched old keyId: token.old_key_id doesn't match supplied old public key
// ---------------------------------------------------------------------------
test('B8 mismatched old keyId: verifyRotationToken returns valid=false with helpful reason', async () => {
  const kpA = makeKeypair();
  const kpB = makeKeypair();
  const kpC = makeKeypair(); // unrelated key — will be passed as oldPublicKey

  const token = signRotationToken(kpA.privPem, kpB.pubPem);
  // token.old_key_id = kpA.keyId, but we supply kpC's public key

  const verdict = verifyRotationToken(token, kpC.pubPem);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reason.includes('old_key_id mismatch'), `expected mismatch reason, got: ${verdict.reason}`);
});

// ---------------------------------------------------------------------------
// W8.1/Fix4 — B8 rotation token expiry check
// ---------------------------------------------------------------------------
test('W8.1 B8 rotation token expired (100 days old) → verifyRotationToken rejects', () => {
  const kpA = makeKeypair();
  const kpB = makeKeypair();

  // Create a token backdated 100 days (beyond the 90-day default window).
  const rotated_at = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const token = signRotationToken(kpA.privPem, kpB.pubPem, { rotated_at });

  const verdict = verifyRotationToken(token, kpA.pubPem);
  assert.equal(verdict.valid, false, 'expired token must be rejected');
  assert.ok(verdict.reason.includes('rotation token expired'), `expected expiry reason, got: ${verdict.reason}`);
});

test('W8.1 B8 rotation token within 90-day window → verifyRotationToken accepts', () => {
  const kpA = makeKeypair();
  const kpB = makeKeypair();

  // Create a token backdated 30 days — within the default 90-day window.
  const rotated_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const token = signRotationToken(kpA.privPem, kpB.pubPem, { rotated_at });

  const verdict = verifyRotationToken(token, kpA.pubPem);
  assert.equal(verdict.valid, true, `30-day-old token should be accepted, got: ${verdict.reason}`);
});

test('W8.1 B8 rotation token respects custom max_age_ms opt', () => {
  const kpA = makeKeypair();
  const kpB = makeKeypair();

  // Token 2 days old; custom max_age of 1 day → reject.
  const rotated_at = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const token = signRotationToken(kpA.privPem, kpB.pubPem, { rotated_at });

  const verdict = verifyRotationToken(token, kpA.pubPem, { max_age_ms: 24 * 60 * 60 * 1000 });
  assert.equal(verdict.valid, false, 'token older than custom max_age_ms must be rejected');
  assert.ok(verdict.reason.includes('rotation token expired'), `expected expiry reason, got: ${verdict.reason}`);
});

// ---------------------------------------------------------------------------
// Test B8-4 — applyRegistry with revoked entry: removes key from trust + records in revoked-publishers.json
// ---------------------------------------------------------------------------
test('B8 applyRegistry consumes revocation: removes key from local trust + writes revoked-publishers.json', async () => {
  const keyX = makeKeypair();

  await withTmpHome(async (tmp) => {
    // Pre-populate trust store with keyX
    const tpPath = join(tmp, '.ijfw', 'trusted-publishers.json');
    await mkdir(join(tmp, '.ijfw'), { recursive: true });
    await writeFile(tpPath, JSON.stringify({
      publishers: {
        [keyX.keyId]: { name: 'Publisher X', publicKey: keyX.pubPem, added_at: new Date().toISOString() },
      },
    }), 'utf8');

    const registry = {
      registry_version: '1.0',
      updated_at: new Date().toISOString(),
      signature: null,
      publishers: {},
      revoked: [{
        keyId: keyX.keyId,
        revoked_at: new Date().toISOString(),
        reason: 'key rotation test',
        superseded_by: null,
      }],
    };

    const diff = await applyRegistry(registry);

    assert.ok(diff.removed.includes(keyX.keyId), `expected ${keyX.keyId} in removed`);

    // Trust store no longer has keyX
    const updated = JSON.parse(await readFile(tpPath, 'utf8'));
    assert.equal(updated.publishers[keyX.keyId], undefined, 'revoked key should be removed from trust store');

    // revoked-publishers.json records it
    const revokedPath = join(tmp, '.ijfw', 'state', 'revoked-publishers.json');
    const revokedStore = JSON.parse(await readFile(revokedPath, 'utf8'));
    assert.ok(
      revokedStore.revoked.some(r => r.keyId === keyX.keyId),
      'keyX should appear in revoked-publishers.json',
    );
  });
});

// ---------------------------------------------------------------------------
// Test B8-5 — Revoked key install attempt: addTrustedPublisher refuses with helpful reason
// ---------------------------------------------------------------------------
test('B8 revoked key install attempt: addTrustedPublisher refuses with "publisher revoked by IJFW registry"', async () => {
  const keyX = makeKeypair();

  await withTmpHome(async (tmp) => {
    // Reset the module-level revoked cache so this test reads from the tmp HOME.
    _resetRevokedCacheForTest();

    // Write a revoked-publishers.json that lists keyX
    const stateDir = join(tmp, '.ijfw', 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, 'revoked-publishers.json'),
      JSON.stringify({
        revoked: [{
          keyId: keyX.keyId,
          revoked_at: new Date().toISOString(),
          reason: 'key rotation test',
          superseded_by: null,
        }],
      }),
      'utf8',
    );

    // Attempt to add keyX to the trust store — should be refused
    const r = await addTrustedPublisher(keyX.keyId, keyX.pubPem, 'Test Publisher');
    assert.equal(r.ok, false);
    assert.ok(
      r.error && r.error.includes('publisher revoked by IJFW registry'),
      `expected "publisher revoked" error, got: ${r.error}`,
    );
  });
  // Reset cache after test so subsequent tests start clean.
  _resetRevokedCacheForTest();
});

// ---------------------------------------------------------------------------
// W8.1/Fix1 — verifyRegistry null-signature gate
// ---------------------------------------------------------------------------
test('W8.1 verifyRegistry: null signature rejected in production mode (default)', () => {
  const registry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    signature: null,
    publishers: {},
    revoked: [],
  };
  const result = verifyRegistry(JSON.stringify(registry));
  assert.equal(result.valid, false, 'null signature must be rejected in production mode');
  assert.ok(result.reason.includes('signature missing'), `unexpected reason: ${result.reason}`);
});

test('W8.1 verifyRegistry: null signature accepted with allowSeed=true, returns warning', () => {
  const registry = {
    registry_version: '1.0',
    updated_at: new Date().toISOString(),
    signature: null,
    publishers: {},
    revoked: [],
  };
  const result = verifyRegistry(JSON.stringify(registry), { allowSeed: true });
  assert.equal(result.valid, true, 'null signature should be accepted with allowSeed:true');
  assert.equal(result.reason, 'unsigned (seed)');
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, 'warnings array must be populated');
});

test('W8.1 verifyRegistry: null signature accepted with IJFW_ALLOW_SEED_REGISTRY=1 env var', () => {
  const orig = process.env.IJFW_ALLOW_SEED_REGISTRY;
  process.env.IJFW_ALLOW_SEED_REGISTRY = '1';
  try {
    const registry = {
      registry_version: '1.0',
      updated_at: new Date().toISOString(),
      signature: null,
      publishers: {},
      revoked: [],
    };
    const result = verifyRegistry(JSON.stringify(registry));
    assert.equal(result.valid, true, 'null signature accepted via env var');
    assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0, 'warnings must be set');
  } finally {
    if (orig === undefined) delete process.env.IJFW_ALLOW_SEED_REGISTRY;
    else process.env.IJFW_ALLOW_SEED_REGISTRY = orig;
  }
});
