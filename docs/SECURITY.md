# IJFW Security Model

Threat model for the 1.1.6 update flow + MCP trust boundary.

## Trust boundaries

IJFW separates three trust zones:

1. **MCP-spawned context** -- model-driven. Anything reaching this layer can be influenced by prompt injection in stored memory, fetched docs, or user content.
2. **Terminal-side CLI** -- human-driven. Commands typed into `ijfw ...` by the user. Out of band from any model.
3. **Background hooks** -- runtime-driven. SessionStart fires `ijfw-check-update.sh` detached; never accepts model input.

The 1.1.6 update flow assumes 1 is hostile, 2 is the only authority capable of running code, and 3 only writes status into the cache file.

## Update flow trust model

`ijfw_update_check` (MCP tool):
- Reads cached version + computes availability
- If update available, issues a 128-bit cryptographic confirmation token (5 min TTL)
- Writes the token to `~/.ijfw/run/<session>/update-token.json` (0600)
- Returns the token to the model with an instruction telling the user to run `ijfw update --confirm <token>` in their terminal

`ijfw_update_apply` (MCP tool):
- Validates the token (expiry + match + not-yet-consumed)
- Writes a pending sentinel to `~/.ijfw/run/<session>/update-pending.json`
- **Does NOT execute anything.** Returns instruction telling the user to run `ijfw update --confirm <token>`

`ijfw update --confirm <token>` (terminal CLI):
- Reads sentinel, validates token, marks consumed
- **Refuses if `IJFW_FROM_MCP=1` is set** (prevents MCP-spawned subprocess workaround)
- Runs the actual update flow with full provenance verification

This means: even if a hostile prompt convinces the model to invoke `ijfw_update_apply`, no code runs until a human types the token in their terminal. The token itself doesn't grant remote-code-execution -- only the act of typing it does.

## Provenance + supply-chain integrity

`ijfw update`:
1. Runs `npm audit signatures @ijfw/install@<target>`. On signature failure the interactive flow refuses unless the user re-confirms with `--yes` (acknowledging unverified provenance).
2. Cross-verifies the target shasum against the GitLab release asset shasum (second factor; F-SEC-7). Compares npm's reported `dist.shasum` against the shasum the publisher recorded in the GitLab release description. Outcomes:
   - `verified` -- both shasums match: install proceeds.
   - `mismatch` -- both available but differ: install is REFUSED (fail closed, non-zero exit). This catches the case where the npm registry is serving a tampered tarball, or the GitLab release was tampered with, or the publisher made an inconsistent release.
   - `advisory` -- GitLab side is missing (older release, no shasum published, or transient fetch failure): requires explicit `--yes` to proceed; non-interactive contexts fail closed.
   - `error` -- npm side missing (no shasum reported by `npm view`): install is REFUSED.
3. On success: persists `last_good_shasum = <target shasum>` and `last_applied_version = <target>` to `state.json`. `last_good_shasum` is only written when the shasum was actually cross-verified (mode `verified`); advisory paths leave the previous value untouched so the record never contains an unverified hash.

Critically, `last_good_shasum` records the CURRENTLY INSTALLED version's shasum -- not a comparison target. Earlier drafts (v2) required the new version's shasum to equal the old, which would have refused every legitimate update. v3 corrects this: shasum is a one-way "what did we actually install" record, not a precondition.

