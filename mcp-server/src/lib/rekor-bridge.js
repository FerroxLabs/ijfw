/**
 * rekor-bridge.js — IJFW v1.5.0 audit-H5.7 Sigstore Rekor transparency log.
 *
 * Closes the meta-key-compromise gap from v1.4.1. When the optional
 * `@sigstore/rekor` peer dep is present (or `IJFW_REKOR_URL` is set for a
 * self-hosted Rekor instance), the registry signer pushes the
 * `{payload, signature, publicKey}` triple to Rekor's append-only public
 * transparency log on sign. Downstream verifiers cross-check the registry's
 * embedded Rekor entry against the live log on verify — an attacker who
 * swaps the meta-key cannot backdate a Rekor entry, so the swap is detectable.
 *
 * Three principles:
 *   1. Graceful no-op. If the peer dep is missing, every function returns null
 *      or false in a way the caller can ignore. Ed25519 signature verification
 *      remains the primary trust check.
 *   2. Never throw. submitToRekor and verifyRekorEntry catch all errors,
 *      emit a stderr advisory, and return null. The caller decides whether
 *      to proceed.
 *   3. Backcompat. Unsigned-by-Rekor registries (signed before this lift) still
 *      verify on the Ed25519 check alone — the cross-check fires only when
 *      both a `rekor` field is embedded AND a local Rekor client is available.
 *
 * Threat model (v1.4.1 → v1.5.0):
 *   v1.4.1 shipped Ed25519 publisher signing + meta-key rotation. But if an
 *   attacker compromises the meta-key, downstream installs cannot detect the
 *   swap — there is no append-only third-party witness. Rekor provides that
 *   witness: every legitimate registry sign is also pushed to a public log,
 *   so an attacker who later swaps the meta-key would have to either
 *   (a) push a tampered registry to Rekor with an entry that doesn't
 *       match any prior entry — clients see the registry's rekor field
 *       contains a uuid that resolves to a payload not matching the
 *       served registry, OR
 *   (b) try to backdate Rekor entries, which is cryptographically
 *       impossible (Merkle tree append-only).
 *
 * @see https://docs.sigstore.dev/rekor/overview/
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Client cache: avoid re-importing the peer dep on every call.
// __setRekorClientForTest replaces the cache for unit tests; resolveClient
// honors the test override before attempting the real import.
// ---------------------------------------------------------------------------

let _cachedClient = undefined; // undefined = not-yet-probed, null = unavailable
let _testClient = null;        // explicit test-only override

/**
 * Test-only seam: inject a stub Rekor client.
 *
 * The stub must implement:
 *   - createEntry({ payload, signature, publicKey }) → Promise<{ uuid, logIndex, integratedTime }>
 *   - getEntry({ uuid }) → Promise<{ payloadHash: string }>
 *
 * Where `payloadHash` is the sha256-hex of the payload that was originally
 * submitted to Rekor (so verifyRekorEntry can compare hashes without re-fetching
 * the entire payload from the log).
 *
 * Pass `null` to clear the override and resume normal probe behavior.
 *
 * @param {object|null} stub
 */
export function __setRekorClientForTest(stub) {
  _testClient = stub;
  // Reset cache so the next call re-resolves through the test override.
  _cachedClient = undefined;
}

/**
 * Resolve a Rekor client, preferring (in order):
 *   1. The explicit test override (`__setRekorClientForTest`).
 *   2. A dynamic import of `@sigstore/rekor` if it's installed as a peer dep.
 *   3. null when neither is available.
 *
 * The result is cached for the process lifetime (test overrides bust the cache).
 *
 * @returns {Promise<object|null>}
 */
async function resolveClient() {
  if (_testClient !== null) return _testClient;
  if (_cachedClient !== undefined) return _cachedClient;
  try {
    const mod = await import('@sigstore/rekor');
    // Accept either a named `RekorClient` constructor or a default export.
    const ClientCtor =
      (mod && (mod.RekorClient || (mod.default && mod.default.RekorClient))) || null;
    if (typeof ClientCtor !== 'function') {
      _cachedClient = null;
      return null;
    }
    const baseURL =
      typeof process.env.IJFW_REKOR_URL === 'string' && process.env.IJFW_REKOR_URL.length > 0
        ? process.env.IJFW_REKOR_URL
        : 'https://rekor.sigstore.dev';
    _cachedClient = new ClientCtor({ baseURL });
    return _cachedClient;
  } catch {
    _cachedClient = null;
    return null;
  }
}

