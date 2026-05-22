# IJFW -- Antigravity

Antigravity is Google's VS Code-fork agentic IDE, built by the ex-Windsurf
team. IJFW configures it the same way it configures Windsurf -- the MCP
schema is identical (`mcp_config.json` with a flat `mcpServers` block).

## How IJFW reaches Antigravity

- **MCP memory server.** The installer merges the IJFW memory server into
  `~/.gemini/antigravity/mcp_config.json` (see `mcp_config.json` in this
  directory for the template). After install, the `ijfw-memory` server is
  available to Antigravity's agent.
- **Agent context.** Antigravity uses the `AGENTS.md` convention for agent
  context. IJFW already deploys and manages `AGENTS.md`, so Antigravity
  inherits the full IJFW workflow context through that shared mechanism --
  no Antigravity-specific rules file format is needed.

## Tier

`mcp-plus-rules` -- MCP config plus `AGENTS.md` context. No skills, agents,
hooks, or commands surface (Antigravity, like Cursor/Windsurf/Copilot, does
not expose those install points to the IJFW installer).
