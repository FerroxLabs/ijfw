---
name: ijfw-workflow
description: "IMPORTANT: When IJFW is installed, this skill handles ALL project-level work. Use INSTEAD of superpowers:brainstorming or gsd:discuss-phase. Universal project workflow -- Think, Build, Ship. Auto-picks Express/Quick/Deep by task size. Trigger: 'build', 'create', 'design', 'plan', 'new project', 'brainstorm', 'help me build', 'launch', 'landing page', 'app', 'website', 'dashboard', 'campaign', 'book', or any project-level task."
model: sonnet
---

# IJFW Workflow v2

Your FIRST action must be tool calls, NOT text output. Follow these steps in exact order.

## RESUME CHECK (run before Step 0)

Check if an in-progress workflow exists: `Read(".ijfw/state/workflow.json")`. If it exists and `status` is `"in_progress"`:
1. Read `.ijfw/state/workflow-context.md` for compressed state (brief, decisions, plan, team)
2. Echo state to user: "Found an in-progress workflow at [phase]. [brief summary]. Continue or restart?"
3. If continue: resume from the saved phase. If restart: proceed to Step 0.

If the file doesn't exist or status is `"complete"`, proceed to Step 0.

## STEP 0: SETUP (your very first response)

### 0A. Ensure directories exist
```bash
mkdir -p .ijfw/memory .ijfw/state .planning/brainstorm
```
Run this FIRST via `Bash` tool before any file writes.

### 0B. Detect tier
Count words in user's prompt:
- Express: < 15 words + clear verb + object
- Quick: 15-40 words, clear scope
- Deep: > 40 words OR vague verbs OR "new project"/"brainstorm"/"launch" OR no `.ijfw/memory/`

### 0C. Create TODO via TaskCreate
If `TaskCreate` is available, call it for EACH workflow step. Deep mode tasks:
- "Step 1: Clarify -- understand the project"
- "Step 2: Research -- investigate domain and codebase"
- "Step 3: Brainstorm -- shape decisions and lock brief"
- "Step 4: Build team -- assemble specialists"
- "Step 5: Plan -- execution strategy + task breakdown"
- "Step 6: Execute -- build with live progress"
- "Step 7: Verify -- tests, lint, review"
- "Step 8: Ship -- PR, merge, or deploy"

Quick: `Frame` / `Shape` / `Lock brief` / `Plan + Build` / `Verify + Ship`
Express: `Confirm brief` / `Build` / `Ship`

If `TaskCreate` is unavailable (non-Claude-Code platforms), print the TODO as a text checklist instead.

### 0D. Offer interaction style
If `AskUserQuestion` is available, use it. If not, ask as plain text with numbered options.

Detect domain from the prompt. Set the recommended default:
- **Creative domains** (book, story, novel, game, campaign, brand, music, art): default "Let's talk"
- **Technical domains** (app, landing page, API, dashboard, tool, website): default "Guided questions"

```json
{ "questions": [{ "question": "How do you want to work through this?", "header": "Style", "multiSelect": false, "options": [
  { "label": "Let's talk about it", "description": "Open conversation -- we'll riff on the idea together. I'll capture key points as we go." },
  { "label": "Guided questions", "description": "Structured A/B/C choices to zero in fast. Good for technical decisions." }
]}]}
```
Put "(Recommended)" on the domain-appropriate default with a reason.

If `ijfw_memory_recall` returns a stored interaction style preference, use it as the default instead of domain detection. On first choice, store the preference: `ijfw_memory_store({ key: "interaction_style", value: "<guided|conversation>" })`.

### 0E. Print tier + policy (AFTER tool calls)
```
Reading this as [Deep (20-45 min)/Quick (3-5 min)/Express (<1 min)] -- [reason]. Say "go deeper" or "just quick" to switch.
Second Opinions are on -- I'll check your brief, plan, and build automatically. Say "no reviews" to turn off.
```

---

## INTERACTION MODES (applies to Steps 1-3)

