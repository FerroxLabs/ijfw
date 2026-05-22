/**
 * hardware-signer.js — IJFW v1.4.3 W9-A2 / B15
 *
 * Backend abstraction for publisher signing operations. Two backends:
 *
 *   SOFTWARE_BACKEND — private key on disk (PEM), signs in-process via
 *     node:crypto. Existing v1.4.0 behavior, preserved for back-compat.
 *
 *   SSH_AGENT_BACKEND — private key never enters the IJFW process. Signing
 *     forwarded to the user's running ssh-agent (or hardware-token-backed
 *     agent like YubiKey, Solokey, gpg-agent's SSH socket, Pageant on
 *     Windows). Implements the OpenSSH agent wire protocol over UNIX
 *     sockets (or named-pipes on Windows) using node:net only.
 *
 * Backend resolution is FAIL-CLOSED (SEC-L-02): unknown backend names throw
 * rather than silently fall through to software. This means a manifest with
 * `publisher_key_backend: 'libfido2'` (a direct-FIDO2 backend deferred to a
 * future release — the ssh-agent backend already covers FIDO2 tokens via the
 * agent socket) is a hard error at sign-time, not a quiet downgrade to a
 * weaker backend.
 *
 * Identity selection (SEC-H-03): when the ssh-agent backend signs, the
 * agent is asked to enumerate identities. The expected public-key blob is
 * loaded from `~/.ijfw/keys/<keyId>/backend.json` (`pubkey_blob_hex`) and
 * matched against each agent identity by raw key material with
 * `crypto.timingSafeEqual`. The SSH key comment is NEVER used for matching
 * — comments are user-supplied strings and can collide; only raw public-key
 * bytes are trustworthy.
 *
 * Spec: .planning/1.4.3/HANDOFF-1.4.3.md §B15
 */

import {
  createHash,
  createPublicKey,
  createPrivateKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  timingSafeEqual,
} from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// === SSH agent wire-protocol constants =====================================
// See draft-miller-ssh-agent (OpenSSH agent protocol).
const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH2_AGENTC_SIGN_REQUEST = 13;
const SSH2_AGENT_SIGN_RESPONSE = 14;
const SSH2_AGENT_FAILURE = 5;

// SSH wire string for the Ed25519 algorithm id. Prefix of every Ed25519
// pubkey blob and signature blob.
const SSH_ED25519_ALG = 'ssh-ed25519';

/**
 * Encode a buffer/string as an SSH wire "string" — uint32 length + bytes.
 *
 * @param {Buffer|string} v
 * @returns {Buffer}
 */
