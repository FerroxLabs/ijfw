# IJFW -- Project Context

Stack: Node.js / Bash / Markdown
Architecture: Plugin system -- ships platform-native packages for 15 AI coding agents
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
- `aider/` -- Aider rules-only tier (`~/.aider.conf.yml` + `~/CONVENTIONS.md`)
- `universal/` -- 20-line paste-anywhere rules file
- `mcp-server/` -- Cross-platform MCP memory server (Node.js, zero deps)
- `scripts/e2e-smoke.sh` -- end-to-end test harness (30+ gates across 2 modes); must pass before publish
- `scripts/dashboard/` -- local observability dashboard (`ijfw dashboard start`)
- `docs/` -- README, DESIGN.md

## Key Conventions
- Core skill (ijfw-core/SKILL.md) hard cap: **55 lines**. Single source of truth -- supersedes any older 40/51 references in handoff/instructions docs. Currently 54 lines.
- On-demand skills: hot-load only when triggered, unload when done.
- Hooks: shell scripts only, deterministic, no LLM calls.
- MCP server: ≤14 tools (full manifest, history, retirement-review rationale, and cap policy live in `mcp-server/TOOLS.md` — single source of truth, machine-checkable via `scripts/check-mcp.sh`). Combine before raise.
- Startup report: positive framing ONLY. No negatives, no "not found", no diagnostics.
- Platform rules files: identical core rules, adapted for platform format.
- All memory storage: plain markdown (hot), SQLite FTS5 (warm), optional vectors (cold).
- Dashboard (`scripts/dashboard/`) is a Claude-host-first feature: memory/project panels read from `~/.claude/projects/`; cost data aggregates across all platforms (Codeburn, Codex SQLite, Gemini dirs). Non-Claude-only users see populated cost tiles but empty memory panels -- graceful degradation, not a bug. Full platform-agnostic memory surfacing is a future milestone.

## Design Principles
1. Rory Sutherland: position as "smarter" not "cheaper". Wow factor.
2. Steve Krug: don't make me think. Zero config. Smart defaults.
3. Sean Donahoe: one install, it just fucking works.

## Subagent Model Routing (v1.5.2 — proactive layer)

When you dispatch a subagent for code work, the model MUST match the scope. Failure to route correctly was the root cause of the v1.5.1 multi-file hallucination bug. This policy is the proactive layer; the reactive backstop is the SCOPE GATE inside `ijfw:builder` itself.

**Decision tree — apply BEFORE selecting subagent_type or model:**

1. Count the files the task will modify. Read the brief carefully — count actual files, not just file mentions.
2. Scan for scope-keywords: `across`, `integration`, `wire X into Y`, `throughout`, `rewire`, `thread`, `ripple`, `cross-module`, `refactor multiple`, `globally`.
3. Apply the routing:

| Task signal | Dispatch via |
|---|---|
| Single file, mechanical, spec-complete | `ijfw:builder` — Sonnet, fast, cheap |
| 2 files (source + test) with clear spec | `ijfw:builder` — Sonnet |
| 3+ files OR any scope-keyword present | `ijfw:architect` — Opus, high effort |
| Architectural choice (multiple valid approaches) | `ijfw:architect` — Opus |
| Cross-file refactor / migration | `ijfw:architect` — Opus |
| Pure read-only investigation | `ijfw:scout` — Haiku (read-only is safe at any model tier) |
| Ambiguous / unknown scope | `Agent(subagent_type='general-purpose', model='opus')` — over-spend beats hallucinate |

**Verification after every dispatch (trust-but-verify):**

Run `git diff --stat HEAD` from the dispatcher's perspective. If the diff is empty and the subagent claimed DONE, the subagent hallucinated — treat as a failed dispatch. Either redispatch via Opus or complete the work inline.

**Hallucination signature to watch for:**

If a subagent's final report contains a ` ```diff ` block presented as if it were the deliverable, the work probably did NOT land. Confirm via `git show <sha>` or `git diff --stat`. The diff is the Edit-tool input, never the final-response output.

**Why this exists:** v1.5.1 had a 100% hallucination rate on multi-file dispatches through `ijfw:builder` — Sonnet at medium effort interpreted the instruction "Output diffs for edits" as "the diff IS my output" and generated polished diff text in the final report without calling the Edit tool. v1.5.2 fixed `builder.md` (SCOPE GATE + anti-hallucination verification gate). This section closes the loop on the dispatcher side so the mismatch can't happen in the first place.

<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->
<ijfw-memory>
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.

Recent decisions:
**How to apply:** v1.5.2 IJFW Brain (Plan A) shipped: visible `ijfw/` layer, dump-folder pipeline, dream-cycle with tiered LLM + budget guard, bi-temporal wiki with citation enforcement, combined `ijfw_brain` MCP tool (8 verbs in one slot). MCP cap 13 → 14. New runtime dep: `chokidar@^4.0.1`. Plans B (dashboard panel) and C (Wayland PR) consume the locked contract at `.planning/wayland-memory/CONTRACT.md`.
**Why:** First milestone of the bigger Brain bet — combining bi-temporal facts + Obsidian-style graph + Karpathy LLM-wiki + cross-CLI breadth + sandboxed MCP runtime. Plan A is the backend foundation; Plans B/C surface it visually.
**How to apply:** If user reports an install issue: npm view shows both at 1.4.0 globally. Smoke test: `cd $(mktemp -d) && npm install -g @ijfw/install && ijfw --version`. macOS users will work even though CI didn't verify it — pure-Node packages, no native build step except better-sqlite3 which has prebuilt binaries. If user wants a github mirror: origin remote needs to be re-set up (was removed during this session because the URL 404'd).
**Why:** User principle: no half-shipping. v1.4.0's "v1.5.0 backlog" violated this — signing without a registry is the same UX as no signing because trust doesn't scale by hand; runtime mediation on one of seven platforms is the same UX as no runtime mediation for users on the other six; memory feedback with one detector is a demo not a product. Folding into v1.4.1 keeps the trust-model promise honest.
**How to apply:** Next session: read .planning/1.4.1/HANDOFF-1.4.1.md, invoke /superpowers:subagent-driven-development, dispatch W8-A1 + W8-A2 + W8-A3 in parallel per the wave plan, then W8-B sequential after W8-A1, then W8-C1 + W8-C2 in parallel. Then round 11. Then ship 1.4.1. Use the same subagent-driven-development discipline + Ralph loop that worked for W7+W7.1. If user wants github mirror set up for B12, that's a manual step at github.com/TheRealSeanDonahoe/ijfw (create repo + push). If B6 default registry URL isn't yet live (DNS not configured), seed registry from docs/registry/publishers/v1.json in repo and use the GitLab Pages fallback URL.

Last handoff: Handoff: 2026-05-25 (IJFW Brain v1.6.0 PLANNED — ready to execute Plan A)
====================
</ijfw-memory>

<ijfw-routing>
IJFW is installed alongside a peer brainstorming skill. For project-level tasks (build, create, design, plan, brainstorm, landing page, app, website, dashboard, campaign, book, launch), prefer the ijfw:ijfw-workflow skill -- the user opted into IJFW via install, and ijfw-workflow is its configured workflow entry point. IJFW orchestrates think-build-ship end to end and dispatches peer specialist skills (frontend-design, TDD, code-review) as subagent tools when the workflow needs them.
</ijfw-routing>
<!-- IJFW-MEMORY-END -->
