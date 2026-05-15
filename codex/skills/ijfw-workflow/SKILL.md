---
name: ijfw-workflow
description: "Universal project workflow with built-in quality auditing. Quick mode (fast brainstorm, ~5 min) or Deep mode (full plan with audits, ~30 min). Auto-picks based on task size. Trigger: 'build', 'create', 'plan', 'new project', 'brainstorm', 'design', 'UI', 'website', 'dashboard', 'app', 'help me build', or any project-level task."
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

## RUNTIME BOOTSTRAP AND FALLBACKS

Before the first workflow write or command invocation, inspect whether
`.ijfw/memory/` exists so the auto-picker and empty-state opener can use that
signal accurately. Then ensure `.ijfw/memory/` and `.planning/` exist before
writing artifacts. If the `ijfw` CLI is unavailable in this session, continue
with markdown files and visible chat checklists, then state the exact CLI
command the user can run later. Optional commands such as `ijfw cross`,
`ijfw design`, `ijfw recover`, `ijfw blackboard`, `ijfw team`, and `ijfw swarm`
must degrade to explicit written artifacts instead of blocking the workflow.

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

For focused work. Picks up from current context. Each move has ONE input slot.

### Move 1 -- FRAME (45s)

- Assistant parses the goal from the ask or asks: `Goal in one line.`
- Memory hook fires. Assistant pastes up to 3 related recalls inline.
- **Rewrite vague asks into verifiable goals before echoing back:**
  - "Add validation" -> "Write tests for invalid inputs (empty, malformed, oversized), then make them pass."
  - "Fix the bug" -> "Write a failing test that reproduces the reported symptom, then make it pass."
  - "Refactor X" -> "Existing test suite passes before and after. No public API changes."
  - "Make it faster" -> "Benchmark the hot path, identify the bottleneck with profiling, change it, show the benchmark improved."
  - "Clean up the code" -> "Pick one specific smell. Fix only that. Diff fits in one commit message."
- If the ask cannot be reduced to a checkable outcome, surface that gap before proceeding.
- Assistant echoes: `So: <concise goal>. Yes?`
- User confirms or edits.

### Move 2 -- WHY (30s)

- Assistant asks: `Why does this matter? What's broken if we don't ship it?`
- Single 5-Whys drill -- one follow-up question if the answer stays surface.
- Assistant surfaces the root motivation: `Root: <X>. That means we should <design implication>.`

### Move 3 -- SHAPE (60s)

- Assistant proposes **3 approaches**, each as 1 line + 1 tradeoff:
  > A: <approach> -- tradeoff: <cost>
  > B: <approach> -- tradeoff: <cost>
  > C: <approach> -- tradeoff: <cost>
- User picks, hybrids, or overrides. No blank page, ever.

### Move 4 -- STRESS (30s)

- Assistant runs a pre-mortem flash: `Top risk: <concrete scenario>. Mitigation: <concrete fix>.`
- User confirms mitigation or swaps.
- Sutherland wow: the risk the user hadn't thought of.

### Move 5 -- LOCK (15s)

- Assistant pastes the brief in-chat (max 6 lines: goal / root / approach / risk / mitigation / success).
- User says one word: `lock` / `fix <X>` / `go deeper`.
- On `lock`: write `.ijfw/memory/brief.md`. Route straight to PLAN.

**Quick-mode closer:** `You went from <original-ask> to locked brief with <N> risks mitigated in <M> minutes.` Receipt for the work.

---

# DEEP MODE -- 6 required modules + 3 optional

For substantial projects. Modules are a spine, not a checklist. Every module has a memory hook, a visible artifact, and a one-word commit.

## Required spine

### Module 1 -- FRAME (3 min)

- Memory recall on the goal keywords.
- Socratic arc: problem -> users -> constraints -> scope (in and out).
- One question per turn. Echo back every 3 turns to confirm understanding.
- Exit: `Brief draft ready to review. Paste now? (y/edit)`
- Artifact: `.ijfw/memory/brief-draft.md` (30 lines max). Promote to `.ijfw/memory/brief.md` only after LOCK.

