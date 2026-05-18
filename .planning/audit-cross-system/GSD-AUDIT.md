# GSD Audit (get-shit-done-cc)

**Audited:** 2026-05-18
**GSD version:** 1.41.2 (`get-shit-done-cc@1.41.2` on npm)
**Author:** TÂCHES
**License:** MIT
**Node engine:** `>=22.0.0`
**Distribution:** npm `npx get-shit-done-cc` installer; ships skills to `~/.claude/skills/gsd-*`, agents to `~/.claude/agents/gsd-*.md`, slash commands to `~/.claude/commands/`, hooks to `~/.claude/hooks/`, plus an `sdk/` JS SDK with a `gsd-sdk` CLI binary.
**Surface area:** **66 skills**, **33 specialist subagents**, slash-command layer, a CLI SDK (`gsd-sdk query …`) backing every state mutation, and hooks/scripts. Roughly 5-10x IJFW v1.4.4's footprint (IJFW: ~20 skills / 13 specialists).
**Auditor:** R2 (researcher in 3-agent parallel audit swarm)

---

## TL;DR

### Top 8 patterns IJFW should ADAPT (concrete, immediate value)

1. **`gsd-executor` deviation rules + checkpoint return contract.** Four-rule taxonomy (auto-fix bug / auto-add missing critical / auto-fix blocker / ask-about-architectural) with explicit STOP-and-return-structured-message protocol. This is the cleanest answer to IJFW v1.5.0 S1's truncation gap I have seen — they did not just add checkpoints, they classified WHY you stop. ADAPT directly into IJFW execute-phase.
2. **Three-tier verification strategy in `gsd-code-fixer`.** Tier 1 mandatory re-read, Tier 2 preferred syntax check (per-language matrix), Tier 3 fallback. Each tier has explicit failure semantics (rollback vs proceed). IJFW v1.4.4 N3 review.js has only a single "did it apply" check.
3. **`commit-to-subrepo` for monorepo routing.** Files are auto-routed to their correct sub-repo based on path patterns; a single executor commit produces N per-repo commits. IJFW has no monorepo story at all.
4. **Atomic worktree + recovery-sentinel pattern in `gsd-code-fixer`.** Writes `.review-fix-recovery-pending.json` BEFORE crash window opens, removes AFTER `git worktree remove` succeeds — making the cleanup tail transactional. Crash-safe recovery on next run. Direct fit for IJFW S2 (worktrees-no-npm-install gap).
5. **Pre-commit cwd-drift assertion + absolute-path safety guard + protected-ref deny-list.** Three guards (#3097, #3099, #2924) inside the executor: cwd sentinel pinned at spawn, absolute path containment check vs `git rev-parse --show-toplevel`, refuse-to-commit if HEAD drifted onto `main|master|develop|trunk|release/*`. IJFW has minimal worktree safety today.
6. **Analysis-paralysis guard** — "if 5+ consecutive Read/Grep/Glob without Edit/Write/Bash, STOP and state one sentence why." Cheap, codified, and aimed at a real subagent failure mode. Should be a standard preamble in every IJFW specialist.
7. **`gsd-plan-review-convergence` iterative loop.** Replan + cross-AI review until HIGH concerns drop to zero (or max-rounds), with the convergence criterion explicit. IJFW Trident is single-shot.
8. **`gsd-audit-fix` autonomous audit-to-fix pipeline.** Find issues → classify → fix → test → commit, with the entire loop owned by a skill, not the orchestrator. Pairs naturally with #2 above.

### Top 5 patterns IJFW should DUPLICATE (already partial in v1.5.0)

1. **Specialist roster expansion.** GSD has 33 specialists; IJFW has 13. The 20-ish IJFW lacks are mostly `*-researcher` + `*-auditor` + `*-checker` variants — see specialist inventory.
2. **Threat model as first-class plan section.** GSD plans carry `<threat_model>` and the executor's Rule 2 ("auto-add missing critical functionality") explicitly checks "if the plan's `<threat_model>` assigns `mitigate` dispositions to this task's files, they are correctness requirements." IJFW has secure-phase but not in-line in plans.
3. **Stub tracking + threat-flags scan before SUMMARY.** GSD executor scans the codebase for stub patterns (`=[]`, `=""`, "placeholder", "TODO") and threat-flag patterns BEFORE writing SUMMARY.md, forcing them into a `## Known Stubs` / `## Threat Flags` section. IJFW v1.5.0 has the bones (verify-phase) but no automatic stub scan.
4. **STATE machine driven by `gsd-sdk query state.*` verbs.** Every state mutation goes through a single SDK verb (advance-plan, update-progress, record-metric, add-decision, etc.). Idempotent, testable, scriptable. IJFW has scattered `.ijfw/state/workflow.json` writes — should consolidate behind a verb namespace.
5. **Project-skills auto-discovery from `.claude/skills/` or `.agents/skills/`.** Reviewer + fixer both auto-load project SKILL.md files (skipping 100KB+ AGENTS.md). IJFW project skill is loaded but not auto-discovered by specialists.

### Top 3 patterns IJFW should IGNORE

1. **66-skill surface area.** GSD's "everything is a skill" approach has produced `gsd-ns-context`, `gsd-ns-ideate`, `gsd-ns-manage`, `gsd-ns-project`, `gsd-ns-review`, `gsd-ns-workflow` — six namespace-grouped skills that exist mainly to redirect to other skills. IJFW's `ijfw:ijfw` command-index pattern is leaner.
2. **`gsd-ultraplan-phase` cloud offload.** "Offload plan phase to Claude Code's ultraplan cloud; review in browser and import back" — beta, vendor-specific, and IJFW already has cross-AI Trident. Not worth porting.
3. **`gsd-manager` "interactive command center for multiple phases from one terminal".** Cool concept but adds a coordination surface for a problem IJFW does not have (IJFW already uses dispatch-parallel-agents pattern).

### One pattern that fundamentally changes the IJFW roadmap

**The deviation-rules-with-bounded-fix-attempts pattern from `gsd-executor`.** Rules 1-3 say "auto-fix without asking," Rule 4 says "stop and ask about architectural changes," but the killer detail is the explicit **"3 auto-fix attempts per task" cap** with a "STOP fixing, document remaining issues, continue to next task, do NOT restart the build to find more issues" protocol. This is the missing piece for IJFW's S1 truncation work — it gives subagents a finite, deterministic energy budget per task, which is exactly the property that lets you set guard timers and detect runaway loops. Recommend folding into v1.5.0 S1 immediately.

---

## Skill inventory (66 skills — compact verdict table)

Verdicts: **A** = ADAPT to IJFW, **D** = DUPLICATE (we already do a version), **I** = IGNORE.

| Skill | Purpose | Verdict | Notes |
|---|---|---|---|
| gsd-add-tests | Generate tests for completed phase from UAT | A | IJFW has TDD skill but no "retroactive test generation from UAT criteria" |
| gsd-ai-integration-phase | AI-SPEC.md design contract for AI-building phases | I | IJFW workflow already AI-aware |
| gsd-audit-fix | Autonomous audit→classify→fix→test→commit pipeline | **A** | Closed-loop fix automation, see deep-dive |
| gsd-audit-milestone | Audit milestone completion vs original intent before archiving | A | Cheap pre-archive gate IJFW lacks |
| gsd-audit-uat | Cross-phase audit of all outstanding UAT items | A | UAT debt tracker — IJFW has per-phase verify, not cross-phase |
| gsd-autonomous | Run all remaining phases autonomously (discuss→plan→execute per phase) | D | IJFW workflow does this end-to-end |
| gsd-capture | Capture ideas/tasks/notes/seeds to destination | D | IJFW has memory-store |
| gsd-cleanup | Archive accumulated phase directories from completed milestones | A | Lightweight archival skill IJFW lacks |
| gsd-code-review | Review source files changed during a phase (deep-dive below) | **A** | Pipeline source — see deep-dive |
| gsd-complete-milestone | Archive completed milestone, prep next version | D | IJFW ijfw-ship + complete-milestone-ish |
| gsd-config | Configure GSD workflow toggles + model profile | D | IJFW ijfw-mode |
| gsd-debug | Systematic debugging with persistent state across context resets | **A** | Multi-cycle subagent loop — see deep-dive |
| gsd-discuss-phase | Adaptive questioning before planning | A | Discuss-phase is sharper than IJFW's brainstorm pass |
| gsd-docs-update | Generate/update project docs verified against codebase | A | Verification-against-codebase angle is novel |
| gsd-eval-review | Audit an executed AI phase's eval coverage + produce EVAL-REVIEW.md | A | AI-specific eval auditing — fits IJFW's AI-integration story |
| gsd-execute-phase | Execute all plans with wave-based parallelization | **A** | Core workflow — direct compare to IJFW execute |
| gsd-explore | Socratic ideation and idea routing | D | IJFW brainstorm |
| gsd-extract-learnings | Extract decisions/lessons/patterns/surprises from completed phase | A | Auto-mining a phase for memory entries — fits IJFW memory model |
| gsd-fast | Execute a trivial task inline (no subagents) | D | IJFW Quick mode |
| gsd-forensics | Post-mortem investigation for failed GSD workflows | **A** | Diagnostic skill IJFW lacks entirely |
| gsd-graphify | Build/query/inspect project knowledge graph | A | Knowledge graph layer for project; IJFW has memory but not graph |
| gsd-health | Diagnose planning directory health + optionally repair | D | IJFW doctor |
| gsd-help | Show available commands + usage guide | D | IJFW ijfw-help |
| gsd-import | Ingest external plans with conflict detection vs project decisions | A | Plan-import w/ conflict detection — IJFW lacks |
| gsd-inbox | Triage open GitHub issues + PRs against project templates | A | GitHub triage skill IJFW lacks |
| gsd-ingest-docs | Bootstrap or merge `.planning/` from existing ADRs/PRDs/SPECs/docs | A | Cold-start migration tool IJFW lacks |
| gsd-manager | Interactive command center for multiple phases from one terminal | I | Adds coordination surface IJFW does not need |
| gsd-map-codebase | Parallel mapper agents → `.planning/codebase/` documents | A | Bigger / parallelized version of IJFW codebase index |
| gsd-milestone-summary | Comprehensive project summary from milestone artifacts | A | Onboarding-doc generation IJFW lacks |
| gsd-mvp-phase | Plan phase as vertical MVP slice (SPIDR splitting) | A | SPIDR splitting heuristic is a useful technique to fold in |
| gsd-new-milestone | Start new milestone cycle | D | IJFW workflow handles |
| gsd-new-project | Initialize new project w/ deep context + PROJECT.md | D | IJFW ijfw-workflow does the cold-start |
| gsd-ns-context | Namespace: map/graphify/docs/learnings | I | Pure router |
| gsd-ns-ideate | Namespace: explore/sketch/spike/spec/capture | I | Pure router |
| gsd-ns-manage | Namespace: workstreams/thread/update/ship/inbox | I | Pure router |
| gsd-ns-project | Namespace: milestones/audits/summary | I | Pure router |
| gsd-ns-review | Namespace: code review/debug/audit/security/eval/ui | I | Pure router |
| gsd-ns-workflow | Namespace: discuss/plan/execute/verify/phase/progress | I | Pure router |
| gsd-pause-work | Context handoff when pausing mid-phase | D | IJFW handoff |
| gsd-phase | CRUD for phases in ROADMAP.md (add/insert/remove/edit) | A | ROADMAP CRUD ops IJFW lacks as a skill |
| gsd-plan-phase | Detailed phase plan (PLAN.md) with verification loop | A | Self-verifying plan-phase — IJFW plan-phase is single-pass |
| gsd-plan-review-convergence | Cross-AI plan convergence loop — replan until no HIGH concerns | **A** | UNIQUE — deep-dive below |
| gsd-pr-branch | Create clean PR branch filtering out `.planning/` commits | **A** | Direct fit for IJFW (publish-to-public-without-planning-noise) |
| gsd-profile-user | Developer behavioral profile + Claude-discoverable artifacts | A | User-profiling for adapted behavior — interesting, low priority |
| gsd-progress | Unified situational command (check / advance / dispatch freeform intent) | A | One-skill-many-modes IJFW could consolidate around |
| gsd-quick | Execute quick task with atomic commits but skip optional agents | D | IJFW Quick mode |
| gsd-resume-work | Resume work from previous session w/ full context restoration | D | IJFW handoff resume |
| gsd-review | Cross-AI peer review of plans from external AI CLIs | **A** | See deep-dive — IJFW Trident is single-round |
| gsd-review-backlog | Review + promote backlog items to active milestone | A | Backlog-promotion workflow IJFW lacks |
| gsd-secure-phase | Retroactively verify threat mitigations for completed phase | D | IJFW has secure-phase analogue |
| gsd-settings | Configure workflow toggles + advanced knobs | D | IJFW config |
| gsd-ship | Create PR, run review, prep for merge | A | More structured than IJFW ijfw-ship |
| gsd-sketch | Sketch UI/design ideas with throwaway HTML mockups | I | UI-specific, lower priority |
| gsd-spec-phase | Clarify WHAT phase delivers w/ ambiguity scoring → SPEC.md | **A** | Ambiguity-scoring is a great upstream gate |
| gsd-spike | Spike idea through experiential exploration | A | "Spike" as first-class phase type |
| gsd-stats | Display project statistics (phases/plans/requirements/git/timeline) | A | Dashboard-style stats IJFW lacks |
| gsd-thread | Manage persistent context threads for cross-session work | A | Context-thread management; IJFW has memory but not explicit threads |
| gsd-ui-phase | Generate UI-SPEC.md design contract for frontend phases | A | Frontend-specific design contract |
| gsd-ui-review | Retroactive 6-pillar visual audit of frontend code | A | Visual audit skill |
| gsd-ultraplan-phase | BETA: offload plan phase to Claude Code's ultraplan cloud | I | Vendor-specific BETA |
| gsd-undo | Safe git revert using phase manifest w/ dependency checks | A | Phase-aware undo IJFW lacks |
| gsd-update | Update GSD to latest version w/ changelog display | D | IJFW ijfw-update |
| gsd-validate-phase | Retroactively audit + fill Nyquist validation gaps for completed phase | A | "Nyquist validation" concept — see specialist inventory |
| gsd-verify-work | Validate built features through conversational UAT | D | IJFW verify |
| gsd-workspace | Create/list/remove isolated workspace environments | A | Worktree management — see workspace deep-dive |
| gsd-workstreams | Manage parallel workstreams (list/create/switch/status/complete) | **A** | Persistent parallel-work tracking IJFW lacks |

**Verdict tally:** A=43, D=14, I=9. (Note: the A column is aspirational — most are low-priority. The bolded entries are the ones with deep-dives below.)

---

## Subagent inventory (33 specialists — compact role + tools table)

Tools shorthand: `R`=Read `W`=Write `E`=Edit `B`=Bash `G`=Grep `Gl`=Glob `Agt`=Agent (sub-dispatch) `Ctx7`=Context7 MCP `WF`=WebFetch.

| Agent | Role group | Tools (allowlist) | Verdict | IJFW gap? |
|---|---|---|---|---|
| gsd-advisor-researcher | Researcher | R W B G Gl | A | Yes — no general "advisor" researcher in IJFW |
| gsd-ai-researcher | Researcher (AI domain) | R W B G Gl + WF | A | Yes |
| gsd-assumptions-analyzer | Analyzer | R W B G Gl | **A** | Yes — surfaces hidden assumptions in plans |
| gsd-code-fixer | Fixer | R E W B G Gl | **A** | Yes — IJFW v1.4.4 N3 review.js is partial |
| gsd-code-reviewer | Reviewer | R W B G Gl | **A** | Partial — IJFW has reviewer skill, no dedicated subagent |
| gsd-codebase-mapper | Mapper | R W B G Gl | A | Yes — IJFW has codebase index, no mapper specialist |
| gsd-debug-session-manager | Orchestrator | R W B G Gl Agt | **A** | Yes — multi-cycle subagent loop, see deep-dive |
| gsd-debugger | Specialist | R E W B G Gl | **A** | Yes — fix-application subagent for debug loop |
| gsd-doc-classifier | Classifier | R G Gl | A | Yes — classifies docs for ingest |
| gsd-doc-synthesizer | Synthesizer | R W B | A | Yes — merges classified docs |
| gsd-doc-verifier | Verifier | R B G Gl | A | Yes — verifies generated docs vs codebase |
| gsd-doc-writer | Writer | R W E B | A | Yes — generates project docs |
| gsd-domain-researcher | Researcher (domain) | R W B G Gl + WF | A | Yes |
| gsd-eval-auditor | Auditor (AI evals) | R W B G Gl | **A** | Yes — AI eval coverage audit |
| gsd-eval-planner | Planner (AI evals) | R W B G Gl | A | Yes |
| gsd-executor | Executor | R W E B G Gl + Ctx7 | **A** | Partial — IJFW dispatcher lacks deviation rules + checkpoint contract |
| gsd-framework-selector | Selector | R W B G Gl + WF | A | Yes — picks framework given requirements |
| gsd-integration-checker | Checker | R B G Gl | A | Yes — checks API/integration boundaries |
| gsd-intel-updater | Updater | R W B + WF | A | Yes — refreshes domain intelligence cache |
| gsd-nyquist-auditor | Auditor (validation) | R W B G Gl | **A** | Yes — "Nyquist validation" — see notes |
| gsd-pattern-mapper | Mapper | R W B G Gl | A | Yes — maps recurring patterns across code |
| gsd-phase-researcher | Researcher (phase scope) | R W B G Gl | A | Yes |
| gsd-plan-checker | Checker | R W B G Gl | A | Yes — sanity-checks PLAN.md before execution |
| gsd-planner | Planner | R W B G Gl + Ctx7 | D | IJFW has planner skill |
| gsd-project-researcher | Researcher (project) | R W B G Gl | A | Yes |
| gsd-research-synthesizer | Synthesizer | R W B | A | Yes |
| gsd-roadmapper | Planner (roadmap) | R W E B G Gl | A | Yes — owns ROADMAP.md updates |
| gsd-security-auditor | Auditor (security) | R W B G Gl | A | Yes — IJFW has secure-phase skill, no dedicated subagent |
| gsd-ui-auditor | Auditor (UI) | R W B G Gl | A | Yes |
| gsd-ui-checker | Checker (UI) | R B G Gl | A | Yes |
| gsd-ui-researcher | Researcher (UI) | R W B G Gl + WF | A | Yes |
| gsd-user-profiler | Profiler | R W B G Gl | A | Yes — behavioral profile |
| gsd-verifier | Verifier | R W B G Gl | D | IJFW has verifier |

**The ~20 IJFW lacks (priority order):**

1. **gsd-executor** (priority 1 — deviation rules + checkpoint contract)
2. **gsd-code-reviewer + gsd-code-fixer** (priority 1 — closed-loop review)
3. **gsd-debug-session-manager + gsd-debugger** (priority 1 — multi-cycle loop)
4. **gsd-nyquist-auditor** (priority 2 — explicit validation-coverage check)
5. **gsd-security-auditor** (priority 2 — IJFW has skill, lacks specialist)
6. **gsd-eval-auditor + gsd-eval-planner** (priority 2 — AI eval coverage)
7. **gsd-assumptions-analyzer** (priority 2 — hidden-assumption surfacing)
8. **gsd-plan-checker** (priority 2 — pre-execution PLAN sanity check)
9. **gsd-roadmapper** (priority 3 — owns ROADMAP.md mutations)
10. **gsd-codebase-mapper** (priority 3 — parallelized codebase indexer)
11. **gsd-pattern-mapper** (priority 3 — recurring-pattern detector)
12. **gsd-integration-checker** (priority 3 — API/boundary checker)
13. **gsd-doc-classifier / doc-synthesizer / doc-verifier / doc-writer** (priority 3 — docs-update pipeline)
14. **gsd-ui-auditor / ui-checker / ui-researcher** (priority 3 — frontend specialists)
15. **gsd-domain-researcher / ai-researcher / phase-researcher / project-researcher / advisor-researcher** (priority 3 — research roster)
16. **gsd-research-synthesizer** (priority 3 — multi-researcher output merger)
17. **gsd-framework-selector** (priority 3 — tech-choice helper)
18. **gsd-intel-updater** (priority 3 — refreshes external intel cache)
19. **gsd-user-profiler** (priority 4 — behavioral profile)
20. **gsd-doc-classifier** (already counted above)

That is 19 distinct net-new specialists, matching the "15-20 GSD has that IJFW lacks" estimate in the audit brief.

**Observation on tool allowlists:** Researchers consistently include `WF` (WebFetch); verifiers/checkers consistently exclude `W`/`E` (read-only); only the executor + fixer + debugger get `E` (edit). Allowlists are uniformly tight — there is no equivalent of "give the agent everything" anti-pattern. IJFW should adopt this discipline.

---

## gsd-executor pattern (deep-dive — direct comparison to IJFW dispatch)

**File:** `~/.claude/agents/gsd-executor.md` (699 lines — the largest agent in GSD)
**Frontmatter tools allowlist:** `Read, Write, Edit, Bash, Grep, Glob, mcp__context7__*`
**Color:** yellow
**Spawned by:** `/gsd-execute-phase` orchestrator

### Structure (10 ordered sections)

1. `<role>` — single-sentence mission + mandatory-initial-read reference
2. `<documentation_lookup>` — Context7 MCP primary, `npx ctx7@latest` CLI fallback (because of upstream bug `anthropics/claude-code#13898` that strips MCP tools from tools-allowlisted agents)
3. `<project_context>` — reads `./CLAUDE.md` as hard constraints; CLAUDE.md takes precedence over plan instructions
4. `<execution_flow>` — load_project_state → load_plan → record_start_time → determine_execution_pattern → execute_tasks
5. `<deviation_rules>` — 4 rules with priority order and edge-case decision guide
6. `<analysis_paralysis_guard>` — 5-consecutive-reads-without-write → STOP
7. `<authentication_gates>` — auth errors are gates, not failures
8. `<auto_mode_detection>` — checks `_auto_chain_active` + `auto_advance` config
9. `<checkpoint_protocol>` + `<checkpoint_return_format>` — three checkpoint types
10. `<continuation_handling>` + `<tdd_execution>` + `<task_commit_protocol>` + `<destructive_git_prohibition>` + `<summary_creation>` + `<self_check>` + `<state_updates>` + `<final_commit>` + `<completion_format>` + `<success_criteria>`

### Status reporting contract (`<checkpoint_return_format>`)

```markdown
## CHECKPOINT REACHED
**Type:** [human-verify | decision | human-action]
**Plan:** {phase}-{plan}
**Progress:** {completed}/{total} tasks complete

### Completed Tasks
| Task | Name | Commit | Files |
| 1 | … | abc1234 | … |

### Current Task
**Task {N}:** [name]
**Status:** [blocked | awaiting verification | awaiting decision]
**Blocked by:** [specific blocker]

### Checkpoint Details
[Type-specific content]

### Awaiting
[What user needs to do/provide]
```

Three checkpoint types with explicit frequencies: **human-verify (90%)** — visual/functional verification after automation; **decision (9%)** — implementation choice needed; **human-action (1%)** — truly unavoidable manual step (email link, 2FA). Auth gates are a separate channel.

Final completion format is symmetric:

```markdown
## PLAN COMPLETE
**Plan:** {phase}-{plan}
**Tasks:** {completed}/{total}
**SUMMARY:** {path}
**Commits:**
- abc1234: {message}
**Duration:** {time}
```

### Atomic-commit discipline

7-step per-task commit protocol (lines 379-499):

- **0a. cwd-drift assertion** (worktree only) — captures spawn-time toplevel in `$WT_GIT_DIR/gsd-spawn-toplevel`, verifies on every subsequent commit; halts if drift detected. (Bug #3097)
- **0b. absolute-path safety** — Edit/Write absolute paths must resolve inside `git rev-parse --show-toplevel`, else FATAL. (Bug #3099)
- **0. pre-commit HEAD assertion** — refuses commit if HEAD is `main|master|develop|trunk|release/*` OR not in the `worktree-agent-*` namespace; **explicitly prohibits self-recovery via `git update-ref refs/heads/<protected>`**. (Bug #2924)
- **1. `git status --short`** to inspect modified files
- **2. Stage individually** — `git add path/to/file.ts`; **NEVER `git add .` or `git add -A`**
- **3. Commit type matrix** — `feat|fix|test|refactor|perf|docs|style|chore` (8 conventional-commit types)
- **4. Commit** via `gsd-sdk query commit-to-subrepo` for multi-repo OR plain `git commit -m` for single-repo
- **5. Record hash** — `TASK_COMMIT=$(git rev-parse --short HEAD)`; multi-repo extracts from JSON
- **6. Post-commit deletion check** — `git diff --diff-filter=D --name-only HEAD~1 HEAD`; WARN if commit deleted tracked files; unexpected deletions are Rule 1 (revert + fix)
- **7. Untracked-files check** — `git status --short | grep '^??'`; commit intentional, gitignore generated, never leave generated untracked

### Deviation rules (the central innovation)

| Rule | Trigger | Action | Permission |
|---|---|---|---|
| 1 — Auto-fix bugs | Broken behavior, errors, wrong output | Fix inline → update tests → verify → continue | **No** |
| 2 — Auto-add missing critical | Missing essential functionality (error handling, validation, auth, CSRF, indexes, logging) | Same inline-fix flow | **No** |
| 3 — Auto-fix blocking | Missing dep, wrong types, broken imports, env var, DB conn, build config | Same inline-fix flow | **No** |
| 4 — Ask architectural | New table, schema change, new service, switch library, breaking API | STOP → return checkpoint with: what found / proposed change / why / impact / alternatives | **Required** |

**Priority logic:**
1. Rule 4 applies → STOP
2. Rules 1-3 apply → fix automatically
3. Genuinely unsure → Rule 4 (ask)

**Hard caps:**
- **SCOPE BOUNDARY:** only auto-fix issues directly caused by current task's changes; pre-existing warnings out-of-scope → log to `deferred-items.md`
- **FIX ATTEMPT LIMIT:** track auto-fix attempts per task; after **3 attempts** STOP fixing, document in SUMMARY.md "Deferred Issues", continue, do NOT restart build hoping things resolve

The 3-attempt cap is the most actionable single rule I have seen — it directly maps to IJFW's S1 truncation work and gives the dispatcher a clean signal for "subagent is in a loop, abort."

### Checkpoint protocol (compare to IJFW v1.5.0 S1)

- **Three checkpoint types**: human-verify / decision / human-action
- **Auto-mode behavior** is explicit:
  - human-verify → auto-approve + log `⚡ Auto-approved: [what-built]`
  - decision → auto-select first option (planners are required to front-load the recommended choice) + log `⚡ Auto-selected: [option name]`
  - human-action → STOP (auth gates cannot be automated)
- **Continuation handling**: agent spawned with `<completed_tasks>` in prompt verifies prior commits exist, does NOT redo, starts from resume point, handles by type

IJFW v1.5.0 S1 (checkpoint protocol) appears to be the same idea, but GSD's three-type taxonomy with frequency annotations and auto-mode lookup is sharper. Recommend adopting verbatim.

### Self-check protocol (rare and worth duplicating)

After writing SUMMARY.md, before state updates:
1. `[ -f "path" ] && echo "FOUND" || echo "MISSING"` for every claimed file
2. `git log --oneline --all | grep -q "{hash}" && echo "FOUND" || echo "MISSING"` for every claimed commit
3. Append `## Self-Check: PASSED` or `## Self-Check: FAILED` (with missing items) to SUMMARY.md
4. Do NOT proceed to state updates if self-check fails

This is the **hallucination-detection check** for completion claims. IJFW S1 has nothing equivalent.

### State updates (via `gsd-sdk query` verbs)

```bash
gsd-sdk query state.advance-plan
gsd-sdk query state.update-progress
gsd-sdk query state.record-metric "$PHASE" "$PLAN" "$DURATION" "$TASK_COUNT" "$FILE_COUNT"
gsd-sdk query state.add-decision "$decision"
gsd-sdk query state.record-session "" "Completed $PHASE-$PLAN-PLAN.md" "None"
gsd-sdk query roadmap.update-plan-progress "$PHASE_NUMBER"
gsd-sdk query requirements.mark-complete $REQ_IDS
```

Every state mutation is a verb. The SDK enforces idempotency, edge-case handling, and consistency. IJFW could consolidate `.ijfw/state/*` writes behind a comparable `ijfw-sdk query state.*` namespace.

### Destructive-git prohibition (worth duplicating)

Explicit prohibition list:
- `git clean` (ANY flags — `-f`, `-fd`, `-fdx`, `-n`) — destroys files committed in feature branches the worktree branch has not seen
- `git rm` on files not created by current task
- `git checkout -- .` or `git restore .` (blanket resets)
- `git reset --hard` (except worktree branch-check at startup)
- `git update-ref refs/heads/<protected>` — absolute prohibition (#2924); halt + surface blocker if HEAD attached to protected branch
- `git push --force` to branches the agent did not create

This is a defensive perimeter built from real incident reports (#2075 c6f4753, #2924, #2839, #2990, #3097, #3099). IJFW does not currently have anything like it.

### IJFW gap summary (compared to current dispatch model)

| Capability | GSD | IJFW v1.5.0 |
|---|---|---|
| Tool allowlist | Yes (R/W/E/B/G/Gl + ctx7) | Yes (varies by specialist) |
| Atomic-per-task commits | Yes (7-step protocol) | Partial (dispatch wave commits) |
| Deviation classification | 4 rules + priority | None |
| Fix-attempt limit per task | 3 attempts | None — direct truncation cause |
| Checkpoint return format | 3-type structured | Partial (S1 in progress) |
| Continuation handling | Explicit (completed_tasks) | Partial |
| Self-check after SUMMARY | Yes | No |
| State via SDK verbs | Yes (`gsd-sdk query state.*`) | Partial (direct .ijfw/state writes) |
| Worktree safety guards (#3097, #3099, #2924) | Yes | Minimal |
| Destructive-git prohibition | Explicit list | Implicit |
| Analysis-paralysis guard | Yes | No |
| Auth-gate handling | First-class | Partial |

</content>
</invoke>