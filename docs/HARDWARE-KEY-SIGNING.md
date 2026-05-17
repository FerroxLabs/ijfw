# Hardware-Key Signing for IJFW Publishers

IJFW v1.4.3 adds a pluggable signing-backend abstraction so publisher
private keys can live in a hardware token (YubiKey, Solokey, etc.) instead
of on disk. The private key never enters the IJFW process — all signing
operations are forwarded to your running SSH agent, which in turn forwards
them to the token.

## TL;DR

```bash
# 1. Generate (or already have) an Ed25519 key on your hardware token.
ssh-keygen -t ed25519-sk -O resident -O application=ssh:ijfw-publisher \
  -C "ijfw-publisher@$(hostname)"

# 2. Make sure ssh-agent is running and the key is loaded.
echo "$SSH_AUTH_SOCK"          # must be non-empty
ssh-add -L | grep ssh-ed25519  # must list your token-backed key

# 3. Enroll the agent-backed key as an IJFW publisher key.
ijfw extension keygen "Your Name" \
  --backend ssh-agent \
  --ssh-key-comment "ijfw-publisher@$(hostname)"
```

That's it. From now on, when you sign a manifest with
`publisher_key_backend: "ssh-agent"`, IJFW asks the agent to sign; the
hardware token blinks (or asks for a tap/PIN per the token's policy); the
agent returns a 64-byte Ed25519 signature; the manifest is wrapped and
shipped. The token's private key never touches IJFW process memory.

## Supported hardware

Anything that speaks the OpenSSH agent protocol with an Ed25519 identity:

- **YubiKey 5 / 5C / Bio** (`ed25519-sk` resident keys)
- **Solokey Solo 2 / Tap** (`ed25519-sk` resident keys)
- **Nitrokey 3** (FIDO2 + SSH)
- **gpg-agent** with a smartcard-resident Ed25519 key
- **Pageant** on Windows (with hardware-token plugins)
- **1Password SSH agent** (software-backed but signs out-of-process; same
  trust model upgrade as a hardware token — IJFW never sees the private key)
- **Plain `ssh-agent` with a software Ed25519 key** — supported, useful for
  development; the private key never enters IJFW process memory but does
  exist on disk in your `~/.ssh/`.

## Why SSH agent, not libfido2?

libfido2 / `node-fido2-lib` would be IJFW's first native production
dependency. That's a v1.5.0+ architecture conversation — the install story
(prebuilt binaries per platform, fallback for unsupported targets, supply
chain story for the native blob) is heavy. SSH agent is already on every
macOS / Linux box, ships with Windows 10+, and modern hardware tokens speak
it natively. Zero new IJFW dependencies; same security property.

`ijfw extension keygen-fido2` is reserved and prints a one-line message
routing you to `--backend ssh-agent` until v1.5.0 lands.

## Security model

| Property | Software backend (default, v1.4.0) | SSH-agent backend (v1.4.3, B15) |
|---|---|---|
| Where the private key lives | `~/.ijfw/keys/<keyId>/private.pem` (mode 0600) | Inside the agent — never on disk in clear; for hardware tokens, never leaves the token |
| Who can sign | Anyone with read access to your `~/.ijfw/keys/` | Anyone who can talk to your live agent socket (and pass the token's tap/PIN policy if any) |
| Signature format | Raw Ed25519, identical | Raw Ed25519, identical — sigs are wire-compatible across backends |
| Verification | Software backend (always — any backend's Ed25519 sig is verifiable with the raw public key) | Software backend (same) |

**Identity selection (SEC-H-03):** when the ssh-agent backend signs, IJFW
asks the agent for its list of identities, then matches the expected
public-key wire blob (stored in `~/.ijfw/keys/<keyId>/backend.json`)
against each candidate using a constant-time byte comparison. The
SSH key **comment** field is recorded for human display and never used for
matching. An attacker who adds a malicious agent identity with a colliding
comment cannot trick IJFW into signing with their key — only raw key
material matches.

**Backend resolution is fail-closed (SEC-L-02):** a manifest with
`publisher_key_backend: "libfido2"` (or any value other than `"software"` /
`"ssh-agent"`) is rejected at validation time, not silently downgraded to
software. New backends must be explicitly added to `resolveBackend()`.

## How signing works under the hood

1. You ship a manifest with `publisher_key_backend: "ssh-agent"` and a
   matching `publisher_key_id` (sha256 fingerprint of your public key).
2. `signManifestWithBackend()` resolves the backend, canonicalises the
   manifest (sorted keys, drop `signature`/`integrity`), and asks the
   backend to sign the canonical bytes.
3. The SSH-agent backend reads `~/.ijfw/keys/<keyId>/backend.json` to find
   the expected `pubkey_blob_hex`, enumerates the agent's identities via
   `SSH2_AGENTC_REQUEST_IDENTITIES`, picks the one whose pubkey blob equals
   the expected blob, and issues `SSH2_AGENTC_SIGN_REQUEST` with the
   payload. The agent returns an SSH-wire signature; IJFW unwraps the
   inner 64-byte raw Ed25519 signature and embeds it as
   `signature: "ed25519:<base64>"`.
4. Verifiers (other IJFW installs) verify with the **software backend** —
   they only need the public PEM, no agent required.

## FIDO2 / tap & PIN policies

IJFW does not configure your token's tap or PIN policy. Set it once with
your agent / token tooling (e.g.
`ssh-keygen -t ed25519-sk -O verify-required` for tap-on-every-signature)
and IJFW inherits it: every manifest signature triggers exactly one tap
(or one PIN entry, etc.) at the OS level. There is no IJFW-side knob —
this is intentional, so the security policy lives in one place.

## Migrating an existing software key to hardware

Rotation is the supported migration path:

1. Enroll the new hardware-backed keyId via `keygen --backend ssh-agent`.
2. Issue a rotation token signed by the OLD software key:
   `signRotationTokenWithBackend({ oldKeyId, newPublicKeyPem })`.
3. Publish the rotation token to the registry per the standard B8 flow.
4. Once propagated, decommission the old software key (delete its files
   from `~/.ijfw/keys/<old-keyId>/`).

There is no in-place upgrade — keys are immutable once issued. This is the
same property that makes Ed25519 secure: a key is a 32-byte fact, not a
mutable resource.

## Disk layout under `~/.ijfw/keys/<keyId>/`

| Backend | Files |
|---|---|
| `software` | `public.pem`, `private.pem` (0600), optional `author.txt` |
| `ssh-agent` | `public.pem`, `backend.json`, optional `author.txt`. **No private key file.** |

`backend.json` shape:

```json
{
  "backend": "ssh-agent",
  "pubkey_blob_hex": "0000000b7373682d65643235353139000000200a...",
  "keyId": "8e3c505d0d775df6a917c442520cf0bd4e84199c7ca6cae57088df4162150f49",
  "ssh_key_comment": "ijfw-publisher@laptop"
}
```

`pubkey_blob_hex` is the hex-encoded SSH wire blob:
`SSH-string("ssh-ed25519") || SSH-string(raw32-pubkey)`. This is what the
agent emits in `SSH2_AGENT_IDENTITIES_ANSWER`; we store it verbatim so
sign-time matching is a constant-time byte compare.

## Troubleshooting

**`SSH agent not available; set SSH_AUTH_SOCK or use --backend software`**
Your shell can't see a running agent. On macOS, `ssh-add -L` will start one
on demand. On Linux, see `systemctl --user status ssh-agent`. On Windows,
ensure the OpenSSH Authentication Agent service is running.

**`SSH agent identity not found for keyId <id>; expected pubkey blob ...`**
The agent has identities, but none of them is the one you enrolled. Run
`ssh-add -L` to confirm your key is loaded. If you swapped tokens, you'll
need to re-enroll (the keyId — and thus your IJFW identity — is tied to
the public-key bytes, not the comment).

**`Ambiguous SSH agent identities for keyId <id>`**
The agent serves the same public-key blob twice. This is unusual
(typically a duplicate `ssh-add` from two sources). Restart the agent or
remove duplicates with `ssh-add -d`.

**The token doesn't blink / I never get a tap prompt**
Either your token policy is set to no-tap (check
`ssh-keygen -t ed25519-sk -O ...` flags at creation time), or your agent
is caching the signature material. This is an agent-side concern, not
IJFW.