### Module 2 -- RECON (5-10 min)

- State the research questions in-chat first: `I want to answer X, Y, Z -- okay?`
- Dispatch scout / Explore agents with those questions (parallel where independent). If the current runtime has no agent-dispatch capability, do the research locally in separate labeled passes and record the limitation in `.ijfw/memory/research.md`.
- When agents return, paste synthesis in-chat: **ask** + **answer** + **contradictions** + **plan implications**.
- User reacts. Follow up if they push back.
- Artifact: `.ijfw/memory/research.md` (cleaned-up synthesis, not raw agent output).

### Module 3 -- HMW (3 min)

- Assistant proposes 2-3 "How Might We" reframings based on FRAME + RECON.
- User picks one, rejects, or edits.
- The chosen HMW anchors DIVERGE.

### Module 4 -- DIVERGE (8 min)

- Assistant sketches **4-5 approaches** as 2-line bullets (shape + key tradeoff).
- User picks 2, rejects, or says `hybrid A + C`.
- No blank page. If user wants a 6th sketch, Assistant generates it on demand.

### Module 5 -- CONVERGE (5 min)

- Assistant drafts success metrics / acceptance criteria from the chosen approach.
- Pre-mortem pass: Assistant generates 4-5 plausible failure scenarios.
- User picks top 2 risks. Assistant proposes mitigation for each.
- Artifact: metrics + risks + mitigations appended to brief.md.

### Module 6 -- LOCK (2 min)

- Assistant pastes the full brief (goal / HMW / approach / metrics / risks / mitigations) in-chat.
- Optional Trident cross-critique fires here if ENABLED (see below).
- User says `lock` / `fix <X>` / `skip Trident` / `route to plan`.
- On `lock`: promote `.ijfw/memory/brief-draft.md` to `.ijfw/memory/brief.md` or write the confirmed brief there, then route to PLAN phase.

## Optional modules (auto-triggered)

### EXTERNAL BRIEF (5 min) -- mini PR/FAQ
Auto-triggers when: project has end-users, public launch, marketing surface, or user says "product".
Writes a 2-paragraph press-release + 5-question FAQ. Forces customer-POV thinking.

### ANTI-SCOPE (2 min) -- "what we won't do"
Auto-triggers when: 5+ candidate features surfaced in DIVERGE, or domain is feature-heavy (CRM, dashboards, admin panels).
Assistant lists 5 things we could build but won't. User confirms or pulls one back in.

### TRIDENT CROSS-CRITIQUE (~2 min) -- external model challenge
Auto-triggers when: new project, major refactor, public launch, or LOCK on brief > 20 lines.
Fires `ijfw cross critique <brief>` in background. Surfaces consensus + contested findings. User decides.
User override: `skip Trident` or `force Trident` at any LOCK.

---

# POST-BRAINSTORM WORKFLOW

After LOCK, the brief drives every downstream phase. Same discipline, same memory hooks, same positive framing.

## PLAN (after LOCK)

- Memory hook: recall past similar plans.
- Assistant drafts `.ijfw/memory/plan.md` (max 15 tasks for Quick, 30 for Deep).
- Each task: what / how-to-verify / file paths.
- User reviews. One-word commit: `approve` / `trim` / `expand`.

