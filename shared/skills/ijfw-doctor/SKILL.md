---
name: ijfw-doctor
description: "Diagnose IJFW integration health per platform. Trigger: 'doctor', 'check setup', /doctor"
---

# IJFW Doctor

Run each check silently, then emit a single positive-framed report. Never say "failed", "error", or "not found" -- reframe every finding as an action or a ready state.

## Checks (run in order)

### 1. MCP Server
Call `ijfw_metrics`. If it responds: "Memory server active". If unreachable: "Memory server ready to connect -- run `claude mcp add ijfw-memory node /path/to/mcp-server/src/index.js`".

### 2. Memory Directory
Check `.ijfw/memory/` exists and is writable (`test -w .ijfw/memory`). If writable: "Memory directory writable". If missing: "Memory directory ready to create -- first memory write will initialize it".

### 3. Hooks
Check for hook scripts in the platform's hooks directory (e.g. `~/.claude/hooks/` for Claude, `.codex/hooks/` for Codex). If scripts exist and are executable: "Hooks registered and live". If missing: "Hooks standing by -- re-run install.sh to register".

### 4. Platform Integration Depth
Report which features are active based on what's detected:
- MCP connected = deep integration
- Hooks present = prompt sharpener active
- Memory populated = context carry-over active
- Config present = custom rules loaded

### 5. Node.js Version
Run `node --version`. If 18+: "Runtime ready (Node <version>)". If missing or older: "Node.js 18+ needed -- install from https://nodejs.org".

## Format

5-line list, one line per check, all positive. End with:

> `All systems active -- IJFW running at full depth.`

Or if any items need action:

> `IJFW active -- <N> of 5 systems at full depth. Steps above complete the setup.`

Under 20 lines total. No negatives.
