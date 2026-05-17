#!/usr/bin/env node
/**
 * test-hardware-signer.js — IJFW v1.4.3 W9-A2 / B15
 *
 * Coverage for the backend abstraction + ssh-agent signing path.
 *
 * Strategy:
 *   - Pure-Node mock SSH agent. No external `ssh-agent` binary; no host
 *     keyring dependency. The mock listens on a tmp UNIX socket and
 *     implements only the two operations we use:
 *       SSH2_AGENTC_REQUEST_IDENTITIES → list of (pubkey-blob, comment)
 *       SSH2_AGENTC_SIGN_REQUEST       → Ed25519 sig over the requested payload
 *   - HOME isolation: both process.env.HOME and process.env.USERPROFILE are
 *     swapped to a mkdtemp dir per test (Windows reads USERPROFILE).
 *   - Fixture Ed25519 keypair generated per test via node:crypto.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  createPublicKey,
  createPrivateKey,
} from 'node:crypto';

import {
  SOFTWARE_BACKEND,
  SSH_AGENT_BACKEND,
  resolveBackend,
  publicKeyFingerprint,
  pubkeyBlobFromPem,
  _testInternals,
} from './src/hardware-signer.js';
import { validateExtensionManifest } from './src/extension-manifest-schema.js';
import {
  signManifestWithBackend,
  signManifest,
  verifyManifestSignature,
} from './src/extension-signer.js';
import { handlers, subcommandHelp } from './src/dispatch/signer-cli.js';

const {
  sshWireString,
  readSshString,
  ed25519PubkeyBlob,
  SSH2_AGENTC_REQUEST_IDENTITIES,
  SSH2_AGENT_IDENTITIES_ANSWER,
  SSH2_AGENTC_SIGN_REQUEST,
  SSH2_AGENT_SIGN_RESPONSE,
} = _testInternals;

// ---------------------------------------------------------------------------
// Mock SSH agent ------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Spin up an in-process SSH agent on a tmp UNIX socket.
 *
 * @param {Array<{ pem: string, comment: string }>} identities
 *   Each identity supplies a PEM-encoded Ed25519 public+private key for the
 *   agent to enumerate and sign with. The mock derives the SSH wire pubkey
 *   blob from the PEM and signs with the matching private key.
 * @returns {Promise<{ socketPath: string, close: () => Promise<void> }>}
 */
