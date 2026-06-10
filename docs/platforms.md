# Platforms & how they connect

IJFW installs once and reaches sixteen AI coding agents: one shared, local memory and one set of conventions underneath every tool you already use. This page explains which tools connect, how each one is wired, and why a single profile reaches all of them with zero per-app code.

← Back to the [README](../README.md).

---

## The sixteen tools

IJFW is a layer, not a tool. It does not compete with the agents below; it sits underneath them and gives them one brain. Two groups:

**Dedicated coding agents (13):** Claude Code · Codex CLI · Gemini CLI · Cursor · Windsurf · GitHub Copilot · Cline · OpenCode · Qwen Code · Kimi Code · Wayland · Antigravity · Aider

**General agents with strong coding (3):** Hermes (Nous Research) · OpenClaw · Pi

No tool on this list shares its memory with the others. Each keeps its own siloed history, or none at all. IJFW is the one layer that gives you a single learned memory across all sixteen.

---

## Three connection tiers

A tool connects through the richest mechanism it actually supports. IJFW does not pretend a tool has capabilities it lacks; it meets each one where it is.

### Tier 1: Full skill tree (Claude Code)

Claude Code is the richest surface and the only one that takes the complete plugin. The installer registers IJFW as a Claude marketplace plugin (`~/.claude/settings.json` → `enabledPlugins` + `extraKnownMarketplaces`, plus the `ijfw-memory` MCP server) and ships the full feature set:

- **Skills**: the on-demand skill tree (workflow, commit, handoff, review, critique, compress, team, and more), hot-loaded on trigger.
- **Hooks**: deterministic shell hooks on SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop.
- **Agents**: the generated specialist bench plus the permanent swarm.
- **Commands**: the full slash-command set.
- **MCP server**: the same memory server every other MCP-capable tool connects to.

Everything below is a graceful step down from this.

### Tier 2: MCP server (most tools)

Most tools connect through a single local MCP memory server: one Node process, zero runtime dependencies, started over stdio. The installer merges an `ijfw-memory` server entry into each tool's native MCP config, in that tool's own schema:

| Tool | Where the MCP entry lands | Schema note |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `mcpServers` (plus full plugin) |
| Codex CLI | `~/.codex/config.toml` | TOML MCP block + hooks + skills |
| Gemini CLI | `~/.gemini/settings.json` | + `~/.gemini/extensions/ijfw/` bundle |
| Cursor | `./.cursor/mcp.json` | project-scoped + `rules/ijfw.mdc` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | home-scoped MCP + `.windsurfrules` |
| GitHub Copilot | `./.vscode/mcp.json` | project-scoped + `copilot-instructions.md` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.local` schema |
| Qwen Code | `~/.qwen/settings.json` | standard `mcpServers` |
| Cline | VS Code `globalStorage` (extension) | Cline globalStorage schema |
| Kimi Code | `~/.kimi/mcp.json` | standard `mcpServers` |
| OpenClaw | `~/.openclaw/openclaw.json` | nested `mcp.servers` (CLI + file write) |
| Antigravity | `~/.gemini/antigravity/...` + `.../config/...` | IDE + CLI surfaces, flat `mcpServers` |
| Wayland | `~/.wayland/plugins/ijfw/plugin.toml` | declarative manifest (see below) |
| Hermes | `~/.hermes/config.yaml` | YAML MCP + plugin tree + tier-2 hook |

All of these talk to the **same** memory server, so a decision stored from one tool is recalled from any other. The server exposes a small, capped tool surface (≤14, machine-checked): memory prelude, recall, search, store, bi-temporal facts, cross-project search, the brain/wiki facade, the Trident convergence verb, and a few admin tools. The full manifest and cap policy live in [`mcp-server/TOOLS.md`](../mcp-server/TOOLS.md).

Because the MCP tools are namespaced (`ijfw_*`), they sit alongside whatever other MCP servers you already run without collision. Existing MCP entries, model preferences, and per-project trust settings are preserved; every modified config is backed up first.

### Tier 3: Rules-file fallback (tools without MCP)

Some tools have no native MCP client. For those, IJFW ships its conventions as the platform's own rules/instructions file. The shared brain still travels, just through context rather than live tool calls:

| Tool | Rules file written |
|---|---|
| Aider | `~/.aider.conf.yml` + `~/CONVENTIONS.md` |
| Pi | `~/.pi/agent/AGENTS.md` |

These are copy-if-absent: IJFW never overwrites a rules file you have already edited. When a tool later gains a native MCP client, its entry is promoted to Tier 2, with no change on your side.

Across every tier, IJFW also maintains a canonical `AGENTS.md` (the open spec) so tools that read that convention (Antigravity, Pi, and any future AGENTS.md-aware agent) inherit the same context for free.

---

## The Wayland declarative integration

Wayland is a special case worth calling out, because it shows how far the "meet each tool where it is" principle goes. Wayland reads TOML (not YAML) and cannot run external plugin code, so IJFW does not ship a runtime plugin there. Instead the installer drops a single **declarative manifest**:

```
~/.wayland/plugins/ijfw/plugin.toml
```

Wayland auto-discovers that file at startup. The manifest declares (with no executable `entry`) an MCP server (`ijfw-memory`, launched as `node <server.js>` over stdio) and two lifecycle hooks. Wayland connects the declared server and deterministically dispatches the hooks into the model's context:

- `session_start` to `ijfw_memory_prelude` (the per-session memory projection)
- `pre_prompt` to `ijfw_memory_recall` (relevant recall before each turn)

The manifest is schema-exact (Wayland deserializes with `deny_unknown_fields` and gates declared capabilities behind explicit `[permissions]` flags), so IJFW declares only what Wayland will actually load. Post-tool / session-end phases are registered-but-log-only on Wayland's side today and are intentionally omitted until Wayland wires them.

---

## Per-client injection verification

IJFW only claims a client it can prove it injects into. A config write is not the same as a working connection, so the installer (and `ijfw doctor`) distinguish three states:

- **Live now**: the tool is present on your machine and IJFW verified its config was written and wired.
- **Standing by**: the tool is not yet installed, so IJFW pre-stages nothing it cannot verify. Install the tool later and IJFW activates on its next run.
- **Untouched**: IJFW found no install and made no claim. No phantom "supported" badges.

This is why the install report and the platform table never list a tool IJFW could not actually reach. If a client is named, the injection happened and is on disk as a witness.

---

## One profile, every tool, zero per-app code

Here is the whole point. You write nothing and integrate nothing:

1. **One install** registers IJFW into every tool present, in that tool's own config schema, and pre-stages the rest.
2. **One memory server** backs every MCP-capable tool, so memory written from any agent is readable by all of them. Tools without MCP get the same conventions through their rules file.
3. **One profile** (what you've corrected, what you've decided, your conventions) is served read-only into each agent's context. Nothing per-app to wire, no SDK calls in your code, no cloud account.

Everything stays local. Memory is plain markdown (hot), SQLite FTS5 (warm), and optional local vectors (cold): no bytes leave your machine by default, and every disclosure is logged and forgettable.

Whatever you use today and whatever you switch to tomorrow, the brain comes with you.

---

← Back to the [README](../README.md) · Tool manifest: [`mcp-server/TOOLS.md`](../mcp-server/TOOLS.md)
