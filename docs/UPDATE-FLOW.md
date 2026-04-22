# IJFW Update Flow

Three surfaces, one happy path. Every step opt-in, every action terminal-confirmed.

## Detection (passive, runs in background)

SessionStart fires `claude/hooks/scripts/ijfw-check-update.sh` -- a detached, fire-and-forget spawn. The parent hook exits in <10ms. The child:

1. Reads `~/.ijfw/settings.json.update_check.{interval_hours,failure_backoff_hours}`
2. Honors `IJFW_DISABLE_UPDATE_CHECK={1|true|yes|on}` -- exits 0
3. Honors in-flight marker dedupe (skip if another check ran <30s ago)
4. Honors negative-cache backoff (default 1h after failure)
5. Honors `state.last_applied_version >= cache.last_latest_seen` (just-updated suppression)
6. Runs `npm view @ijfw/install version --json` with 10s timeout + retry
7. Validates result against `/^\d+\.\d+\.\d+(-[\w.]+)?$/`
8. Atomically writes `~/.ijfw/cache/update-check.json`

Always exits 0. Never blocks Claude Code. Errors land in `~/.ijfw/logs/update-check.log` (rotated at 1MB).

## Notification (4 surfaces)

1. **statusline** (Claude Code, Wave 2) -- `↑ 1.1.6 available` segment
2. **Memory prelude** (all 8 platforms) -- first-turn one-liner when behind AND `last_applied_version < last_latest_seen`
3. **Chat command** (all 8 platforms via MCP) -- user types "ijfw update check" -> model invokes `ijfw_update_check` -> renders structured result + terminal confirmation instruction
4. **Explicit CLI** -- `ijfw update --check` (exit 0 up-to-date, 3 if available, 1 on error)

## Action (out-of-band confirmation)

`ijfw update` (interactive, terminal):
1. Read `state.json.install_method`; prompt for repair if missing
2. Run `npm audit signatures @ijfw/install@<target>` -- refuse on failure
3. Cross-verify target shasum vs GitHub release asset shasum -- refuse on mismatch
4. Fetch + ANSI-strip + render release notes (cap 4 KB)
5. Confirm with user
6. Acquire `~/.ijfw/.update.lock` via `withLock` helper
7. Dispatch by install-method: `npm install -g @ijfw/install@<target>` (npm-global), `git pull && bash scripts/install.sh` (git-clone), `npx @ijfw/install` (manual)
8. Run `scripts/install.sh` to refresh platform configs
9. On success: persist `last_applied_version` + `last_good_shasum` to `state.json`
10. Release lock

`ijfw update --confirm <token>` (consume MCP-issued token):
1. Locate `~/.ijfw/run/<session>/update-pending.json`
2. Validate token match + not expired + not consumed
3. Refuse if `IJFW_FROM_MCP=1` (prevent MCP-subprocess workaround)
4. Clear sentinel, run the standard `ijfw update` flow above

## Cross-platform reach

| Platform | Update notification | Update action |
|---|---|---|
| Claude Code | statusLine (Wave 2) + memory prelude + chat | CLI + chat -> MCP -> terminal confirm |
| Codex / Gemini / Cursor / Windsurf / Copilot | Memory prelude + chat | CLI + chat -> MCP -> terminal confirm |
| Hermes / Wayland | Receipt + memory prelude + chat | CLI + chat -> MCP -> terminal confirm |

Full parity across all 8 platforms via the chat -> MCP -> terminal confirm path. No rules-file rewrites in 1.1.6.

## All `ijfw update` flags

| Flag | Behavior |
|---|---|
| (none) | Interactive update with provenance + shasum verification |
| `--check` | Non-invasive availability check (exit 3 if available) |
| `--yes` | Non-interactive (terminal-only; refuses if `IJFW_FROM_MCP=1`) |
| `--verify` | Verification dry-run (no install) |
| `--changelog` | Full release notes for available version |
| `--confirm <token>` | Consume MCP-issued token, run update |
| `--auto on\|off\|ask` | Set/query `auto_update` preference |
