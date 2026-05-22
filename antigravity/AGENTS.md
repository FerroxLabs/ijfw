# IJFW -- Antigravity

Antigravity is Google's VS Code-fork agentic IDE, built by the ex-Windsurf
team. IJFW configures it the same way it configures Windsurf -- the MCP
schema is identical (`mcp_config.json` with a flat `mcpServers` block).

Antigravity ships **two surfaces**, both Gemini-family and both using the
identical `mcp_config.json` schema:

- **Antigravity IDE** -- reads MCP config from `~/.gemini/antigravity/mcp_config.json`.
- **Antigravity CLI** (`agy`) -- reads MCP config from `~/.gemini/config/mcp_config.json`.

A single `ijfw install` wires both.

## How IJFW reaches Antigravity

- **MCP memory server.** The installer merges the IJFW memory server into
  BOTH `~/.gemini/antigravity/mcp_config.json` (IDE) and
  `~/.gemini/config/mcp_config.json` (CLI `agy`). See `mcp_config.json` in
  this directory for the shared template -- the schema is identical for both
  surfaces. After install, the `ijfw-memory` server is available to both the
  Antigravity IDE agent and the `agy` CLI.
- **Agent context.** Antigravity uses the `AGENTS.md` convention for agent
  context. IJFW already deploys and manages `AGENTS.md`, so Antigravity
  inherits the full IJFW workflow context through that shared mechanism --
  no Antigravity-specific rules file format is needed.

## Tier

`mcp-plus-rules` -- MCP config plus `AGENTS.md` context. No skills, agents,
hooks, or commands surface (Antigravity, like Cursor/Windsurf/Copilot, does
not expose those install points to the IJFW installer).
