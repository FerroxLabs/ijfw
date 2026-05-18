# Cross-System Gap Matrix — IJFW v1.5.0 vs Superpowers 5.1.0 vs GSD 1.41.2

**Synthesizer:** R4 (final agent in 4-agent cross-system audit)
**Date:** 2026-05-18
**Inputs:** SUPERPOWERS-AUDIT.md (R1), GSD-AUDIT.md (R2), IJFW-CURRENT.md (R3)
**Audience:** v1.5.1 planning + v1.6.0 roadmap

---

## TL;DR

IJFW v1.5.0 is **strongest at cross-AI audit** (Phase E `runPhaseEAuto` is fully wired with INCONCLUSIVE-on-zero-productive logic, S7 per-auditor timeouts, and r14 PASS proof in production), **weakest at runtime enforcement of its own contracts** (parseAgentReport, handleStatus, reviewTask, checkVerificationGate are all imported by tests + markdown only — the "orchestrator" is the Claude session running the workflow skill, which is expected to obey the contracts by eye), and the **single biggest gap to close in v1.5.1 is the worktree → parent checkpoint visibility blindspot** — S1 shipped a real checkpoint contract but in canonical `isolation:'worktree'` dispatch mode, checkpoints land at `<worktree>/.ijfw/wave-<id>/…` and the parent's `listOrphanedSubagents` reads `<parent>/.ijfw/wave-<id>/` and finds nothing.

**Headline numbers:**
- **Specialist roster:** IJFW 13 / Superpowers ~0 (Superpowers ships SKILL.md files, not named subagent files) / GSD 33 — IJFW lacks ~19 distinct GSD specialists (executor, code-fixer, debug-session-manager, nyquist-auditor, plan-checker, assumptions-analyzer, doc-classifier/synthesizer/verifier/writer, 5x research roster, etc.)
- **Audit reach:** Trident is **single-shot** (one fan-out per Phase E call; iteration is LLM-orchestrated re-fire); `gsd-plan-review-convergence` is **iterative** with explicit `CYCLE_SUMMARY: current_high=N` contract, stall detection, and max-cycles cap; Superpowers has **no cross-AI audit at all**.
- **Truncation handling:** Only IJFW has it (v1.5.0 S1 checkpoint contract + telemetry); GSD's answer is bounded-budget (3-attempt fix cap per task + deviation rules); Superpowers has **zero** mention of token caps or commit-as-you-go. **But IJFW's S1 is worktree-blind** — closes the gap for shared-tree dispatch only.
- **Runtime enforcement:** IJFW = discipline-in-markdown (LLM-session-as-orchestrator); GSD = daemon-style state SDK (`gsd-sdk query state.*` verbs as the only mutation surface); Superpowers = SessionStart hook injects the meta-skill verbatim into the system prompt every session (force-load via JSON envelope).

---

## 8-dimension comparison matrix

