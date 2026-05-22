---
description: "IJFW command index. Groups commands by intent: Build / Remember / Ship / Review / Configure."
---

Single landing surface for IJFW commands, grouped by what the user is trying to do. Print when invoked without arguments.

```
IJFW -- one interface, 15 platforms, persistent memory across all of them.

Build -- plan -- explore
  /workflow             -- quick or deep project workflow (brainstorm -> plan -> build)
  /team                 -- set up project-specific agent team during Discovery
  /consolidate          -- compress a memory/context file into terse form

Remember -- recall -- audit
  /handoff              -- write a structured session handoff
  /memory-audit         -- list auto-extracted memory entries for review
  /status               -- current mode, memory state, active skills

Ship -- commit -- review
  /ijfw-commit          -- terse conventional commit
  /ijfw-review          -- one-line code review comments
  /cross-audit          -- Trident peer review: one OpenAI + one Google + specialist swarm

Configure -- mode -- help
  /mode smart|fast|deep|manual|brutal -- switch IJFW mode
  /compress             -- compress context files
  /metrics              -- session metrics (tokens, cost, routing)
  /doctor               -- health check (MCP, hooks, memory, caps)
  /ijfw                 -- this index
```

Sub-commands (e.g. `/memory-audit`) route to dedicated command files in this plugin. The `/ijfw` index itself is a no-op that just prints what's available -- no configuration changes.

Natural-language discovery: also list by intent in chat if user asks "what can IJFW do" / "list commands" / "what's available".
