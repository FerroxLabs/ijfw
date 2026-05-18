# IJFW -- Design Document
## Everything We Decided and Why

This document captures all architectural decisions made during the design phase,
including everything beyond the original Master Design Spec.

---

## Design Principles

### 1. Rory Sutherland -- Perceived Value Through Reframing
- Never position as "cheaper." Position as "smarter."
- Startup report shows ONLY positives -- what IJFW did FOR you.
- No negatives, no "not found," no diagnostics, no error-style messaging.
- Every line the user sees should make them feel upgraded.
- The savings are a side effect of intelligence, not the goal.

### 2. Steve Krug -- Don't Make Me Think
- One concept: mode. Everything else is automatic.
- No settings pages, no config files to edit, no env vars to set.
- Smart defaults that work for 80%+ of cases.
- Override via natural language, not configuration.
- If something's missing, quietly create it. Don't ask permission for safe actions.

### 3. Sean Donahoe -- It Just Fucking Works
- One install. Works on session one.
- Self-contained. No external dependencies required.
- Auto-detects environment and adapts silently.
- If a feature can't be fully automated, it ships as a one-word command.

---

## Platform Support (Corrected)

ALL major platforms support MCP. The original spec was wrong about Gemini, Codex, and Copilot.

| Platform | MCP | Hooks | Skills | Commands | Agents |
|----------|-----|-------|--------|----------|--------|
| Claude Code | ✅ | ✅ | ✅ | ✅ | ✅ |
| Codex | ✅ | ✅ | ✅ | $ syntax | Limited |
| Gemini CLI | ✅ | ❌ | Via GEMINI.md | ❌ | ❌ |
| Cursor | ✅ | ❌ | Via .cursorrules | ❌ | ❌ |
| Windsurf | ✅ | ❌ | Via .windsurfrules | ❌ | ❌ |
| Copilot | ✅ (tools) | ❌ | Via instructions | ❌ | ❌ |

MCP is the universal backbone for cross-platform memory sharing.

---

## No Proxy Architecture

IJFW NEVER:
- Proxies network traffic
- Intercepts API calls
- Redirects model requests through middleware
- Inserts itself in the auth/billing path

IJFW configures agent BEHAVIOUR, not agent INFRASTRUCTURE.
Works identically on Max, Pro, API, Team, Enterprise, OpenRouter, Bedrock, Vertex AI.

---

## Auto-Detection at SessionStart

The startup hook silently detects (milliseconds, no external network calls):

- **OpenRouter**: `OPENROUTER_API_KEY` env var or `ANTHROPIC_BASE_URL` → openrouter.ai
- **Claude Code Router**: `~/.claude-code-router/config.json` or running process
- **Ollama**: ping `localhost:11434/api/tags`
- **LM Studio**: ping `localhost:1234/v1/models`
- **DeepSeek**: `DEEPSEEK_API_KEY` env var

If detected → silently leverage for routing/cheap processing.
If nothing → use native provider gracefully.
If user installs something later → IJFW picks it up next session.

---

## Startup Report UX

Positive framing only. No negatives. Examples:

**Returning session:**
```
--- IJFW ------------------------------
smart mode | high effort | OpenRouter + local model

Memory loaded (34 decisions, 12 sessions)
Last session: auth migration 4/7 complete
Next: routes/exams.ts

Ready.
---------------------------------------
```

**New project:**
```
--- IJFW ------------------------------
smart mode | high effort | multi-model routing

Project: Next.js 14 / TypeScript / PostgreSQL
Optimized project context created (42 lines)
Codebase indexed (247 files, 23 API routes)
Ready.
---------------------------------------
```

**Nothing to report:**
```
--- IJFW ------------------------------
smart mode | high effort

Ready.
---------------------------------------
```

---

## Three-Tier Memory System

### Tier 1 -- Session Memory (Working Memory)
- What's happening now. Decisions, files touched, errors, progress.
- Captured by hooks at compaction events and session end.
- Stored: `.ijfw/sessions/<session-id>.md` (plain markdown)
- Token cost: zero additional per-turn. Hooks fire only at boundaries.

