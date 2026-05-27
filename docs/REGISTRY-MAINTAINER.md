# IJFW Registry Maintainer Guide

This document covers the admin workflow for the hosted publisher key registry
(`docs/registry/publishers/v1.json`). Normal users do not need this — it is
for the IJFW project maintainer (Ferrox Labs) only.

---

## Registry file

**Repo path:** `docs/registry/publishers/v1.json`

**Deployed URL (primary):** `https://registry.ijfw.dev/publishers/v1.json`

**Deployed URL (fallback):** `https://ferroxlabs.github.io/ijfw/registry/publishers/v1.json`

The fallback URL is served by GitHub Pages via the `.github/workflows/pages.yml`
workflow. It deploys automatically on every push to `main` that includes a
change to `docs/registry/publishers/v1.json`.

---

## Admin commands (not shown in normal help)

All commands run via the IJFW MCP `extension` tool or the CLI shim:

```bash
cd mcp-server
node --input-type=module <<'EOF'
import { extensionDispatch } from './src/dispatch/extension.js';
const r = await extensionDispatch({ command: 'keygen-meta', args: 'Ferrox Labs' });
console.log(JSON.stringify(r, null, 2));
EOF
```

### `keygen-meta <author>`

Generates a new Ed25519 meta-keypair (the root signing key for the registry).
- Public key: written to `~/.ijfw/keys/<keyId>/public.pem`
- Private key: written to `~/.ijfw/keys/<keyId>/private.pem` (mode 0600)
- Marker: `~/.ijfw/keys/<keyId>/meta-role.txt` distinguishes this from publisher keys

**The private key never leaves the maintainer's machine and is NEVER committed.**

After keygen-meta you must:
1. Copy the public key PEM into `mcp-server/src/extension-registry.js` as the
   `IJFW_REGISTRY_META_KEY_PEM` constant.
2. Ship a new v1.4.x release — the compiled-in public key is the trust root.

### `sign-registry <path>`

Signs `docs/registry/publishers/v1.json` in place. Updates `signature` and
`updated_at`. Writes atomically.

```bash
node --input-type=module <<'EOF'
import { extensionDispatch } from './src/dispatch/extension.js';
const r = await extensionDispatch({ command: 'sign-registry', args: '../docs/registry/publishers/v1.json' });
console.log(JSON.stringify(r, null, 2));
EOF
```

The command auto-discovers the meta private key from `~/.ijfw/keys/` by looking
for directories containing a `meta-role.txt` marker. If multiple meta keys
exist (shouldn't happen), the first one found is used.

### `verify-registry <path>`

Verifies the signature on a registry file against the compiled-in meta-key:

```bash
node --input-type=module <<'EOF'
import { extensionDispatch } from './src/dispatch/extension.js';
const r = await extensionDispatch({ command: 'verify-registry', args: '../docs/registry/publishers/v1.json' });
console.log(JSON.stringify(r, null, 2));
EOF
```

### `registry-status`

Shows the local cache age, size, publisher count, and signature status:

```bash
ijfw extension registry-status
```

---

## Adding a publisher

1. Obtain the publisher's Ed25519 public key PEM and keyId (sha256 fingerprint
   of the SPKI DER).
2. Verify the publisher's identity out-of-band (GitHub profile, email, etc.).
3. Add an entry to `docs/registry/publishers/v1.json`:

```json
{
  "publishers": {
    "<keyId>": {
      "name": "Publisher Name",
      "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
      "verified_at": "2026-05-17T00:00:00.000Z",
      "metadata": {
        "homepage": "https://example.com",
        "github": "https://github.com/handle"
      }
    }
  }
}
```

4. Sign: `extension sign-registry ../docs/registry/publishers/v1.json`
5. Verify: `extension verify-registry ../docs/registry/publishers/v1.json`
6. Commit + push to `main` — the `pages:` CI job deploys automatically.

---

## Revoking a publisher

When a publisher key is compromised, lost, or superseded by rotation:

1. Remove the entry from `publishers` (or leave it — applyRegistry will ignore
   revoked entries already absent from the local store).
2. Add an entry to `revoked`:

```json
{
  "revoked": [
    {
      "keyId": "<old-keyId>",
      "revoked_at": "2026-05-17T00:00:00.000Z",
      "reason": "key compromised",
      "superseded_by": "<new-keyId or null>"
    }
  ]
}
```

3. Sign, verify, commit, push.

Clients that fetch the updated registry will:
- Remove the revoked keyId from their local trust store.
- Record it in `~/.ijfw/state/revoked-publishers.json` so it can never be
  re-added via `extension trust <keyId>`.

---

## Key rotation policy

Meta-key rotation (the registry signing key) requires a new v1.4.x release:

1. Run `extension keygen-meta <author>` → new keypair in `~/.ijfw/keys/`.
2. Copy the new public key PEM into `IJFW_REGISTRY_META_KEY_PEM` in
   `mcp-server/src/extension-registry.js`.