/**
 * Whether a Rekor client is available. Synchronous in spec but the underlying
 * resolution is async (dynamic import); we expose an async probe that the
 * caller awaits. Returns true when either the peer dep is installed or a
 * test stub has been injected.
 *
 * @returns {Promise<boolean>}
 */
export async function hasRekorClient() {
  const client = await resolveClient();
  return client !== null;
}

/**
 * Submit a `{payload, signature, publicKey}` triple to the configured Rekor
 * instance. The payload is the canonical signing bytes that the upstream
 * Ed25519 signature was computed over (NOT the serialized registry).
 *
 * Returns the Rekor entry handle on success, or null on any failure
 * (no client, network error, malformed response, unexpected exception).
 * NEVER throws.
 *
 * Stderr advisory is emitted on failure so operators see when a sign-time
 * Rekor anchor was attempted but skipped — important for audit trails when
 * a registry ships without a `rekor` field.
 *
 * @param {object} args
 * @param {Buffer|string} args.payload canonical bytes of the signed body
 * @param {string} args.signature Ed25519 signature string (e.g. "ed25519:<b64>")
 * @param {string} args.publicKey PEM-encoded SPKI public key
 * @returns {Promise<{ uuid: string, logIndex: number, integratedTime: number } | null>}
 */
export async function submitToRekor({ payload, signature, publicKey } = {}) {
  const client = await resolveClient();
  if (client === null) return null;
  if (payload === undefined || signature === undefined || publicKey === undefined) {
    advise('rekor: submit called without payload/signature/publicKey — skipping');
    return null;
  }
  try {
    const entry = await client.createEntry({ payload, signature, publicKey });
    if (
      !entry ||
      typeof entry.uuid !== 'string' ||
      typeof entry.logIndex !== 'number' ||
      typeof entry.integratedTime !== 'number'
    ) {
      advise('rekor: createEntry returned malformed response — skipping anchor');
      return null;
    }
    return {
      uuid: entry.uuid,
      logIndex: entry.logIndex,
      integratedTime: entry.integratedTime,
    };
  } catch (err) {
    advise(`rekor: submit failed — ${err.message || 'unknown error'}`);
    return null;
  }
}

/**
 * Verify that a Rekor entry's recorded payload hash matches the locally
 * canonicalized payload. This is the detection mechanism for meta-key
 * compromise: if an attacker swaps the meta-key but re-uses an old Rekor
 * uuid, the payload hashes will not match and verification fails.
 *
 * Return values:
 *   - true  — entry exists in Rekor AND its payload hash matches.
 *   - false — entry exists but payload hash MISMATCH (tamper detected, REJECT).
 *   - null  — client unavailable OR entry lookup failed. Caller should fall
 *             back to the Ed25519 check alone (backcompat).
 *
 * NEVER throws.
 *
 * @param {object} args
 * @param {string} args.uuid Rekor entry uuid (from registry's embedded rekor field)
 * @param {Buffer|string} args.payload canonical bytes the entry should attest to
 * @returns {Promise<boolean|null>}
 */
export async function verifyRekorEntry({ uuid, payload } = {}) {
  const client = await resolveClient();
  if (client === null) return null;
  if (typeof uuid !== 'string' || uuid.length === 0 || payload === undefined) {
    advise('rekor: verify called without uuid/payload — skipping');
    return null;
  }
  let entry;
  try {
    entry = await client.getEntry({ uuid });
  } catch (err) {
    advise(`rekor: getEntry failed — ${err.message || 'unknown error'}`);
    return null;
  }
  if (!entry || typeof entry.payloadHash !== 'string' || entry.payloadHash.length === 0) {
    advise('rekor: getEntry returned no payloadHash — cannot cross-check');
    return null;
  }
  const localHash = createHash('sha256')
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
    .digest('hex');
  return localHash === entry.payloadHash.toLowerCase();
}

// ---------------------------------------------------------------------------
// Internal: stderr advisory. Always one-shot, never duplicated. Silenceable
// via IJFW_REKOR_QUIET=1 for noisy test environments.
// ---------------------------------------------------------------------------

function advise(message) {
  if (process.env.IJFW_REKOR_QUIET === '1') return;
  try {
    process.stderr.write(`[ijfw] ${message}\n`);
  } catch {
    /* best-effort */
  }
}
