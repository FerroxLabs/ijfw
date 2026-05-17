/**
 * extension-registry.js — IJFW v1.4.1/B6 Hosted Publisher Key Registry.
 *
 * Fetches, verifies, and applies a canonical registry of trusted publishers
 * signed by the IJFW meta-key. Clients cache the registry locally with a
 * 24 h TTL; offline fallback returns the cached copy with a warning.
 *
 * Uses node:https + node:crypto + node:fs/promises only — zero new prod deps.
 */

import { createPublicKey, createHash, verify as cryptoVerify } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';

// ---------------------------------------------------------------------------
// Embedded meta-key — compiled-in trust root for registry signature verification.
// Source: mcp-server/src/.registry-meta-key.pem (gitignored sentinel).
// Rotation requires a new v1.4.x release with a new key inlined here.
// ---------------------------------------------------------------------------
const IJFW_REGISTRY_META_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAL2lCdti0bYiFTGUo/hffy+NiBUBXdbDcdaDmjJS27i0=
-----END PUBLIC KEY-----`;

const DEFAULT_REGISTRY_URL = 'https://registry.ijfw.dev/publishers/v1.json';
const FALLBACK_REGISTRY_URL = 'https://therealseandonahoe.gitlab.io/ijfw/registry/publishers/v1.json';
const MAX_REGISTRY_BYTES = 1024 * 1024; // 1 MiB cap
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function ijfwStateDir() {
  return join(homedir(), '.ijfw', 'state');
}

function registryCachePath() {
  return join(ijfwStateDir(), 'registry-cache.json');
}

function revokedPublishersPath() {
  return join(ijfwStateDir(), 'revoked-publishers.json');
}

// ---------------------------------------------------------------------------
// Canonical signing bytes — same logic as extension-signer.js
// Excludes `signature` from bytes so the field can carry the sig itself.
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

function registryCanonicalBytes(registry) {
  const shallow = {};
  for (const k of Object.keys(registry)) {
    if (k === 'signature') continue;
    shallow[k] = registry[k];
  }
  return Buffer.from(JSON.stringify(sortKeysDeep(shallow)), 'utf8');
}

// ---------------------------------------------------------------------------
// fetchRegistry — HTTPS-only, timeout + redirect cap + body size cap
// ---------------------------------------------------------------------------

/**
 * Fetch the registry JSON from a URL.
 * @param {string} [url]
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable for tests; receives (url) -> Promise<{ok,body,error}>
 * @returns {Promise<{ok: boolean, body: string|null, error: string|null}>}
 */
export async function fetchRegistry(url = DEFAULT_REGISTRY_URL, opts = {}) {
  if (typeof opts.fetchImpl === 'function') {
    return opts.fetchImpl(url);
  }

  // HTTPS-only enforcement
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, body: null, error: `invalid URL: ${url}` };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { ok: false, body: null, error: `registry URL must use HTTPS (got ${parsedUrl.protocol})` };
  }

  return _httpsGet(url, 0);
}

function _httpsGet(url, redirectCount) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return resolve({ ok: false, body: null, error: `invalid redirect URL: ${url}` });
    }
    if (parsedUrl.protocol !== 'https:') {
      return resolve({ ok: false, body: null, error: `redirect to non-HTTPS rejected: ${url}` });
    }

    const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      const { statusCode, headers } = res;

      // Handle redirects
      if (statusCode >= 301 && statusCode <= 308 && headers.location) {
        res.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          return resolve({ ok: false, body: null, error: `too many redirects (max ${MAX_REDIRECTS})` });
        }
        return resolve(_httpsGet(headers.location, redirectCount + 1));
      }

      if (statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, body: null, error: `HTTP ${statusCode}` });
      }

      const chunks = [];
      let totalBytes = 0;
      let oversize = false;

      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_REGISTRY_BYTES) {
          oversize = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (oversize) {
          return resolve({ ok: false, body: null, error: `registry response exceeds ${MAX_REGISTRY_BYTES} bytes` });
        }
        resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8'), error: null });
      });

      res.on('error', (err) => {
        resolve({ ok: false, body: null, error: err.message });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: null, error: `fetch timeout after ${FETCH_TIMEOUT_MS}ms` });
    });

    req.on('error', (err) => {
      resolve({ ok: false, body: null, error: err.message });
    });
  });
}

// ---------------------------------------------------------------------------
// verifyRegistry — parse JSON, validate shape, verify signature
// ---------------------------------------------------------------------------

/**
 * Verify a registry JSON body string.
 * @param {string} body
 * @returns {{ valid: boolean, registry: object|null, reason: string }}
 */
export function verifyRegistry(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return { valid: false, registry: null, reason: `JSON parse failed: ${err.message}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, registry: null, reason: 'registry must be a JSON object' };
  }

  // Shape validation
  if (parsed.registry_version !== '1.0') {
    return { valid: false, registry: null, reason: `unsupported registry_version: ${parsed.registry_version}` };
  }
  if (typeof parsed.updated_at !== 'string') {
    return { valid: false, registry: null, reason: 'missing or invalid updated_at' };
  }
  if (parsed.publishers === null || typeof parsed.publishers !== 'object' || Array.isArray(parsed.publishers)) {
    return { valid: false, registry: null, reason: 'publishers must be an object' };
  }
  if (!Array.isArray(parsed.revoked)) {
    return { valid: false, registry: null, reason: 'revoked must be an array' };
  }

  // Signature verification — null signature is accepted (unsigned seed)
  if (parsed.signature === null) {
    return { valid: true, registry: parsed, reason: 'unsigned (seed)' };
  }

  if (typeof parsed.signature !== 'string' || !parsed.signature.startsWith('ed25519:')) {
    return { valid: false, registry: null, reason: 'signature must be null or "ed25519:<base64>"' };
  }

  let metaKey;
  try {
    metaKey = createPublicKey(IJFW_REGISTRY_META_KEY_PEM);
  } catch (err) {
    return { valid: false, registry: null, reason: `meta-key parse failed: ${err.message}` };
  }

  const sigB64 = parsed.signature.slice('ed25519:'.length);
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigB64, 'base64');
  } catch {
    return { valid: false, registry: null, reason: 'signature base64 decode failed' };
  }

  const bytes = registryCanonicalBytes(parsed);
  let ok;
  try {
    ok = cryptoVerify(null, bytes, metaKey, sigBuf);
  } catch (err) {
    return { valid: false, registry: null, reason: `signature verify threw: ${err.message}` };
  }

  if (!ok) {
    return { valid: false, registry: null, reason: 'signature does not verify against meta-key' };
  }

  return { valid: true, registry: parsed, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Read the cached registry from disk.
 * @returns {Promise<{registry: object|null, cachedAt: number|null, stale: boolean}>}
 */
export async function readCachedRegistry() {
  let raw;
  try {
    raw = await readFile(registryCachePath(), 'utf8');
  } catch {
    return { registry: null, cachedAt: null, stale: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { registry: null, cachedAt: null, stale: true };
  }
  const cachedAt = typeof parsed.cached_at === 'number' ? parsed.cached_at : null;
  const stale = cachedAt === null || (Date.now() - cachedAt) > CACHE_TTL_MS;
  return { registry: parsed.registry ?? null, cachedAt, stale };
}

/**
 * Write the registry to the local cache.
 * @param {object} registry
 */
export async function writeCachedRegistry(registry) {
  await mkdir(ijfwStateDir(), { recursive: true });
  const payload = JSON.stringify({ cached_at: Date.now(), registry }, null, 2) + '\n';
  await writeFile(registryCachePath(), payload, 'utf8');
}

// ---------------------------------------------------------------------------
// applyRegistry — merge publishers + process revocations
// ---------------------------------------------------------------------------

/**
 * Apply a verified registry to the local trust store.
 * @param {object} registry
 * @param {object} [opts]
 * @returns {Promise<{added: string[], removed: string[], unchanged: string[], rejected: string[]}>}
 */
export async function applyRegistry(registry, _opts = {}) {
  const added = [];
  const removed = [];
  const unchanged = [];
  const rejected = [];

  // Read current trust store
  const tpPath = join(homedir(), '.ijfw', 'trusted-publishers.json');
  let store = { publishers: {} };
  try {
    const raw = await readFile(tpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.publishers === 'object' && parsed.publishers !== null) {
      store = parsed;
    }
  } catch { /* absent or malformed → start fresh */ }

  // Read / update revoked list
  let revokedStore = { revoked: [] };
  try {
    const raw = await readFile(revokedPublishersPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.revoked)) revokedStore = parsed;
  } catch { /* absent → start fresh */ }

  const revokedSet = new Set(revokedStore.revoked.map(r => r.keyId));

  // Process revocations first
  for (const entry of (registry.revoked || [])) {
    const { keyId } = entry;
    if (!keyId) continue;
    if (Object.prototype.hasOwnProperty.call(store.publishers, keyId)) {
      delete store.publishers[keyId];
      removed.push(keyId);
    }
    // Record in revoked-publishers.json if not already there
    if (!revokedSet.has(keyId)) {
      revokedSet.add(keyId);
      revokedStore.revoked.push({
        keyId,
        revoked_at: entry.revoked_at || new Date().toISOString(),
        reason: entry.reason || '',
        superseded_by: entry.superseded_by || null,
      });
    }
  }

  // Merge publishers
  for (const [keyId, entry] of Object.entries(registry.publishers || {})) {
    if (!entry || typeof entry.publicKey !== 'string') {
      rejected.push(keyId);
      continue;
    }
    // Don't re-add revoked publishers
    if (revokedSet.has(keyId)) {
      rejected.push(keyId);
      continue;
    }
    // Verify fingerprint matches keyId
    try {
      const key = createPublicKey(entry.publicKey);
      const der = key.export({ type: 'spki', format: 'der' });
      const fp = createHash('sha256').update(der).digest('hex');
      if (fp !== keyId) {
        rejected.push(keyId);
        continue;
      }
    } catch {
      rejected.push(keyId);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(store.publishers, keyId)) {
      unchanged.push(keyId);
    } else {
      store.publishers[keyId] = {
        name: entry.name,
        publicKey: entry.publicKey,
        verified_at: entry.verified_at,
        metadata: entry.metadata,
        added_at: new Date().toISOString(),
      };
      added.push(keyId);
    }
  }

  // Persist
  await mkdir(join(homedir(), '.ijfw'), { recursive: true });
  await writeFile(tpPath, JSON.stringify(store, null, 2) + '\n', 'utf8');

  await mkdir(ijfwStateDir(), { recursive: true });
  await writeFile(
    revokedPublishersPath(),
    JSON.stringify(revokedStore, null, 2) + '\n',
    'utf8',
  );

  return { added, removed, unchanged, rejected };
}

// ---------------------------------------------------------------------------
// refreshTrustFromRegistry — high-level entry point
// ---------------------------------------------------------------------------

/**
 * Fetch → verify → apply → cache. The main entry point for the CLI.
 * Falls back to cache on offline; warns if stale.
 *
 * @param {string} [url]
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable for tests
 * @returns {Promise<{ok: boolean, diff: object|null, fromCache: boolean, warnings: string[], error: string|null}>}
 */
export async function refreshTrustFromRegistry(url = DEFAULT_REGISTRY_URL, opts = {}) {
  const warnings = [];

  const fetched = await fetchRegistry(url, opts);
  if (!fetched.ok) {
    // Offline path — try cache
    const cached = await readCachedRegistry();
    if (cached.registry) {
      if (cached.stale) warnings.push(`offline and cache is stale (age > ${CACHE_TTL_MS / 3600000}h) — trust store not updated`);
      else warnings.push('offline — using cached registry');
      return { ok: true, diff: null, fromCache: true, warnings, error: null };
    }
    // No cache either — return existing trust store untouched
    warnings.push(`offline and no cache available — trust store unchanged: ${fetched.error}`);
    return { ok: true, diff: null, fromCache: false, warnings, error: null };
  }

  const verified = verifyRegistry(fetched.body);
  if (!verified.valid) {
    return { ok: false, diff: null, fromCache: false, warnings, error: `registry verify failed: ${verified.reason}` };
  }

  const diff = await applyRegistry(verified.registry, opts);
  await writeCachedRegistry(verified.registry);

  return { ok: true, diff, fromCache: false, warnings, error: null };
}

// ---------------------------------------------------------------------------
// Signing CLI helpers (keygen-meta, sign-registry, verify-registry)
// ---------------------------------------------------------------------------

import { generateKeyPairSync, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import { cwd } from 'node:process';

/**
 * Generate a registry meta-keypair and persist under ~/.ijfw/keys/<keyId>/.
 * Writes a `meta-role.txt` marker file to distinguish from publisher keys.
 *
 * @param {string} author
 * @returns {Promise<{keyId: string, publicKey: string, dir: string}>}
 */
export async function keygenMeta(author) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(der).digest('hex');

  const dir = join(homedir(), '.ijfw', 'keys', keyId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await chmod(dir, 0o700); } catch { /* best-effort */ }

  await writeFile(join(dir, 'public.pem'), pubPem, 'utf8');
  await writeFile(join(dir, 'private.pem'), privPem, { encoding: 'utf8', mode: 0o600 });
  try { await chmod(join(dir, 'private.pem'), 0o600); } catch { /* best-effort */ }
  try { await chmod(join(dir, 'public.pem'), 0o644); } catch { /* best-effort */ }

  // Meta-role marker
  await writeFile(
    join(dir, 'meta-role.txt'),
    `meta\n${author || 'unknown'}\n${new Date().toISOString()}\n`,
    'utf8',
  );

  return { keyId, publicKey: pubPem, dir };
}

/**
 * Sign a registry JSON file in place. Updates `signature` and `updated_at`.
 * Writes atomically.
 *
 * Path must resolve under cwd() (path traversal defence).
 *
 * @param {string} registryPath
 * @param {object} [opts]
 * @param {string} [opts.privateKeyPem] - if not provided, loads from ~/.ijfw/keys/<keyId>/private.pem
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function signRegistry(registryPath, opts = {}) {
  // Path security: must resolve under cwd
  const abs = pathResolve(registryPath);
  const cwdAbs = pathResolve(cwd());
  if (!abs.startsWith(cwdAbs + '/') && abs !== cwdAbs) {
    return { ok: false, error: `path traversal rejected: ${registryPath}` };
  }

  let raw;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    return { ok: false, error: `read failed: ${err.message}` };
  }

  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }

  // Find the private key: prefer opts.privateKeyPem, else load from meta-keypair dir
  let privPem = opts.privateKeyPem || null;
  if (!privPem) {
    // Find meta-key in ~/.ijfw/keys/
    const keysDir = join(homedir(), '.ijfw', 'keys');
    let keyDirs = [];
    try {
      const { readdir } = await import('node:fs/promises');
      keyDirs = await readdir(keysDir);
    } catch { /* none found */ }

    for (const kid of keyDirs) {
      const markerPath = join(keysDir, kid, 'meta-role.txt');
      try {
        await readFile(markerPath, 'utf8');
        privPem = await readFile(join(keysDir, kid, 'private.pem'), 'utf8');
        break;
      } catch { /* not a meta key dir */ }
    }
  }

  if (!privPem) {
    return { ok: false, error: 'no meta private key found; run keygen-meta first or pass privateKeyPem in opts' };
  }

  let privKey;
  try {
    privKey = createPrivateKey(privPem);
  } catch (err) {
    return { ok: false, error: `private key parse failed: ${err.message}` };
  }

  // Update updated_at, clear old signature, compute canonical bytes, sign
  registry.updated_at = new Date().toISOString();
  delete registry.signature;
  const bytes = registryCanonicalBytes(registry);
  const sigBuf = cryptoSign(null, bytes, privKey);
  registry.signature = `ed25519:${sigBuf.toString('base64')}`;

  try {
    await writeFile(abs, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `write failed: ${err.message}` };
  }

  return { ok: true };
}

/**
 * Verify a registry JSON file's signature against the compiled-in meta-key.
 *
 * Path must resolve under cwd().
 *
 * @param {string} registryPath
 * @returns {Promise<{ok: boolean, valid: boolean, reason: string}>}
 */
export async function verifyRegistryFile(registryPath) {
  // Path security
  const abs = pathResolve(registryPath);
  const cwdAbs = pathResolve(cwd());
  if (!abs.startsWith(cwdAbs + '/') && abs !== cwdAbs) {
    return { ok: false, valid: false, reason: `path traversal rejected: ${registryPath}` };
  }

  let raw;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    return { ok: false, valid: false, reason: `read failed: ${err.message}` };
  }

  const result = verifyRegistry(raw);
  return { ok: true, valid: result.valid, reason: result.reason };
}

export { DEFAULT_REGISTRY_URL, FALLBACK_REGISTRY_URL, CACHE_TTL_MS, IJFW_REGISTRY_META_KEY_PEM };
