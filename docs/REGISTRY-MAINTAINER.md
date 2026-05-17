# IJFW Registry Maintainer Guide

This document covers the admin workflow for the hosted publisher key registry
(`docs/registry/publishers/v1.json`). Normal users do not need this — it is
for the IJFW project maintainer (Sean Donahoe) only.

---

## Registry file

**Repo path:** `docs/registry/publishers/v1.json`

**Deployed URL (primary):** `https://registry.ijfw.dev/publishers/v1.json`

**Deployed URL (fallback):** `https://therealseandonahoe.gitlab.io/ijfw/registry/publishers/v1.json`

The fallback URL is served by GitLab Pages via the `pages:` CI job. It deploys
automatically on every push to `main` that includes a change to
`docs/registry/publishers/v1.json`.

---

## Admin commands (not shown in normal help)

All commands run via the IJFW MCP `extension` tool or the CLI shim:

```bash
cd mcp-server
node --input-type=module <<'EOF'
import { extensionDispatch } from './src/dispatch/extension.js';
const r = await extensionDispatch({ command: 'keygen-meta', args: 'Sean Donahoe' });
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
        "gitlab": "https://gitlab.com/handle",
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

## Deployment

The `pages:` CI job in `.gitlab-ci.yml` copies the registry JSON to the Pages
public tree on every push to `main`. No manual deploy step is required.

Verify deployment after pushing:

```bash
curl https://therealseandonahoe.gitlab.io/ijfw/registry/publishers/v1.json | jq .signature
```
