/**
 * extension-registry.js — IJFW v1.4.1/B6 Hosted Publisher Key Registry
 *                       + IJFW v1.4.3/B14 Federated Registries
 *                       + IJFW v1.4.3/B17 Live Revocation (split TTL + emergency)
 *
 * v1.4.1 baseline: single hosted registry signed by the embedded meta-key.
 *
 * v1.4.3 lift (B14 + B17):
 *   - Federated registries: clients pull from a priority-ordered list defined in
 *     `~/.ijfw/registries.json`. Higher-priority publishers override lower; ANY
 *     source's revocation revokes globally (defense-in-depth).
 *   - Per-source cache files: `~/.ijfw/state/registry-cache-<sanitized-name>.json`.
 *     Atomic tmp+rename inside `withFsLock` (consumes W9-A0 fs-lock.js).
 *   - Split TTL: revocation polled every 5 min; publishers every 24 h.
 *   - Emergency refresh path bypasses all caches.
 *   - Cache corruption is reported per-source; never silently falls through.
 *   - `verifyRegistry(body, { metaKeyPem, allowSeed })` is the v1.4.3-frozen
 *     signature (SEC-L-01). Default meta key is the embedded `IJFW_REGISTRY_META_KEY_PEM`.
 *
 * Uses node:https + node:crypto + node:fs/promises only — zero new prod deps.
 */

import { createPublicKey, createHash, verify as cryptoVerify } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';

import { withFsLock } from './fs-lock.js';

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
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h (back-compat alias)
const PUBLISHER_TTL_MS = 24 * 60 * 60 * 1000; // 24 h — B17 publisher half
const REVOCATION_TTL_MS = 5 * 60 * 1000; // 5 min — B17 revocation half
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// Source name shape (filesystem-safe; same vocab as gate_id).
const SOURCE_NAME_PATTERN = /^[a-z0-9_-]+$/;
const META_KEY_SENTINEL = '<embedded>';

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

function registriesConfigPath() {
  return join(homedir(), '.ijfw', 'registries.json');
}

function sanitizeSourceName(name) {
  if (typeof name !== 'string' || !SOURCE_NAME_PATTERN.test(name)) {
    throw new RegistrySourcesError(
      `source name must match /^[a-z0-9_-]+$/, got ${JSON.stringify(name)}`,
      { reason: 'invalid_source_name' },
    );
  }
  return name;
}

function perSourceCachePath(sourceName) {
  return join(ijfwStateDir(), `registry-cache-${sanitizeSourceName(sourceName)}.json`);
}

function perSourceLockPath(sourceName) {
  return join(ijfwStateDir(), `.registry-cache-${sanitizeSourceName(sourceName)}.lock`);
}

// ---------------------------------------------------------------------------
// RegistrySourcesError — thrown on container-malformed registries.json
// (SEC-M-01: container errors are fatal; remote-source failures are warnings).
// ---------------------------------------------------------------------------

export class RegistrySourcesError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'RegistrySourcesError';
    this.code = 'REGISTRY_SOURCES_ERROR';
    this.reason = info.reason || 'malformed';
    if (typeof info.line === 'number') this.line = info.line;
    if (typeof info.column === 'number') this.column = info.column;
  }
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

// Exposed for the WS client stub (same canonical-bytes algorithm).
export function _registryCanonicalBytesForTest(registry) {
  return registryCanonicalBytes(registry);
}

// ---------------------------------------------------------------------------
// fetchRegistry — HTTPS-only, timeout + redirect cap + body size cap
// ---------------------------------------------------------------------------

/**
 * Fetch the registry JSON from a URL.
 * @param {string} [url]
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable for tests; receives (url) -> Promise<{ok,body,error}>
 * @param {'all'|'revoked'} [opts.part] - B17: registry slice to fetch. Server returns
 *   the same JSON for both today; client caches them with their own TTL.
 * @returns {Promise<{ok: boolean, body: string|null, error: string|null}>}
 */
