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
- MCP server: ≤13 tools (v1.5.0-major raised cap from 10 to 12; v1.5.0 memory-moat amendment raised 12 → 13; cap is now FULLY POPULATED at 13/13: slot 11 = `ijfw_state` — the single MCP face for the state-SDK verb facade (v1.5.0 T13 — absorbed the retired `ijfw_subagent_post_done` tool; `subagent.post-done` is now a verb on this tool, and all 20 frozen verbs from STATE-SDK-CONTRACT §7 — `workflow.*`, `wave.*`, `phase.*`, `subagent.*`, `event.emit`, `telemetry.record`, `roster.*`, `extension.set-active`, `decision.add`, `blocker.*`, `state.replay`, `state.validate` — are reachable through it; runtime contract enforcement for v1.4.4 N2/N3/N5 now lives behind the `subagent.post-done` verb) — slot 12 = `ijfw_cross_audit_converge` — Trident-as-a-service multi-lens consensus convergence loop, lock-in #47 — and slot 13 = `ijfw_memory_facts` — bi-temporal read path that surfaces `getValidAt` / `getHistory` / `getAllFactsWithWindows` from `memory/temporal.js` (v1.5.0 memory-moat M5; can NOT fold into `ijfw_memory_search` without breaking the deterministic `(subject, predicate, valid_at)` contract that makes temporal queries replayable). **Retirement review of existing tools was considered and rejected:** `ijfw_update_check` + `ijfw_update_apply` could not be combined (air-gapped security model documented in README, two-step token flow can't compress to one call without losing the prompt-injection defense); `ijfw_prompt_check` cannot be retired without degrading Codex/Cursor/Windsurf/Copilot/Gemini UX (no pre-prompt hook on those platforms); `ijfw_cross_project_search` cannot fold into `ijfw_memory_search` without breaking scope semantics. Combined-tool pattern (single tool with `action`/`verb` param — exemplified by `ijfw_state` absorbing `ijfw_subagent_post_done` as the `subagent.post-done` verb) is preferred over individual additions. Future growth: combine before raise; raise only when combine breaks user-facing semantics.
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

Recent decisions:
**How to apply:** If user reports an install issue: npm view shows both at 1.4.0 globally. Smoke test: `cd $(mktemp -d) && npm install -g @ijfw/install && ijfw --version`. macOS users will work even though CI didn't verify it — pure-Node packages, no native build step except better-sqlite3 which has prebuilt binaries. If user wants a github mirror: origin remote needs to be re-set up (was removed during this session because the URL 404'd).
**Why:** User principle: no half-shipping. v1.4.0's "v1.5.0 backlog" violated this — signing without a registry is the same UX as no signing because trust doesn't scale by hand; runtime mediation on one of seven platforms is the same UX as no runtime mediation for users on the other six; memory feedback with one detector is a demo not a product. Folding into v1.4.1 keeps the trust-model promise honest.
**How to apply:** Next session: read .planning/1.4.1/HANDOFF-1.4.1.md, invoke /superpowers:subagent-driven-development, dispatch W8-A1 + W8-A2 + W8-A3 in parallel per the wave plan, then W8-B sequential after W8-A1, then W8-C1 + W8-C2 in parallel. Then round 11. Then ship 1.4.1. Use the same subagent-driven-development discipline + Ralph loop that worked for W7+W7.1. If user wants github mirror set up for B12, that's a manual step at github.com/TheRealSeanDonahoe/ijfw (create repo + push). If B6 default registry URL isn't yet live (DNS not configured), seed registry from docs/registry/publishers/v1.json in repo and use the GitLab Pages fallback URL.

Last handoff: &gt; Handoff: IJFW v1.4.0 SHIPPED (2026-05-16) |  | **v1.4.0 "Open Ecosystem" is live on gitlab.** Tag v1.4.0 pushed. 66 commits total ahead of pre-ship gitlab/main, all merged to main. Release commit: 3a6d979. |  | &gt; What landed | - Extension framework W0-W5 (manifest schema, install gate, cross-platform deploy with path-traversal hardening, org/user scope lazy deploy, gate-result contract, override resolution at deployment time, cross-project override-use registry) | - W7 trust chain folded in: Ed25519 publisher signing (B1), runtime sandbox mediation tier-1+tier-2 (B2), memory feedback auto-routing (B3), PRESET_NAME_PATTERN consolidation (B4), C7-H-01 regression test (B5) | - W7.1 patch wave: active-extension state writer + activate/deactivate CLI (B2-H-01), tool:* permission vocabulary (B2-H-02), pre-stat DoS + lstat symlink reject (B3-H-01), 2 doc-cleanup commits |  | &gt; Audit gate | - 10 cross-audit rounds completed, 25 HIGH + 5 MEDIUM closed across 8 patch waves | - Round 10 = 3/3 lens PASS (Codex CONDITIONAL→PASS after a11e416, Gemini PASS empirical, Claude PASS) | - 177/177 mcp-server tests pass across 13 suites |  | &gt; Known gaps to flag if user asks | - **origin (GitHub) remote** returned "Repository not found" — only pushed to gitlab. If user wants GitHub mirror, the repo needs to be created at github.com/TheRealSeanDonahoe/ijfw first, OR the origin remote URL needs correction, OR the origin remote should be removed. | - AGENTS.md + CLAUDE.md have pre-existing unstaged session-state mods (not from this milestone; safe to leave) |  | &gt; v1.5.0 next-milestone backlog | - Hosted publisher key registry / discovery URL | - Tier-2 runtime mediation hooks for Codex/Gemini/Cursor/Windsurf/Copilot/Hermes/Wayland (Claude-only in v1.4.0) | - Key rotation + revocation list distribution | - Per-extension audit log surfacing in dashboard UI | - Pattern detection beyond repeated-fail-same-artifact (time-series, cross-skill correlation) | - Interactive 2-step --accept-untrusted confirmation prompt |  | &gt; Artifacts | - Workflow state: .ijfw/state/workflow.json (status: complete, phase: shipped) | - Round 10 synthesis: .ijfw/cross-audit/round10/SYNTHESIS.md | - Round 9 synthesis: .ijfw/cross-audit/round9/SYNTHESIS.md | - Original handoff: .planning/1.4.0/HANDOFF-W7-EXPANSION.md (historical) | - CHANGELOG.md v1.4.0 entry: comprehensive overview of the full milestone
</ijfw-memory>

<ijfw-routing>
IJFW is installed alongside a peer brainstorming skill. For project-level tasks (build, create, design, plan, brainstorm, landing page, app, website, dashboard, campaign, book, launch), prefer the ijfw:ijfw-workflow skill -- the user opted into IJFW via install, and ijfw-workflow is its configured workflow entry point. IJFW orchestrates think-build-ship end to end and dispatches peer specialist skills (frontend-design, TDD, code-review) as subagent tools when the workflow needs them.
</ijfw-routing>
<!-- IJFW-MEMORY-END -->
