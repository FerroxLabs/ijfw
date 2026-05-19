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
