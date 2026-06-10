# Wayland Core ↔ IJFW Integration — Instructions for IJFW

**Date:** 2026-06-10  **Audience:** IJFW maintainers/agent  **Status:** Wayland side shipped; IJFW installer PR drafted (review + finish on your side).

---

## TL;DR

Wayland Core now treats IJFW like any other install-time integration: **IJFW's installer drops one declarative `plugin.toml` into `~/.wayland/plugins/ijfw/`, and Wayland auto-discovers it on startup** — connecting IJFW's memory MCP server and deterministically firing IJFW's lifecycle hooks into the model's context. There is **nothing to compile into Wayland and nothing for Wayland to detect at install time beyond the file**.

This is a tier *above* how IJFW works in Claude Code / Codex / Gemini: those hosts have no lifecycle-hook concept, so IJFW relies on an MCP server + an `AGENTS.md` instruction telling the model to call `ijfw_memory_prelude`. Wayland instead **deterministically calls it at SessionStart and injects the result** — guaranteed, not model discretion.

**As of this change, Wayland no longer ships a compiled-in IJFW plugin** (it used to bake one in). The declarative install is now the *only* integration path, so the installer step below is required for IJFW to work on Wayland.

---

## The two Wayland commits that enable this

- `090b8339` (FerroxLabs/wayland-core `main`) — declarative on-disk plugin support + discovery of `~/.wayland/plugins`.
- `feat/ijfw-declarative-only` (merging) — removes the old compiled-in `wayland-ijfw` plugin so there's no double-registration.

---

## What's already drafted on the IJFW side