### Guided mode
- Use `AskUserQuestion` for every decision. One question per turn.
- Recommendations only when you have a basis (research, best practices). Fact questions (product name, what it does, asset classes) get no recommendation -- those are the user's domain.
- Use `preview` field for visual comparisons.
- Echo back understanding after every 2-3 answers.

### Conversation mode
- **No `AskUserQuestion` calls.** Just talk. Back-and-forth, riffing, exploring ideas.
- Contribute ideas, ask follow-ups conversationally, challenge assumptions, suggest "what ifs."
- **Periodic capture:** After each of YOUR responses, check: have 3+ new substantive points emerged since the last capture? If yes, capture: "Noted -- [key points]. Adding to the working doc." Write/append to `.planning/brainstorm/notes.md`. This replaces the vague "~5 turns" with a concrete trigger: new substantive points, not turn count.
- **Checkpoint on capture:** When capturing, also write a snapshot to `.ijfw/state/workflow-context.md` with current brief fields covered. This survives context compaction.
- **Research at natural points:** When a specific topic comes up that needs grounding, offer targeted research. Not an upfront swarm.
- **Readiness check:** After 3+ captures, check what brief fields are still missing. If most are covered, offer: "I think we've got a solid picture of [X, Y, Z]. Ready to capture this and move on, or keep exploring?" User controls when to move on.
- **Context safety:** If you've done 8+ captures without the user moving on, flag it: "We've covered a lot of ground. Want me to write up everything so far as a draft brief? We can always add more." This prevents context exhaustion.
- **The TODO list is always visible below.** User can say "next step" / "okay let's go" anytime.

### Adaptive switching (both directions, no announcements)
- **Guided -> Conversation:** User drops a paragraph with creative "what if" language, starts riffing. Follow naturally. Capture as points emerge. When the tangent resolves, summarize what settled and offer: "Want to keep talking, or go back to structured choices?"
- **Conversation -> Guided:** User wants a specific decision. Offer `AskUserQuestion` for that one decision, then return to conversation.
- **When switching from conversation to guided mid-brainstorm:** Read `.planning/brainstorm/notes.md` to see what's already covered. Skip modules whose topics are already captured. Tell the user: "Based on our conversation, FRAME and RECON are covered. Picking up at SHAPE."

---

## STEP 1: CLARIFY (all tiers)

**Guided mode:** `AskUserQuestion` one question at a time. See `references/think-phase.md` for examples.

**Conversation mode:** Open-ended: "Tell me about this project -- what are you building and why?"