### Tier 2 -- Project Memory (Short-Term Recall)
- Cross-session. Last 7-14 days of activity.
- Session summaries, handoffs, rolling project journal.
- Stored: `.ijfw/memory/project-journal.md`, `.ijfw/memory/handoff.md`
- Compressed at SessionEnd, injected at SessionStart.

### Tier 3 -- Knowledge Base (Long-Term Memory)
- Architectural decisions, codebase conventions, user preferences.
- Persists indefinitely. Grows via dream cycle.
- Stored: `.ijfw/memory/knowledge.md` (~2000 tokens max)
- Cross-project: `~/.ijfw/memory/global-knowledge.md`

### Storage Hierarchy
- **Hot**: Plain markdown files. Zero dependencies. Human-readable. Git-friendly.
- **Warm**: SQLite FTS5 keyword search. Ships with every runtime. No setup.
- **Cold**: Optional vector embeddings. Only if user configures embedding provider.

---

## Dream Cycle (Memory Consolidation)

Runs automatically every 5 sessions. Manual: `/consolidate`.

1. **Promote**: Patterns repeating across 3+ sessions → knowledge base
2. **Prune**: Journal entries >14 days → archive (don't delete)
3. **Reconcile**: Contradictions resolved with temporal weighting
   - Newer memories = higher weight
   - Git-derived memories = higher confidence than observations
   - Old decisions marked superseded, not deleted
4. **Deduplicate**: Merge related entries in knowledge base
5. **Cross-project**: Promote universal knowledge to global level

Uses architect agent (Opus, high effort). Cost: ~5-10K tokens. Infrequent.

---

## MCP Memory Server

### 8 Tools (Scannable Surface, Not 19 or 22 Like Competitors)

Cap set in CLAUDE.md. Additions beyond this must displace an existing tool.

| Tool | Purpose |
|------|---------|
| `ijfw_memory_recall` | Retrieve context. Progressive disclosure. Cross-project via `from_project`. |
| `ijfw_memory_store` | Store decisions / patterns / handoffs / preferences / observations. |
| `ijfw_memory_search` | Keyword + BM25 search, local or all-projects. |
| `ijfw_memory_status` | ~200-token wake-up injection. |
| `ijfw_memory_prelude` | Full first-turn memory bundle for Codex/Cursor/Windsurf/Copilot. |
| `ijfw_prompt_check` | Deterministic vague-prompt detector for platforms without pre-prompt hooks. |
| `ijfw_metrics` | Tokens / cost / routing / session totals. |
| `ijfw_cross_project_search` | BM25 search across every registered IJFW project. |

### Why 4 and Not More
- Don't make me think. Fewer tools = less agent decision overhead.
- Each tool handles multiple patterns internally (recall handles wake-up, handoff, decisions, queries).
- Tool schema overhead is ~200 tokens total across all 4.

---

## Input/Context Optimization

### Deterministic (Zero LLM Cost, Always On)
- PreToolUse hooks strip ANSI codes, collapse passing tests, truncate verbose output
- Minified JSON for tool call payloads
- Whitespace normalization

### Structural (Via Codebase Index)
- Targeted file reads (line ranges, not whole files)
- No re-reads of files already in context
- Index queries (~50 tokens) instead of grep (~2000 tokens)
- Structural context (signatures/exports) before full content
- Diff-based context for "what changed" questions

### Context Management
- Auto-generate CLAUDE.md if none exists (via ijfw-summarize skill, max 50 lines)
- Auto-compress bloated CLAUDE.md (backup original, ~40-50% savings)
- Headroom management: graduated thresholds at 40/60/70/80%
- Smart compaction guidance: PreCompact hook tells agent what to preserve vs drop
- Tiered CLAUDE.md loading: small always-load core, reference sections on-demand

---

## Hot-Loadable Smart Skills

Skills load ONLY when triggered by context/keywords. Unload when done.
Core skill acts as dispatcher. Users create custom skills in `.ijfw/skills/`.

Built-in: ijfw-commit, ijfw-review, ijfw-compress, ijfw-handoff, ijfw-summarize

The 25K compaction re-attachment budget means we must be strategic about
which skills are active simultaneously. Hot-loading prevents crowding.

---

## Custom Agents

Users define agents in `.ijfw/agents/` or `.claude/agents/`:
- Markdown file with YAML frontmatter (name, model, effort, description, tools)
- Body contains agent instructions
- IJFW discovers automatically
- Example: devops agent, reviewer agent, docs agent

---

## Settings Audit (First Run, Positive Framing)

Silently checks and fixes:
- Effort medium → upgrade to high ("Upgraded thinking depth")
- No CLAUDE.md → create optimized one ("Optimized project context created")
- Bloated CLAUDE.md → compress ("Project context optimized, saved X tokens")
- Missing .claudeignore → create sensible defaults
- Subagent models defaulting to Opus → recommend cheaper defaults

Never presented as problems. Presented as upgrades.

---

## Processing Tiers (Cost Optimization)

```
Tier 1 -- Deterministic (free, always on):
  ANSI stripping, test collapsing, whitespace normalization,
  JSON minification, tool output truncation

Tier 2 -- Cheap LLM (optional, auto-detected):
  Memory compression, dream cycle, session summarization,
  project context generation
  Routes to: Ollama/LM Studio (if detected) → Haiku (fallback)

Tier 3 -- Full LLM (user's configured model):
  Actual coding tasks, architecture, complex reasoning
```

---

## Build Phases

### Phase 1 -- MVP (Current Build)
- [x] Core skill (ijfw-core/SKILL.md)
- [x] Agents (scout/builder/architect)
- [x] Commands (mode/compress/status/handoff/consolidate)
- [x] On-demand skills (commit/review/compress/handoff/summarize)
- [x] Hooks (SessionStart/PreCompact/Stop/PreToolUse)
- [x] Hook scripts (startup detection, compaction guidance, session end, input stripping)
- [x] MCP memory server (8 tools, markdown + BM25 + cross-project search)
- [x] Platform configs (Claude/Codex/Gemini/Cursor/Windsurf/Copilot)
- [x] Universal rules file
- [x] Activation rules
- [x] README + DESIGN docs

### Phase 2 -- Intelligence Layer
- [ ] Effort auto-scaling by task keywords (classifier in core skill)
- [ ] Self-verification enforcement rules
- [ ] Plan-then-execute enforcement
- [ ] Dream cycle implementation (consolidation algorithm)
- [ ] Codebase index (SQLite + tree-sitter)
- [ ] Cross-project global knowledge promotion
- [ ] SQLite FTS5 warm layer for memory server

### Phase 3 -- Platform Polish
- [ ] Full plugin marketplace listings
- [ ] npx one-liner install scripts per platform
- [ ] Platform-specific hook adaptations
- [ ] Benchmark harness (three-arm: baseline vs terse vs IJFW)

### Phase 4 -- Advanced
- [x] Optional vector embedding layer (cold storage) — shipped v1.5.0 r17. Hybrid BM25+cosine rerank via `src/search-hybrid.js` + `src/vectors.js`; enabled with `IJFW_VECTORS=on` + `npm i @xenova/transformers` (optional peer dep, not bundled).
- [ ] Token usage dashboard (/ijfw-status with cost tracking)
- [ ] Team memory sharing
- [ ] Visual memory (image-based context for multimodal agents)

---

## Prior Art Credits

| Tool | What We Learned |
|------|----------------|
| caveman | Terse output works. 22-87% savings. Three-arm benchmarking. |
| claude-mem | Hook-based session capture. Progressive disclosure. |
| claude-router / CCR | Model routing saves 40-60% cost. Proxy approach = fragile. |
| Memorix | Cross-agent MCP memory. Git memory. 3-layer progressive disclosure. |
| MemPalace | Structured memory metaphor. 170-token wake-up. Temporal knowledge graph. |
| context-mode | PreToolUse interception. Sandbox execution. 98% context reduction. |
| RTK | Deterministic tool output stripping. 68.9% efficiency. |
| DCP | Dynamic context pruning. Smart compaction guidance. |
| handoff plugin | Structured session handoff. PreCompact/PostCompact hooks. |
| clauditor | Waste factor measurement. Session rotation. |
| AiDex | Lightweight local code index. ~50 tokens/query. SQLite + tree-sitter. |
| Claude Context MCP | Semantic code search. Hybrid BM25 + vector. |

IJFW is the first to coordinate all of these into a single, zero-config system.

---

*Document Version: 1.0*
*Author: Sean Donahoe*
*Design Session: April 2026*
