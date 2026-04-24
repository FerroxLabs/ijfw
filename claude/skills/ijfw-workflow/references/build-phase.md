# Build Phase -- Reference Detail

This file provides detail for Steps 5-6 in SKILL.md.
SKILL.md is the enforcer. This file is supplementary.

---

## PREREQUISITE CHECK (run before ANY build work)

**Before Step 5, verify these files exist:**
- `.ijfw/memory/brief.md` -- if not found, go back to Think phase Step 3 (LOCK).
- Team must be approved -- if not, go back to Step 4 (BUILD TEAM).

---

## Step 5: PLAN + IMPLEMENTATION BREAKDOWN

Memory hook fires -- recall past similar plans.

### Part A: High-level plan with dependency analysis

Write execution plan with tasks assigned to team members. **Before organizing into waves, analyze dependencies:**

**Dependency check for each task -- ask these questions:**
1. Does this task read files that another task writes? (data dependency -- must be sequential)
2. Does this task modify the same files as another task? (write conflict -- must be sequential)
3. Does this task depend on the output/API/schema of another task? (interface dependency -- must be sequential)
4. Does this task only read shared resources without modifying them? (safe to parallel)
5. Does this task work on completely independent files/modules? (safe to parallel)

**Organize into waves based on the analysis:**
- Tasks with NO dependencies on other tasks in the same wave -> **parallel** (swarm)
- Tasks that depend on output from a prior wave -> **sequential** (wait for prior wave)
- Tasks within a wave that depend on each other -> move one to the next wave or make the wave sequential

**Mark each wave explicitly:**
```
Wave A (parallel -- no shared files, independent modules):
  [Sonnet] Builder: scaffold project structure (/src/layout/)
  [Haiku] Scout: map existing components (/src/components/) -- READ ONLY

Wave B (sequential -- each task builds on the previous):
  [Opus] Architect: design auth flow -> produces /src/auth/schema.ts
  [Sonnet] Builder: implement login endpoint -> DEPENDS ON schema.ts
  [Sonnet] Builder: implement registration flow -> DEPENDS ON schema.ts + login

Wave C (parallel -- independent concerns):
  [Sonnet] QA: write test suite -- reads all, writes /tests/ only
  [Sonnet] Builder: responsive styles -- writes /src/styles/ only
```

**Present the dependency reasoning to the user.** Don't just label waves parallel/sequential -- show WHY. "Wave A is parallel because scaffold and scout touch different directories. Wave B is sequential because login depends on the auth schema that the architect produces."

Each task includes: what / who / how-to-verify / file paths / depends-on (if any).
Quick mode: max 15 tasks. Deep mode: max 30 tasks.

### Part B: Implementation breakdown

Break each plan task into bite-sized steps (2-5 min each):
- TDD where applicable: write test -> fail -> implement -> pass -> commit
- Each step assigned to team member with model tier visible
- Verifiable success criteria per step (goal-driven: "done when X passes")

### Approval + artifacts

User approves with `approve` / `trim` / `expand`.
Write `.ijfw/memory/plan.md` on approval. Render as HTML and open in browser.

**Downstream consumers -- parse plan-check metrics block:**
```bash
sed -n '/<!-- plan-check-metrics/,/-->/p' .ijfw/memory/plan.md
```
Use this snippet to extract machine-readable counters (tasks_total, budget_overrun,
verdict, etc.) emitted by `ijfw-plan-check` Step 6.5 after the verdict text.

**Second Opinion on plan (auto-fire if enabled):**
Check CLI availability (`command -v codex gemini`). Fire only those that exist.
When clean: `Second Opinion reviewed your plan -- all clear.`
When findings: `Second Opinion surfaced [N] points to consider. Address now?`

---

## Step 6: EXECUTE

### Execution mode offer

After the plan is approved, offer two paths:

```
How should we build this?

A) Sequential -- tasks built in order, one at a time. Slower but each step
   builds on the last. Best for tightly coupled work.
B) Subagent swarm -- each task gets its own agent. Faster, parallel execution.
   Best for independent tasks.
```

