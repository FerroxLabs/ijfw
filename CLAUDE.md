# IJFW -- Project Context

Stack: Node.js / Bash / Markdown
Architecture: Plugin system -- ships platform-native packages for 8 AI coding agents
Author: Sean Donahoe

## Structure
- `claude/` -- Claude Code plugin (full featured: skills, hooks, agents, commands)
- `codex/` -- Codex CLI config + instructions
- `gemini/` -- Gemini CLI MCP config + GEMINI.md
- `cursor/` -- Cursor MCP config + .cursorrules
- `windsurf/` -- Windsurf MCP config + .windsurfrules
- `copilot/` -- Copilot MCP config + instructions
- `hermes/` -- Hermes CLI HERMES.md + MCP registration for ~/.hermes/config.yaml
- `wayland/` -- Wayland CLI WAYLAND.md + MCP registration for ~/.wayland/config.yaml
- `universal/` -- 15-line paste-anywhere rules file
- `mcp-server/` -- Cross-platform MCP memory server (Node.js, zero deps)
- `scripts/e2e-smoke.sh` -- end-to-end test harness (30+ gates across 2 modes); must pass before publish
- `scripts/dashboard/` -- local observability dashboard (`ijfw dashboard start`)
- `docs/` -- README, DESIGN.md

## Key Conventions
- Core skill (ijfw-core/SKILL.md) hard cap: **55 lines**. Single source of truth -- supersedes any older 40/51 references in handoff/instructions docs. Currently 53 lines.
- On-demand skills: hot-load only when triggered, unload when done.
- Hooks: shell scripts only, deterministic, no LLM calls.
- MCP server: ≤10 tools (1.1.6 raises from 8 to 10 to land `ijfw_update_check` + `ijfw_update_apply` admin tools). Future growth triggers retirement review of existing tools, not another cap raise.
- Startup report: positive framing ONLY. No negatives, no "not found", no diagnostics.
- Platform rules files: identical core rules, adapted for platform format.
- All memory storage: plain markdown (hot), SQLite FTS5 (warm), optional vectors (cold).
- Dashboard (`scripts/dashboard/`) is a Claude-host-first feature: memory/project panels read from `~/.claude/projects/`; cost data aggregates across all platforms (Codeburn, Codex SQLite, Gemini dirs). Non-Claude-only users see populated cost tiles but empty memory panels -- graceful degradation, not a bug. Full platform-agnostic memory surfacing is a future milestone.

## Design Principles
1. Rory Sutherland: position as "smarter" not "cheaper". Wow factor.
2. Steve Krug: don't make me think. Zero config. Smart defaults.
3. Sean Donahoe: one install, it just fucking works.

<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->
<ijfw-memory>
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.

Last handoff: # Handoff: 2026-04-23 - IJFW 1.1.7 PUSHED IN ERROR + emergency 1.1.8 needed
## TLDR (60 seconds)
</ijfw-memory>

<ijfw-routing>
IJFW is installed alongside a peer brainstorming skill. For project-level tasks (build, create, design, plan, brainstorm, landing page, app, website, dashboard, campaign, book, launch), prefer the ijfw:ijfw-workflow skill -- the user opted into IJFW via install, and ijfw-workflow is its configured workflow entry point. IJFW orchestrates think-build-ship end to end and dispatches peer specialist skills (frontend-design, TDD, code-review) as subagent tools when the workflow needs them.
</ijfw-routing>
<!-- IJFW-MEMORY-END -->