3. Re-sign the registry with the new private key.
4. Ship the release. Old clients with the old compiled-in meta-key will stop
   accepting the re-signed registry — this is intentional (forced upgrade).

**Never rotate the meta-key casually.** It invalidates all existing clients'
ability to verify the registry until they upgrade. Only rotate on confirmed
compromise or scheduled security review (annual or per-release).

A publisher who **loses** their private key (cannot self-rotate via
`extension rotate-keys`) must contact the registry maintainer for an
out-of-band identity check + manual key replacement: the maintainer adds the
new key to `publishers` and adds the old key to `revoked` without a
rotation token. Document the identity verification in the revocation `reason`.

---

## Lost old key — manual key replacement

A publisher who **loses** their old private key cannot produce a rotation token
(the token must be signed by the old key as proof of control). The
`extension rotate-keys` command will fail with "old keypair not found".

**Limitation:** There is no cryptographic way to verify the publisher's identity
without the old private key. Manual out-of-band verification is required.

**Maintainer steps:**

1. Receive a key replacement request from the publisher out-of-band (email,
   signed message with a separate identity credential, etc.).
2. Verify the publisher's identity independently — do NOT rely solely on the
   request message.
3. Add the new key to `publishers` in `docs/registry/publishers/v1.json`.
4. Add the old key to `revoked` with `reason` documenting the identity
   verification performed and `superseded_by` set to the new keyId:

```json
{
  "keyId": "<old-keyId>",
  "revoked_at": "2026-05-17T00:00:00.000Z",
  "reason": "lost key — identity verified via GitHub signed commit on 2026-05-17",
  "superseded_by": "<new-keyId>"
}
```

5. Sign, verify, commit, push — clients will pick up the new key on next
   `extension trust-registry` and reject the old one.

**Note:** Any extension manifests signed with the lost old key will stop
verifying on client machines after the registry update. The publisher must
re-sign all existing extensions with the new private key and publish new
versions.

---

## Deployment

The `.github/workflows/pages.yml` workflow copies the registry JSON to the
GitHub Pages public tree on every push to `main`. No manual deploy step is
required.

Verify deployment after pushing:

```bash
curl https://ferroxlabs.github.io/ijfw/registry/publishers/v1.json | jq .signature
```

---

# v1.4.3 — Federation + Live Revocation (B14 + B17)

v1.4.1 shipped a single hosted publisher registry. v1.4.3 generalizes this into **federated registries**: a priority-ordered list of independently signed sources, each with its own meta-key, configured per-machine via `~/.ijfw/registries.json`. Corporate operators can layer an internal registry on top of the public one without forking IJFW.

## `~/.ijfw/registries.json` schema

```json
{
  "schema_version": "1.0",
  "registries": [
    {
      "name": "corporate",
      "url": "https://registry.corp.example.com/publishers/v1.json",
      "meta_key_pem": "-----BEGIN PUBLIC KEY-----\n<corp meta pubkey>\n-----END PUBLIC KEY-----",
      "priority": 0,
      "publisher_ttl_ms": 86400000,
      "revocation_ttl_ms": 300000
    },
    {
      "name": "public",
      "url": "https://ferroxlabs.github.io/ijfw/registry/publishers/v1.json",
      "meta_key_pem": "<embedded>",
      "priority": 1,
      "publisher_ttl_ms": 86400000,
      "revocation_ttl_ms": 300000
    }
  ]
}
```

- `name` — must match `/^[a-z0-9_-]+$/` (filesystem-safe; used in per-source cache paths).
- `meta_key_pem` — accepts the literal sentinel `"<embedded>"` OR field-absent to resolve to the compiled-in `IJFW_REGISTRY_META_KEY_PEM`. Any other value MUST parse as a valid Ed25519 SPKI PEM.
- `priority` — lower number = higher priority. Same-keyId publishers from a higher-priority source win.
- `publisher_ttl_ms` / `revocation_ttl_ms` — split TTLs for live revocation. Revocation refreshes every 5 minutes; publisher refreshes every 24 hours by default.

If `~/.ijfw/registries.json` is missing, IJFW falls back to the single-public-registry behavior (back-compat with v1.4.1).

## Precedence + conflict resolution

- **Publishers:** higher-priority source wins. Conflicts are reported (not silenced) in `applyMultiRegistry().sources[].rejected`.
- **Revocations:** ANY trusted source's `revoked[]` entry revokes globally (defense-in-depth — no "trust the lower-priority less" semantics for revocation).
- **Malformed container** (parse error, missing required keys, schema violation): throws `RegistrySourcesError` with `{line, column, reason}`. The `trust-registry` CLI catches and exits 1. NEVER silently falls back when a malformed file exists.
- **Source-level failure** (network timeout, signature invalid, meta-key mismatch): that source is skipped with a stderr warning and reported in `applyMultiRegistry().sources[].rejected`. Other sources continue. Per-source cache is used as a fallback if available.
- **Cache corruption** (per-source cache file unparseable / wrong source_name): treated as cache-absent for refresh; emits `[ijfw] WARNING: cache for source '<name>' corrupt — ignored`; existing in-memory trust state for that source is preserved.