async function startMockAgent(identities) {
  const dir = await mkdtemp(join(tmpdir(), 'ijfw-mock-agent-'));
  const socketPath = join(dir, 'agent.sock');

  // Precompute each identity's pubkey blob and parsed private key.
  const prepared = identities.map(({ pem, privatePem, comment }) => {
    const blob = pubkeyBlobFromPem(pem);
    const priv = createPrivateKey(privatePem);
    return { blob, comment, priv };
  });

  const server = net.createServer(socket => {
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      // Frame loop: uint32 length || payload.
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const payload = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        if (payload.length < 1) {
          socket.end();
          return;
        }
        const type = payload[0];
        if (type === SSH2_AGENTC_REQUEST_IDENTITIES) {
          // Response: type || uint32 count || (string blob || string comment) * count
          const count = Buffer.alloc(4);
          count.writeUInt32BE(prepared.length, 0);
          const parts = [Buffer.from([SSH2_AGENT_IDENTITIES_ANSWER]), count];
          for (const ident of prepared) {
            parts.push(sshWireString(ident.blob));
            parts.push(sshWireString(ident.comment));
          }
          const body = Buffer.concat(parts);
          const out = Buffer.alloc(4);
          out.writeUInt32BE(body.length, 0);
          socket.write(Buffer.concat([out, body]));
        } else if (type === SSH2_AGENTC_SIGN_REQUEST) {
          // Body: ssh-string(key_blob) || ssh-string(payload) || uint32 flags
          let off = 1;
          const keyBlobRead = readSshString(payload, off);
          off = keyBlobRead.next;
          const sigPayloadRead = readSshString(payload, off);
          off = sigPayloadRead.next;
          const keyBlob = keyBlobRead.value;
          const sigPayload = sigPayloadRead.value;
          const match = prepared.find(p => p.blob.equals(keyBlob));
          if (!match) {
            // SSH_AGENT_FAILURE
            const fail = Buffer.from([5]);
            const out = Buffer.alloc(4);
            out.writeUInt32BE(fail.length, 0);
            socket.write(Buffer.concat([out, fail]));
            return;
          }
          const rawSig = cryptoSign(null, sigPayload, match.priv);
          // Response body:
          //   type || ssh-string( ssh-string("ssh-ed25519") || ssh-string(raw64-sig) )
          const sigBlob = Buffer.concat([
            sshWireString('ssh-ed25519'),
            sshWireString(rawSig),
          ]);
          const body = Buffer.concat([
            Buffer.from([SSH2_AGENT_SIGN_RESPONSE]),
            sshWireString(sigBlob),
          ]);
          const out = Buffer.alloc(4);
          out.writeUInt32BE(body.length, 0);
          socket.write(Buffer.concat([out, body]));
        } else {
          // Unknown msg type — fail.
          const fail = Buffer.from([5]);
          const out = Buffer.alloc(4);
          out.writeUInt32BE(fail.length, 0);
          socket.write(Buffer.concat([out, fail]));
        }
      }
    });
    socket.on('error', () => { /* swallow */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    socketPath,
    async close() {
      await new Promise(res => server.close(() => res()));
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Generate a fresh Ed25519 fixture (public PEM + private PEM).
 */
function genFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem };
}

/**
 * Run `fn` with isolated HOME + USERPROFILE + SSH_AUTH_SOCK env, then
 * restore (including unsetting if originally unset).
 */
async function withIsolatedEnv(label, fn) {
  const home = await mkdtemp(join(tmpdir(), `ijfw-hwsig-${label}-`));
  const prev = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Default: no agent. Tests that need one set it themselves.
  delete process.env.SSH_AUTH_SOCK;
  try {
    await fn(home);
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeBackendJson(home, keyId, body) {
  const dir = join(home, '.ijfw', 'keys', keyId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'backend.json'), JSON.stringify(body, null, 2), 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// Tests ---------------------------------------------------------------------
// ---------------------------------------------------------------------------

test('resolveBackend: undefined → SOFTWARE_BACKEND', () => {
  assert.equal(resolveBackend(undefined), SOFTWARE_BACKEND);
});

test('resolveBackend: "software" → SOFTWARE_BACKEND', () => {
  assert.equal(resolveBackend('software'), SOFTWARE_BACKEND);
});

test('resolveBackend: "ssh-agent" → SSH_AGENT_BACKEND', () => {
  assert.equal(resolveBackend('ssh-agent'), SSH_AGENT_BACKEND);
});

test('resolveBackend: unknown name fails closed (SEC-L-02)', () => {
  assert.throws(
    () => resolveBackend('libfido2'),
    /Unsupported signing backend: libfido2/,
  );
  assert.throws(
    () => resolveBackend('Software'), // case-sensitive
    /Unsupported signing backend: Software/,
  );
});

test('schema: publisher_key_backend "ssh-agent" is valid', () => {
  const m = {
    schema_version: '1.0',
    name: 'demo',
    version: '1.0.0',
    type: 'skill-only',
    skills: [],
    permissions: { reads: [], writes: [] },
    integrity: 'sha256:' + 'a'.repeat(64),
    publisher_key_backend: 'ssh-agent',
  };
  const r = validateExtensionManifest(m);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('schema: publisher_key_backend "software" is valid', () => {
  const m = {
    schema_version: '1.0',
    name: 'demo',
    version: '1.0.0',
    type: 'skill-only',
    skills: [],
    permissions: { reads: [], writes: [] },
    integrity: 'sha256:' + 'a'.repeat(64),
    publisher_key_backend: 'software',
  };
  const r = validateExtensionManifest(m);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('schema: publisher_key_backend "libfido2" rejected', () => {
  const m = {
    schema_version: '1.0',
    name: 'demo',
    version: '1.0.0',
    type: 'skill-only',
    skills: [],
    permissions: { reads: [], writes: [] },
    integrity: 'sha256:' + 'a'.repeat(64),
    publisher_key_backend: 'libfido2',
  };
  const r = validateExtensionManifest(m);
  assert.equal(r.valid, false);
  assert.ok(
    r.errors.some(e => /publisher_key_backend/.test(e)),
    `expected publisher_key_backend error, got ${JSON.stringify(r.errors)}`,
  );
});

test('schema: missing publisher_key_backend is back-compat valid', () => {
  const m = {
    schema_version: '1.0',
    name: 'demo',
    version: '1.0.0',
    type: 'skill-only',
    skills: [],
    permissions: { reads: [], writes: [] },
    integrity: 'sha256:' + 'a'.repeat(64),
  };
  const r = validateExtensionManifest(m);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('ssh-agent backend: happy path — sign + verify with software backend (round-trip)', async () => {
  await withIsolatedEnv('happy', async (home) => {
    const fx = genFixture();
    const keyId = publicKeyFingerprint(fx.publicKeyPem);
    const agent = await startMockAgent([
      { pem: fx.publicKeyPem, privatePem: fx.privateKeyPem, comment: 'yubikey-prod' },
    ]);
    try {
      const blob = pubkeyBlobFromPem(fx.publicKeyPem);
      await writeBackendJson(home, keyId, {
        backend: 'ssh-agent',
        pubkey_blob_hex: blob.toString('hex'),
        keyId,
        ssh_key_comment: 'yubikey-prod',
      });
      const payload = Buffer.from('hello world');
      const sig = await SSH_AGENT_BACKEND.sign(payload, keyId, {
        home,
        socketPath: agent.socketPath,
      });
      assert.equal(sig.length, 64, 'Ed25519 raw sig must be 64 bytes');
      // Verify with software backend (any backend's Ed25519 sig is verifiable
      // with the raw public key).
      const ok = await SOFTWARE_BACKEND.verify(payload, sig, fx.publicKeyPem);
      assert.equal(ok, true);
    } finally {
      await agent.close();
    }
  });
});

test('ssh-agent backend: agent unavailable yields clear error', async () => {
  await withIsolatedEnv('no-agent', async (home) => {
    const fx = genFixture();
    const keyId = publicKeyFingerprint(fx.publicKeyPem);
    const blob = pubkeyBlobFromPem(fx.publicKeyPem);
    await writeBackendJson(home, keyId, {
      backend: 'ssh-agent',
      pubkey_blob_hex: blob.toString('hex'),
      keyId,
      ssh_key_comment: 'absent',
    });
    // SSH_AUTH_SOCK is deleted by withIsolatedEnv.
    await assert.rejects(
      SSH_AGENT_BACKEND.sign(Buffer.from('x'), keyId, { home }),
      /SSH agent not available/,
    );
  });
});

test('ssh-agent backend: key not in agent — selection-by-blob fails (SEC-H-03)', async () => {
  await withIsolatedEnv('missing-key', async (home) => {
    const expectedFx = genFixture();
    const otherFx = genFixture(); // agent serves THIS one — not expected
    const keyId = publicKeyFingerprint(expectedFx.publicKeyPem);
    const expectedBlob = pubkeyBlobFromPem(expectedFx.publicKeyPem);
    const agent = await startMockAgent([
      { pem: otherFx.publicKeyPem, privatePem: otherFx.privateKeyPem, comment: 'wrong-key' },
    ]);
    try {
      await writeBackendJson(home, keyId, {
        backend: 'ssh-agent',
        pubkey_blob_hex: expectedBlob.toString('hex'),
        keyId,
        ssh_key_comment: 'whatever-comment',
      });
      await assert.rejects(
        SSH_AGENT_BACKEND.sign(Buffer.from('x'), keyId, {
          home,
          socketPath: agent.socketPath,
        }),
        /SSH agent identity not found/,
      );
    } finally {
      await agent.close();
    }
  });
});

test('ssh-agent backend: ambiguous identities (duplicate blob) → error', async () => {
  await withIsolatedEnv('ambiguous', async (home) => {
    const fx = genFixture();
    const keyId = publicKeyFingerprint(fx.publicKeyPem);
    const blob = pubkeyBlobFromPem(fx.publicKeyPem);
    // Mock agent that lists the same blob twice with different comments —
    // a comment-based selector would still match the first one; the
    // blob-based selector must refuse to pick.
    const agent = await startMockAgent([
      { pem: fx.publicKeyPem, privatePem: fx.privateKeyPem, comment: 'dup-1' },
      { pem: fx.publicKeyPem, privatePem: fx.privateKeyPem, comment: 'dup-2' },
    ]);
    try {
      await writeBackendJson(home, keyId, {
        backend: 'ssh-agent',
        pubkey_blob_hex: blob.toString('hex'),
        keyId,
        ssh_key_comment: 'dup-1',
      });
      await assert.rejects(
        SSH_AGENT_BACKEND.sign(Buffer.from('x'), keyId, {
          home,
          socketPath: agent.socketPath,
        }),
        /Ambiguous SSH agent identities/,
      );
    } finally {
      await agent.close();
    }
  });
});

test('signManifestWithBackend: ssh-agent path produces a manifest verifiable by verifyManifestSignature', async () => {
  await withIsolatedEnv('mwb-ssh', async (home) => {
    const fx = genFixture();
    const keyId = publicKeyFingerprint(fx.publicKeyPem);
    const blob = pubkeyBlobFromPem(fx.publicKeyPem);
    const agent = await startMockAgent([
      { pem: fx.publicKeyPem, privatePem: fx.privateKeyPem, comment: 'prod' },
    ]);
    try {
      await writeBackendJson(home, keyId, {
        backend: 'ssh-agent',
        pubkey_blob_hex: blob.toString('hex'),
        keyId,
        ssh_key_comment: 'prod',
      });
      const manifest = {
        schema_version: '1.0',
        name: 'demo',
        version: '1.0.0',
        type: 'skill-only',
        skills: [],
        permissions: { reads: [], writes: [] },
        publisher_key_backend: 'ssh-agent',
      };
      const signed = await signManifestWithBackend(manifest, {
        keyId,
        home,
        socketPath: agent.socketPath,
      });
      assert.ok(signed.signature, 'manifest has signature');
      assert.equal(signed.publisher_key_id, keyId);
      assert.equal(signed.publisher_key_backend, 'ssh-agent');
      // Verify with the existing software-backend verifier (verify is
      // always software-backend per the contract).
      const r = verifyManifestSignature(signed, {
        publishers: {
          [keyId]: { publicKey: fx.publicKeyPem, name: 'demo' },
        },
      });
      assert.equal(r.valid, true, r.reason);
    } finally {
      await agent.close();
    }
  });
});

test('back-compat: existing signManifest (software, sync) still works unchanged', async () => {
  const fx = genFixture();
  const keyId = publicKeyFingerprint(fx.publicKeyPem);
  const manifest = {
    schema_version: '1.0',
    name: 'demo',
    version: '1.0.0',
    type: 'skill-only',
    skills: [],
    permissions: { reads: [], writes: [] },
  };
  const signed = signManifest(manifest, fx.privateKeyPem);
  assert.equal(signed.publisher_key_id, keyId);
  assert.ok(signed.signature.startsWith('ed25519:'));
  // No publisher_key_backend field on a software-backend manifest.
  assert.equal(signed.publisher_key_backend, undefined);
  const r = verifyManifestSignature(signed, {
    publishers: { [keyId]: { publicKey: fx.publicKeyPem } },
  });
  assert.equal(r.valid, true, r.reason);
});

test('software backend: round-trip via SOFTWARE_BACKEND.sign reads private.pem from <home>', async () => {
  await withIsolatedEnv('sw-roundtrip', async (home) => {
    const fx = genFixture();
    const keyId = publicKeyFingerprint(fx.publicKeyPem);
    const dir = join(home, '.ijfw', 'keys', keyId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'private.pem'), fx.privateKeyPem, 'utf8');
    await writeFile(join(dir, 'public.pem'), fx.publicKeyPem, 'utf8');
    const payload = Buffer.from('software-backend test');
    const sig = await SOFTWARE_BACKEND.sign(payload, keyId, { home });
    assert.equal(sig.length, 64);
    const ok = await SOFTWARE_BACKEND.verify(payload, sig, fx.publicKeyPem);
    assert.equal(ok, true);
  });
});

test('signer-cli: handlers + subcommandHelp shape is frozen', () => {
  assert.ok(handlers, 'handlers exported');
  assert.ok(subcommandHelp, 'subcommandHelp exported');
  assert.equal(typeof handlers.keygen, 'function');
  assert.equal(typeof handlers['keygen-fido2'], 'function');
  assert.equal(typeof subcommandHelp.keygen, 'string');
  assert.equal(typeof subcommandHelp['keygen-fido2'], 'string');
  assert.ok(Object.isFrozen(handlers), 'handlers frozen');
  assert.ok(Object.isFrozen(subcommandHelp), 'subcommandHelp frozen');
});

test('signer-cli: keygen-fido2 emits deferred message + exits ok', async () => {
  const captured = [];
  const stderr = { write: (s) => { captured.push(String(s)); return true; } };
  const r = await handlers['keygen-fido2']('alice', { stderr });
  assert.equal(r.ok, true);
  assert.equal(r.deferred, true);
  assert.ok(/deferred to v1\.5\.0/.test(captured.join('')), 'stderr message present');
});

test('signer-cli: keygen --backend ssh-agent enrolls a key', async () => {
  await withIsolatedEnv('cli-enrol', async (home) => {
    const fx = genFixture();
    const agent = await startMockAgent([
      { pem: fx.publicKeyPem, privatePem: fx.privateKeyPem, comment: 'enrol-me' },
    ]);
    try {
      const r = await handlers.keygen(
        ['alice', '--backend', 'ssh-agent', '--ssh-key-comment', 'enrol-me'],
        { home, socketPath: agent.socketPath },
      );
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.backend, 'ssh-agent');
      assert.match(r.keyId, /^[a-f0-9]{64}$/);
      // The enrolled keyId should match the SPKI fingerprint of the fixture.
      const expectedKeyId = publicKeyFingerprint(fx.publicKeyPem);
      assert.equal(r.keyId, expectedKeyId);
    } finally {
      await agent.close();
    }
  });
});

test('signer-cli: keygen --backend ssh-agent rejects unknown comment', async () => {
  await withIsolatedEnv('cli-bad-comment', async (home) => {
    const fx = genFixture();
    const agent = await startMockAgent([
      { pem: fx.publicKeyPem, privatePem: fx.privateKeyPem, comment: 'the-only-one' },
    ]);
    try {
      const r = await handlers.keygen(
        ['alice', '--backend', 'ssh-agent', '--ssh-key-comment', 'not-there'],
        { home, socketPath: agent.socketPath },
      );
      assert.equal(r.ok, false);
      assert.match(r.error, /no Ed25519 identity with comment/);
    } finally {
      await agent.close();
    }
  });
});

test('signer-cli: keygen --backend unknown fails closed', async () => {
  const r = await handlers.keygen(['alice', '--backend', 'libfido2'], {});
  assert.equal(r.ok, false);
  assert.match(r.error, /Unsupported --backend value "libfido2"/);
});
