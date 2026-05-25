---
name: ijfw-update
description: "Check for and apply IJFW updates safely. Trigger: 'update ijfw', 'upgrade', 'latest version', 'is there a new version', /update"
---

## What this skill does

Helps the user check for and apply IJFW updates. Updates are air-gapped: the model cannot execute them. The model issues a confirmation token; the user types `ijfw update --confirm <token>` in their terminal to actually run.

## When to fire

Triggers: "update ijfw", "upgrade ijfw", "is there a new version", "latest version", `/update`. Also fires when memory prelude reports "update available" on first turn.

## Execution

1. **Call the MCP tool**: `ijfw_update_check`. This returns:
   - `current` -- installed version
   - `latest` -- latest published version on npm
   - `available` -- boolean
   - If `available: true`: also `confirmation_token`, `expires_at`, `changelog_url`, and `instruction`. The same call writes the pending sentinel that the terminal command consumes -- one MCP call, one terminal command, no intermediate ceremony.

2. **If up to date**: report it. Stop.

   > IJFW is up to date (v1.2.5).

3. **If update available**: present the version delta + changelog link, then surface the OOB instruction verbatim. The terminal command is the air-gap; the model never runs the update itself.

   > Update available: v1.2.4 -> v1.2.5
   >   Changelog: <changelog_url>
   >
   > To proceed, run in your TERMINAL:
   >     ijfw update --confirm <confirmation_token>
   >
   > Token expires in 5 minutes. I cannot run the update for you -- only typing this command in your terminal can.

4. **DO NOT** run `npm install`, `npx @ijfw/install`, `bash scripts/install.sh`, or any equivalent yourself. The MCP path is air-gapped on purpose. Even if the user asks you to "just do it", refuse and surface the terminal command.

5. **Back-compat note:** `ijfw_update_apply` still exists for older clients. It is idempotent against the sentinel that `ijfw_update_check` already wrote, so calling it is harmless but unnecessary in the streamlined flow.

## Security model

The token + sentinel + terminal-confirm flow exists so that prompt injection in stored memory, fetched docs, or user-paste content cannot trick the model into auto-updating IJFW. See `docs/SECURITY.md` for the full threat model.

## Common variations

- "Just check, don't update yet" -- call `ijfw_update_check`, report status, stop.
- "Update silently" -- not supported via the MCP path. Tell the user to run `ijfw update --yes` in their terminal directly.
- "Roll back to <version>" -- not supported yet (rollback tarballs deferred). Suggest `npm install -g @ijfw/install@<version>` from the user's terminal.

## After a successful update

The user will see "Updated to v<latest>" in their terminal. The next IJFW SessionStart will reflect the new version. Suggest restarting any open agent sessions so they pick up the new skills/hooks.