Provenance attests origin, not safety. A compromised maintainer token could still sign a malicious release. This is documented limitation; the OOB confirmation step is the safety net. The shasum cross-check adds an independent second factor: even if the npm registry credential is compromised, the attacker would also need to compromise the GitLab release page (or the publisher's CI key that posts the shasum there) to avoid a mismatch.

## Re-entrancy guard

After successful update, `state.json.last_applied_version` is set to the just-installed version. The MCP `ijfw_update_check` tool, the SessionStart hook, the statusline (Wave 2), and the memory prelude all suppress the update nudge while `last_applied_version >= last_latest_seen`.

This prevents the loop:

> SessionStart sees stale cache -> nudges -> user updates -> next SessionStart sees same stale cache (background check hasn't fired) -> nudges again -> infinite loop

## Permissions

- `~/.ijfw/` -- 0700
- `~/.ijfw/settings.json`, `state.json`, all `*.json` under `cache/`, `run/`, `logs/` -- 0600

Permission mutations only happen in cold paths (`scripts/install.sh`, `ijfw update`, `ijfw doctor --fix-perms`). Hot paths (statusline, hooks) only read + validate; on mismatch they log once to `~/.ijfw/logs/permissions.log` and continue.

Symlinks are refused at write targets (`writeAtomic` checks before overwriting).

## Out of scope for 1.1.6

- Auto-update execution (the `auto_update: "on"` setting persists but does not fire updates until 1.1.7)
- Rollback tarballs (not justified by failure data yet)
- Telemetry (local-first forever)
- Rules-file rewriting (deferred from 1.1.6 due to supply-chain risk)

## Trust chain overview (v1.4.x +)

IJFW's supply-chain trust chain has four layers, each independently verifiable:

1. **Embedded meta-key** -- a single Ed25519 public key compiled into `mcp-server/src/extension-registry.js` (`IJFW_REGISTRY_META_KEY_PEM`). Rotation requires a new v1.4.x release with a new key inlined. This is the trust root: every other key in the system is signed by this one.
2. **Federated publisher registry** -- `~/.ijfw/registries.json` lists priority-ordered registry sources. Each source serves a signed `publishers/v1.json` blob (one keypair per source, all rooted in the meta-key). Higher-priority sources override lower; ANY source's revocation revokes globally.
3. **Per-publisher Ed25519 keys** -- registered publishers sign extension manifests + tarballs. Verified on install.
4. **Rekor transparency log (optional, F-SEC-7 second factor)** -- registry blobs are submitted to a Rekor instance; clients can cross-verify the registry signature against the public log to detect a compromised publisher pushing a re-signed registry.

The first two layers run on every `ijfw trust-registry` invocation. Layers 3-4 run on `ijfw install <ext>`.

## Sandbox threat model (`ijfw_run` -- F-SEC-5)

**Risk class:** any caller of the `ijfw_run` MCP tool can execute arbitrary shell commands as the user.

The `ijfw_run` MCP tool implementation (`mcp-server/src/sandbox.js`) spawns child processes with `shell: true` and the raw command string from the tool arguments. This is by design -- the feature IS shell execution. But the security implication is explicit:

> **Access to the `ijfw_run` MCP tool is functionally equivalent to a remote-shell capability.** A model with access to `ijfw_run` can run any shell command the IJFW process can run.

This matters because:

- **Prompt injection** -- malicious content in fetched docs, stored memory, or user-supplied text can convince the model to invoke `ijfw_run` with attacker-chosen commands. The model is not a security boundary.
- **Active-extension permission gating** -- the tier-1 mediator at `runtime-mediator.js` maps `ijfw_run` calls to the `tool:ijfw_run` permission. Extensions that do not declare `writes: ["tool:ijfw_run"]` (or the broader `writes: ["*"]`) have their `ijfw_run` calls rejected. **The default bundled-context policy is `*`**, which preserves UX for the user's own commands but means any model running under the bundled context can spawn shell.
- **No sandbox** -- `ijfw_run` is NOT a containment boundary. It does not run commands in a chroot, namespace, or container. The command runs with the full privileges of the IJFW process.

### Recommended posture

- For shared-MCP setups (multi-tenant), require `ijfw_run` permission to be explicitly opted into per extension.
- Treat any model with `tool:ijfw_run` permission as having shell access to the host.
- The IJFW dashboard's recent-commands tile (`scripts/dashboard/`) surfaces every `ijfw_run` invocation; review periodically.
- For agents that should NEVER run shell, declare `writes: []` in the extension manifest -- this is the only safe policy.

## Active-extension permission model

Permissions are declared in each extension's `manifest.json` under `permissions`:

```json
{
  "permissions": {
    "reads": ["memory:*", "tool:ijfw_memory_search"],
    "writes": ["memory:project:notes", "tool:ijfw_memory_store"]
  }
}
```

The vocabulary is documented in `docs/EXTENSION-SECURITY.md`. Key categories:

- `memory:*` -- read/write memory entries by scope.
- `tool:<tool-name>` -- invoke a specific MCP tool. `tool:ijfw_run` is the shell-execution permission described above.
- `run:<subject>` -- coarse-grained subject prefix for `ijfw_run` invocations (e.g. `run:git:*` to allow only git subcommands).
- `*` -- all permissions (bundled context only; not recommended for third-party extensions).

The runtime mediator (`runtime-mediator.js`) enforces these on every MCP call. Mediation runs INSIDE the MCP server, so platforms that re-export IJFW's tools (Claude, Codex, Cursor, Windsurf, Copilot, Gemini, Hermes, Wayland) all share the same enforcement.

## Compromised meta-key recovery

The embedded meta-key is the trust root. If it is compromised:

1. **Generate a new keypair** -- the IJFW maintainer creates a fresh Ed25519 keypair via `ijfw trust-keygen`.
2. **Rotate the inlined constant** -- update `IJFW_REGISTRY_META_KEY_PEM` in `mcp-server/src/extension-registry.js` with the new public key.
3. **Re-sign the registry** -- sign `publishers/v1.json` with the new private key and publish to all federated registry endpoints.
4. **Ship a patch release** -- cut v1.5.x with the new compiled-in key. Existing installs continue to trust the old key until they update; the patch release IS the rotation event.
5. **Publish the rotation notice** -- announce the compromise + the patch version in the public CHANGELOG so users can prioritise the update.

There is no in-band key-revocation mechanism for the meta-key itself (intentional -- that would create a recursive trust problem). The OOB update flow described above IS the recovery primitive.

For publisher-key compromise (a downstream Ed25519 key, not the meta-key), the registry's `revoked` field is the standard channel -- revocations propagate within `REVOCATION_TTL_MS` (5 minutes by default).