If < 5 tasks, recommend Sequential. If 5+, recommend Subagent swarm.

**Sequential mode:**
- Execute tasks in plan order, in the current session
- Each task builds on the previous -- full context continuity
- Two-stage review after each task (spec + quality)

**Subagent swarm mode (PARALLEL -- this is the key):**
- **Send ALL Agent tool calls for a wave in a SINGLE response.** This is what makes them parallel. If Wave A has 3 tasks, your response contains 3 `Agent` calls simultaneously with `run_in_background: true` on each.
- Do NOT dispatch one agent, wait for completion, then dispatch the next. That is sequential execution disguised as swarm mode.
- Use `isolation: "worktree"` if available, otherwise dispatch without isolation
- Fresh context per agent -- focused, no pollution from other tasks
- Wait for ALL agents in the wave to complete before starting wave review

Example (3 parallel agents in one response):
```
Agent(description="[Task 1]", prompt="...", run_in_background=true)
Agent(description="[Task 2]", prompt="...", run_in_background=true)
Agent(description="[Task 3]", prompt="...", run_in_background=true)
```
All three launch simultaneously. You'll be notified as each completes.

### Dispatch (both modes)

Each task gets:
- Task spec + acceptance criteria
- Karpathy principles (baked into agent definition, not recited):
  - State assumptions before implementing
  - Simplicity first -- if a senior engineer would simplify it, simplify it
  - Surgical changes -- touch only what the task specifies
  - Verify before reporting done
- Status reporting: DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED

### Task tracking (mandatory)

TaskCreate per task BEFORE dispatching (or text checklist if TaskCreate unavailable). Flip in real time.

Mid-task pings for operations > 30s: `[Agent] in progress (~[estimate]).`

### Two-stage review per task

After each agent completes:
1. Spec compliance: did they build what was asked?
2. Code quality: is it clean, tested, secure?

Both checks run before marking complete. If spec review fails: one retry with explicit fix instructions. If quality review fails: flag for user decision. Two consecutive failures: halt wave, escalate.

### Wave completion: merge + verify + iterate

**Subagent swarm mode:** After ALL agents in a wave complete:
1. **Merge** in dependency order. Conflicts halt and escalate -- never auto-resolve.
2. **Run verification** (pre-commit hooks, tests, lint) on the merged result.

**Sequential mode:** Review is inline after each task.

**Both modes -- domain-specific verification:**

| Domain | Verification |
|--------|-------------|
| Software | Run test suite + type check + lint. If E2E tests exist, run those too. |
| Book | Continuity check, tone consistency, outline adherence |
| Campaign | Brand voice review, CTA audit, platform compliance |
| Design | Accessibility audit (4.5:1 contrast), responsive check, visual consistency |

If verification fails: fix + re-verify (max 2 iterations). If still failing: halt and escalate.

Pre-next-wave dependency check before Wave 2+ starts.

### Design tasks

Generate HTML mockups, open in browser with viewer.html, user reviews before implementation proceeds.

### Self-improvement loop

After ANY user correction during execution:
1. Capture: `Lesson: [what happened] -> [what to do instead]`
2. Write to workflow context
3. Apply to remaining tasks
4. Promote to IJFW memory at session end

### Failure policy

| Situation | Action |
|-----------|--------|
| Spec review didn't pass | Retry once with explicit fix |
| Quality review didn't pass | Flag for user decision |
| Two consecutive issues | Halt wave, escalate |
| BLOCKED / NEEDS_CONTEXT | Surface immediately, never guess |
| Verification didn't pass after 2 fix iterations | Halt, escalate |
| Merge conflict | Halt, escalate -- never auto-resolve |

No auto-advance to Ship. User confirms all tasks done.

Micro-receipt: `Build done -- [N] tasks completed in [time], [N] lessons captured.`

---

## COMPACTION GATE (Build -> Ship transition)

**Before proceeding to Ship, verify:**
- All tasks in plan are marked completed
- Two-stage review passed for each task
- User has confirmed all tasks are done

Update `.ijfw/state/workflow-context.md` and `.ijfw/state/workflow.json`.