## Per-source cache files

Located at `~/.ijfw/state/registry-cache-<sanitized-name>.json`:

```json
{
  "publishers":            { /* keyId → publisher entry */ },
  "publishers_fetched_at": "<ISO>",
  "revoked":               [ /* RevokedEntry */ ],
  "revocation_fetched_at": "<ISO>",
  "source_name":           "<name>",
  "source_url":            "<url>"
}
```

The two `_fetched_at` fields enable split-TTL refresh: revocation re-fetched every 5 min, publishers every 24 h, both written back to the same file. All read-modify-write paths over these files run inside `withFsLock` (see `EXTENSION-SECURITY.md::Concurrency`).

## Emergency revocation

```bash
ijfw extension trust-registry --emergency
```

Bypasses every cache and forces a fresh fetch of both publishers and revocation from every configured source. Use after a known key compromise to invalidate the stale revocation TTL.

## CLI subcommands (v1.4.3)

- `ijfw extension registry-list` — prints sources in priority order with name/url/last-fetch
- `ijfw extension registry-add <name> <url> [<meta-key-path>]` — appends to `registries.json`; validates meta-key PEM
- `ijfw extension registry-remove <name>` — removes by name
- `ijfw extension registry-prioritize <name> <position>` — moves source to new priority slot
- `ijfw extension registry-status` — reports per-source state (publishers_last_fetched_at, revocation_last_fetched_at, rejected[])
- `ijfw extension trust-registry --emergency [<url>]` — bypass-cache forced refresh

## WebSocket revocation protocol (v1.5.0 server infrastructure)

v1.4.3 ships the **WebSocket CLIENT** (gated by `IJFW_REGISTRY_WS_URL` or `IJFW_REGISTRY_WS_SOURCE`). The SERVER infrastructure (always-on push) is deferred to v1.5.0. With the 5-min TTL fallback, this is acceptable: clients miss the push but pick up revocations within 5 minutes of CDN propagation.

### Client source binding

Clients map their WS endpoint to a configured source via EITHER:
- `IJFW_REGISTRY_WS_SOURCE=<name>` (PREFERRED) — exact `name` match in `registries.json`. Reject if no match.
- `IJFW_REGISTRY_WS_URL=<ws://...>` (legacy short form) — mapped by `origin + pathname-prefix` match (NEVER host-only). Zero matches → refuse. Multiple matches → refuse with "set IJFW_REGISTRY_WS_SOURCE=<name>".

The client verifies each push message against the bound source's `meta_key_pem`. A different source MAY share a host (e.g., enterprise proxy fronting multiple registries) — explicit binding eliminates ambiguity.

### Server-to-client signed-payload schema

```json
{
  "registry_version": "1.0",
  "source_name":      "<name>",
  "source_url":       "<url>",
  "updated_at":       "<ISO>",
  "revoked":          [ /* RevokedEntry, same shape as registry.revoked */ ],
  "sequence_number":  42,
  "signature":        "ed25519:<base64>"
}
```

Canonical signing bytes = JSON-stringify with sorted keys, EXCLUDING the `signature` field (same algorithm as `registryCanonicalBytes`).

### Client verification rules

1. Verify `signature` against the bound source's `meta_key_pem` (Ed25519, raw 64-byte sig).
2. Verify `source_name` and `source_url` match the bound source.
3. Verify `sequence_number > last_seen_sequence_for_source` (replay defense). Maintained in-memory per source for the WS session lifetime.
4. On all valid: merge `revoked[]` entries into the source's cache file inside `withFsLock` and update `revocation_fetched_at`.
5. On disconnect: silently fall back to TTL polling (no behavior change).

### Handshake (`node:net` fallback path)

For Node versions before `globalThis.WebSocket` is native (or environments where it's unavailable), the client falls back to a raw `node:net` TCP socket performing the RFC 6455 handshake inline:

- Client generates a random 16-byte `Sec-WebSocket-Key` (base64-encoded) in the HTTP Upgrade request.
- Client expects the response to contain `Sec-WebSocket-Accept: <base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))>`.
- On absent or mismatched Accept header, the client refuses upgrade with `[ijfw] WS handshake verification failed for source '<name>' — refusing connection`.

This is a basic anti-hijack measure for the opt-in WS path.

## Out of scope for v1.4.3 (deferred to v1.5.0)

- WebSocket SERVER infrastructure (always-on push origin)
- Hosted publisher KEY DISCOVERY (clients still need to install per-source meta-keys manually)
- Key rotation revocation-list distribution federation (in v1.4.3 each source is independently rotated by its own meta-key)

