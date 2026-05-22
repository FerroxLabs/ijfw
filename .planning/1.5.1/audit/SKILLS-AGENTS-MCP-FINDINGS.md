# v1.5.1 Audit: MCP + Skills + Agents

> Scope: MCP tool surface (`mcp-server/src/`), Skills surface (per-platform `*/skills/`), and Agents surface (`claude/agents/`).
> Sister audits cover CLI, orphan code, and platform parity.
> Date: 2026-05-22 (v1.5.0 just shipped to npm).

---

## Summary

- **README lies about MCP tool count.** README.md:295 says "Thirteen MCP tool endpoints (11 user-facing in `tools/list` + 2 admin handler...)". FALSE. All 13 tools live in the single `TOOLS` array in `mcp-server/src/server.js:952-1126` and are returned by the `tools/list` handler at server.js:1902-1903. There is no 11+2 split. README needs to be rewritten.
- **Phantom dispatch handler.** `mcp-server/src/server.js:2041-2043` handles `ijfw_memory_status` — a tool that does NOT exist in the TOOLS array and is NEVER registered. Dead branch with no caller path. Should be deleted.
- **8 phantom agent_type refs in swarm-config.js.** `mcp-server/src/swarm-config.js` declares specialists with `agent_type: 'ijfw-story-architect'`, `'ijfw-continuity-editor'`, `'ijfw-copy-editor'`, `'ijfw-data-analyst'`, `'ijfw-prose-stylist'`, `'ijfw-research-lead'`, plus 3rd-party `'silent-failure-hunter'`, `'code-reviewer'`, `'pr-test-analyzer'`, `'type-design-analyzer'`. NONE of these have matching `claude/agents/*.md` files. If a non-software domain swarm fires, it tries to dispatch nothing.
- **Stale "12/12" tool-cap policy comments and an "11 tools" memory entry.** Code comments in `server.js:1086-1092`, `1107-1114` and the project memory still say "12/12 slots". Actual cap is 13. Plus a memory observation says "11 tools" was the canonical roster — drifted from CLAUDE.md which says 13.
- **6 Claude skills have a stray HTML-comment narrator-marker on line 1 pushing the YAML frontmatter to line 2.** Skills loaders normally accept this but it violates the standard `---` on line 1 convention shared by codex/shared/gemini/etc. Inconsistent.
- **Preflight gate count diverges across platforms.** Claude's `ijfw-preflight/SKILL.md:3` says "12 gates"; codex + shared say "11 gates". One of the two is lying — same bug Sean is pissed about for CLI surface.
- **3 fully orphaned Claude-only agents** (`architect.md`, `builder.md`, `scout.md`): never referenced anywhere — not in any skill, not in swarm-config, not in team templates, not in hooks. Pure dead spec.
- **Cross-platform skills parity gap (huge).** Claude ships 34 skills; codex/shared/installer ship only 19. **15+ skills missing from non-Claude platforms**, including project-critical ones like `ijfw-tdd`, `ijfw-verify`, `ijfw-ship`, `ijfw-plan`, `ijfw-new-project`, `ijfw-spec-phase`, `ijfw-ui-spec`. Gemini/cursor/windsurf/copilot/hermes/wayland have **NO** skills directories at all.

---

## MCP tool findings

### HIGH severity

#### MCP-H1: README MCP tool count is wrong (`README.md:295`, `README.md:438`)
**File**: `/Users/seandonahoe/dev/ijfw/README.md` lines 295, 438.
**Claim**: "Thirteen MCP tool endpoints (11 user-facing in `tools/list` + 2 admin handler-only)."
**Reality**: All 13 tools are registered in the `TOOLS` array in `mcp-server/src/server.js:952-1126`. The `tools/list` handler at `server.js:1902-1903` simply returns `TOOLS` wholesale. `UPDATE_CHECK_TOOL` (server.js:1071) and `UPDATE_APPLY_TOOL` (server.js:1072) are spread into the same array — they are user-facing too.
**Fix**: Rewrite README §MCP-tools as "13 user-facing MCP tools, all returned by `tools/list`." Drop the "admin handler-only" framing.