**Design auto-fire** -- if plan mentions UI, dashboard, component, page, layout, CSS, styles, content layout, brand system, document design, diagram, presentation, marketing surface, or another visual artifact:
- Deep mode: dispatch `ijfw-design` automatically before writing tasks. Log observation via `bash scripts/design-pass.sh`.
- Quick mode: offer `I'll run a design pass first. Say "show me" to open it, or "skip" to continue.` Wait for the user's next turn before starting visual companion work.
- Use `ijfw design init` when no `DESIGN.md` exists or the existing contract is stale.
- Use `ijfw design plan` before implementation tasks so the plan has durable visual scope, constraints, and success criteria.
- Use `ijfw design audit` or `ijfw design critique` at LOCK or before EXECUTE when visual quality, accessibility, brand fit, hierarchy, or audience fit carries risk.
- Use `ijfw design polish`, `ijfw design normalize`, `ijfw design bolder`, or `ijfw design quieter` during refinement, depending on whether the artifact needs quality pass, drift correction, stronger expression, or restraint.
- Use `ijfw design handoff` before VERIFY/SHIP when visual decisions need to survive context loss or platform handoff.
- Live companion commands (`ijfw design start/open/status/stop/push/clear`) are transient preview. `DESIGN.md` plus the durable design commands are the design memory.
- On completion: write `.ijfw/design-pass.json` sentinel for preflight gate.

**Plan audit** -- run `ijfw plan-check` or follow inline checklist, not silent:
- Every task has a verify step.
- No unstated assumptions.
- Scope matches brief (nothing new).
- Destructive ops flagged.
- User confirms before EXECUTE.

## EXECUTE

**Phase banner** -- emit at every phase transition (Brainstorm, Plan, Execute, Verify, Ship):
```
IJFW > BRAINSTORM (Quick mode, step 2 of 5)
IJFW > PLAN (Deep mode, module 3 of 6)
IJFW > EXECUTE (Wave 2 of 4)
```

**Team announcement** -- at plan→execute transition, emit before dispatching agents:
```
Assembling team: [Opus] Architect, 2x [Sonnet] Builders, [Haiku] Scout
Dispatching Wave 1...
```

**Swarm preparation (Deep mode or 2+ parallel agents):**
- Before using swarm commands, run `ijfw recover status` to surface any existing checkpoint and `ijfw blackboard init` when the project has no blackboard yet.
- If no team exists, run `ijfw team init` first. Use `--archetype <type>` when the project type is known.
- In Codex-heavy projects, run `ijfw codex doctor` after team setup to confirm plugin metadata, hooks, MCP config, skills, AGENTS.md memory, and custom-agent surfaces are ready.
- Run `ijfw codex sync-agents` when `.codex/agents/*.toml` needs to be regenerated from the current Team Assembly charter.
- Run `ijfw swarm plan` to explain artifact owners, parallel/review/blocked waves, and verification.
- Run `ijfw swarm prepare` before dispatch, or `ijfw swarm prepare --reviews` when review tasks should be queued immediately. This writes `.ijfw/blackboard/tasks.json`.
- Run `ijfw swarm tasks` to list prepared task IDs. Tasks may represent code, design, research, writing, business artifacts, or other project work.
- Run `ijfw swarm status` and surface ready/blocked counts before assigning agents.
- Dispatch only tasks marked `ready`. For each dispatched task, run `ijfw swarm start <task-id>` before work begins.
- Generate a scoped dispatch brief before spawning a worker: `ijfw swarm prompt <task-id>`, or `ijfw swarm prompt <task-id> --codex` when the worker is a Codex subagent. Paste the generated prompt into the worker so artifact scope, allowed paths, dependencies, blackboard commands, verification, and non-revert rules travel with the task.
- Codex runtime caveat: some tool-backed Codex sessions expose only a generic `spawn_agent` interface, without direct named custom-agent invocation. IJFW still generates `.codex/agents/*.toml`; when named agents are not callable, paste the `ijfw swarm prompt <task-id> --codex` output into the built-in worker or explorer agent.
- On completion, run `ijfw swarm complete <task-id>`. If a task is blocked, run `ijfw swarm block <task-id> --message <why>` and escalate the blocker through claims, scope adjustment, or user decision.
- At each transition, create a durable safety point with `ijfw memory checkpoint <label>`. Use labels like `after-team-init`, `after-swarm-prepare`, `after-wave-1`, `before-worktree-integrate`, and `before-ship`.
- If context is lost, run `ijfw recover status` first, then `ijfw recover latest` for the last checkpoint body.

