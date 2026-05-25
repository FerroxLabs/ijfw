---
name: ijfw-workflow
description: "Use when the user says: 'build', 'create', 'plan', 'new project', 'brainstorm', 'design', 'UI', 'website', 'dashboard', 'app', 'help me build', 'launch', 'book', 'campaign', or anything project-level. Skill body decides Quick vs Deep path."
context: fork
model: sonnet
---

# IJFW Workflow

Two modes, same principles, same invariants.

- **Quick** -- 5 moves, 3-5 minutes, locked brief. For features, fixes, ideas.
- **Deep** -- 6 required modules + 3 optional, 20-45 minutes. For new projects, major refactors, launches.

```
Donahoe Loop: BRAINSTORM -> PLAN -> EXECUTE -> VERIFY -> SHIP -> MEASURE
              |<--- memory recall at every entry --->|
              |<--- Trident cross-audit on request --->|
```

> **Detailed downstream procedure** (PLAN / EXECUTE / VERIFY / SHIP, including wave dispatch, post-DONE pipeline, Phase-E cross-audit): see `references/post-brainstorm-workflow.md`.
> **Deep-mode optional modules** (EXTERNAL BRIEF / ANTI-SCOPE / TRIDENT CROSS-CRITIQUE): see `references/deep-mode-optional.md`.

## RUNTIME BOOTSTRAP AND FALLBACKS

Before the first workflow write or command invocation, inspect whether `.ijfw/memory/` exists so the auto-picker and empty-state opener can use that signal accurately. Then ensure `.ijfw/memory/` and `.planning/` exist before writing artifacts. If the `ijfw` CLI is unavailable in this session, continue with markdown files and visible chat checklists, then state the exact CLI command the user can run later. Optional commands such as `ijfw cross`, `ijfw design`, `ijfw recover`, `ijfw blackboard`, `ijfw team`, and `ijfw swarm` must degrade to explicit written artifacts instead of blocking the workflow.

---

# AUTO-PICKER (runs first, every time)

Deterministic signals, visible reasoning, no friction.

| Signal | Points towards |
|---|---|
| Prompt < 15 words | Quick |
| Prompt has clear verb + object | Quick |
| Vague verbs alone ("improve", "fix", "handle", "deal with") | Deep |
| "New project", "major refactor", "launch", "design" | Deep |
| Project dir has no `.ijfw/memory/` | Deep |
| Explicit "brainstorm", "quick idea", "just sketch" | Quick |

**Protocol:**
1. Read signals silently.
2. Say in one line: `Reading this as <Quick|Deep> -- <reason>. Say "go deeper" / "just quick" to switch.`
3. If signals tie, ask once: `Quick or Deep?` Accept any affirmative shortcut ("q" / "d").
4. Start immediately. The user should never wait on a modal.

Mid-flow escalation: user can say `go deeper` at any Quick step; skill re-enters Deep at the equivalent module. Mid-flow de-escalation: `just quick` collapses the remaining Deep modules into a single LOCK.

---

# EMPTY-STATE OPENER

First session in a project (no `.ijfw/memory/` or zero entries in it) is the onboarding moment. Do not stay silent. Open with one line:

> `Clean slate here. Want me to run a 5-minute Quick brainstorm on what we're building, or jump straight in?`

User replies `brainstorm` / `jump in` / custom intent. If they jump in, still offer memory hooks for the first 3 turns so decisions get captured. If they brainstorm, route into QUICK mode FRAME. Either way, `.ijfw/memory/` gets bootstrapped silently.

If memory is populated but the last handoff is >7 days old, open with a softer beat: `Welcome back -- last handoff was <N> days ago. Quick recap?` User says `recap` / `new task` / actual intent.

---

# BRAINSTORM DISCIPLINE (invariants)

Hard rules. Violating any of these is a workflow failure worth auditing.

1. **One question at a time.** Never dump a numbered list and wait. Ask, get the answer, absorb, ask the next.
2. **No offscreen research.** If you dispatch an Explore / scout agent, paste a synthesis (3-5 bullets + contradictions + plan implications) in-chat BEFORE using it for anything.
3. **No skipping to the plan.** `plan.md` is written only after the user has explicitly confirmed the brief.
4. **No auto-advance.** Audit gates are user-facing checklists, not silent passes.
5. **Visible deliverables.** Every artifact (brief.md, research.md, plan.md) is summarized to the user in-chat when written.
6. **Intermediate thinking is tight output, not monologue.** Thirty words, then the next question.

