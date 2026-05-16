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
 * Full implementation lands in t7 (Wave 1). This file is the Wave 0 stub
 * providing signatures the rest of the plan compiles against.
 *
 * Spec: .planning/1.4.0/security-spec.md
 */

// TODO(v1.5.0): rename file to `extension-integrity.js` and add a separate
// `extension-signing.js` for asymmetric publisher signatures (residual R13).

/**
 * Produce the canonical JSON representation of a manifest for hashing.
 * Recursively sorts object keys; omits the top-level `integrity` field.
 *
 * @param {object} _manifest
 * @returns {string} canonical JSON string (UTF-8)
 *
 * TODO t7 (Wave 1): full implementation. Sort keys recursively;
 * strip top-level `integrity`; UTF-8 stringify; no trailing whitespace.
 */
export function canonicalise(_manifest) {
  // TODO t7: implement canonical JSON serialisation.
  return '';
}

/**
 * Compute the SHA256 integrity hash over the canonical manifest and return
 * a copy of the manifest with the `integrity` field populated.
 *
 * @param {object} manifest
 * @returns {object} manifest with `integrity: "sha256:<64 lowercase hex>"`
 *
 * TODO t7 (Wave 1): use `node:crypto.createHash('sha256')` over
 * `canonicalise(manifest)` to compute the hex digest.
 */
export function computeIntegrity(manifest) {
  // TODO t7: replace placeholder with crypto.createHash('sha256').update(canonicalise(manifest)).digest('hex').
  return { ...manifest, integrity: 'sha256:' + '0'.repeat(64) };
}

/**
 * Verify the integrity hash on a manifest. Recomputes the canonical hash and
 * compares to the `integrity` field. Enforces the strict format
 * `^sha256:[a-f0-9]{64}$` per residual R5.
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, expected: string | null, got: string | null }}
 *
 * TODO t7 (Wave 1): full implementation.
 */
export function verifyIntegrity(manifest) {
  // TODO t7: implement format check + canonical recompute + comparison.
  return { valid: false, expected: null, got: manifest?.integrity ?? null };
}

/**
 * Walk all files under `extensionDir` and scan each value for known secret
 * patterns using `classify()` from `mcp-server/src/redactor.js`. Does NOT
 * use `redactSecrets()` for detection — that returns the redacted string,
 * not findings.
 *
 * Rejects install if any finding. Findings include `{file, line, kind}` —
 * never the matched value itself.
 *
 * @param {string} _extensionDir
 * @returns {{ clean: boolean, findings: Array<{ file: string, line: number, kind: string }> }}
 *
 * TODO t7 (Wave 1): walk files; for each candidate value call classify();
 * record findings where `clean === false`. Skip binary files and
 * `node_modules/`, `.git/`. Also run `redactSecrets()` once per file and
 * compare to original to catch INLINE rules (key=value style).
 */
export function scanExtensionForSecrets(_extensionDir) {
  // TODO t7: implement static secret scan using classify() from redactor.js.
  return { clean: true, findings: [] };
}

/**
 * Validate the declarative permissions block on a manifest. v1.4.0
 * permissions are intent only — runtime enforcement is deferred to v1.5.0.
 * This validator only checks shape: `{reads: string[], writes: string[]}`.
 *
 * @param {object} _manifest
 * @returns {{ valid: boolean, errors: string[] }}
 *
 * TODO t7 (Wave 1): full implementation. Check that permissions is an
 * object, reads is string[], writes is string[]. Empty arrays allowed.
 * Missing block is allowed (treated as `{reads: [], writes: []}`).
 */
export function validatePermissions(_manifest) {
  // TODO t7: implement shape validation.
  return { valid: true, errors: [] };
}