| # | Dimension | IJFW v1.5.0 | Superpowers 5.1.0 | GSD 1.41.2 | IJFW gap rank |
|---|-----------|-------------|-------------------|------------|---------------|
| 1 | **Subagent dispatch** | 4-value status + parseAgentReport + freshness/branch-tuple verifier — defined in `status-protocol.js`, no runtime caller, LLM enforces by eye | 4-value status (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED) + 3 separate prompt files (implementer/spec-reviewer/code-quality) + explicit "Bad work is worse than no work" psychological-safety framing — single-tree (no parallel implementers) | `gsd-executor` agent with 10 ordered sections, 4 deviation rules (auto-fix bug / missing-critical / blocker / ask-architectural), 3-attempt fix cap, structured 3-type checkpoint return format, atomic 7-step per-task commit protocol, destructive-git deny-list with #2924/#3097/#3099 incident-driven guards | **2** — IJFW has the contract surface but neither GSD's wired-in executor agent with deviation rules nor Superpowers' adversarial implementer prompt. Worst at bounding subagent energy budget. |
| 2 | **Subagent recovery / truncation** | S1 checkpoint contract (recordCheckpoint, listOrphanedSubagents, checkpoint-cli.js wired into extension.js) + S5 checkpointWave rollup — but **worktree-blind**: checkpoints write to subagent's worktree, parent listOrphanedSubagents reads parent's `.ijfw/wave-<id>/` and finds nothing | **Zero truncation handling.** No checkpoints, no commit-as-you-go, no skeleton-first. Just BLOCKED ladder (more context → more capable model → smaller pieces → human) | No explicit checkpoint contract per se, but 3-attempt fix cap converts truncation from a behavior problem to a budget problem; gsd-debug-session-manager pattern keeps state in `.planning/debug/{slug}.md` across context resets; self-check protocol verifies file/commit existence after SUMMARY.md | **1** (worst) — IJFW shipped the most code on this dimension and is still the most broken at its own canonical dispatch mode. GSD's 3-attempt cap is a sharper conceptual answer; IJFW's S1 is field-untested. |
| 3 | **Code review pipeline** | Two-stage spec→quality via reviewTask in `review.js` with REVIEW_MAX_ITERATIONS=3 + injected `dispatch` callback + `spec-reviewer.md` + `quality-reviewer.md` prompts (PASS/FAIL + HIGH/MED/LOW severity) — defined, tested, **no runtime caller** in mcp-server/src/ | Strict spec→quality ordering hard rule ("Start code quality review before spec compliance is ✅ (wrong order)" = Never), adversarial framing ("implementer finished suspiciously quickly — do not trust the report"), git-SHA range diff scoping, binary spec verdict + 5-section quality verdict (Strengths/Critical/Important/Minor/Recommendations/Assessment), no iteration cap (weakness) | `gsd-code-reviewer` (read-only) + `gsd-code-fixer` (worktree-isolated edits) + 3-depth review (quick 5-regex / standard per-language matrix for 5 langs / deep import-graph) + 3-tier verification matrix (mandatory re-read / per-language syntax check / fallback) + recovery sentinel file + atomic per-finding commits + logic-bug flag ("requires human verification") + code-fence-aware parser + `--auto` iteration cap at 3 | **2** — IJFW has the right shape (separate spec/quality prompts, 3-iter cap, injected dispatch) but missing adversarial framing, per-language matrix, 3-tier verification, and most importantly: a runtime caller. GSD's worktree-isolated fixer with recovery sentinel is best-in-class. |
| 4 | **Plan → Execute workflow** | BRAINSTORM → PLAN → EXECUTE → VERIFY → SHIP → MEASURE ("Donahoe Loop") in 519-line workflow skill; Quick (5 moves) vs Deep (6 modules) auto-picker; wave dispatch via A1-DISPATCH block; design auto-fire if plan mentions UI; no separate SPEC.md gate — brief.md carries the spec role | `writing-plans` mandates 4-line header (Goal/Architecture/Tech Stack/Required sub-skill) + per-task checkbox steps (2-5 min each) + "tasks may be read out of order" framing + 3-axis plan self-review (spec coverage/placeholder scan/type consistency) + No Placeholders contract ("TBD"/"TODO"/"Similar to Task N" = plan failures); brainstorming HARD-GATE before any implementation skill | 9-state phase machine (discussing/discussed/planning/planned/executing/executed/verifying/verified/shipped) via `gsd-sdk query state.*` verbs; gsd-discuss-phase + gsd-spec-phase (ambiguity-scoring) + gsd-plan-phase (with internal plan-checker spawn) + gsd-execute-phase (wave-based, --wave/--gaps-only/--interactive flags) + `--reviews` flag to replan with feedback; pre-flight gate on every phase-scoped skill (`gsd-sdk query roadmap.get-phase`) | **3** — IJFW's auto-picker is a real DX win over GSD's "every project gets full process" and Superpowers' "every project regardless of perceived simplicity" — but IJFW lacks (a) explicit ambiguity-scored spec gate, (b) state-verb-namespace consolidation, (c) plan-checker pre-execution gate, (d) plan-self-review checklist. |
| 5 | **Verification gate** | `checkVerificationGate(message, toolCallsInMessage)` scans COMPLETION_PATTERNS (DONE/✅/all tests pass) without matching test/build Bash call → returns `{ok:false, violation}`; `recordViolation` appends JSONL; **no runtime caller** + **no host capturing per-message tool calls** + advisory-only by design | "Iron Law" framing: `NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE` + 5-step Gate Function (IDENTIFY/RUN/READ/VERIFY/ONLY THEN) + verbatim Common Failures table (8 rows) + Rationalization Prevention table + "Spirit over letter" anti-loophole framing — but it's a SKILL not a daemon, so still depends on agent discipline | gsd-executor self-check protocol after SUMMARY.md: `[ -f "path" ] && echo "FOUND"` for every claimed file + `git log --oneline --all | grep -q "{hash}"` for every claimed commit → appends `## Self-Check: PASSED/FAILED` to SUMMARY.md → does NOT proceed to state updates if failed | **2** — IJFW has the gate function; Superpowers has the prompt framing; GSD has the self-check execution. IJFW's gate is a pure function awaiting a host that doesn't exist. |
| 6 | **Debug loop** | 52-line `ijfw-debug` SKILL.md with 6-step protocol (Reproduce/Check changes/Isolate/Hypothesize/Fix+Verify/**Two-strikes session reset**) + SYMPTOM/ROOT CAUSE/FIX/VERIFIED/FOLLOW-UPS output format; no debug-state persistence, no specialist dispatch table | `systematic-debugging` 4-phase Iron Law (`NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST`) + Root Cause/Pattern/Hypothesis/Implementation + **3-fix architecture-question rule** (3+ failed fixes → STOP and question architecture, not fundamentals) + multi-component evidence-gathering template + partner-signals decoder ("Stop guessing" → STOP→Phase 1) | gsd-debug 3-layer pattern: `/gsd-debug` skill → `gsd-debug-session-manager` agent (isolated context, persistent `.planning/debug/{slug}.md`) → `gsd-debugger` agent (one cycle, structured return); 5 return-header types (ROOT CAUSE FOUND / TDD CHECKPOINT / DEBUG COMPLETE / CHECKPOINT REACHED / INVESTIGATION INCONCLUSIVE); specialist-dispatch table (10 hints → skills); DATA_START/DATA_END prompt-injection defense; falsifiability requirement | **1** (worst) — IJFW's debug skill is the thinnest of the three (52 lines vs Superpowers ~400+ vs GSD's 3-layer architecture). Missing: persistence across context resets, structured-return contract, specialist dispatch, falsifiability, multi-component evidence template, 3-fix architecture rule. |
| 7 | **Specialist roster** | 13 named agents (accessibility-eng, dep-audit, doc-verifier, doc-writer, e2e-runner, integration-checker, llm-budget-watcher, nyquist-auditor, pattern-mapper, plan-checker, ralph-loop-runner, release-eng, security-auditor) + 2 reviewer prompts (spec-reviewer.md, quality-reviewer.md) inside workflow skill | **~0 named subagent files**. Superpowers ships SKILL.md files only; the implementer/spec-reviewer/code-quality-reviewer "subagents" are prompt templates inside skills/, not standalone agent definitions. Cleaner for single-tree dispatch | 33 named agents across 8 role groups: Researcher (5: advisor/ai/domain/phase/project), Analyzer (1: assumptions), Fixer (1: code-fixer), Reviewer (1: code-reviewer), Mapper (3: codebase/pattern/research-synthesizer), Orchestrator (1: debug-session-manager), Specialist (1: debugger), Classifier/Synthesizer/Verifier/Writer (4: doc-*), Auditor (4: eval/nyquist/security/ui), Executor (1), Selector (1: framework), Checker (3: integration/plan/ui), Updater (1: intel), Planner (1), Profiler (1: user), Roadmapper (1), Verifier (1) | **2** — IJFW's 13 cover audit/verify/ship/coverage strongly but lack: codebase-mapper (real mapping skill, not just pattern detector), assumptions-analyzer, debug-session-manager, doc-pipeline quartet (classifier/synthesizer/verifier/writer), 5-agent research roster, framework-selector, ui-auditor (6-pillar visual), extract-learnings, milestone-summary. |
| 8 | **Cross-AI audit** | Phase E / Trident: `runPhaseEAuto` fully wired (roster → reachability probe → fan-out with per-auditor timeoutMs → INCONCLUSIVE on zero productive); 9-entry roster (codex/gemini/qwen/deepseek/kimi/opencode/aider/copilot/claude); diversity-strategy picker; CLI + API fallback per auditor; r14 PASS in production; **single-shot per phase** — iteration is LLM-orchestrated re-fire; F5 audit-rotation schema declared but no runtime consumer | **None.** Superpowers has no cross-AI audit primitive. Closest is `requesting-code-review` which dispatches one reviewer subagent with git SHA range — but it's same-model, same-session | `gsd-plan-review-convergence` iterative loop: spawns `gsd-review` (7 reviewers including 3 local-model: ollama/lm-studio/llama-cpp) → CYCLE_SUMMARY: current_high=N contract (PARTIALLY_RESOLVED vs FULLY_RESOLVED taxonomy) → replan via `gsd-plan-phase --reviews` → loop until HIGH=0 or max_cycles → stall detection (HIGH_COUNT >= prev) | **3** — IJFW wins on roster breadth (9 entries incl. OSS lineages) and production-proven wiring, but loses on iteration. GSD's CYCLE_SUMMARY convergence contract is the missing piece. |

**Rank scale:** 1 = IJFW is worst on this dimension (closest to broken / furthest from parity). 5 = IJFW is at or above parity.

**Aggregate:** IJFW averages **2.0** across 8 dimensions. Strongest at #8 (cross-AI audit, rank 3); weakest at #2 and #6 (subagent recovery, debug loop — both rank 1).

---

## Top 10 ranked backlog items (v1.5.1+)

Ranked by **gap severity × adoption cost ratio**. ID prefix `v151-S` indicates "synthesis item" (vs. existing S-series in v1.5.0 handoff).

### v151-S01 — Worktree → parent checkpoint visibility fix

- **Source pattern:** R3 (IJFW-CURRENT) — top single gap, "load-bearing for v1.6.0 planning"
- **Estimated cost:** 3-5 dev-days
- **Concrete file changes:**
  - `mcp-server/src/dispatch/checkpoint-cli.js` — when `process.env.IJFW_PARENT_PROJECT_ROOT` is set, resolve checkpoint path against parent, not `process.cwd()`
  - `mcp-server/src/dispatch/extension.js` — when spawning `Agent({ isolation: 'worktree' })`, pass `IJFW_PARENT_PROJECT_ROOT=<parent>` in env
  - `mcp-server/src/orchestrator/subagent-telemetry.js` — `listOrphanedSubagents` accepts optional `additionalRoots: string[]` and reads checkpoints from all worktree paths in `git worktree list --porcelain` before cleanup runs
  - `mcp-server/src/dispatch/wave-cli.js` (or wherever `ijfw swarm worktree cleanup` lives) — add `drainCheckpoints(taskId)` pre-step that copies any `<worktree>/.ijfw/wave-<id>/*.checkpoint.json` to parent before `git worktree remove`
  - `mcp-server/src/orchestrator/checkpoint-contract.md` — add "Worktree isolation drain protocol" section
  - Test: `mcp-server/test-orchestrator-subagent-telemetry-worktree.js` — e2e test: spawn worktree subagent → write checkpoint → cleanup → assert parent sees checkpoint
- **Verdict:** **ADAPT** (env-var passthrough + drain-before-cleanup)
- **Why this rank:** This is R3's #1 honest finding. S1 was sized to close the 62% truncation rate but currently doesn't fire in the canonical dispatch mode. Without this, S1 is shelfware. Highest-leverage single item in the backlog.

### v151-S02 — Discipline-in-markdown → wired-in-code runtime loop

- **Source pattern:** R3 (IJFW-CURRENT) — "no runtime caller" finding across S3, S5, F6, N2, N3, N5
- **Estimated cost:** 4-6 dev-days
- **Concrete file changes:**
  - New: `mcp-server/src/orchestrator/runtime-loop.js` — exports `reviewSubagentReport(reportText, ctx)` that internally calls `parseAgentReport` → `handleStatus` → `verifyFreshCommit` → returns route decision
  - New: `mcp-server/src/orchestrator/post-done-runner.js` — exports `runPostDone({ taskId, taskSpec, commitSha, branch, dispatch })` that internally calls `reviewTask` (two-stage) → `checkVerificationGate` on the final message → returns `{ verdict, violations }`
  - New MCP tools: `ijfw_review_subagent_report` + `ijfw_run_post_done` in `mcp-server/src/server.js` — exposes the runtime loop as callable tools the orchestrator-LLM MUST invoke (with cheap test-side fakes)
  - `claude/skills/ijfw-workflow/SKILL.md` (lines 240-330) — replace "the orchestrator runs … reviewTask" prose with explicit "call `ijfw_run_post_done` with `taskId / commitSha / branch`" instructions
  - Test: `mcp-server/test-orchestrator-runtime-loop.js` + `mcp-server/test-orchestrator-post-done-runner.js`
- **Verdict:** **ADAPT** (wrap existing functions in MCP-callable tools, force orchestrator-LLM to invoke them via concrete tool calls rather than mental imports)
- **Why this rank:** This converts the entire `mcp-server/src/orchestrator/*.js` library from aspirational to invocable. Without this, ~6 v1.4.4/v1.5.0 features are advisory-of-nothing.

### v151-S03 — GSD deviation rules + 3-attempt fix cap

- **Source pattern:** R2 (GSD-AUDIT) — "the one pattern that changes the roadmap"
- **Estimated cost:** 1-2 dev-days
- **Concrete file changes:**
  - `claude/agents/ijfw-executor.md` — NEW agent (currently no IJFW executor agent), modeled on `gsd-executor.md`'s 4-rule taxonomy: (1) auto-fix bug, (2) auto-add missing critical, (3) auto-fix blocker, (4) ASK on architectural change
  - Embed scope boundary: "only auto-fix issues directly caused by current task's changes; pre-existing → log to `deferred-items.md`"
  - Embed 3-attempt fix-cap: track per-task auto-fix attempt counter; after 3 → STOP, document in SUMMARY, continue to next task, do NOT restart build
  - `claude/skills/ijfw-workflow/lib/dispatch-helpers.md` — append "Deviation rules" + "Fix-attempt budget" sections to implementer prompt template
  - `mcp-server/src/orchestrator/status-protocol.js` — new status sub-field `Attempts:` in parseAgentReport; handleStatus routes Attempts>=3 to `escalate_to_user`
- **Verdict:** **DUPLICATE** (verbatim adoption of GSD's taxonomy + cap)
- **Why this rank:** Converts truncation from behavior problem to budget problem. Cheapest big-impact item. R2 explicitly says this should land in v1.5.0 S1 immediately, not wait.

### v151-S04 — Superpowers description-as-trigger CSO discipline

- **Source pattern:** R1 (SUPERPOWERS-AUDIT) — recommendation #5, highest-leverage 20-line fix
- **Estimated cost:** 0.5 dev-day
- **Concrete file changes:**
  - `claude/skills/ijfw-workflow/SKILL.md` (frontmatter `description:`) — strip the current workflow summary ("Quick mode (fast brainstorm, ~5 min) or Deep mode … Auto-picks based on task size") and replace with pure "Use when..." trigger
  - `claude/skills/ijfw-plan/SKILL.md`, `ijfw-execute/SKILL.md`, `ijfw-debug/SKILL.md`, `ijfw-ship/SKILL.md`, `ijfw-verify/SKILL.md`, `ijfw-design/SKILL.md`, `ijfw-commit/SKILL.md`, `ijfw-recall/SKILL.md`, `ijfw-summarize/SKILL.md`, `ijfw-critique/SKILL.md` — same treatment
  - `scripts/lint/check-skill-descriptions.sh` — NEW lint: reject any SKILL.md frontmatter `description:` over 1024 chars OR containing workflow keywords (steps, phases, modes)
- **Verdict:** **DUPLICATE** (verbatim CSO discipline from Superpowers' `writing-skills`)
- **Why this rank:** Highest-impact 20-line fix in the whole backlog. Superpowers' testing showed workflow-summary descriptions cause Claude to follow the description shortcut and skip the skill body — IJFW skills may currently be partially loaded. Lowest cost, biggest behavioral leverage.

### v151-S05 — Spec→quality strict ordering with adversarial framing

- **Source pattern:** R1 (SUPERPOWERS-AUDIT) — recommendation #1, HIGH impact / LOW cost
- **Estimated cost:** 1-2 dev-days
- **Concrete file changes:**
  - `claude/skills/ijfw-workflow/prompts/spec-reviewer.md` — prepend Superpowers' verbatim adversarial preamble: "## CRITICAL: Do Not Trust the Report — The implementer finished suspiciously quickly. Their report may be incomplete, inaccurate, or optimistic. You MUST verify everything independently." + DO / DO NOT lists + 3 failure modes (Missing requirements / Extra unneeded work / Misunderstandings)
  - `claude/skills/ijfw-workflow/prompts/quality-reviewer.md` — restructure to 5-section verdict (Strengths / Critical / Important / Minor / Recommendations / Assessment with Ready-to-merge Yes/No/With-fixes)
  - Both prompts: add git-SHA range diff scoping (`BASE_SHA=$(git rev-parse HEAD~1)` … `git diff {BASE_SHA}..{HEAD_SHA}`)
  - `mcp-server/src/orchestrator/review.js` — already enforces spec-PASS-gates-quality; add explicit `Never` rule violation log if stage-2 dispatched without stage-1 PASS
- **Verdict:** **ADAPT** (Superpowers' framing + GSD's per-finding `file:line, issue, fix` structure)
- **Why this rank:** Two-stage review already exists; this is a prompt-level hardening that produces sharper findings. Pairs naturally with v151-S02 (which makes it actually fire).

### v151-S06 — GSD plan-review-convergence iterative loop

- **Source pattern:** R2 (GSD-AUDIT) — "likely IJFW's single biggest competitive gap"
- **Estimated cost:** 3-5 dev-days
- **Concrete file changes:**
  - `mcp-server/src/cross-orchestrator.js` — new function `runPhaseEConverge({ phase, maxCycles=3, threshold='high', dispatch })` that wraps `runPhaseEAuto` in a loop
  - Adopt CYCLE_SUMMARY contract verbatim: each auditor's prompt template (in `claude/skills/ijfw-workflow/prompts/`) must include "End with `CYCLE_SUMMARY: current_high=<N>` + `## Current HIGH Concerns` section (bulleted, or `None.`)"
  - Stall detection: if `HIGH_COUNT >= prev_high_count`, log warning but continue to max_cycles
  - Replan trigger: between cycles, if HIGH > 0, write findings to `.planning/<phase>/REVIEWS-r<N>.md`, dispatch ijfw-plan to replan with `--reviews` flag
  - New MCP tool: `ijfw_cross_audit_converge` exposed via `server.js`
  - `claude/skills/ijfw-workflow/SKILL.md` — replace Phase E single-shot description with auto-converge protocol (still LLM can opt-out via `skip cross-audit`)
- **Verdict:** **DUPLICATE** (verbatim CYCLE_SUMMARY contract, IJFW-specific roster wiring)
- **Why this rank:** Closes the biggest functional gap between IJFW Trident and GSD's review pipeline. Single-shot Trident in production has been re-fired manually r1→r14 during v1.5.0 dev; codifying that loop saves human attention and adds stall detection.

### v151-S07 — GSD code-fixer 3-tier verification matrix + recovery sentinel

- **Source pattern:** R2 (GSD-AUDIT) — priorities #4 and #5 (3-tier verification + recovery sentinel)
- **Estimated cost:** 2-3 dev-days
- **Concrete file changes:**
  - New: `claude/agents/ijfw-code-fixer.md` (worktree-isolated edits agent, modeled on `gsd-code-fixer.md`)
  - `mcp-server/src/orchestrator/review.js` — when reviewer returns issues + `--fix` flag, dispatch ijfw-code-fixer agent into worktree
  - Recovery sentinel: write `.planning/<phase>/.review-fix-recovery-pending.json` BEFORE `git worktree remove`, delete AFTER successful removal — sentinel discoverable on next run for crash-safe cleanup
  - 3-tier verification: per-fix Tier 1 (re-read modified file section) mandatory, Tier 2 per-language syntax check (`node -c`, `npx tsc --noEmit`, `python -c "import ast"`), Tier 3 fallback to Tier 1
  - Logic-bug flag: if fix is classified as logic (not syntax), commit status = `"fixed: requires human verification"`
  - Atomic per-finding commits, conventional format `fix({phase}): {finding_id} {desc}`
  - Test: `mcp-server/test-orchestrator-code-fixer-worktree.js` + crash-recovery test
- **Verdict:** **ADAPT** (verbatim GSD pattern)
- **Why this rank:** Closes the "review finds things, nothing fixes them" gap. Pairs with v151-S05 (better reviews) + v151-S01 (worktree visibility). Recovery sentinel is also general — could be reused for swarm worktree cleanup.

### v151-S08 — GSD debug-session-manager 3-layer isolation

- **Source pattern:** R2 (GSD-AUDIT) — priority #7
- **Estimated cost:** 3-4 dev-days
- **Concrete file changes:**
  - New: `claude/agents/ijfw-debug-session-manager.md` (orchestrator-side, persistent context across resets)
  - New: `claude/agents/ijfw-debugger.md` (one-cycle investigator)
  - `claude/skills/ijfw-debug/SKILL.md` — restructure as thin dispatch to session-manager (current 52-line in-skill protocol becomes the session-manager's instructions)
  - Persistent state: `.ijfw/debug/<slug>.md` — session survives context resets; `ijfw debug continue <slug>` + `ijfw debug list` resumes/lists
  - 5 structured return-header types: `## ROOT CAUSE FOUND` / `## TDD CHECKPOINT` / `## DEBUG COMPLETE` / `## CHECKPOINT REACHED` / `## INVESTIGATION INCONCLUSIVE`
  - DATA_START/DATA_END prompt-injection defense: wrap user-supplied bug-report content in markers; both manager and debugger agents have `<security_context>` block declaring data-not-instructions
  - Falsifiability requirement in debugger prompt
  - Specialist dispatch table (typescript/react/swift/python/go/rust/ios/android/general → existing IJFW agents where they exist)
  - New MCP tool: `ijfw_debug_session_start|continue|list`
- **Verdict:** **ADAPT** (3-layer pattern + DATA_START/END + falsifiability)
- **Why this rank:** IJFW debug is currently the thinnest skill of the three systems. Multi-cycle persistence + structured-header contract + prompt-injection defense are all missing.

### v151-S09 — Consolidate state writes behind ijfw-sdk verb namespace

- **Source pattern:** R2 (GSD-AUDIT) — priority #8 ("STATE machine driven by gsd-sdk query verbs")
- **Estimated cost:** 2-3 dev-days
- **Concrete file changes:**
  - New: `mcp-server/src/state-sdk.js` exporting a single `query(verb, ...args)` dispatcher
  - Verb namespace: `state.advance-phase`, `state.update-progress`, `state.add-decision`, `state.record-session`, `state.record-metric`, `state.record-checkpoint`, `state.add-violation`, `state.add-extension`
  - Refactor all callers of `.ijfw/state/workflow.json`, `.ijfw/memory/verification-violations.jsonl`, `.ijfw/wave-*/`, `.ijfw/active-extension.json` to route through `state-sdk.query`
  - Idempotency: every verb is safe to call N times with same args (key by timestamp + verb + payload hash)
  - New CLI bin: `bin/ijfw-state` exposing the verbs (so external tools / scripts can mutate state without writing JSON by hand)
  - Test: `mcp-server/test-state-sdk.js` — all verbs idempotent + concurrent-write safe
- **Verdict:** **DUPLICATE** (GSD's `gsd-sdk query` pattern)
- **Why this rank:** Currently `.ijfw/state/*` writes are scattered across `dispatch-planner.js`, `agents-md-blackboard.js`, `subagent-telemetry.js`, `verification-gate.js`. Consolidating before v1.6.0 prevents drift. Modest cost, big maintainability win.

### v151-S10 — Top 5 GSD specialists IJFW lacks

- **Source pattern:** R2 (GSD-AUDIT) — priority #9 (5 priority specialists)
- **Estimated cost:** 3-5 dev-days (1 day per agent, picking the 5 highest-leverage)
- **Concrete file changes:**
  - `claude/agents/ijfw-assumptions-analyzer.md` — surfaces hidden assumptions in brief/plan before EXECUTE
  - `claude/agents/ijfw-codebase-mapper.md` — produces `.planning/codebase/*.md` documents via parallel mapping subagents (not just pattern detection like current `ijfw-pattern-mapper`)
  - `claude/agents/ijfw-extract-learnings.md` — post-phase mining: decisions/lessons/patterns/surprises → memory entries
  - `claude/agents/ijfw-discuss-phase.md` — adaptive questioning specialist that consults prior brief.md decisions and skips already-resolved gray areas
  - `claude/agents/ijfw-eval-auditor.md` — AI eval coverage audit for AI-integration phases
  - Each frontmatter follows the v151-S04 "Use when..." trigger discipline
- **Verdict:** **ADAPT** (selectively, not the full 19-agent gap — pick the 5 with highest orthogonality to existing roster)
- **Why this rank:** Lower-impact than runtime-wiring fixes (S01-S03), but high-leverage for cross-project ergonomics. Defer the other 14 GSD specialists (doc-pipeline quartet, 5-agent research roster, framework-selector, ui-checker, etc.) to v1.6.0 or never.

### Summary by impact × cost

| Rank | ID | Source | Cost | Impact | Verdict |
|------|-----|--------|------|--------|---------|
| 1 | S01 | R3 | 3-5d | CRITICAL — closes S1 in canonical mode | ADAPT |
| 2 | S02 | R3 | 4-6d | CRITICAL — converts 6 features from advisory to wired | ADAPT |
| 3 | S03 | R2 | 1-2d | HIGH — truncation as budget problem | DUPLICATE |
| 4 | S04 | R1 | 0.5d | HIGH — fixes possible skill-body skipping | DUPLICATE |
| 5 | S05 | R1 | 1-2d | HIGH — sharper reviewer findings | ADAPT |
| 6 | S06 | R2 | 3-5d | HIGH — closes Trident single-shot | DUPLICATE |
| 7 | S07 | R2 | 2-3d | MEDIUM — review→fix loop completion | ADAPT |
| 8 | S08 | R2 | 3-4d | MEDIUM — debug persistence + injection defense | ADAPT |
| 9 | S09 | R2 | 2-3d | MEDIUM — maintainability + scriptability | DUPLICATE |
| 10 | S10 | R2 | 3-5d | MEDIUM — cross-project ergonomics | ADAPT |

**Total backlog:** 23-40 dev-days.

---

## Anti-patterns to AVOID adopting

### From Superpowers

1. **DO NOT regress to single-tree dispatch.** `subagent-driven-development` runs ALL subagents in the controller's tree and explicitly forbids parallel implementers ("Dispatch multiple implementation subagents in parallel (conflicts)" = Never). IJFW's `Agent({ isolation: 'worktree' })` per dispatched agent is strictly better. R1 says this verbatim. The worktree-blindness fix (v151-S01) repairs IJFW's S1; reverting to single-tree to dodge the bug would lose the parallelism. **Stay worktree-isolated.**
2. **DO NOT adopt graphviz `dot` decision trees inside SKILL.md.** Cute for Claude Code but unparseable for the other 7 platforms IJFW ships to (codex, gemini, cursor, windsurf, copilot, hermes, wayland). IJFW's plain-prose convention serves all 8 platforms; graphviz would split the codebase.
3. **DO NOT adopt "every project gets full process" rigor.** Superpowers' `brainstorming` skill HARD-GATEs even a config change through the full 9-step process. IJFW's Quick/Deep mode auto-picker is strictly better DX — Sutherland-style "smarter not slower" wins. Keep auto-picker; do not bolt the GATE on Quick mode.

### From GSD

1. **DO NOT adopt the 66-skill / 33-agent surface area.** GSD's "everything is a skill" approach has produced 6 namespace-router skills (`gsd-ns-context`, `gsd-ns-ideate`, `gsd-ns-manage`, `gsd-ns-project`, `gsd-ns-review`, `gsd-ns-workflow`) that exist mainly to redirect to other skills. IJFW's `ijfw:ijfw` command-index pattern is leaner. Cap IJFW at ~25 skills / ~20 specialists max. Pick the 5 highest-leverage GSD agents (v151-S10), defer the other 14.
2. **DO NOT adopt `gsd-manager` interactive command center.** Adds a coordination surface for a problem IJFW does not have. IJFW's dispatch-parallel-agents pattern + wave-CLI already covers this. R2 flags it as IGNORE.
3. **DO NOT adopt Node 22+ engine requirement.** GSD locks out users on older runtimes. IJFW supports Node 18+ — keep it. The two-runtime-deps discipline (`better-sqlite3` + `@modelcontextprotocol/sdk`) is fine; do not chase GSD's `@anthropic-ai/claude-agent-sdk` dependency which is Anthropic-specific.

---

## v1.5.1 vs v1.6.0 split

### v1.5.1 — "Wired-in Honesty" (~10-14 dev-days budget)

Tightest, highest-leverage. Focus: **make IJFW honest about what its code actually does**. Every item in v1.5.1 closes a "spec ≠ runtime" gap or a "broken in canonical mode" gap.

| Order | ID | Cost | Why this milestone |
|-------|-----|------|---------------------|
| 1 | **v151-S04** | 0.5d | Cheapest, highest behavioral leverage. Land first. |
| 2 | **v151-S01** | 3-5d | Closes S1's worktree blindspot — without this, S1 is shelfware. Cannot ship v1.5.1 without it. |
| 3 | **v151-S03** | 1-2d | 3-attempt fix cap + deviation rules turn truncation into a budget problem. R2 says "fold into v1.5.0 S1 immediately." |
| 4 | **v151-S05** | 1-2d | Adversarial reviewer framing is prompt-level only; ships independently of S02. |
| 5 | **v151-S02** | 4-6d | Runtime-loop MCP tools that the orchestrator-LLM MUST call. Foundational for v1.6.0 items. |

**v1.5.1 total: 9.5-15.5 dev-days.** Calls v1.5.1 "Runtime Honesty Completion" — closes the discipline-in-markdown gap.

### v1.6.0 — "Convergence + Specialist Roster" (~20-30 dev-days budget)

Bigger structural changes. Focus: **make IJFW iterative + extend the specialist surface area** in ways that depend on v1.5.1's runtime-wiring foundation.

| Order | ID | Cost | Why this milestone |
|-------|-----|------|---------------------|
| 6 | **v151-S06** | 3-5d | CYCLE_SUMMARY convergence loop — depends on v151-S02's MCP tool surface |
| 7 | **v151-S07** | 2-3d | Code-fixer with recovery sentinel — pairs with v151-S05 + v151-S01 |
| 8 | **v151-S08** | 3-4d | Debug-session-manager — depends on v151-S09's state-SDK for persistence |
| 9 | **v151-S09** | 2-3d | State-verb namespace consolidation — refactor stable enough to require runtime tests |
| 10 | **v151-S10** | 3-5d | Top 5 specialists — depends on v151-S04's frontmatter discipline being landed |

**v1.6.0 total: 13-20 dev-days.** Plus a buffer for inevitable F-series follow-ups (Trident convergence will surface integration friction; debug-session-manager will surface MCP tool gaps).

**v1.6.0 plus reserve: ~20-30 dev-days.**

---

## Where we fucked up (honesty section)

The user asked: "find out where we fucked up, where we need to improve, where we need to strengthen, and what we need to adapt." Below is the honest reckoning across v1.4.x and v1.5.0, written with the benefit of this three-agent audit.

### 1. The "orchestrator is the LLM session" assumption was never written down

The single most consequential drift in IJFW is that every v1.4.4 N-series feature (N2 status protocol, N3 review.js, N5 verification-gate.js) and most v1.5.0 S-series features (S1 checkpoint contract, S3 freshness check, S5 checkpointWave rollup) were shipped as JS modules with unit tests but **no production caller in the JS codebase**. The implicit assumption was always: "the Claude session running ijfw-workflow is the orchestrator — it will read the skill, import the function mentally, and call it." That assumption never appeared in a CLAUDE.md, design doc, or DESIGN.md. It became architecturally load-bearing without ever being explicit, and the result is that ~6 features ship as advisory-of-nothing. R3 calls this out repeatedly: "the orchestrator is the LLM session, not the JS module." We need to either make the LLM-as-orchestrator pattern explicit (and design around it) or invert it — expose every contract function as an MCP tool the orchestrator-LLM MUST call (v151-S02's path).

### 2. v1.4.4 N3 review.js exists but was never called — wrong abstraction

We built `reviewTask` with an injected `dispatch` callback so we could test it without a live Agent tool. That was good engineering for the test surface. We then shipped it and assumed the workflow skill would describe "the orchestrator runs reviewTask after DONE" and the orchestrator would do it. Eight months later, `grep -rn "reviewTask"` returns the definition file and nothing else. The abstraction (function-with-injected-dispatch) was correct; the deployment surface (markdown prose telling an LLM session to invoke it) was wrong. Same pattern repeats with `parseAgentReport`, `handleStatus`, `checkVerificationGate`. We mistook unit-testability for production-readiness.

### 3. v1.5.0 S1 checkpoint contract has the worktree blindspot — tested but not field-validated

S1 shipped with `recordCheckpoint` + `listOrphanedSubagents` + atomic FS-lock writes + 4 KB max size + WAVE_ID_PATTERN / SUB_ID_PATTERN traversal hardening + a 94-line frozen contract document. All of that is real. What we never tested end-to-end was the dispatch mode it was sized to close: `Agent({ isolation: 'worktree' })`. The subagent in a worktree writes its checkpoint to its own `.ijfw/wave-<id>/`; the parent orchestrator reads the parent's `.ijfw/wave-<id>/` and finds nothing; after worktree cleanup the checkpoint is gone. We have a checkpoint contract that closes the 62% truncation rate for **shared-tree dispatch** (a mode we explicitly call non-canonical) and not for worktree dispatch (canonical). The fix is small (env-var passthrough + drain-before-cleanup, ~3-5 days). The lesson is bigger: feature acceptance for v1.5.0 needed to include "demonstrate it firing in the canonical dispatch mode," not just "1428/1428 tests pass."

### 4. v1.5.0 N6 5-specialists were picked from build-pain, not from cross-system comparison

We added accessibility-eng, dep-audit, doc-verifier, e2e-runner, integration-checker, nyquist-auditor, pattern-mapper, security-auditor across v1.4.4 W10-A3 and v1.5.0 W11-D1 because we kept hitting recurring failure modes in our own waves. That's a fine heuristic. What we never did was compare the roster against existing GSD specialists or Superpowers patterns. R2's audit shows we re-invented some wheels (nyquist-auditor, security-auditor have direct GSD analogues) while missing high-leverage agents we didn't think to build (assumptions-analyzer, debug-session-manager, codebase-mapper, extract-learnings). Roster expansion needs an explicit "what does the field do?" gate, not just "what hurt this week?" v151-S10 codifies the top 5 missing.

### 5. Trident shipped as single-shot when the iteration discipline already existed in our own dev cycle

We ran Phase E r1 → r14 during v1.5.0 development. The pattern was: fan out, find HIGH, fix, re-fan-out, repeat until 0 HIGH or 2-of-3 productive PASS. That IS gsd-plan-review-convergence's CYCLE_SUMMARY contract — we just never automated it. Every cycle was a human (or LLM-session) re-firing `runCrossOp({ mode: 'phase-e-auto' })` by hand and reading r1 vs r2 by eye. R2 calls this out: "iteration is LLM-orchestrated, not auto-converged." We had the empirical loop; we never made it a first-class primitive. v151-S06 fixes by adopting CYCLE_SUMMARY verbatim.

### 6. We didn't audit our skill descriptions against Superpowers' description-as-trigger rule until R1 read it

R1's audit caught that current IJFW skill descriptions (visible in this very session's reminder block) summarize workflow ("Quick mode (fast brainstorm, ~5 min) or Deep mode … Auto-picks based on task size"). Superpowers' testing showed workflow-summary descriptions cause Claude to follow the description shortcut and skip the skill body. We may have been shipping partially-loaded skills for months and never noticed. v151-S04 is a 20-line frontmatter fix that could be the biggest single behavioral leverage in the whole backlog. The deeper lesson: we never set up a "compare against best-in-class" gate during release. R2 + R3 confirm there are 10+ such cheap wins (analysis-paralysis guard, destructive-git deny-list, self-check protocol, DATA_START/END injection defense) we missed because we built in isolation.

---

## Closing recommendation

**v1.5.1 should commit to one thing: "Runtime Honesty Completion."** Scope = the 5 items above (v151-S04, S01, S03, S05, S02 in landing order), 10-14 dev-days. The no-half-shipping boundary is: **every wired-in feature must have a runtime caller in the JS codebase OR be invoked as an MCP tool the orchestrator-LLM is required by skill text to call.** If a v1.4.4 N-series or v1.5.0 S-series feature cannot meet that bar, it gets either (a) wired up in v1.5.1, (b) explicitly demoted to "advisory library, not enforced" in the docs, or (c) deleted. No more "ships as code, ships as test, ships as markdown — but never fires." That violates the v1.4.0 lesson ("no half-shipping") and Trident r14 cannot save us from a feature that never runs. v1.6.0 then earns the right to add convergence + specialists on top of a runtime-honest foundation.