Failure signatures to catch in yourself: about to write `plan.md` without user confirming brief; about to dispatch a research agent whose output will not be paraphrased back; about to say "Phase N complete, ready to build" in a turn where the user has not seen the intermediate findings.

---

# MEMORY HOOK (every FRAME step)

At the start of every brainstorm or plan, call `ijfw_memory_recall` with the goal text when the memory tool is available. If it is unavailable, read the visible memory files under `.ijfw/memory/` when possible; if neither is available, continue and say `clean slate -- memory unavailable this turn`.

> I remember: decision from <project> on <date> -- <1-line summary>. Pull full context?

This is the single biggest superpower IJFW delivers. Never skip the attempt. If memory is empty, say so ("clean slate -- nothing recalled") so the silence is intentional, not absence of effort.

---

# QUICK MODE -- 5 moves, 3-5 min

For focused work. Each move has ONE input slot.

### Move 1 -- FRAME (45s)

- Parse the goal from the ask or ask: `Goal in one line.`
- Memory hook fires. Paste up to 3 related recalls inline.
- Rewrite vague asks into verifiable goals before echoing back. Examples: "Add validation" → "Tests for invalid inputs, then make them pass"; "Fix the bug" → "Failing repro test, then make it pass"; "Refactor X" → "Suite passes before and after, no public API changes"; "Make it faster" → "Profile hot path, change it, show the bench improved"; "Clean up the code" → "Pick one smell, fix only that, one-commit diff".
- If the ask cannot be reduced to a checkable outcome, surface that gap before proceeding.
- Echo: `So: <concise goal>. Yes?` User confirms or edits.

### Move 2 -- WHY (30s)

Ask: `Why does this matter? What's broken if we don't ship it?` One 5-Whys drill if surface. Surface the root: `Root: <X>. That means we should <design implication>.`

### Move 3 -- SHAPE (60s)

Propose **3 approaches**, each 1 line + 1 tradeoff. User picks, hybrids, or overrides. No blank page.

### Move 4 -- STRESS (30s)

Pre-mortem flash: `Top risk: <concrete scenario>. Mitigation: <concrete fix>.` Sutherland wow: the risk the user hadn't thought of.

### Move 5 -- LOCK (15s)

- Paste the brief in-chat (max 6 lines: goal / root / approach / risk / mitigation / success).
- One word: `lock` / `fix <X>` / `go deeper`.
- On `lock`: write `.ijfw/memory/brief.md`. Route straight to PLAN (see `references/post-brainstorm-workflow.md`).
- Invoke `ijfw-agents-md` skill with intent context (brief.md) to seed AGENTS.md if missing; create platform adapter (e.g. CLAUDE.md) from template if detected IDE file is absent.
- N7 LOCK-hook: call `populateDisciplineBlock(projectRoot)` (from `mcp-server/src/orchestrator/agents-md-blackboard.js`) immediately after `ijfw-agents-md` returns. This writes the DISCIPLINE block to AGENTS.md with the project-type-appropriate discipline template. Non-throwing -- a failure here is logged but never blocks the workflow. Idempotent re-fire at plan-LOCK; byte-identical output unless `.ijfw/memory/brief.md` frontmatter `type:` was manually changed between locks.

**Quick-mode closer:** `You went from <original-ask> to locked brief with <N> risks mitigated in <M> minutes.`

---

# DEEP MODE -- 6 required modules + 3 optional

Modules are a spine, not a checklist. Every module has a memory hook, a visible artifact, and a one-word commit.

### Module 1 -- FRAME (3 min)
Memory recall on goal keywords. Socratic arc: problem → users → constraints → scope. One question per turn. Echo back every 3 turns. Artifact: `.ijfw/memory/brief-draft.md` (≤30 lines); promote to `brief.md` only after LOCK.

### Module 2 -- RECON (5-10 min)
State research questions in-chat first. Dispatch scout / Explore agents (parallel where independent), or do passes locally and record the limitation. Paste synthesis: **ask** + **answer** + **contradictions** + **plan implications**. Artifact: `.ijfw/memory/research.md`.

### Module 3 -- HMW (3 min)
Propose 2-3 "How Might We" reframings based on FRAME + RECON. User picks, rejects, or edits. Chosen HMW anchors DIVERGE.

### Module 4 -- DIVERGE (8 min)
Sketch **4-5 approaches** as 2-line bullets (shape + tradeoff). User picks 2, rejects, or `hybrid A + C`. Generate a 6th on demand.

### Module 5 -- CONVERGE (5 min)
Draft success metrics / acceptance criteria. Pre-mortem: 4-5 plausible failures. User picks top 2 risks; propose mitigations. Append metrics + risks + mitigations to brief.md.

