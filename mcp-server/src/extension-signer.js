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

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { classify } from './redactor.js';
import { isSafeVerifyCommand } from './ralph-allowlist.js';
import {
  INTEGRITY_PATTERN,
  PERMISSION_READS,
  PERMISSION_WRITES,
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
 * Extract shell commands from markdown fenced code blocks (```bash / ```sh /
 * ```shell) and inline `$ <cmd>` lines, then run each through
 * `isSafeVerifyCommand()`. Returns findings for unsafe commands (FORBID_LIST
 * matches). Allowlist misses do NOT produce findings — skill bodies
 * legitimately contain prose like `npm run dev` that isn't a verify primitive.
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

  // 1. Fenced code blocks: ```bash / ```sh / ```shell.
  const fenceRe = /```(bash|sh|shell)\s*\n([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(skillBody)) !== null) {
    const block = m[2];
    const rawLines = block.split(/\r?\n/);
    for (const raw of rawLines) {
      // Split compound commands on &&, ||, ;, newline.
      const segments = raw.split(/&&|\|\||;/);
      for (const segRaw of segments) {
        const seg = segRaw.trim();
        if (!seg) continue;
        if (seg.startsWith('#')) continue; // comment
        const result = isSafeVerifyCommand(seg);
        if (result.safe === false && /is in forbid list/.test(result.reason)) {
          findings.push({
            kind: 'unsafe-command',
            command: seg.slice(0, 80),
            reason: result.reason,
          });
        }
      }
    }
  }

  // 2. Inline `$ <cmd>` lines OUTSIDE fenced blocks. We do a second pass
  //    after stripping fenced blocks so we don't double-count.
  const stripped = skillBody.replace(/```[\s\S]*?```/g, '');
  const inlineRe = /^\s*\$\s+(.+)$/gm;
  while ((m = inlineRe.exec(stripped)) !== null) {
    const segments = m[1].split(/&&|\|\||;/);
    for (const segRaw of segments) {
      const seg = segRaw.trim();
      if (!seg) continue;
      if (seg.startsWith('#')) continue;
      const result = isSafeVerifyCommand(seg);
      if (result.safe === false && /is in forbid list/.test(result.reason)) {
        findings.push({
          kind: 'unsafe-command',
          command: seg.slice(0, 80),
          reason: result.reason,
        });
      }
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
