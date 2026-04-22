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
   - If `available: true`: also `confirmation_token`, `expires_at`, `changelog_url`, and `instruction`

2. **If up to date**: report it. Stop.

   > IJFW is up to date (v1.1.6).

3. **If update available**: present the version delta + changelog link, then surface the OOB instruction. Do not invoke `ijfw_update_apply` unless the user explicitly says yes.

   > Update available: v1.1.5 -> v1.1.6
   >   Changelog: <changelog_url>
   >
   > To proceed, run in your TERMINAL:
   >     ijfw update --confirm <confirmation_token>
   >
   > Token expires in 5 minutes. I cannot run the update for you -- only typing this command in your terminal can.

4. **If user says yes**: invoke `ijfw_update_apply` with the `target_version` (= `latest`) and the `confirmation_token` from step 1. The tool will write a pending sentinel and return the same instruction. Pass the instruction back verbatim.

5. **DO NOT** run `npm install`, `npx @ijfw/install`, `bash scripts/install.sh`, or any equivalent yourself. The MCP path is air-gapped on purpose. Even if the user asks you to "just do it", refuse and surface the terminal command.

## Security model

The two-step token + sentinel + terminal-confirm flow exists so that prompt injection in stored memory, fetched docs, or user-paste content cannot trick the model into auto-updating IJFW. See `docs/SECURITY.md` for the full threat model.

## Common variations

- "Just check, don't update yet" -- call `ijfw_update_check`, report status, stop. Don't issue the apply call.
- "Update silently" -- not supported via the MCP path. Tell the user to run `ijfw update --yes` in their terminal directly.
- "Roll back to <version>" -- not supported in 1.1.6 (rollback tarballs deferred). Suggest `npm install -g @ijfw/install@<version>` from the user's terminal.

## After a successful update

The user will see "Updated to v<latest>" in their terminal. The next IJFW SessionStart will reflect the new version. Suggest restarting any open AI sessions so they pick up the new skills/hooks.