#### MCP-H2: Phantom `ijfw_memory_status` handler (`mcp-server/src/server.js:2041-2043`)
**File**: `mcp-server/src/server.js:2041-2043`.
```
case 'ijfw_memory_status':
  result = handleStatus();
  break;
```
**Problem**: No tool with name `ijfw_memory_status` exists in the `TOOLS` array. The case is unreachable from `tools/list` — dispatch can never route here. `handleStatus()` (defined somewhere in server.js) is dead code reachable only from this dead branch.
**Fix**: Either (a) delete the case + `handleStatus()`, or (b) if there's a non-MCP code path that calls it (unlikely), document it. Recommended: delete.

#### MCP-H3: Stale "12/12" tool-cap claims in comments (`mcp-server/src/server.js:1086-1092`, `1107-1114`)
**File**: `mcp-server/src/server.js`.
**Claim**:
- Line 1091: `"keeping the MCP cap at 12/12"`
- Line 1114: `"Fills the 12th tool-cap slot"`
**Reality**: CLAUDE.md says cap was raised 12 → 13 in v1.5.0 memory-moat. Auto-memory observations also still say "12/12 slots" (#7023, 2026-05-20). Code lies about its own cap.
**Fix**: Update comments to "13/13" and note that `ijfw_memory_facts` is the 13th slot.

### MED severity

#### MCP-M1: `ijfw_run` description is too narrow (`mcp-server/src/server.js:1075`)
**File**: `mcp-server/src/server.js:1074-1085`.
**Description**: "Run a shell command. For commands likely to produce large output..."
**Reality**: The handler at `server.js:2067-2094` ALSO routes colon-namespaced commands through `dispatchRun()` — i.e. `compute:python`, `compute:js`, `index:<source>`, `detect:project_type` are first-class behaviors of this tool. The description doesn't mention these dispatch namespaces, so models discover them by accident or never.
**Fix**: Add to description: "Also accepts colon-namespaced commands: `compute:python`, `compute:js`, `index:<source>`, `detect:project_type`."

#### MCP-M2: `ijfw_memory_search` description doesn't mention `graph:` namespace (`mcp-server/src/server.js:994`)
**File**: `mcp-server/src/server.js:993-1005`.
**Description**: Mentions `scope: 'sandbox'` colon path but not the `graph:<query>` colon namespace.
**Reality**: Handler at `server.js:2025` explicitly routes `parsedQuery.namespace === 'graph'` through `dispatchSearch()`. Undocumented in tool schema.
**Fix**: Add `graph:<query>` mention to description.

#### MCP-M3: `ijfw_state` description claims 20 verbs but doesn't list them (`mcp-server/src/server.js:1094`)
**File**: `mcp-server/src/server.js:1094`.
**Description**: "...invoke any of the 20 frozen verbs (workflow.*, wave.*, phase.*, subagent.*, event.emit, telemetry.record, roster.*, extension.set-active, decision.add, blocker.*, state.replay, state.validate)..."
**Problem**: Globs (`workflow.*`) are not enumerable verb names. A user / model cannot know whether `workflow.set` or `workflow.update` is valid without reading STATE-SDK-CONTRACT §7 (an internal doc).
**Fix**: Either enumerate the 20 verbs in the schema, or add a 21st verb `state.list-verbs` that returns the contract programmatically.

#### MCP-M4: `ijfw_cross_audit_converge` maxIterations doc says "default 3" but spec says cap 10 (`mcp-server/src/server.js:1120`)
**File**: `mcp-server/src/server.js:1120` says "Max convergence iterations (default 3)" — README:434 says "Bounded `maxIterations` (cap 10)". Schema doesn't expose the cap.
**Fix**: Add `maximum: 10` to the JSON schema for `maxIterations`, and document the cap in the description.

#### MCP-M5: `ijfw_metrics` description claims period default "7d" but no default in schema (`mcp-server/src/server.js:1053`)
**File**: `mcp-server/src/server.js:1053`.
**Description**: "Time window (default 7d)."
**Schema**: No `default: '7d'` declared. Handler `handleMetrics` likely applies a runtime default, but JSON schema clients see no default. Honesty drift.
**Fix**: Add `default: '7d'` to the period schema (same for `metric: 'tokens'` default).

### LOW severity

#### MCP-L1: Triple-redundant "12/12 slot" rationale in `CLAUDE.md` lives in the wrong place
The retirement-review essay belongs in `docs/` not in the project CLAUDE.md. Bumps token budget on every read.

#### MCP-L2: `ijfw_memory_facts` description says "v1.5.0 M5 (INT.6)" inline comment leaks
The internal milestone tag comment is fine in code (line 1022) but the user-visible description (line 1024) should be slug-free.

---

## Skills findings

### HIGH severity

#### SK-H1: 15+ skills missing from non-Claude platforms (cross-platform parity collapse)
**Files**: `claude/skills/` ships 34 skills; `codex/skills/`, `shared/skills/`, `installer/.codex/skills/` ship only 19 each.
**Missing from codex/shared/installer**: `ijfw-agents-md`, `ijfw-auto-memorize`, `ijfw-complete-milestone`, `ijfw-compute`, `ijfw-core`, `ijfw-metrics`, `ijfw-milestone-summary`, `ijfw-new-milestone`, `ijfw-new-project`, `ijfw-plan`, `ijfw-receiving-review`, `ijfw-ship`, `ijfw-spec-phase`, `ijfw-tdd`, `ijfw-ui-spec`, `ijfw-verify`, `ijfw-writing-skills`.
**Missing skills directories entirely**: `gemini/skills/`, `cursor/skills/`, `windsurf/skills/`, `copilot/skills/`, `hermes/skills/`, `wayland/skills/` — none exist. CLAUDE.md says IJFW is "Plugin system -- ships platform-native packages for 8 AI coding agents" but only Claude/Codex have skill surfaces.
**Fix**: Decision required: either (a) port to all platforms, (b) document the platform matrix honestly in README, or (c) accept Claude+Codex as the only skill-bearing platforms and update CLAUDE.md.

#### SK-H2: Codex skill `ijfw-review` description lies about scope vs Claude version
**Files**:
- `claude/skills/ijfw-review/SKILL.md:5`: "Use when the user asks for a review of any artifact -- code diff, PR, book chapter, campaign brief, landing-page copy, or design tokens..."
- `codex/skills/ijfw-review/SKILL.md:3`: "One-line code review comments. Trigger: review, code review, PR review, /ijfw-review"
**Problem**: Different skills. Codex version is a stripped-down code-only review; Claude version is the domain-agnostic critic. Same skill name, different contracts. Will mislead users moving between platforms.
**Fix**: Either rename codex version to `ijfw-code-review`, or port the Claude domain-agnostic body.

#### SK-H3: Preflight gate count diverges across platforms
**Files**:
- `claude/skills/ijfw-preflight/SKILL.md:3`: "12 gates, fail-fast"
- `codex/skills/ijfw-preflight/SKILL.md:3`: "11 gates, fail-fast"
- `shared/skills/ijfw-preflight/SKILL.md:3`: "11 gates, fail-fast"
**Fix**: Determine actual gate count by reading the preflight pipeline, then sync description across all 3.

### MED severity

#### SK-M1: 6 Claude skills have HTML comment above frontmatter (`ijfw-compress`, `ijfw-metrics`, `ijfw-receiving-review`, `ijfw-review`, `ijfw-tdd`, `ijfw-writing-skills`)
**Files**:
- `claude/skills/ijfw-compress/SKILL.md:1`: `<!-- IJFW: narration-not-applicable -->` before `---`
- Same pattern in `ijfw-metrics`, `ijfw-receiving-review`, `ijfw-review`, `ijfw-tdd`, `ijfw-writing-skills`.
**Problem**: Pushes YAML frontmatter to line 2. Most Markdown YAML parsers handle this, but Claude Code's skill loader convention is `---` on line 1. Inconsistent within the same directory.
**Fix**: Either (a) move the marker comment into the body below frontmatter, or (b) systematically apply the marker to all 34 skills if it's intentional discipline.

#### SK-M2: `ijfw-team/SKILL.md:240` contains literal template placeholder text in source
**File**: `claude/skills/ijfw-team/SKILL.md:240-243` and `codex/skills/ijfw-team/SKILL.md:233-236` contain literal text `name: <role-name>` / `description: <when to use this agent -- 1-2 lines>` — these look like agent-frontmatter template stubs embedded in the skill body. If the skill loader treats top-of-file YAML as authoritative this could trip second-frontmatter parsers.
**Fix**: Confirm intentional, and if so wrap in a code fence (`` ```yaml ``) to make it documentation-only.

#### SK-M3: `ijfw-cross-audit` description varies between platforms in trigger phrasing
**Files**:
- Claude `ijfw-cross-audit/SKILL.md:3`: "...'check with other models'..."
- Codex `ijfw-cross-audit/SKILL.md:3`: "...'check with other AIs'..."
Same skill, different trigger phrases. The Codex version will miss the "models" keyword; the Claude version will miss "AIs".
**Fix**: Sync trigger phrasing across platforms — include both.

#### SK-M4: `ijfw-status` ships on codex/shared but NOT on Claude
**Files**: `codex/skills/ijfw-status/SKILL.md` exists; no equivalent in `claude/skills/`. Memory notes say `/ijfw status` is documented in IJFW ijfw command index. Claude users have no skill-loaded status surface.
**Fix**: Either port the skill to Claude, or document that `/status` is a hook-driven slash command on Claude (if so).

#### SK-M5: `ijfw-doctor` ships on codex/shared but NOT on Claude
**Files**: Same pattern as SK-M4. Codex has `ijfw-doctor/`; Claude does not.
**Fix**: Port or document.

### LOW severity

#### SK-L1: `ijfw-team/SKILL.md` template placeholder repeats description verbatim in codex
`codex/skills/ijfw-team/SKILL.md:236` reuses the same "Use when the user says: 'set up a team'..." text for the embedded template agent stub — likely copy-paste artifact.

#### SK-L2: `ijfw-writing-skills/SKILL.md:28-37` contains 4 example `description:` snippets that look like real frontmatter
Inside the body (lines 28-37) of `claude/skills/ijfw-writing-skills/SKILL.md` are 4 example `description:` strings demonstrating skill authoring. They're in prose context, not real frontmatter — but a naive parser scanning for `^description:` could double-count.

---

## Agents findings

### HIGH severity

#### AG-H1: 8 phantom `agent_type` refs in `swarm-config.js` with NO matching agent file
**File**: `mcp-server/src/swarm-config.js` lines 56-90 area.
**Refs with no `claude/agents/*.md`**:
1. `ijfw-story-architect` (line 61) — closest existing: `architect.md` (different name)
2. `ijfw-continuity-editor` (line 63) — closest existing: `ijfw-narrative-continuity-checker.md` (different name)
3. `ijfw-copy-editor` (line 64) — closest existing: `ijfw-copy-reviewer.md` (different name)
4. `ijfw-data-analyst` — no file
5. `ijfw-prose-stylist` — closest existing: `ijfw-line-editor.md` (different name)
6. `ijfw-research-lead` — no file
7. `silent-failure-hunter` — 3rd party? no file in `claude/agents/`
8. `pr-test-analyzer`, `type-design-analyzer`, `code-reviewer` — assumed 3rd-party from pr-review-toolkit plugin

**Impact**: When a non-software domain swarm fires (book, campaign, research, data), it dispatches against agent names that don't resolve. Silent failure unless dispatcher fails closed.
**Fix**: Either (a) create the missing agent .md files, (b) rename the swarm-config refs to point at existing agents (e.g. `ijfw-continuity-editor` → `ijfw-narrative-continuity-checker`), or (c) gate the swarm-config entries behind a "needs implementation" feature flag.

#### AG-H2: 3 orphan Claude-only agents (`architect.md`, `builder.md`, `scout.md`)
**Files**:
- `claude/agents/architect.md`
- `claude/agents/builder.md`
- `claude/agents/scout.md`

**Search results**: Not referenced as `subagent_type:` or `Task:` anywhere in `claude/skills/`, `claude/hooks/`, `mcp-server/src/`, `installer/`. Pure orphan specs.
**Fix**: Either delete, or wire into a dispatcher. These look like generic templates that pre-date the `ijfw-*` naming convention.

### MED severity

#### AG-M1: `ijfw-debug-session-manager.md` references `Agent` tool which is deprecated
**File**: `claude/agents/ijfw-debug-session-manager.md:5`: `allowed-tools: Read, Write, Bash, Grep, Glob, Agent`.
**Problem**: The current Claude tool name is `Task` (used in `ijfw-ui-auditor.md:5`). `Agent` was the older name. Inconsistent across the agents dir.
**Fix**: Replace `Agent` with `Task` in `ijfw-debug-session-manager.md:5`.

#### AG-M2: Only 2 of 33 agents declare any MCP tool in `allowed-tools`
**Files**: `architect.md:8` and `scout.md:7` are the only agents that pull `mcp__ijfw-memory__ijfw_memory_search` / `ijfw_memory_store`. Every other agent has zero MCP tools — meaning agents like `ijfw-codebase-mapper`, `ijfw-extract-learnings`, `ijfw-roadmapper`, `ijfw-doc-writer` cannot read project memory.
**Problem**: That makes agents context-blind to project memory unless re-dispatched with hints.
**Fix**: Audit per-agent: which need memory read? Likely candidates: extract-learnings, codebase-mapper, roadmapper, security-auditor, plan-checker. Add `mcp__ijfw-memory__ijfw_memory_search` to their tool lists.

#### AG-M3: Two reviewer agents with near-identical scope (`ijfw-accessibility-eng` vs `ijfw-accessibility-reviewer`)
**Files**: `claude/agents/ijfw-accessibility-eng.md` (4.0K) and `ijfw-accessibility-reviewer.md` (5.4K).
**Problem**: Both audit accessibility. swarm-config only references `ijfw-accessibility-eng`. Which is canonical? Is `-reviewer` orphan?
**Fix**: Verify against swarm-config + dispatchers; consolidate or document the role split.

### LOW severity

#### AG-L1: Agents use mixed YAML quoting in `allowed-tools` (single comma-separated string vs YAML list)
Some agents declare `allowed-tools: Read, Write, Edit, Bash` as a comma-string; conventional YAML would be a list. Not a parsing issue (Claude harness accepts both) but inconsistent style.

#### AG-L2: `ijfw-ui-auditor.md:5` includes `Task` in allowed-tools — re-entry risk
`Task` lets the agent dispatch sub-tasks. Combined with already-large UI audit scope, this is a structural footgun if the agent recursively calls itself. Worth documenting.

---

## Cross-platform parity matrix (Skills only)

| Skill | claude | codex | shared | installer | gemini | cursor | windsurf | copilot | hermes | wayland |
|---|---|---|---|---|---|---|---|---|---|---|
| ijfw-agents-md          | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-auto-memorize      | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-commit             | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-complete-milestone | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-compress           | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-compute            | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-core               | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-critique           | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-cross-audit        | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-dashboard          | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-debug              | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-design             | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-doctor             | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-handoff            | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-memory-audit       | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-metrics            | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-milestone-summary  | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-new-milestone      | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-new-project        | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-plan               | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-plan-check         | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-preflight          | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-recall             | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-receiving-review   | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-review             | ✓ | ✓ (diff scope!) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-ship               | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-spec-phase         | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-status             | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-summarize          | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-tdd                | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-team               | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-ui-spec            | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-update             | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-verify             | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-workflow           | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ijfw-writing-skills     | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

**Tally**: Claude 34 skills | Codex 19 | Shared 19 | Installer 19 | gemini/cursor/windsurf/copilot/hermes/wayland 0.

---

## Recommended v1.5.1 fix waves

- **Wave 1 (truth-up, 1-2 hr)**: MCP-H1, MCP-H2, MCP-H3 (README + dead `ijfw_memory_status` handler + 12/12 comments).
- **Wave 2 (orphans, 1-2 hr)**: AG-H2 (delete or wire architect/builder/scout), AG-H1 (decide on the 8 phantom swarm-config refs).
- **Wave 3 (parity, larger)**: SK-H1 cross-platform port decision — either ship the 15 missing skills to codex/shared/installer or honestly downgrade the platform-matrix claim in README.
- **Wave 4 (drift)**: SK-H3 preflight gate count truth, SK-H2 codex `ijfw-review` scope harmonisation, MCP-M1..M5 description drift, SK-M1 frontmatter consistency.
- **Wave 5 (low)**: cosmetics.