### Module 6 -- LOCK (2 min)
Paste the full brief (goal / HMW / approach / metrics / risks / mitigations). Optional Trident cross-critique fires here if ENABLED. User says `lock` / `fix <X>` / `skip Trident` / `route to plan`. On `lock`: promote brief-draft.md → brief.md, route to PLAN, invoke `ijfw-agents-md` skill. N7 LOCK-hook fires (see N7 description above).

**Optional modules:** EXTERNAL BRIEF, ANTI-SCOPE, TRIDENT CROSS-CRITIQUE — see `references/deep-mode-optional.md` for triggers + procedure.

---

# POST-BRAINSTORM WORKFLOW (overview)

After LOCK, the brief drives every downstream phase. Same discipline, same memory hooks, same positive framing. **Full procedure:** `references/post-brainstorm-workflow.md`.

Quick reference:
- **PLAN** → write `.ijfw/memory/plan.md`; design auto-fire on visual artifacts; `ijfw plan-check` audit.
- **EXECUTE** → wave dispatch via `dispatch-planner.js`; status-block protocol; mandatory `ijfw_state` MCP call with `verb: 'subagent.post-done'` after every subagent (v1.5.0 T13 — single state-SDK MCP face); task micro-audit.
- **VERIFY** → audit against brief, not plan; Functional + UX + Security + Quality checklists; optional `ijfw cross audit <diff>`.
- **Cross-Audit Phase (Phase E)** → auto-fires after VERIFY; reads `.ijfw/swarm.json::auditors` or falls back to `[codex, gemini, claude]`; PASS / CONDITIONAL / FAIL routes.
- **SHIP** → atomic commit, explicit user approval before tag/release/publish, memory write, ship gate.

---

# NARRATION (every transition)

One sentence at every phase entry and mid-step ping. Format: `Phase <name> -- Move <n> -- <what's happening>.`

**Model routing (mandatory):** Before every agent dispatch, name the actual platform/model or role tier available, e.g. `Routing to builder for implementation` or `Routing to Sonnet for this build`. Never dispatch silently. No hardcoded phase numbers — narration tracks the current workflow step.

---

# POSITIVE FRAMING (enforced everywhere)

Replace negatives with reframes for brainstorming, planning, and ordinary user-facing progress. Do NOT rewrite exact failure terminology in audit, CI, preflight, security, exception, test, or log contexts.

| Never | Always |
|---|---|
| "found problems" | "surfaced X points" |
| "failed" | "didn't complete -- try again?" |
| "error" (as header) | "heads up" / "one thing" |
| "missing" | "ready to add" |
| "not supported" | "standing by" |
| "broken" | "needs a sharpening pass" |

End-of-phase closer is a receipt: `You went from <input> to <outcome> in <time>.`

---

# USER OVERRIDES (one-word commits)

`lock` / `go deeper` / `just quick` / `skip <module>` / `force Trident` / `rollback` / `help`.

---

# TASK TRACKING USAGE (mandatory)

When the platform exposes native task tracking, create one task per specialist or prepared swarm task before dispatch. Mark `in_progress` when work starts, then `completed` or `blocked` as soon as each worker reports back. If no native tracker exists, use `.ijfw/blackboard/tasks.json` plus concise progress updates.

**[Model] prefix required** -- every task title includes the model tier: `[Haiku] Scout: ...`, `[Sonnet] Build: ...`, `[Opus] Audit: ...`.

Quick-mode minimum: 5 tasks (one per move). Deep-mode minimum: one per module + one per specialist + one per audit gate + ship gate. Silent dispatch is a workflow violation.

---

# NAMING-GAP AUDIT (every turn)

Before emitting any "next step" text, scan for foreign plugin prefixes -- any `<plugin>:` pattern where `<plugin>` is not `ijfw`. If found as an action verb, rewrite to the IJFW-native equivalent or halt with: `Rewrite needed -- foreign plugin verb detected.`

Specialist swarm members (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer) are allowed. Foreign plugin commands are not.

---

# STATE FILE (Deep Mode)

Write `.ijfw/state/workflow.json` at every transition with `{mode, module, last_commit, artifacts, next}`. On session resume: read this file, echo the current state, offer `continue` / `restart`. Memory recall also fires on resume.

---

**Invariant:** every move should make the user feel smarter and more in control -- memory surfaces forgotten context, Assistant proposes before the user has to, Trident challenges before they commit, one word advances. Anything that makes them feel stupid or stuck is a workflow bug.
