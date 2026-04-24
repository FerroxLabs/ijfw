---
name: ijfw-execute
description: "Jump directly to the IJFW workflow Execute phase (Deep D4 / Quick Q3). Usage: /ijfw-execute [task or phase name]"
---

Jump straight into the IJFW workflow Execute phase. Use this when a plan is
already approved and you're ready to build.

**Quick mode (Q3):** Work through tasks in sequence. Run tests and verification
after each. Store key decisions in memory. One-keystroke: `/ijfw-execute`.

**Deep mode (D4):** Dispatch tasks to the project team agents set up during
Discovery. Specialist agents run in parallel where tasks are independent. Human
checkpoints fire at each phase boundary. Atomic commits for code changes.
`progress.md` updates after every phase.

This command invokes `ijfw-workflow` at the Execute phase directly. IJFW drives
the full execution loop via the `Agent` tool -- no external plugin hand-off.
Every task transition creates a visible task entry so you can see progress in
real time.

**Natural triggers:** "start building", "execute the plan", "let's go", "build it",
"kick off execution."

If no `plan.md` exists, this command offers a 2-minute Quick Plan pass first
before executing -- skipping planning reliably causes scope drift.

**Deep mode runs tasks under completion contracts with max-iter=3.** Each task in
Deep mode requires a completion contract (defined in plan.md). The Ralph loop
runs up to 3 iterations per task, re-dispatching with failure feedback on each
failed criterion. If all criteria pass: VERIFIED. If max iterations exhausted or
stagnation detected (two identical result sets): ISSUE persisted to
`.ijfw/state/execute-issues.json`.

**resolve sub-command:** `/ijfw-execute resolve <iss_id> <note>` resolves a
ledger entry. Matches: "resolve issue <id>", "mark <id> resolved", etc.
1. Load `.ijfw/state/execute-issues.json`.
2. Find entry by `id`; set `status: resolved`, `resolution: accepted` (or
   `deferred` / `reworked` per note), `resolved_at: <now ISO-8601>`.
3. Write back atomically (temp file + rename).
4. Emit one-line receipt: `Resolved iss_001 (accepted). 0 unresolved issues remain.`

Alternative: next successful execute of the same `task_id` auto-resolves all
unresolved entries for that task.

**Ledger gate:** Before starting execution, read `.ijfw/state/execute-issues.json`
(treat missing file as zero issues). If any entry has `status: unresolved`, halt
and list the issues -- resolve them first or use the resolve sub-command.

**GATE:** Execute phase ends at the PHASE AUDIT gate -- all phase tasks complete,
brief still accurate, memory updated. Gate runs at each phase boundary.