- **Conservative worktree support (code-heavy tasks only by default):**
  - Worktrees are optional execution isolation, not the coordination model. Use blackboard claims for writing, design, research, business, strategy, and other non-code artifacts.
  - Create a task worktree only after `ijfw swarm start <task-id>` has succeeded: `ijfw swarm worktree create <task-id>`.
  - Inspect active task worktrees with `ijfw swarm worktree list` before assigning or integrating parallel code work.
  - Before integration, run task verification in the worktree and create `ijfw memory checkpoint before-worktree-integrate`.
  - Integrate one completed task at a time with `ijfw swarm worktree integrate <task-id>`, then run wave-level verification in the main worktree.
  - Clean up only successful, verified integrations with `ijfw swarm worktree cleanup <task-id>`.
  - Preserve failed or blocked worktrees for inspection. Do not clean them up automatically.
  - Never auto-resolve merge conflicts. On any conflict, stop, record `ijfw swarm block <task-id> --message <why>`, and escalate to the user or lead agent.

- Dispatch per workflow manifest and blackboard task records.
- Use blackboard claims before parallel artifact edits: `ijfw blackboard claim --artifact <id> --owner <agent> --paths <globs>`.
- When the platform has a native task tracker, create one visible task per prepared blackboard task and keep it synchronized with `start` / `complete` / `block`.
- Mid-step pings for operations > 30s: `<agent> in progress (~<estimate>).`
- After each task: task micro-audit (6 points).
- Post-wave: update blackboard tasks/findings/blockers. Integrate worktrees only when worktrees were used. Conflicts halt + escalate without auto-resolution.
- **No auto-advance to VERIFY.** User confirms all tasks done.

**Task micro-audit** -- one line per task:
- Criteria met, scope clean, tests pass, no new assumptions.

**Phase audit** -- at wave/milestone boundaries:
- Brief still accurate? Speed respectful? Security invisible? Memory updated?

### LIVE VISUAL COMPANION (UI/design projects, opt-in)

For visual software work -- HTML, app UI, dashboards, interfaces, landing
pages, components, design systems -- offer a live preview before SHAPE:
`This is visual. Want me to open a live preview while we brainstorm?`

`yes` runs `ijfw design start`, writes/pushes real HTML mockups with
`ijfw design push <file.html> [more.html ...]`, and keeps `http://localhost:<port>/design`
open while options evolve. Use this for brainstorm variants, design choices,
and implementation review. Durable visual identity still belongs in `DESIGN.md`;
the live companion is the fast feedback loop.

For architecture-only visuals, use Mermaid in `.ijfw/visual/<phase>.md`.
Skip visual companion for non-visual work where the brief and plan carry enough
structure.

## VERIFY

- Audit the result against the **brief**, not the plan. (Tasks can pass while brief goals miss.)
- Functional + UX + Security + Quality checklists.
- Optional Trident cross-audit on the diff: `ijfw cross audit <diff>`.
- User confirms: `verified` / `gap: <X>` / `ship it`.

## SHIP

- Atomic commit with the brief's one-liner as the title, only after explicit user approval to commit.
- Optional Trident final critique: `ijfw cross critique HEAD~1..HEAD` (background).
- Before any tag, release, deploy, or publish action, read AGENTS.md/CLAUDE.md memory for release cautions and require explicit user approval.
- Tag / release notes / CHANGELOG entry only when this is a public ship and the release gate is clear.
- Memory write: decision + pattern + learning.
- Announcement copy -- user owns the channels, IJFW provides talking points.

**Ship gate** -- single pass:
- Diff matches brief. Tests green. Changelog updated. Memory stored. Trident receipt logged.

---

# NARRATION (every transition)