A branch is ready in this repo: **`fix/wayland-declarative-plugin`** (commit `26554ab`).
- Rewrites `installer/src/installWayland()` to write the declarative `plugin.toml` (below), and **removes** the three dead surfaces it used to write: the YAML `~/.wayland/config.yaml` (Wayland reads TOML, and the server is now declared in the plugin), the **Python** plugin tree (Wayland can't run it), and the Python tier-2 hook.
- Keeps the `WAYLAND.md` + skills copies.
- Updates `uninstall.js` to remove `~/.wayland/plugins/ijfw/`, and the installer tests. **`npm test` = 34/34 pass.**
- ⚠️ **Base branch:** this repo's `origin/main` is ~215 commits behind the active installer; the branch was cut off `feat/v1.6.0-benchmark-harness` (`b3afba3`). Rebase onto whatever lands as the real base.

**Action for IJFW:** review, rebase, and merge `fix/wayland-declarative-plugin`.

---

## The contract you own: the declarative `plugin.toml`

Install location (the installer already targets `~/.wayland/`; Wayland discovers `~/.wayland/plugins/*/plugin.toml`):

```
~/.wayland/plugins/ijfw/plugin.toml
```

Exact schema Wayland reads (it parses with `deny_unknown_fields` — do not add keys outside this):

```toml
[plugin]
name = "wayland-ijfw"
version = "<ijfw version>"          # required
description = "IJFW memory + lifecycle hooks for Wayland Core"
license = "MIT"                     # required (IJFW is MIT)
# entry is intentionally omitted — declarative plugins have no executable

[permissions]
register_hooks = true               # required, else Wayland rejects the [[hooks]]
register_mcp_server = true          # required, else Wayland rejects [mcp_server]

[runtime]
kind = "declarative"                # selects the no-code path

[mcp_server]
name = "ijfw-memory"                # the server key; its tools get this namespace

[mcp_server.transport]              # serde-tagged enum — `kind` selects the variant
kind = "stdio"
command = "node"
args = ["<absolute path to the IJFW server.js>"]   # the installer's serverJsNative

[[hooks]]
phase = "session_start"            # snake_case phase
tool  = "ijfw_memory_prelude"      # MUST equal an advertised MCP tool name

[[hooks]]
phase = "pre_prompt"
tool  = "ijfw_memory_recall"
```

### The one hard rule: hook `tool` == advertised MCP tool name
Wayland binds a hook to your server by matching the hook's `tool` string to a tool the `ijfw-memory` server advertises (via `tools/list`). So:
- `session_start` → `ijfw_memory_prelude` (your server already advertises this ✓).
- `pre_prompt` → **`ijfw_memory_recall`** — note this is the real advertised tool. The old name `ijfw_pre_prompt_recall` does **not** exist on the server and would silently no-op. The drafted PR uses the correct name.
- If you ever rename a server tool, update the hook `tool` in lockstep, or that hook stops firing (tolerant: it just contributes nothing).

### Transport
`node <serverJsNative>` (the local server the installer already resolves for Codex/Gemini) is the recommended launch — no network fetch. `npx -y @ijfw/memory-server` also works if you prefer the published package. Either way it's plain stdio, argv-mode (no shell), so paths/args are safe literals — but emit `serverJsNative` as a properly-escaped TOML string (escape `\` and `"`, or use a single-quoted literal). The drafted PR does this.

---

## How it works end to end (so you can reason about it)

1. Wayland starts → on-disk plugin discovery scans `~/.wayland/plugins/` → finds `ijfw/plugin.toml`.
2. It validates the manifest (permissions gate the hooks/server), then registers the hooks and the `ijfw-memory` MCP server through Wayland's normal plugin pipeline.
3. Wayland connects the server (spawns `node <serverJsNative>`), lists its tools.
4. Wayland's dispatcher binds `wayland-ijfw` → `ijfw-memory` because the server advertises tools matching the hook names.
5. **SessionStart (cold session):** Wayland calls `ijfw_memory_prelude`, wraps the result in an untrusted `<plugin-context trust="untrusted">…</plugin-context>` block, and injects it as a User-role message — deterministic memory hydration, no model action needed.
6. **PrePrompt (per turn):** Wayland calls `ijfw_memory_recall` and appends it to that turn's request (budget-capped, deduped).

Trust/safety on Wayland's side: hook output is always an **untrusted** block, never the system prompt; the server spawn is gated like any operator-configured MCP server; the plugin must live under `~/.wayland/plugins` (path-prefix trust). You don't need to do anything for this — it's enforced host-side.

---

## What works today vs deferred (Wayland side)

| IJFW hook | Phase | Status on Wayland |
|---|---|---|
| `ijfw_memory_prelude` | SessionStart | ✅ **dispatches** — deterministic injection |
| `ijfw_memory_recall` | PrePrompt | ✅ **dispatches** — per-turn, gated |
| `ijfw_observation_capture` | PostToolUse | ⏸️ registers but **log-only** (Wayland future work) |
| `ijfw_session_summarize` | SessionEnd | ⏸️ log-only |
| `ijfw_pre_compact_optimize` | PreCompact | ⏸️ log-only |

So include only the two dispatching hooks in `plugin.toml` for now (the drafted PR does). When Wayland wires the other phases, add them. Tools are also model-callable regardless (they're registered MCP tools), so the model can still call any `ijfw_*` tool directly.

---

## Verification (after merging the IJFW PR)

1. Run the IJFW installer; confirm `~/.wayland/plugins/ijfw/plugin.toml` exists and parses (no `config.yaml`, no Python tree).
2. With Node installed, start `wayland-core` in an IJFW-tracked repo.
3. Confirm the memory prelude reaches context — check logs for a one-time `info` line that the plugin hook dispatcher was wired, and that the first turn's context carries the `<plugin-context source="wayland-ijfw:ijfw_memory_prelude" trust="untrusted">` block.
4. Uninstall; confirm `~/.wayland/plugins/ijfw/` is removed.

---

## Open coordination items

1. **Tool-name contract:** keep `ijfw_memory_prelude` (SessionStart) and `ijfw_memory_recall` (PrePrompt) as advertised tool names, or update the plugin.toml hooks if they change.
2. **`pre_prompt` arguments:** Wayland currently calls hook tools with **no arguments**. `ijfw_memory_recall` works without a `context_hint` (returns general recall), but it can't yet be query-scoped per turn. If you want per-turn query-relevant recall, that's a Wayland enhancement (pass the user prompt as the recall arg) — flag it and we'll wire it.
3. **Schema drift:** the `plugin.toml` shape is Wayland's `PluginManifest`. If Wayland changes it, the installer template needs a matching update. This doc + the drafted PR reflect Wayland `main` @ `090b8339`.
4. **PostToolUse/SessionEnd/PreCompact dispatch:** deferred on Wayland. When wired, add those hooks to `plugin.toml`.
