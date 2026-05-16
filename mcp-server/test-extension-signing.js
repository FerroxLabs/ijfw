#!/usr/bin/env node
/**
 * test-extension-signing.js -- IJFW 1.4.0 W7/B1
 *
 * Ed25519 publisher signing tests. Covers:
 *   - keypair generation + key file modes
 *   - signManifest / verifyManifestSignature round-trip
 *   - rejection of wrong-key, tampered-body, untrusted-publisher, malformed inputs
 *   - addTrustedPublisher / removeTrustedPublisher
 *   - install gate: unsigned without --allow-unsigned, unsigned with flag,
 *     signed-but-untrusted without --accept-untrusted
 *
 * HOME isolation: every test swaps process.env.HOME to a fresh mkdtemp dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  computeIntegrity,
  generatePublisherKeypair,
  loadPublisherKeypair,
  signManifest,
  verifyManifestSignature,
  readTrustedPublishers,
  addTrustedPublisher,
  removeTrustedPublisher,
  publicKeyFingerprint,
} from './src/extension-signer.js';
import { installExtension } from './src/extension-installer.js';
import {
  _resetCache as resetLensCache,
  _setCache as setLensCache,
} from './src/trident/lens-health.js';

const KEYID_RE = /^[a-f0-9]{64}$/;
const ED25519_SIG_RE = /^ed25519:[A-Za-z0-9+/=]+$/;

function baseManifest(overrides = {}) {
  return {
    schema_version: '1.0',
    name: 'demo-ext',
    version: '1.0.0',
    type: 'skill-only',
    skills: [{ name: 'hello', file: 'skills/hello.md' }],
    permissions: { reads: ['./README.md'], writes: ['memory:write'] },
    ...overrides,
  };
}

async function withIsolatedHome(label, fn) {
  const home = await mkdtemp(join(tmpdir(), `ijfw-sig-${label}-`));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    process.env.HOME = prev;
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

function seedLensesLive() {
  resetLensCache();
  const ts = Date.now();
  setLensCache('codex', { live: true, latency_ms: 0, error: null }, ts);
  setLensCache('gemini', { live: true, latency_ms: 0, error: null }, ts);
}

function makeTridentStub(verdict = 'PASS') {
  return async ({ lens }) => ({
    lens,
    verdict,
    findings: [],
    latency_ms: 0,
    note: `b1-stub:${verdict}`,
  });
}

async function writeValidExtensionLayout(dir, manifest) {
  await mkdir(join(dir, 'skills'), { recursive: true });
  await writeFile(
    join(dir, 'skills', 'hello.md'),
    '# Hello\n\nThis skill is benign and contains no secrets.\n',
    'utf8',
  );
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

// --- keypair generation ----------------------------------------------------

test('generatePublisherKeypair produces a well-formed Ed25519 keypair', async () => {
  await withIsolatedHome('keygen', async (home) => {
    const kp = await generatePublisherKeypair('alice');
    assert.ok(KEYID_RE.test(kp.keyId), `keyId must be sha256 hex, got ${kp.keyId}`);
    assert.ok(kp.publicKey.includes('BEGIN PUBLIC KEY'), 'publicKey must be PEM');
    assert.ok(kp.privateKey.includes('BEGIN PRIVATE KEY'), 'privateKey must be PEM');
    // Fingerprint of the public key must equal the returned keyId.
    assert.equal(publicKeyFingerprint(kp.publicKey), kp.keyId);
    // Files exist with restrictive private-key mode.
    const privPath = join(home, '.ijfw', 'keys', kp.keyId, 'private.pem');
    const pubPath = join(home, '.ijfw', 'keys', kp.keyId, 'public.pem');
    const st = await stat(privPath);
    // On POSIX the mode should be 0600 (or close — at least no world-readable).
    if (process.platform !== 'win32') {
      const mode = st.mode & 0o777;
      assert.equal(mode & 0o077, 0, `private.pem must not be group/world-readable (got 0${mode.toString(8)})`);
    }
    const pubExists = await stat(pubPath).then(() => true).catch(() => false);
    assert.equal(pubExists, true);
  });
});

test('loadPublisherKeypair round-trips after generate', async () => {
  await withIsolatedHome('load', async () => {
    const kp = await generatePublisherKeypair('bob');
    const loaded = await loadPublisherKeypair(kp.keyId);
    assert.ok(loaded, 'must load');
    assert.equal(loaded.keyId, kp.keyId);
    assert.equal(loaded.publicKey.trim(), kp.publicKey.trim());
    assert.equal(loaded.privateKey.trim(), kp.privateKey.trim());
  });
});

test('loadPublisherKeypair returns null for unknown keyId', async () => {
  await withIsolatedHome('load-miss', async () => {
    const loaded = await loadPublisherKeypair('a'.repeat(64));
    assert.equal(loaded, null);
  });
});

test('loadPublisherKeypair rejects malformed keyId', async () => {
  await withIsolatedHome('load-bad', async () => {
    const loaded = await loadPublisherKeypair('../../etc/passwd');
    assert.equal(loaded, null);
  });
});

// --- sign / verify round-trip ---------------------------------------------

test('signManifest + verifyManifestSignature round-trip is valid', async () => {
  await withIsolatedHome('roundtrip', async () => {
    const kp = await generatePublisherKeypair('alice');
    await addTrustedPublisher(kp.keyId, kp.publicKey, 'alice');
    const signed = signManifest(baseManifest(), kp.privateKey);
    assert.ok(ED25519_SIG_RE.test(signed.signature), `signature must be ed25519:<base64>, got ${signed.signature}`);
    assert.equal(signed.publisher_key_id, kp.keyId);
    const trusted = await readTrustedPublishers();
    const v = verifyManifestSignature(signed, trusted);
    assert.equal(v.valid, true, `verify failed: ${v.reason}`);
    assert.equal(v.publisherKeyId, kp.keyId);
  });
});

test('verifyManifestSignature: WRONG key in trusted store fails', async () => {
  await withIsolatedHome('wrong-key', async () => {
    const alice = await generatePublisherKeypair('alice');
    const eve = await generatePublisherKeypair('eve');
    const signedByAlice = signManifest(baseManifest(), alice.privateKey);
    // Tamper the trusted store so the keyId points to eve's public key.
    // The fingerprint mismatch must be detected.
    await writeFile(
      join(process.env.HOME, '.ijfw', 'trusted-publishers.json'),
      JSON.stringify({ publishers: { [alice.keyId]: { name: 'alice', publicKey: eve.publicKey } } }),
      'utf8',
    );
    const trusted = await readTrustedPublishers();
    const v = verifyManifestSignature(signedByAlice, trusted);
    assert.equal(v.valid, false);
    assert.match(v.reason, /publicKey|fingerprint|not trusted|filter/i);
  });
});

test('verifyManifestSignature: TAMPERED body fails', async () => {
  await withIsolatedHome('tamper', async () => {
    const kp = await generatePublisherKeypair('alice');
    await addTrustedPublisher(kp.keyId, kp.publicKey, 'alice');
    const signed = signManifest(baseManifest(), kp.privateKey);
    const tampered = { ...signed, name: 'evil-rename' };
    const trusted = await readTrustedPublishers();
    const v = verifyManifestSignature(tampered, trusted);
    assert.equal(v.valid, false);
    assert.match(v.reason, /signature does not verify|verify failed/i);
  });
});

test('verifyManifestSignature: missing signature → invalid', async () => {
  await withIsolatedHome('missing-sig', async () => {
    const v = verifyManifestSignature(baseManifest(), { publishers: {} });
    assert.equal(v.valid, false);
    assert.match(v.reason, /no signature/i);
  });
});

test('verifyManifestSignature: malformed signature shape → invalid', async () => {
  await withIsolatedHome('bad-shape', async () => {
    const v = verifyManifestSignature(
      { ...baseManifest(), signature: 'not-ed25519:xxx', publisher_key_id: 'a'.repeat(64) },
      { publishers: {} },
    );
    assert.equal(v.valid, false);
    assert.match(v.reason, /signature shape invalid/i);
  });
});

test('verifyManifestSignature: untrusted publisher_key_id → invalid', async () => {
  await withIsolatedHome('untrusted', async () => {
    const kp = await generatePublisherKeypair('alice');
    // Do NOT call addTrustedPublisher.
    const signed = signManifest(baseManifest(), kp.privateKey);
    const trusted = await readTrustedPublishers();
    const v = verifyManifestSignature(signed, trusted);
    assert.equal(v.valid, false);
    assert.match(v.reason, /not trusted/i);
    assert.equal(v.publisherKeyId, kp.keyId);
  });
});

// --- trusted-publishers store ---------------------------------------------

test('addTrustedPublisher persists and readTrustedPublishers returns it', async () => {
  await withIsolatedHome('add', async () => {
    const kp = await generatePublisherKeypair('alice');
    const r = await addTrustedPublisher(kp.keyId, kp.publicKey, 'alice');
    assert.equal(r.ok, true);
    const store = await readTrustedPublishers();
    assert.ok(store.publishers[kp.keyId], 'publisher should be present');
    assert.equal(store.publishers[kp.keyId].name, 'alice');
  });
});

test('addTrustedPublisher rejects keyId/publicKey fingerprint mismatch', async () => {
  await withIsolatedHome('mismatch', async () => {
    const alice = await generatePublisherKeypair('alice');
    const eve = await generatePublisherKeypair('eve');
    const r = await addTrustedPublisher(alice.keyId, eve.publicKey, 'alice');
    assert.equal(r.ok, false);
    assert.match(r.error, /fingerprint|does not match/i);
  });
});

test('addTrustedPublisher rejects malformed keyId', async () => {
  await withIsolatedHome('bad-kid', async () => {
    const r = await addTrustedPublisher('not-hex', 'whatever', 'alice');
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid keyId/i);
  });
});

test('removeTrustedPublisher is idempotent', async () => {
  await withIsolatedHome('remove', async () => {
    const kp = await generatePublisherKeypair('alice');
    await addTrustedPublisher(kp.keyId, kp.publicKey, 'alice');
    const r1 = await removeTrustedPublisher(kp.keyId);
    assert.equal(r1.ok, true);
    assert.equal(r1.removed, true);
    const r2 = await removeTrustedPublisher(kp.keyId);
    assert.equal(r2.ok, true);
    assert.equal(r2.removed, false);
  });
});

// --- install gate (signature integration) ---------------------------------

test('installExtension: UNSIGNED manifest is REJECTED by default', async () => {
  await withIsolatedHome('install-unsigned', async (home) => {
    const ext = await mkdtemp(join(tmpdir(), 'b1-unsigned-ext-'));
    const proj = await mkdtemp(join(tmpdir(), 'b1-unsigned-proj-'));
    const unsigned = computeIntegrity(baseManifest({ name: 'unsigned-ext' }));
    await writeValidExtensionLayout(ext, unsigned);
    seedLensesLive();
    const r = await installExtension(ext, {
      projectRoot: proj,
      scope: 'project',
      tridentExecutor: makeTridentStub('PASS'),
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /unsigned|--allow-unsigned/i.test(e)),
      `expected unsigned-rejected, got: ${JSON.stringify(r.errors)}`);
    await rm(ext, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });
});

test('installExtension: UNSIGNED manifest is ACCEPTED with allowUnsigned: true', async () => {
  await withIsolatedHome('install-unsigned-ok', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'b1-unsigned2-ext-'));
    const proj = await mkdtemp(join(tmpdir(), 'b1-unsigned2-proj-'));
    const unsigned = computeIntegrity(baseManifest({ name: 'allow-unsigned-ext' }));
    await writeValidExtensionLayout(ext, unsigned);
    seedLensesLive();
    const r = await installExtension(ext, {
      projectRoot: proj,
      scope: 'project',
      allowUnsigned: true,
      tridentExecutor: makeTridentStub('PASS'),
    });
    assert.equal(r.ok, true, `expected install ok, got errors: ${JSON.stringify(r.errors || [])}`);
    await rm(ext, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });
});

test('installExtension: SIGNED-BUT-UNTRUSTED manifest is REJECTED by default with keyId hint', async () => {
  await withIsolatedHome('install-untrusted', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'b1-untrusted-ext-'));
    const proj = await mkdtemp(join(tmpdir(), 'b1-untrusted-proj-'));
    // Sign with a fresh key but do NOT add it to the trusted-publishers store.
    const kp = await generatePublisherKeypair('eve');
    const signed = signManifest(baseManifest({ name: 'untrusted-ext' }), kp.privateKey);
    await removeTrustedPublisher(kp.keyId); // ensure not in store
    await writeValidExtensionLayout(ext, signed);
    seedLensesLive();
    const r = await installExtension(ext, {
      projectRoot: proj,
      scope: 'project',
      tridentExecutor: makeTridentStub('PASS'),
    });
    assert.equal(r.ok, false);
    const joined = (r.errors || []).join('\n');
    assert.match(joined, /not trusted|ijfw extension trust|verify failed/i,
      `expected untrusted-publisher rejection with hint, got: ${joined}`);
    assert.ok(joined.includes(kp.keyId), `expected error to mention keyId ${kp.keyId.slice(0, 8)}…`);
    await rm(ext, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });
});

test('installExtension: SIGNED-AND-TRUSTED manifest installs cleanly', async () => {
  await withIsolatedHome('install-trusted', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'b1-trusted-ext-'));
    const proj = await mkdtemp(join(tmpdir(), 'b1-trusted-proj-'));
    const kp = await generatePublisherKeypair('alice');
    await addTrustedPublisher(kp.keyId, kp.publicKey, 'alice');
    const signed = signManifest(baseManifest({ name: 'trusted-ext' }), kp.privateKey);
    await writeValidExtensionLayout(ext, signed);
    seedLensesLive();
    const r = await installExtension(ext, {
      projectRoot: proj,
      scope: 'project',
      tridentExecutor: makeTridentStub('PASS'),
    });
    assert.equal(r.ok, true, `expected install ok, got errors: ${JSON.stringify(r.errors || [])}`);
    await rm(ext, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });
});

test('installExtension: SIGNED-BUT-UNTRUSTED installs WITH acceptUntrusted: true', async () => {
  await withIsolatedHome('install-accept-untrusted', async () => {
    const ext = await mkdtemp(join(tmpdir(), 'b1-accept-ext-'));
    const proj = await mkdtemp(join(tmpdir(), 'b1-accept-proj-'));
    const kp = await generatePublisherKeypair('mallory');
    const signed = signManifest(baseManifest({ name: 'accept-untrusted-ext' }), kp.privateKey);
    await writeValidExtensionLayout(ext, signed);
    seedLensesLive();
    const r = await installExtension(ext, {
      projectRoot: proj,
      scope: 'project',
      acceptUntrusted: true,
      tridentExecutor: makeTridentStub('PASS'),
    });
    assert.equal(r.ok, true, `expected install ok with acceptUntrusted, got: ${JSON.stringify(r.errors || [])}`);
    await rm(ext, { recursive: true, force: true });
    await rm(proj, { recursive: true, force: true });
  });
});