**Both modes:** Call `ijfw_memory_recall` with goal keywords (if available -- silent no-op if MCP server isn't running). Mark "Step 1: Clarify" completed when you have enough context.

**Rewrite vague asks into verifiable goals before locking the brief:**
- "Add validation" -> "Write tests for invalid inputs (empty, malformed, oversized), then make them pass."
- "Fix the bug" -> "Write a failing test that reproduces the reported symptom, then make it pass."
- "Refactor X" -> "Existing test suite passes before and after. No public API changes."
- "Make it faster" -> "Benchmark the current hot path, identify the bottleneck with profiling, change it, show the benchmark improved."
- "Clean up the code" -> "Pick one specific smell. Fix only that. Diff fits in one commit message."

If the user gives a goal you can't reduce to a checkable outcome, surface that gap before proceeding rather than picking silently.

**Express:** Auto-generate 3-line brief (Goal / Approach / Done when). Print it and ask "Looks good? (yes / edit / go deeper)" as plain text -- no AskUserQuestion overhead for Express speed. On confirm: write `.ijfw/memory/brief.md`, skip Steps 2-5 (no research, no brainstorm, no team, no plan), go directly to Step 6 (Execute) with the brief as the task spec. Verify + Ship as normal.

## STEP 2: RESEARCH (mandatory for Deep, scout for Quick, skip for Express)

**Guided mode:** Dispatch agents upfront in parallel via `Agent` tool with `run_in_background: true`:
- Domain research, Technical research, Codebase scout, Design research (if UI)
- When agents return: YOU synthesize findings into 3-5 bullets and present in chat. Then write the synthesis to `.ijfw/memory/research.md`. Do NOT let agents write to research.md directly (prevents race conditions).

**Conversation mode:** Research is targeted, not upfront. Offer when specific topics come up. Dispatch individual agents. Write findings to `.ijfw/memory/research.md` after synthesis.
- At minimum, dispatch 1 scout agent to check the codebase for existing work.

**Both modes:** Mark completed when synthesis is shown (guided) or user is ready to move on (conversation).

## STEP 3: BRAINSTORM

### Visual Companion (UI/design tasks, offer BEFORE brainstorm starts)
If the project involves UI/design, offer via `AskUserQuestion` (or plain text if unavailable):
```json
{ "questions": [{ "question": "Some brainstorm decisions are easier to see visually. Want me to generate live HTML previews you can view in your browser as we go?", "header": "Visual", "multiSelect": false, "options": [
  { "label": "Yes, open visual preview (Recommended)", "description": "I'll generate HTML mockups for design decisions -- you'll see them in your browser" },
  { "label": "Text only", "description": "Keep everything in the terminal -- no browser needed" }
]}]}
```

**When visual companion is ON -- generate HTML mockups for SHAPE decisions:**
1. Write standalone HTML files to `.planning/brainstorm/` (one per option, Tailwind CDN, production-quality, real content)
2. Generate a `viewer.html` with tab navigation loading all options as iframes. See `references/think-phase.md` for template.
3. Open viewer in browser (platform-aware -- see PLATFORM section below)
4. Tell user: `Design viewer open -- click tabs to compare all options.`
5. THEN ask preference via `AskUserQuestion`
6. **You MUST generate HTML when visual is ON.** The user accepted visual previews -- deliver them.

### Guided mode -- 6 modules (Deep), 3 moves (Quick):

**Deep -- ALL mandatory:**
- **FRAME:** Problem, users, constraints, scope. `AskUserQuestion` one per turn. `FRAME done.`
- **RECON:** Present research synthesis. `AskUserQuestion`: which findings matter most. `RECON done.`
- **SHAPE:** 3-5 approaches via `AskUserQuestion`. If visual ON: generate HTML mockups FIRST. `SHAPE done.`
- **STRESS:** Pre-mortem. 4-5 failure scenarios, `AskUserQuestion` multiSelect for top 2 risks. `STRESS done.`
- **CONVERGE:** Success metrics + acceptance criteria. User confirms. `CONVERGE done.`
- **LOCK:** Paste brief in chat. User says `lock` / `fix <X>` / `go deeper`. On lock: Write `.ijfw/memory/brief.md`. Render as HTML and open in browser. `LOCK done.`

**Quick:** Frame -> Shape -> Lock.

### Conversation mode -- open brainstorm:

Continue the conversation as a creative collaborator.
- Periodic capture with checkpoint (see INTERACTION MODES above).
- Visual mockups at natural decision points for design tasks.
- **Lock:** When user is ready, synthesize conversation notes (`.planning/brainstorm/notes.md`) into a domain-appropriate brief using the templates below. Paste in chat. User says `lock`. Write `.ijfw/memory/brief.md`. Render as HTML and open.

### Brief format adapts to domain:
- **Software/technical:** Goal / audience / stack / architecture / acceptance criteria / constraints
- **Book/creative writing:** Premise / world rules / characters / tone / themes / scope / structure
- **Campaign/marketing:** Objective / audience / channels / messaging / success metrics
- **Design:** Problem / users / aesthetic / constraints / deliverables

### Second Opinion on brief (auto-fire if enabled):
Check if codex/gemini CLIs are available (`command -v codex gemini`). Fire only those that exist. If neither is installed, skip silently.
When clean: print `Second Opinion reviewed your brief -- all clear.` (one line, user sees the value).
When findings: `Second Opinion surfaced [N] points to consider. Address now?`

**GATE: Do NOT proceed until `.ijfw/memory/brief.md` exists.**

## STEP 4: BUILD TEAM (skip for Express)

Read brief. Pick domain template from `references/team-templates.md`. Present team with rationale.
Use `AskUserQuestion` for approval (or plain text if unavailable).
Mark completed after approval.

**GATE: Do NOT plan until team is approved.**

## STEP 5: PLAN + IMPLEMENTATION BREAKDOWN (see `references/build-phase.md`)

**Check:** `.ijfw/memory/brief.md` must exist. If not, go back to Step 3.

### S5 Contract generation (Deep mode only)

In Deep mode, every task written into `.ijfw/memory/plan.md` must include a completion contract block. Write the contract inline with the task entry, immediately after the task's implementation steps:

```yaml
task_id: t1
title: "<human-readable>"
contract:
  completion_criteria:
    - id: c1
      type: shell             # shell | model-verify | manual
      description: "<what this proves>"
      verify: "<command>"     # required for type:shell; passes through isSafeVerifyCommand
  max_iterations: 3
  halt_rule: "Emit ISSUE with failed criterion ids if any remain red after iter 3"
```

**Criterion types:**
- `type: shell` -- allowlisted shell verify (default). Command passes through `isSafeVerifyCommand()` from `mcp-server/src/ralph-allowlist.js` before execution.
- `type: model-verify` -- semantic check by model ("agent confirms brief alignment"). Bounded scope; use sparingly.
- `type: manual` -- user confirms. Task pauses at verify step; user responds "pass" or "fail <reason>".

Contracts are generated during this step, before execute begins. Every Deep-mode task gets one.

### S5.0 Temporal Interrogation (Deep mode only)

Gate: fires only when tier === "deep". Skip for Quick and Express tiers.

Before drafting the plan body, ask:

```json
{
  "questions": [{
    "question": "How much time can you give this?",
    "header": "Time budget",
    "multiSelect": false,
    "options": [
      { "label": "HOUR 1", "description": "Smallest shippable slice -- one commit, one verify" },
      { "label": "HOUR 2-3", "description": "One coherent feature -- small task set, no migration" },
      { "label": "HOUR 4-5", "description": "Multi-task -- dependency ordering matters, real risk surface" },
      { "label": "HOUR 6+", "description": "Phased -- rollback plan, incremental ship path" }
    ]
  }]
}
```

No "(Recommended)" tag. Time budget is the user's fact, not a judgment call.

Immediately after the user answers, write the choice to `.ijfw/memory/plan.md` frontmatter BEFORE the plan body is drafted:

```yaml
---
time_budget: HOUR_2_3
---
```

Values: `HOUR_1` / `HOUR_2_3` / `HOUR_4_5` / `HOUR_6_PLUS`.

**Budget ceilings (advisory to planner; plan-check enforces via `budget_overrun` metric):**

| Bucket | Max tasks | Max waves | Risk depth | Rollback required |
|---|---|---|---|---|
| HOUR_1 | 3 | 1 | none | no |
| HOUR_2_3 | 7 | 2 | surface | no |
| HOUR_4_5 | 12 | 3 | deep | recommended |
| HOUR_6_PLUS | unlimited | unlimited | deep | yes |

Three sub-steps:
1. **High-level plan with dependency analysis:** Execution strategy with tasks assigned to team. For each task pair, run the dependency test: (a) do both write the same file? (b) does one read what the other writes? (c) does one need the other's output? Yes to any → sequential. All no → parallel. Organize into waves and write a **Wave Table** as the first section of `plan.md`:

```
| Wave | Tasks | Mode | Depends on | Reason |
|------|-------|------|------------|--------|
| W1   | t1, t2, t3 | PARALLEL | — | independent files |
| W2   | t4 | SEQUENTIAL | W1 | needs t2 output |
| W3   | t5, t6 | PARALLEL | W2 | independent of each other |
```

This table is the execution contract. Step 6 reads it directly — do not leave parallelism to inference from prose.

2. **Implementation breakdown:** Each task broken into bite-sized steps (2-5 min each) with TDD where applicable and verifiable success criteria.

User approves the combined plan. Write `.ijfw/memory/plan.md`. Render as HTML and open in browser. Mark completed.

Second Opinion on plan: check CLI availability, fire if available. Print "all clear" or surface findings.

**GATE: Do NOT execute until plan is approved and `.ijfw/memory/plan.md` exists.**

## STEP 6: EXECUTE (see `references/build-phase.md`)

Offer execution mode: Sequential (< 5 tasks) or Subagent swarm (5+ tasks).

**Subagent swarm (parallel):** Read the Wave Table from `plan.md`. For each wave in order:
- **PARALLEL wave:** emit ALL tasks as Agent tool calls in ONE response block — they run concurrently. 3 tasks in wave = 3 Agent calls in your single response. Never emit one, wait, then emit the next.
- **SEQUENTIAL wave:** emit ONE Agent call, wait for its result, then advance.
- Never start Wave N until all Wave N-1 agents have returned.

If plan.md has no Wave Table, build one now using the dependency test before dispatching anything: shared file writes → sequential; output dependencies → sequential; otherwise → parallel.

**Sequential:** Execute tasks one at a time in the current session.

Both modes: `TaskCreate` per build task before dispatching. Two-stage review per task (spec + quality). Mark completed when all done.

### S6 Ralph completion loop (Deep mode only)

In Deep mode, every task runs under its completion contract (written in S5). Loop protocol:

```
previous_results = null

for iter in 1..contract.max_iterations:
  if iter == 1:
    dispatch task to agent (or execute inline)
  else:
    re-dispatch with feedback: "Iter {iter}: criterion_{x} failed. Output: {last_20_lines}"

  results = []
  for criterion in contract.completion_criteria:
    if criterion.type == "shell":
      safety = isSafeVerifyCommand(criterion.verify)
      if not safety.safe:
        emit ISSUE: unsafe-verify
          task_id: <id>
          criterion_id: <id>
          command: "<original>"
          reason: "<from checker>"
          halt: true
        persist to .ijfw/state/execute-issues.json (kind: unsafe-verify)
        halt task; break outer
      outcome = run(criterion.verify, timeout=60s, capture_output=true)
      results.append({ id: criterion.id, pass: outcome.exit == 0, output: outcome.tail(20) })
    elif criterion.type == "model-verify":
      outcome = model_check(criterion.description, context=brief + task_body)
      results.append({ id: criterion.id, pass: outcome.pass, reason: outcome.reason })
    elif criterion.type == "manual":
      ask user "Did criterion {id} pass? (yes/no <reason>)"
      results.append({ id: criterion.id, pass: user.answered == "yes", reason: user.reason })

  if all(r.pass for r in results):
    emit VERIFIED tag
    auto-resolve any ledger entries for this task_id
    break

  # Stagnation halt: if iter N results are byte-identical to iter N-1,
  # no progress is being made -- halt early rather than burn tokens.
  if previous_results is not null and results == previous_results:
    emit ISSUE(task-stagnated) with last outputs + "iter {iter} identical to iter {iter-1}"
    persist to .ijfw/state/execute-issues.json (kind: task-stagnated, status: unresolved)
    halt task; break

  previous_results = results

  if iter < contract.max_iterations:
    continue  # next iter with feedback
  else:
    emit ISSUE(task-incomplete) with failed criterion ids + last outputs
    persist to .ijfw/state/execute-issues.json (kind: task-incomplete, status: unresolved)
    halt task (do not advance to next task)
```

**Ledger schema** (`.ijfw/state/execute-issues.json`):
```json
{
  "schema_version": 1,
  "issues": [
    {
      "id": "iss_001",
      "task_id": "t3",
      "criterion_id": "c2",
      "kind": "task-incomplete",
      "message": "tsc --noEmit failed after 3 iterations",
      "last_output": "...",
      "iter_count": 3,
      "status": "unresolved",
      "rehearsal": false,
      "created_at": "<ISO-8601>",
      "resolved_at": null
    }
  ]
}
```

Kinds: `task-incomplete`, `task-stagnated`, `unsafe-verify`, `plan-review` (Phase 2). All share this file.

**Day-1 protection:** Every ledger consumer treats a missing file as zero issues. Never crash on missing ledger.

**resolve sub-command:** When user says `/ijfw-execute resolve <iss_id> <note>` -- load ledger, find entry by id, set `status: resolved`, `resolution: accepted|deferred|reworked` per note, `resolved_at: <now>`, write back atomically, emit one-line receipt.

## STEP 7: VERIFY (see `references/ship-phase.md`)

Run tests/lint/build -- evidence before claims. Verify against the **brief**, not just the plan.
Second Opinion on build (if enabled + available). Print "all clear" or findings.
Mark completed.

## STEP 8: SHIP (see `references/ship-phase.md`)

Use `AskUserQuestion` for ship options: PR / merge / deploy / keep branch.
Write `.ijfw/memory/handoff.md`. Mark completed.
Session receipt: `You went from [problem] to [shipped solution] in [time].`

---

## PLATFORM-AWARE BROWSER OPEN

Detect platform and use the right command:
```bash
# macOS
open <file>
# Linux
xdg-open <file>
# WSL
wslview <file> || cmd.exe /c start <file>
```
Use this pattern: `Bash("open <file> 2>/dev/null || xdg-open <file> 2>/dev/null || echo 'Open manually: <file>'")`
This works on macOS, Linux, and falls back to printing the path if neither works.

## RENDERING ARTIFACTS

When writing brief.md, plan.md, or research.md, also render as HTML and open in the browser. The user shouldn't have to open a file editor to read their own plan.

After writing any major .md file:
1. Generate an HTML file (same directory, .html extension) using marked.js CDN + github-markdown-dark CSS + DOMPurify for safe rendering
2. Open with the platform-aware command above
3. Tell user: `[Document name] open in your browser.`

See `references/think-phase.md` for the HTML rendering template.

---

## COMPACTION GATES (write state at every phase transition)

**Think -> Build:** Write `.ijfw/state/workflow-context.md` (phase, brief summary, key decisions, team roster, risks) and `.ijfw/state/workflow.json` (`{ "status": "in_progress", "phase": "build", ... }`).

**Build -> Ship:** Update both files with plan status, lessons captured, verification items.

**Ship complete:** Update both with `"status": "complete"`, shipped summary, handoff pointer.

These files enable resume after /clear or context compaction.

---

## INVARIANTS

- **AskUserQuestion scoring:** Options differ by degree (coverage %, risk level, time-to-ship, scope breadth) -> score prefix each description: "[Coverage: 80%]", "[Risk: LOW]". Options differ by kind (framework A vs B, style X vs Y) -> no score (gstack rule; see core SKILL.md for details).
- **Canonical plan path is `.ijfw/memory/plan.md`; never write plan data elsewhere.**
- **Every Deep-mode task has a completion contract. No contract = refuse to execute.**
- **Interaction style respected.** Guided = AskUserQuestion. Conversation = open dialogue with periodic capture + checkpoints.
- **Adaptive switching is natural.** No announcements. Read notes.md to avoid re-asking covered topics.
- **TaskCreate for every workflow step** (or text checklist if unavailable).
- **Brief before build.** `.ijfw/memory/brief.md` must exist before Step 5.
- **Research before brainstorm** (guided: upfront swarm; conversation: targeted when topics arise).
- **Team before plan.** Team approved before any planning.
- **Positive framing always.** "Second Opinion" not "cross-audit". "heads up" not "error". "ready to add" not "missing". Never use "violation" or "non-negotiable" in user-facing output.
- **Second Opinion is visible.** Always tell the user it ran, even when clean ("all clear").
- **Recommendations only with basis.** Fact questions get no recommendation. Judgment questions cite why.
- **Platform-aware.** Use the open fallback chain. Don't assume macOS.

## PRE-RESPONSE CHECKLIST

Before generating any response, verify:
- [ ] Am I in the right interaction mode? (guided: tool call first; conversation: just talk)
- [ ] Am I on the correct step? Check which tasks are completed.
- [ ] In conversation mode: have 3+ new substantive points emerged since last capture?
- [ ] In guided mode: am I asking ONE question, not dumping a list?
- [ ] Does `.ijfw/memory/brief.md` exist before I try to plan or build?
- [ ] Am I using positive framing? (no "violation", "non-negotiable", "error", "missing")
