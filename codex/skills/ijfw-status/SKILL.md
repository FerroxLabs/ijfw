---
name: ijfw-status
description: "Use when the user says: 'ijfw status', 'show me the system state', 'what is ijfw doing', or to see the at-a-glance routing / memory / activity banner."
---

# IJFW Status

Report the following in order. Use positive framing throughout -- no negatives, no "not found".

## 1. Session Mode
Read `.ijfw/config.json` if present. Report current mode: Quick / Deep / default. If no config, report "running on smart defaults".

## 2. Memory Tiers
- **Working memory**: check `.ijfw/.prompt-check-state` -- report "active" if present, "clean slate" if not.
- **Project memory**: list files in `.ijfw/memory/` -- report count and most recent handoff date. If empty, "ready for first capture".
- Do NOT report global/warm tiers unless explicitly asked.

## 3. Hook Status
Check `.ijfw/.prompt-check-state` for `"fired": true`. Report: "Prompt sharpener active" or "Prompt sharpener standing by".

## 4. MCP Server
Call `ijfw_metrics`. Report its output as a single line. If the tool is unreachable, report "Memory server standing by -- run `claude mcp add` to connect".

## 5. Last Handoff
Read `.ijfw/memory/` for the most recent `HANDOFF*.md` or `handoff*.md`. Extract the date and first heading. Report as: "Last session: <date> -- <heading>". If none, "No handoff yet -- first session captures automatically".

## Format

Emit as a compact table or 5-line list. No headers larger than `##`. End with one receipt line:

> `IJFW active -- <N> memory entries, <mode> mode, hooks live.`

Total output: under 20 lines. Positive framing only.