export async function fetchRegistry(url = DEFAULT_REGISTRY_URL, opts = {}) {
  const part = opts.part === 'revoked' ? 'revoked' : 'all';
  let fetchUrl = url;
  if (part === 'revoked') {
    // Append ?part=revoked (or &part=revoked) — the server ignores the query
    // for v1.4.3 but CDN edge caches treat them as distinct cache keys.
    try {
      const u = new URL(url);
      u.searchParams.set('part', 'revoked');
      fetchUrl = u.toString();
    } catch {
      // Will be caught by HTTPS-only check below.
    }
  }

  if (typeof opts.fetchImpl === 'function') {
    return opts.fetchImpl(fetchUrl);
  }

  // HTTPS-only enforcement
  let parsedUrl;
  try {
    parsedUrl = new URL(fetchUrl);
  } catch {
    return { ok: false, body: null, error: `invalid URL: ${fetchUrl}` };
  }
  if (parsedUrl.protocol !== 'https:') {
    return { ok: false, body: null, error: `registry URL must use HTTPS (got ${parsedUrl.protocol})` };
  }

  return _httpsGet(fetchUrl, 0);
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
// verifyRegistry — parse JSON, validate shape, verify signature.
//
// v1.4.3 (SEC-L-01): standardized call signature
//   verifyRegistry(body, { metaKeyPem, allowSeed })
// metaKeyPem defaults to the embedded IJFW_REGISTRY_META_KEY_PEM so v1.4.1
// callers and existing tests keep working. allowSeed is unchanged.
// ---------------------------------------------------------------------------

/**
 * Verify a registry JSON body string.
 *
 * @param {string} body
 * @param {object} [opts]
 * @param {string} [opts.metaKeyPem] PEM-encoded Ed25519 SPKI key to verify against.
 *   Defaults to IJFW_REGISTRY_META_KEY_PEM. Sentinel `<embedded>` also resolves
 *   to the embedded key.
 * @param {boolean} [opts.allowSeed] Accept unsigned (null-signature) registries (bootstrap mode)
 * @returns {{ valid: boolean, registry: object|null, reason: string, warnings?: string[] }}
 */
export function verifyRegistry(body, opts = {}) {
  // Resolve the meta-key (back-compat with v1.4.1 callers that omitted opts).
  const rawMetaKey = opts.metaKeyPem;
  const metaKeyPem =
    rawMetaKey === undefined ||
    rawMetaKey === null ||
    rawMetaKey === '' ||
    rawMetaKey === META_KEY_SENTINEL
      ? IJFW_REGISTRY_META_KEY_PEM
      : rawMetaKey;

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

  // Signature verification — null signature is only accepted in seed/bootstrap mode.
  if (parsed.signature === null) {
    const allowSeed = opts.allowSeed === true || process.env.IJFW_ALLOW_SEED_REGISTRY === '1';
    if (!allowSeed) {
      return { valid: false, registry: null, reason: 'signature missing — production clients require signed registry' };
    }
    return {
      valid: true,
      registry: parsed,
      reason: 'unsigned (seed)',
      warnings: ['registry has no signature — running in seed/bootstrap mode only'],
    };
  }

  if (typeof parsed.signature !== 'string' || !parsed.signature.startsWith('ed25519:')) {
    return { valid: false, registry: null, reason: 'signature must be null or "ed25519:<base64>"' };
  }

  let metaKey;
  try {
    metaKey = createPublicKey(metaKeyPem);
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
// loadRegistrySources — read ~/.ijfw/registries.json or fall back to single-source.
// ---------------------------------------------------------------------------

function defaultPublicSource() {
  return {
    name: 'public',
    url: DEFAULT_REGISTRY_URL,
    meta_key_pem: IJFW_REGISTRY_META_KEY_PEM,
    priority: 0,
    publisher_ttl_ms: PUBLISHER_TTL_MS,
    revocation_ttl_ms: REVOCATION_TTL_MS,
  };
}

/**
 * Read and validate ~/.ijfw/registries.json. Returns the priority-ordered list
 * of resolved sources.
 *
 * If the file is missing, return the legacy single-source default. If the file
 * is present but malformed, throw RegistrySourcesError (SEC-M-01 — fatal).
 *
 * @returns {Promise<Array<{name:string,url:string,meta_key_pem:string,priority:number,publisher_ttl_ms:number,revocation_ttl_ms:number}>>}
 */
export async function loadRegistrySources() {
  let raw;
  try {
    raw = await readFile(registriesConfigPath(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Back-compat: single public registry default.
      return [defaultPublicSource()];
    }
    throw new RegistrySourcesError(
      `cannot read ${registriesConfigPath()}: ${err.message}`,
      { reason: 'unreadable' },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistrySourcesError(
      `registries.json JSON parse failed: ${err.message}`,
      { reason: 'parse_error' },
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RegistrySourcesError(
      'registries.json root must be a JSON object',
      { reason: 'schema_root' },
    );
  }

  if (parsed.schema_version !== '1.0') {
    throw new RegistrySourcesError(
      `registries.json schema_version must equal "1.0", got ${JSON.stringify(parsed.schema_version)}`,
      { reason: 'schema_version' },
    );
  }

  if (!Array.isArray(parsed.registries) || parsed.registries.length === 0) {
    throw new RegistrySourcesError(
      'registries.json: registries must be a non-empty array',
      { reason: 'schema_registries' },
    );
  }

  const seenNames = new Set();
  const sources = [];

  for (let i = 0; i < parsed.registries.length; i++) {
    const entry = parsed.registries[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RegistrySourcesError(
        `registries[${i}]: must be an object`,
        { reason: 'schema_entry' },
      );
    }
    if (typeof entry.name !== 'string' || !SOURCE_NAME_PATTERN.test(entry.name)) {
      throw new RegistrySourcesError(
        `registries[${i}].name: must match /^[a-z0-9_-]+$/, got ${JSON.stringify(entry.name)}`,
        { reason: 'schema_name' },
      );
    }
    if (seenNames.has(entry.name)) {
      throw new RegistrySourcesError(
        `registries[${i}].name: duplicate source name ${JSON.stringify(entry.name)}`,
        { reason: 'duplicate_name' },
      );
    }
    seenNames.add(entry.name);
    if (typeof entry.url !== 'string') {
      throw new RegistrySourcesError(
        `registries[${i}].url: must be a string`,
        { reason: 'schema_url' },
      );
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(entry.url);
    } catch {
      throw new RegistrySourcesError(
        `registries[${i}].url: invalid URL ${JSON.stringify(entry.url)}`,
        { reason: 'schema_url' },
      );
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new RegistrySourcesError(
        `registries[${i}].url: must use HTTPS, got ${parsedUrl.protocol}`,
        { reason: 'schema_url' },
      );
    }

    // meta_key_pem resolution.
    let metaKeyPem;
    if (
      entry.meta_key_pem === undefined ||
      entry.meta_key_pem === null ||
      entry.meta_key_pem === META_KEY_SENTINEL ||
      entry.meta_key_pem === ''
    ) {
      metaKeyPem = IJFW_REGISTRY_META_KEY_PEM;
    } else if (typeof entry.meta_key_pem !== 'string') {
      throw new RegistrySourcesError(
        `registries[${i}].meta_key_pem: must be a string PEM or the sentinel "<embedded>"`,
        { reason: 'schema_meta_key' },
      );
    } else {
      // Validate it parses.
      try {
        createPublicKey(entry.meta_key_pem);
      } catch (err) {
        throw new RegistrySourcesError(
          `registries[${i}].meta_key_pem: PEM parse failed: ${err.message}`,
          { reason: 'schema_meta_key' },
        );
      }
      metaKeyPem = entry.meta_key_pem;
    }

    const priority =
      typeof entry.priority === 'number' && Number.isFinite(entry.priority)
        ? entry.priority
        : i;

    const publisher_ttl_ms =
      typeof entry.publisher_ttl_ms === 'number' && entry.publisher_ttl_ms > 0
        ? entry.publisher_ttl_ms
        : PUBLISHER_TTL_MS;
    const revocation_ttl_ms =
      typeof entry.revocation_ttl_ms === 'number' && entry.revocation_ttl_ms > 0
        ? entry.revocation_ttl_ms
        : REVOCATION_TTL_MS;

    sources.push({
      name: entry.name,
      url: entry.url,
      meta_key_pem: metaKeyPem,
      priority,
      publisher_ttl_ms,
      revocation_ttl_ms,
    });
  }

  sources.sort((a, b) => a.priority - b.priority);
  return sources;
}

// ---------------------------------------------------------------------------
// Per-source cache helpers (B14/B17). One file per source, atomic + locked.
// ---------------------------------------------------------------------------

const PER_SOURCE_CACHE_KEYS = [
  'publishers',
  'publishers_fetched_at',
  'revoked',
  'revocation_fetched_at',
  'source_name',
  'source_url',
];

function emptySourceCache(source) {
  return {
    publishers: {},
    publishers_fetched_at: null,
    revoked: [],
    revocation_fetched_at: null,
    source_name: source.name,
    source_url: source.url,
  };
}

/**
 * Read the per-source cache. On any parse / shape / source_name mismatch error,
 * returns `{ cache: emptySourceCache(source), corrupt: true, reason }` so the
 * caller can both surface the warning AND avoid silent fall-through (SEC-M-04).
 *
 * @returns {Promise<{ cache: object, corrupt: boolean, reason?: string }>}
 */
export async function readSourceCache(source) {
  const path = perSourceCachePath(source.name);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { cache: emptySourceCache(source), corrupt: false };
    }
    return {
      cache: emptySourceCache(source),
      corrupt: true,
      reason: `read_failed:${err.code || err.message}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      cache: emptySourceCache(source),
      corrupt: true,
      reason: `parse_error:${err.message}`,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { cache: emptySourceCache(source), corrupt: true, reason: 'shape_root' };
  }
  for (const k of PER_SOURCE_CACHE_KEYS) {
    if (!(k in parsed)) {
      return {
        cache: emptySourceCache(source),
        corrupt: true,
        reason: `missing_field:${k}`,
      };
    }
  }
  if (parsed.source_name !== source.name) {
    return {
      cache: emptySourceCache(source),
      corrupt: true,
      reason: `source_name_mismatch:expected=${source.name},got=${parsed.source_name}`,
    };
  }
  if (
    parsed.publishers === null ||
    typeof parsed.publishers !== 'object' ||
    Array.isArray(parsed.publishers)
  ) {
    return { cache: emptySourceCache(source), corrupt: true, reason: 'publishers_shape' };
  }
  if (!Array.isArray(parsed.revoked)) {
    return { cache: emptySourceCache(source), corrupt: true, reason: 'revoked_shape' };
  }
  return { cache: parsed, corrupt: false };
}

async function atomicWriteJson(filePath, payload) {
  await mkdir(ijfwStateDir(), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

/**
 * Mutate the per-source cache inside an exclusive fs-lock.
 * @param {object} source — entry from loadRegistrySources()
 * @param {(cache: object) => object|Promise<object>} mutator
 */
export async function withSourceCache(source, mutator) {
  return withFsLock(perSourceLockPath(source.name), async () => {
    const { cache, corrupt, reason } = await readSourceCache(source);
    if (corrupt) {
      // The mutator still gets a fresh empty cache to write into. We surface
      // `reason` via the mutator's return value when it wants to record it.
      const next = await mutator({ ...cache, _corruptReason: reason });
      if (next && typeof next === 'object') {
        delete next._corruptReason;
        await atomicWriteJson(perSourceCachePath(source.name), next);
      }
      return { corrupt: true, reason };
    }
    const next = await mutator(cache);
    if (next && typeof next === 'object') {
      await atomicWriteJson(perSourceCachePath(source.name), next);
    }
    return { corrupt: false };
  });
}

// ---------------------------------------------------------------------------
// Legacy single-source cache helpers (kept for v1.4.1 back-compat tests).
// ---------------------------------------------------------------------------

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

export async function writeCachedRegistry(registry) {
  await mkdir(ijfwStateDir(), { recursive: true });
  const payload = JSON.stringify({ cached_at: Date.now(), registry }, null, 2) + '\n';
  await writeFile(registryCachePath(), payload, 'utf8');
}

// ---------------------------------------------------------------------------
// applyRegistry — merge publishers + process revocations
// (single-source path, retained for v1.4.1 callers + tests)
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
    if (revokedSet.has(keyId)) {
      rejected.push(keyId);
      continue;
    }
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
// applyMultiRegistry (B14) — multi-source merge with priority + global revoke.
// ---------------------------------------------------------------------------

/**
 * Apply verified-per-source registries to the local trust store.
 *
 * @param {Array<{source:object, registry:object|null, rejected?:{reason:string,detail?:string}}>} appliedSources
 *   Pre-fetched, pre-verified registries paired with their source descriptor.
 *   `registry: null` indicates the source was skipped; `rejected` is non-null
 *   in that case.
 * @returns {Promise<{sources: Array, global_revocations: Array, conflicts: Array}>}
 */
export async function applyMultiRegistry(appliedSources) {
  const sources = [];
  const conflicts = [];
  const global_revocations = [];

  // Read current local trust + revoked stores.
  const tpPath = join(homedir(), '.ijfw', 'trusted-publishers.json');
  let store = { publishers: {} };
  try {
    const raw = await readFile(tpPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.publishers === 'object' && parsed.publishers !== null) {
      store = parsed;
    }
  } catch { /* absent */ }

  let revokedStore = { revoked: [] };
  try {
    const raw = await readFile(revokedPublishersPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.revoked)) revokedStore = parsed;
  } catch { /* absent */ }

  const revokedSet = new Set(revokedStore.revoked.map(r => r.keyId));

  // PASS 1: revocations from ALL sources are global (defense-in-depth).
  for (const { source, registry, rejected } of appliedSources) {
    if (!registry) continue;
    for (const entry of registry.revoked || []) {
      const { keyId } = entry;
      if (!keyId) continue;
      if (Object.prototype.hasOwnProperty.call(store.publishers, keyId)) {
        delete store.publishers[keyId];
      }
      if (!revokedSet.has(keyId)) {
        revokedSet.add(keyId);
        const rev = {
          keyId,
          revoked_at: entry.revoked_at || new Date().toISOString(),
          reason: entry.reason || '',
          superseded_by: entry.superseded_by || null,
          source: source.name,
        };
        revokedStore.revoked.push(rev);
        global_revocations.push({ keyId, source: source.name });
      }
    }
    // Stash the source preamble for the per-source report.
    sources.push({
      name: source.name,
      url: source.url,
      added: [],
      removed: [],
      unchanged: [],
      rejected: rejected ? [{ name: source.name, reason: rejected.reason, detail: rejected.detail }] : [],
      skipped: !registry,
    });
  }

  // PASS 2: publishers in priority order (lowest .priority first).
  const ordered = appliedSources
    .filter((x) => x.registry)
    .slice()
    .sort((a, b) => a.source.priority - b.source.priority);
  const claimedBy = new Map(); // keyId -> source name

  for (const { source, registry } of ordered) {
    const report = sources.find((s) => s.name === source.name);
    for (const [keyId, entry] of Object.entries(registry.publishers || {})) {
      if (!entry || typeof entry.publicKey !== 'string') {
        report.rejected.push({ keyId, reason: 'malformed' });
        continue;
      }
      if (revokedSet.has(keyId)) {
        report.rejected.push({ keyId, reason: 'revoked' });
        continue;
      }
      try {
        const key = createPublicKey(entry.publicKey);
        const der = key.export({ type: 'spki', format: 'der' });
        const fp = createHash('sha256').update(der).digest('hex');
        if (fp !== keyId) {
          report.rejected.push({ keyId, reason: 'fingerprint_mismatch' });
          continue;
        }
      } catch {
        report.rejected.push({ keyId, reason: 'pubkey_parse_failed' });
        continue;
      }

      if (claimedBy.has(keyId)) {
        const winner = claimedBy.get(keyId);
        if (winner !== source.name) {
          conflicts.push({ keyId, winner, also_in: source.name });
          report.rejected.push({ keyId, reason: 'priority_conflict', winner });
        }
        continue;
      }

      claimedBy.set(keyId, source.name);
      const existing = store.publishers[keyId];
      if (existing && existing.publicKey === entry.publicKey) {
        report.unchanged.push(keyId);
      } else {
        store.publishers[keyId] = {
          name: entry.name,
          publicKey: entry.publicKey,
          verified_at: entry.verified_at,
          metadata: entry.metadata,
          source: source.name,
          added_at: new Date().toISOString(),
        };
        if (existing) report.removed.push(keyId);
        report.added.push(keyId);
      }
    }
  }

  await mkdir(join(homedir(), '.ijfw'), { recursive: true });
  await writeFile(tpPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  await mkdir(ijfwStateDir(), { recursive: true });
  await writeFile(
    revokedPublishersPath(),
    JSON.stringify(revokedStore, null, 2) + '\n',
    'utf8',
  );

  return { sources, global_revocations, conflicts };
}

// ---------------------------------------------------------------------------
// refreshTrustFromAllRegistries (B14 + B17) — high-level federated entry.
//
// For each source:
//   1. Decide which parts are stale per split-TTL (publishers / revoked).
//   2. Fetch the stale part(s); fall back to cache on failure.
//   3. Verify against the source's meta key.
//   4. Update the per-source cache inside `withFsLock`.
//   5. Collect into appliedSources → applyMultiRegistry.
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] — injectable for tests; (url, source, part) -> {ok,body,error}
 * @param {boolean} [opts.allowSeed]
 * @param {boolean} [opts.emergency] — bypass all caches; force fetch.
 * @param {boolean} [opts.refreshPublishers] — override TTL check, fetch publishers.
 * @param {boolean} [opts.refreshRevocation] — override TTL check, fetch revocation.
 * @param {Array} [opts.sources] — override loadRegistrySources() (tests).
 * @returns {Promise<{ok:boolean, multi:object|null, warnings:string[], error:string|null}>}
 */
export async function refreshTrustFromAllRegistries(opts = {}) {
  const warnings = [];
  let sources;
  try {
    sources = opts.sources || (await loadRegistrySources());
  } catch (err) {
    if (err instanceof RegistrySourcesError) {
      return { ok: false, multi: null, warnings, error: `registries.json ${err.reason}: ${err.message}` };
    }
    throw err;
  }

  const appliedSources = [];

  for (const source of sources) {
    const fetchImpl = typeof opts.fetchImpl === 'function'
      ? (url, part) => opts.fetchImpl(url, source, part)
      : null;

    let cache;
    let corruptReason = null;
    const cacheRead = await readSourceCache(source);
    cache = cacheRead.cache;
    if (cacheRead.corrupt) {
      corruptReason = cacheRead.reason;
      const msg = `[ijfw] WARNING: cache for source '${source.name}' corrupt (${cacheRead.reason}) — ignored; falling back to network`;
      process.stderr.write(msg + '\n');
      warnings.push(msg);
    }

    const now = Date.now();
    const pubAge = cache.publishers_fetched_at ? now - Date.parse(cache.publishers_fetched_at) : Infinity;
    const revAge = cache.revocation_fetched_at ? now - Date.parse(cache.revocation_fetched_at) : Infinity;
    const wantPublishers = opts.emergency || opts.refreshPublishers || corruptReason || pubAge > source.publisher_ttl_ms;
    const wantRevocation = opts.emergency || opts.refreshRevocation || corruptReason || revAge > source.revocation_ttl_ms;

    let mergedRegistry = null;
    let fetchError = null;

    // Always fetch the full registry when we want publishers (the response is
    // the source of truth for both parts). When ONLY revocation is stale we
    // still issue a fetch (server returns the same JSON; CDN can cache
    // separately if it cares about ?part=revoked).
    if (wantPublishers || wantRevocation) {
      const part = wantPublishers ? 'all' : 'revoked';
      const fetched = await fetchRegistry(source.url, { fetchImpl, part });
      if (!fetched.ok) {
        fetchError = fetched.error;
      } else {
        const verified = verifyRegistry(fetched.body, {
          metaKeyPem: source.meta_key_pem,
          allowSeed: opts.allowSeed,
        });
        if (!verified.valid) {
          fetchError = `verify failed: ${verified.reason}`;
        } else {
          if (verified.warnings) {
            for (const w of verified.warnings) {
              const wMsg = `[ijfw] WARNING (source=${source.name}): ${w}`;
              process.stderr.write(wMsg + '\n');
              warnings.push(wMsg);
            }
          }
          mergedRegistry = verified.registry;
        }
      }
    }

    // Decide what cache to write + which registry to apply.
    if (mergedRegistry) {
      // Update cache.
      const nowIso = new Date().toISOString();
      const updatedCache = {
        publishers: wantPublishers ? mergedRegistry.publishers : cache.publishers,
        publishers_fetched_at: wantPublishers ? nowIso : cache.publishers_fetched_at,
        revoked: mergedRegistry.revoked || cache.revoked,
        revocation_fetched_at: nowIso,
        source_name: source.name,
        source_url: source.url,
      };
      try {
        await withSourceCache(source, () => updatedCache);
      } catch (err) {
        warnings.push(`[ijfw] WARNING: failed to write cache for source '${source.name}': ${err.message}`);
      }
      appliedSources.push({
        source,
        registry: {
          registry_version: '1.0',
          updated_at: mergedRegistry.updated_at,
          publishers: updatedCache.publishers,
          revoked: updatedCache.revoked,
          signature: mergedRegistry.signature,
        },
      });
      continue;
    }

    // Fetch failed or we didn't need to fetch. Try cache fallback.
    const cacheUsable =
      !corruptReason &&
      (cache.publishers_fetched_at !== null || cache.revocation_fetched_at !== null);
    if (cacheUsable) {
      appliedSources.push({
        source,
        registry: {
          registry_version: '1.0',
          updated_at: cache.publishers_fetched_at || cache.revocation_fetched_at,
          publishers: cache.publishers || {},
          revoked: cache.revoked || [],
          signature: 'cached',
        },
      });
      if (fetchError) {
        const msg = `[ijfw] WARNING: source '${source.name}' fetch failed (${fetchError}) — using cached entries`;
        process.stderr.write(msg + '\n');
        warnings.push(msg);
      }
      continue;
    }

    // No cache, no fresh fetch → skip with rejected marker (SEC-M-01 skip-with-warning).
    appliedSources.push({
      source,
      registry: null,
      rejected: {
        reason: corruptReason ? 'cache_corrupt' : 'fetch_failed',
        detail: fetchError || corruptReason || 'no cache available',
      },
    });
    const msg = corruptReason
      ? `[ijfw] WARNING: source '${source.name}' skipped (cache_corrupt: ${corruptReason})`
      : `[ijfw] WARNING: source '${source.name}' skipped (${fetchError || 'no cache'})`;
    process.stderr.write(msg + '\n');
    warnings.push(msg);
  }

  const multi = await applyMultiRegistry(appliedSources);
  return { ok: true, multi, warnings, error: null };
}

// ---------------------------------------------------------------------------
// refreshTrustFromRegistry — v1.4.1 single-source entry point.
//
// v1.4.3 wires this through the new multi-source pipeline when no explicit
// `url` (i.e. caller wants federated default) AND no `fetchImpl` injected for
// the single-source legacy tests. The legacy URL-passing tests continue to use
// the old single-source code path so they keep their explicit assertions.
// ---------------------------------------------------------------------------

/**
 * Fetch → verify → apply → cache. The main entry point for the CLI.
 * Falls back to cache on offline; warns if stale.
 *
 * v1.4.3 (B17): opts.partTtl now influences cache TTL when split fetching;
 * opts.emergency forces a no-cache refresh.
 *
 * @param {string} [url]
 * @param {object} [opts]
 * @returns {Promise<{ok: boolean, diff: object|null, fromCache: boolean, warnings: string[], error: string|null}>}
 */
export async function refreshTrustFromRegistry(url = DEFAULT_REGISTRY_URL, opts = {}) {
  const warnings = [];

  const fetched = await fetchRegistry(url, opts);
  if (!fetched.ok) {
    const cached = await readCachedRegistry();
    if (cached.registry) {
      if (cached.stale) warnings.push(`offline and cache is stale (age > ${CACHE_TTL_MS / 3600000}h) — trust store not updated`);
      else warnings.push('offline — using cached registry');
      return { ok: true, diff: null, fromCache: true, warnings, error: null };
    }
    warnings.push(`offline and no cache available — trust store unchanged: ${fetched.error}`);
    return { ok: true, diff: null, fromCache: false, warnings, error: null };
  }

  const verified = verifyRegistry(fetched.body, opts);
  if (!verified.valid) {
    return { ok: false, diff: null, fromCache: false, warnings, error: `registry verify failed: ${verified.reason}` };
  }
  if (verified.warnings && verified.warnings.length > 0) {
    for (const w of verified.warnings) {
      process.stderr.write(`[ijfw] WARNING: ${w}\n`);
      warnings.push(w);
    }
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
import { resolve as pathResolve, relative as pathRelative, isAbsolute as pathIsAbsolute } from 'node:path';
import { cwd } from 'node:process';

/**
 * Cross-platform path-under-cwd check.
 */
function isUnderCwd(targetPath) {
  const abs = pathResolve(targetPath);
  const cwdAbs = pathResolve(cwd());
  if (abs === cwdAbs) return true;
  const rel = pathRelative(cwdAbs, abs);
  return rel !== '' && !rel.startsWith('..') && !pathIsAbsolute(rel);
}

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

  await writeFile(
    join(dir, 'meta-role.txt'),
    `meta\n${author || 'unknown'}\n${new Date().toISOString()}\n`,
    'utf8',
  );

  return { keyId, publicKey: pubPem, dir };
}

export async function signRegistry(registryPath, opts = {}) {
  const abs = pathResolve(registryPath);
  if (!isUnderCwd(registryPath)) {
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

  let privPem = opts.privateKeyPem || null;
  if (!privPem) {
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

export async function verifyRegistryFile(registryPath) {
  const abs = pathResolve(registryPath);
  if (!isUnderCwd(registryPath)) {
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

export {
  DEFAULT_REGISTRY_URL,
  FALLBACK_REGISTRY_URL,
  CACHE_TTL_MS,
  PUBLISHER_TTL_MS,
  REVOCATION_TTL_MS,
  IJFW_REGISTRY_META_KEY_PEM,
  META_KEY_SENTINEL,
  SOURCE_NAME_PATTERN,
  perSourceCachePath,
  perSourceLockPath,
};