One sentence at every phase entry and mid-step ping. Format:

> `Phase <name> -- Move <n> -- <what's happening>.`

Examples:
- `Brainstorm Quick -- Move 3 SHAPE -- proposing three approaches.`
- `Brainstorm Deep -- RECON -- dispatching two research agents.`
- `Plan -- drafting 12 tasks from brief.`
- `Execute -- wave 1/3 in progress (~4 min).`
- `Ship -- Trident critique running in background.`

**Model routing (mandatory):** Before every agent dispatch, name the actual platform/model or role tier available in the current runtime, for example `Routing to builder for implementation` or `Routing to Sonnet for this build` when Claude tiers are available. Never dispatch silently.

No hardcoded phase numbers. Narration tracks the current workflow step, not historical plan-doc coordinates.

---

# POSITIVE FRAMING (enforced everywhere)

Replace negatives with reframes for brainstorming, planning, and ordinary user-facing progress. Do not rewrite exact failure terminology in audit, CI, preflight, security, exception, test, or log contexts where precise status words are required.

| Never | Always |
|---|---|
| "found problems" | "surfaced X points" |
| "failed" | "didn't complete -- try again?" |
| "error" (as header) | "heads up" / "one thing" |
| "missing" | "ready to add" |
| "not supported" | "standing by" |
| "broken" | "needs a sharpening pass" |

End-of-phase closer is a receipt, not a report:

> `You went from <input> to <outcome> in <time>.`

---

# USER OVERRIDES (one-word commits)

The skill accepts these at any prompt:

- `lock` -- commit current artifact, advance.
- `go deeper` -- escalate Quick to Deep at the equivalent module.
- `just quick` -- collapse remaining Deep modules into one LOCK.
- `skip <module>` -- drop an optional module (Trident / External Brief / Anti-scope).
- `force Trident` -- run Trident cross-critique even on low-stakes LOCK.
- `rollback` -- revert to the prior module's artifact.
- `help` -- where am I + what's next.

---

# TASK TRACKING USAGE (mandatory)

When the platform exposes native task tracking, create one task per specialist or prepared swarm task before dispatch. Mark `in_progress` when work starts, then `completed` or `blocked` as soon as each worker reports back. If no native tracker exists, use `.ijfw/blackboard/tasks.json` plus concise progress updates.

**[Model] prefix required** -- every task title includes the model tier:
```
[Haiku] Scout: explore auth module
[Sonnet] Build: implement login flow
[Opus] Audit: cross-audit Wave 1
```

The user must see real-time progress in the platform's native form. Use strikethrough task lists where supported; otherwise use concise status updates plus `.ijfw/blackboard/tasks.json`. Silent dispatch is a workflow violation.

Quick-mode minimum: 5 tasks (one per move).
Deep-mode minimum: one per module + one per specialist + one per audit gate + ship gate. ~12-18 tasks per full run.

---

# NAMING-GAP AUDIT (every turn)

Before emitting any "next step" text, scan for foreign plugin prefixes -- any `<plugin>:` pattern where `<plugin>` is not `ijfw`. If found as an action verb, rewrite to the IJFW-native equivalent or halt with: `Rewrite needed -- foreign plugin verb detected.`

Specialist swarm members (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer) are allowed. Foreign plugin commands are not.

---

# STATE FILE (Deep Mode)

Write `.ijfw/state/workflow.json` at every transition:

```json
{
  "mode": "deep",
  "module": "HMW",
  "last_commit": "lock",
  "artifacts": ["brief.md", "research.md"],
  "next": "DIVERGE"
}
```

On session resume: read this file, echo the current state, offer `continue` / `restart`. Memory recall also fires on resume so context is live.

---

**Invariant:** every move the user experiences should make them feel smarter and more in control -- memory recall surfaces forgotten context, Assistant proposes before the user has to, Trident challenges before they commit, one word advances. Anything that makes them feel stupid or stuck is a workflow bug.