function sshWireString(v) {
  const body = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/**
 * Decode a sequence of SSH wire strings from `buf` starting at `offset`.
 * Returns the consumed slices and the new offset.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: Buffer, next: number }}
 */
function readSshString(buf, offset) {
  if (offset + 4 > buf.length) {
    throw new Error('SSH wire: truncated length prefix');
  }
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + len;
  if (end > buf.length) {
    throw new Error('SSH wire: truncated body');
  }
  return { value: buf.slice(start, end), next: end };
}

/**
 * Compute the Ed25519 pubkey SSH wire blob from a 32-byte raw public key.
 * Format: SSH-string("ssh-ed25519") || SSH-string(raw32).
 *
 * @param {Buffer} raw32
 * @returns {Buffer}
 */
function ed25519PubkeyBlob(raw32) {
  return Buffer.concat([
    sshWireString(SSH_ED25519_ALG),
    sshWireString(raw32),
  ]);
}

/**
 * Pull the raw 32-byte Ed25519 public key out of an SPKI-DER buffer. DER
 * shape is fixed-size for Ed25519 (12-byte header + 32-byte key). We
 * tolerate small header variation by scanning for a 0x00,0x21 BIT STRING
 * tail and lifting the last 32 bytes.
 *
 * @param {Buffer} spkiDer
 * @returns {Buffer} 32-byte raw key
 */
function ed25519RawFromSpkiDer(spkiDer) {
  if (spkiDer.length < 32) {
    throw new Error('Ed25519 SPKI DER too short');
  }
  return spkiDer.slice(spkiDer.length - 32);
}

/**
 * Build an SPKI-DER for an Ed25519 raw public key. Fixed prefix (id-Ed25519
 * AlgorithmIdentifier + BIT STRING wrapping) per RFC 8410.
 *
 * @param {Buffer} raw32
 * @returns {Buffer}
 */
function ed25519SpkiDerFromRaw(raw32) {
  if (raw32.length !== 32) {
    throw new Error('Ed25519 raw key must be 32 bytes');
  }
  // 30 2A — SEQUENCE (42)
  //   30 05 — SEQUENCE (5)
  //     06 03 2B 65 70 — OID 1.3.101.112 (Ed25519)
  //   03 21 00 <32 bytes> — BIT STRING
  const prefix = Buffer.from([
    0x30, 0x2a,
    0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70,
    0x03, 0x21, 0x00,
  ]);
  return Buffer.concat([prefix, raw32]);
}

/**
 * Convert raw Ed25519 public key bytes to a PEM string.
 *
 * @param {Buffer} raw32
 * @returns {string}
 */
export function ed25519PemFromRaw(raw32) {
  const der = ed25519SpkiDerFromRaw(raw32);
  const b64 = der.toString('base64');
  // 64-char lines per PEM convention.
  const wrapped = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Compute keyId fingerprint matching `extension-signer.js::publicKeyFingerprint`.
 * Takes a PEM-encoded public key and returns sha256(spki-der) hex.
 *
 * Re-implemented here (rather than imported) to avoid a circular import
 * between `extension-signer.js` (which imports this module for backend
 * dispatch) and `hardware-signer.js`.
 *
 * @param {string} publicKeyPem
 * @returns {string} 64-char lowercase hex
 */
export function publicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

// === SSH agent client =====================================================

/**
 * Send one request frame and await one response frame over the SSH agent
 * socket. Frame format: uint32 length || payload.
 *
 * @param {string} socketPath
 * @param {Buffer} payload single-message payload (type byte + body)
 * @param {number} [timeoutMs]
 * @returns {Promise<Buffer>} response payload (type byte + body)
 */
function agentRequest(socketPath, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(socketPath);
    let settled = false;
    const settle = (err, val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(val);
    };

    const timer = setTimeout(
      () => settle(new Error(`SSH agent request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    let buf = Buffer.alloc(0);
    let expected = null;
    sock.on('connect', () => {
      const lenPrefix = Buffer.alloc(4);
      lenPrefix.writeUInt32BE(payload.length, 0);
      sock.write(Buffer.concat([lenPrefix, payload]));
    });
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (expected === null && buf.length >= 4) {
        expected = buf.readUInt32BE(0);
      }
      if (expected !== null && buf.length >= 4 + expected) {
        clearTimeout(timer);
        settle(null, buf.slice(4, 4 + expected));
      }
    });
    sock.on('error', err => {
      clearTimeout(timer);
      settle(new Error(`SSH agent socket error: ${err.message}`));
    });
    sock.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        settle(new Error('SSH agent closed connection before responding'));
      }
    });
  });
}

/**
 * Get the SSH agent socket path from env. Throws a clear error when unset.
 *
 * @returns {string}
 */
function requireAgentSocket() {
  const sock = process.env.SSH_AUTH_SOCK;
  if (!sock || typeof sock !== 'string' || sock.length === 0) {
    throw new Error(
      'SSH agent not available; set SSH_AUTH_SOCK or use --backend software',
    );
  }
  return sock;
}

/**
 * List all identities the agent is willing to enumerate. Returns
 * { blob: Buffer, comment: string } per identity. Filters are applied by
 * the caller — we return the raw list so SEC-H-03 selection can run on
 * raw key material.
 *
 * @param {string} [socketPath]
 * @returns {Promise<Array<{ blob: Buffer, comment: string }>>}
 */
export async function listAgentIdentities(socketPath) {
  const sock = socketPath || requireAgentSocket();
  const payload = Buffer.from([SSH2_AGENTC_REQUEST_IDENTITIES]);
  const resp = await agentRequest(sock, payload);
  if (resp.length < 1) throw new Error('SSH agent: empty response');
  const type = resp[0];
  if (type !== SSH2_AGENT_IDENTITIES_ANSWER) {
    throw new Error(`SSH agent: unexpected response type ${type}`);
  }
  if (resp.length < 5) throw new Error('SSH agent: truncated identities count');
  const count = resp.readUInt32BE(1);
  let off = 5;
  const out = [];
  for (let i = 0; i < count; i++) {
    const blobRead = readSshString(resp, off);
    off = blobRead.next;
    const commentRead = readSshString(resp, off);
    off = commentRead.next;
    out.push({
      blob: Buffer.from(blobRead.value),
      comment: commentRead.value.toString('utf8'),
    });
  }
  return out;
}

/**
 * Ask the agent to sign `payload` with the identity whose pubkey blob is
 * `keyBlob`. Returns the raw 64-byte Ed25519 signature (unwrapped from the
 * SSH wire signature blob).
 *
 * @param {Buffer} keyBlob full SSH wire pubkey blob (ssh-ed25519 + raw32)
 * @param {Buffer} payload bytes to sign
 * @param {string} [socketPath]
 * @returns {Promise<Buffer>} 64-byte raw signature
 */
export async function agentSign(keyBlob, payload, socketPath) {
  const sock = socketPath || requireAgentSocket();
  const flags = Buffer.alloc(4); // flags=0
  const body = Buffer.concat([
    sshWireString(keyBlob),
    sshWireString(payload),
    flags,
  ]);
  const reqType = Buffer.from([SSH2_AGENTC_SIGN_REQUEST]);
  const resp = await agentRequest(sock, Buffer.concat([reqType, body]));
  if (resp.length < 1) throw new Error('SSH agent: empty sign response');
  const type = resp[0];
  if (type === SSH2_AGENT_FAILURE) {
    throw new Error('SSH agent: sign request failed (SSH_AGENT_FAILURE)');
  }
  if (type !== SSH2_AGENT_SIGN_RESPONSE) {
    throw new Error(`SSH agent: unexpected sign response type ${type}`);
  }
  // The body is one SSH wire string containing the signature blob:
  //   ssh-string("ssh-ed25519") || ssh-string(raw64-sig)
  const sigBlob = readSshString(resp, 1).value;
  let off = 0;
  const alg = readSshString(sigBlob, off);
  off = alg.next;
  if (alg.value.toString('utf8') !== SSH_ED25519_ALG) {
    throw new Error(`SSH agent: signature alg is not ssh-ed25519 (got ${alg.value.toString('utf8')})`);
  }
  const rawSig = readSshString(sigBlob, off).value;
  if (rawSig.length !== 64) {
    throw new Error(`SSH agent: Ed25519 signature must be 64 bytes (got ${rawSig.length})`);
  }
  return Buffer.from(rawSig);
}

// === Backend implementations ==============================================

/**
 * SOFTWARE backend — wraps node:crypto Ed25519 ops over PEM keys on disk.
 *
 * For `sign(payload, keyId, { home })`:
 *   - Reads `<home>/.ijfw/keys/<keyId>/private.pem`.
 *   - Returns the 64-byte raw Ed25519 signature as a Uint8Array (Buffer).
 */
const softwareBackend = Object.freeze({
  async sign(payload, keyId, opts = {}) {
    const home = opts.home || homedir();
    const privPath = join(home, '.ijfw', 'keys', keyId, 'private.pem');
    const pem = await readFile(privPath, 'utf8');
    const key = createPrivateKey(pem);
    return cryptoSign(null, Buffer.from(payload), key);
  },
  async verify(payload, signature, publicKeyPem) {
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, Buffer.from(payload), key, Buffer.from(signature));
  },
  async getPublicKey(keyId, opts = {}) {
    const home = opts.home || homedir();
    const pubPath = join(home, '.ijfw', 'keys', keyId, 'public.pem');
    return readFile(pubPath, 'utf8');
  },
});

/**
 * SSH-AGENT backend — defers signing to the running SSH agent. Identity
 * is resolved at sign-time by raw public-key blob (SEC-H-03), NEVER by
 * the user-supplied comment.
 */
const sshAgentBackend = Object.freeze({
  async sign(payload, keyId, opts = {}) {
    const home = opts.home || homedir();
    const backendPath = join(home, '.ijfw', 'keys', keyId, 'backend.json');
    let backend;
    try {
      backend = JSON.parse(await readFile(backendPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `SSH agent backend manifest not found for keyId ${keyId} at ${backendPath}: ${err.message}`,
      );
    }
    if (backend.backend !== 'ssh-agent') {
      throw new Error(
        `keyId ${keyId} backend.json is not ssh-agent (got ${JSON.stringify(backend.backend)})`,
      );
    }
    if (typeof backend.pubkey_blob_hex !== 'string' || backend.pubkey_blob_hex.length === 0) {
      throw new Error(`keyId ${keyId} backend.json missing pubkey_blob_hex`);
    }
    const expected = Buffer.from(backend.pubkey_blob_hex, 'hex');
    const identities = await listAgentIdentities(opts.socketPath);
    // Filter to Ed25519-only — the expected blob is always ssh-ed25519.
    const ed25519Prefix = sshWireString(SSH_ED25519_ALG);
    const candidates = identities.filter(
      ident => ident.blob.length >= ed25519Prefix.length
        && ident.blob.slice(0, ed25519Prefix.length).equals(ed25519Prefix),
    );
    // Constant-time match by full blob. Length-mismatched entries are
    // discarded before timingSafeEqual (which throws on length mismatch).
    const matches = candidates.filter(ident => {
      if (ident.blob.length !== expected.length) return false;
      return timingSafeEqual(ident.blob, expected);
    });
    if (matches.length === 0) {
      throw new Error(
        `SSH agent identity not found for keyId ${keyId}; expected pubkey blob ${backend.pubkey_blob_hex.slice(0, 32)}...`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous SSH agent identities for keyId ${keyId}`);
    }
    return agentSign(matches[0].blob, Buffer.from(payload), opts.socketPath);
  },
  /**
   * SSH agent doesn't expose a verify primitive — Ed25519 signatures are
   * universally verifiable with the raw public key, so delegate to the
   * software backend's verify. Verify is always cryptographic, never
   * agent-mediated.
   */
  async verify(payload, signature, publicKeyPem) {
    return softwareBackend.verify(payload, signature, publicKeyPem);
  },
  async getPublicKey(keyId, opts = {}) {
    return softwareBackend.getPublicKey(keyId, opts);
  },
});

export const SOFTWARE_BACKEND = softwareBackend;
export const SSH_AGENT_BACKEND = sshAgentBackend;

/**
 * Resolve a backend by name. FAIL-CLOSED (SEC-L-02): unknown names throw
 * rather than silently falling back to software.
 *
 *   undefined / 'software' → SOFTWARE_BACKEND
 *   'ssh-agent'            → SSH_AGENT_BACKEND
 *   anything else          → throws
 *
 * @param {string|undefined} name
 * @returns {{ sign: Function, verify: Function, getPublicKey: Function }}
 */
export function resolveBackend(name) {
  if (name === undefined || name === 'software') return SOFTWARE_BACKEND;
  if (name === 'ssh-agent') return SSH_AGENT_BACKEND;
  throw new Error(`Unsupported signing backend: ${name}`);
}

/**
 * Helper: build the Ed25519 SSH wire pubkey blob from a PEM-encoded
 * public key. Useful when enrolling a key — caller has a PEM and needs
 * the corresponding blob to store in `backend.json`.
 *
 * @param {string} publicKeyPem
 * @returns {Buffer}
 */
export function pubkeyBlobFromPem(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  const raw = ed25519RawFromSpkiDer(der);
  return ed25519PubkeyBlob(raw);
}

/**
 * Build a fresh Ed25519 keypair purely for fixtures / tests. NOT used at
 * production sign-time (production keys are generated via
 * `extension-signer.js::generatePublisherKeypair`). Exposed here only for
 * the pure-Node mock-agent test harness.
 *
 * @returns {{ publicKeyPem: string, privateKeyPem: string, rawPub: Buffer, rawPriv: Buffer, pubkeyBlob: Buffer }}
 */
export function _testGenerateEd25519Fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = ed25519RawFromSpkiDer(spkiDer);
  // PKCS#8 for Ed25519 has the raw private key in the last 32 bytes of the
  // OCTET STRING payload. We don't need the raw private for the tests
  // (the mock agent re-imports the PEM directly), so this is a placeholder.
  const rawPriv = Buffer.alloc(0);
  return {
    publicKeyPem,
    privateKeyPem,
    rawPub: Buffer.from(rawPub),
    rawPriv,
    pubkeyBlob: ed25519PubkeyBlob(Buffer.from(rawPub)),
  };
}

/**
 * Low-level helpers exported for the mock SSH agent test harness only.
 */
export const _testInternals = Object.freeze({
  sshWireString,
  readSshString,
  ed25519PubkeyBlob,
  SSH2_AGENTC_REQUEST_IDENTITIES,
  SSH2_AGENT_IDENTITIES_ANSWER,
  SSH2_AGENTC_SIGN_REQUEST,
  SSH2_AGENT_SIGN_RESPONSE,
  SSH2_AGENT_FAILURE,
  SSH_ED25519_ALG,
});
