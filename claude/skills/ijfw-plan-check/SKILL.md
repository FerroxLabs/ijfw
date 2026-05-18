---
name: ijfw-plan-check
description: "Donahoe Loop audit gate before execution. Trigger: 'audit plan', 'check plan', 'review plan', 'plan audit', 'plan check', 'before we build', 'before execution', 'validate the plan', 'is this plan solid', 'plan review'. Owns pre-execution audit intent -- fires before any foreign plan-checker."
---

Pre-execution audit gate. Runs before EXECUTE. Verdict is decisive.

## Step 1 -- Locate the plan

Check in order: user-specified path, `.ijfw/memory/plan.md`, `.planning/**/PLAN.md`.
If none found: `No plan doc located. Paste the plan or give the path.` Do not proceed.

## Step 2 -- Goal-backward analysis

Read success criteria from `.ijfw/memory/brief.md` if present. For every task: does
it trace to a criterion? Tasks with no traceable criterion are scope drift -- flag them.

## Step 3 -- Scope leak check

Anything in the plan not in the brief is a scope leak. List each with task name + reason.
If no brief exists, flag the absence as a risk.

## Step 4 -- Risk surface

Flag tasks that are under-specified (no verify step, no file path), half-baked
(depends on an undecided decision), or destructive (no rollback note).

## Step 5 -- Dependency ordering

If task B needs task A's output but B is listed before A, flag the inversion with names.

## Step 6 -- Verdict

```
Plan audit: <N> tasks reviewed
Goal alignment:   <N> trace to criteria / <N> need attention
Scope:            clean | <N> leak(s)
Risk surface:     <N> need sharpening
Dependency order: correct | <N> inversion(s)

Verdict: PASS | FLAG | BLOCK

Must-fix before execution (FLAG):
  1. <task> -- <file>:<line> -- <fix>

Rework needed (BLOCK):
  1. <issue> -- <reason>
```

- **PASS**: proceed to EXECUTE.
- **FLAG**: fix numbered items, then proceed.
- **BLOCK**: rework required. Do not execute until re-audited.

## Step 6.5 -- Metrics block (machine-readable)

After the verdict text, emit this HTML comment block exactly:

```
<!-- plan-check-metrics
tasks_total: <int>
goal_alignment_pass: <int>
goal_alignment_fail: <int>
scope_leaks: <int>
budget_overrun: <bool>
dep_inversions: <int>
under_specified_pct: <int>
verdict: <PASS|FLAG|BLOCK>
-->
```

**under_specified_pct:** percentage of tasks that are missing ANY of:
- Verb-noun description (e.g., "Write failing test for X", not "fix stuff")
- Target file path(s)
- Verifiable success criterion

Populate each field from the counts gathered in Steps 2-6. `budget_overrun` is
`true` if the plan exceeds the task ceiling for the `time_budget` bucket recorded
in `.ijfw/memory/plan.md` frontmatter (HOUR_1=3, HOUR_2_3=7, HOUR_4_5=12,
HOUR_6_PLUS=unlimited); `false` if no budget was set or ceiling not exceeded.

## Step 7 -- Plan review modes (Deep only)

Fires ONLY for verdict `FLAG` or `PASS`. If verdict is `BLOCK`, skip Step 7 -- rework is needed, not a review mode.

### Default mode selection (reads Step 6.5 metrics block deterministically)

```
if metrics.budget_overrun == true:
  default = REDUCTION
elif metrics.dep_inversions > 0 or metrics.under_specified_pct > 30:
  default = HOLD
elif metrics.goal_alignment_fail > 0 and metrics.scope_leaks == 0:
  default = SCOPE_EXPANSION
else:
  default = SELECTIVE
```

Tag the default with `(Recommended)` and a one-line basis citing the triggering metric:
- `(Recommended) -- budget overrun: <N> tasks vs <BUCKET> ceiling <M>`
- `(Recommended) -- dep inversions: <N>; under-specified <P>%`
- `(Recommended) -- <N> goal-alignment gaps, no scope leaks`
- `(Recommended) -- plan passes audit; pick highest-value subset`

### Mode definitions (kind, not degree -- NO scores per gstack rule)

| Mode | When it fits | Action |
|---|---|---|
| SCOPE EXPANSION | Brief has acceptance criteria with no matching tasks (>20%) | Surface gaps; user adds to brief; re-plan |
| SELECTIVE | Plan is right but too big for session | Pick top N tasks; rest go to backlog |
| HOLD | Plan has too many unknowns (under_specified_pct > 30, or dep_inversions > 0) | Return to Discovery/Research; re-surface later |
| REDUCTION | budget_overrun: true | Cut to smallest viable slice; defer rest |

### AskUserQuestion shape

```json
{
  "question": "Plan is ready. How do you want to move forward?",
  "header": "Plan review",
  "options": [
    { "label": "Selective -- execute top N tasks", "description": "Pick highest-value items; rest go to backlog" },
    { "label": "Reduction -- cut to smallest viable slice", "description": "Trim to what fits the time budget" },
    { "label": "Scope expansion -- surface missing pieces", "description": "Add tasks for uncovered acceptance criteria" },
    { "label": "Hold -- return to discovery", "description": "Too many unknowns; research more before execute" }
  ]
}
```

### Routing (each mode terminates with a specific next step)

- **SELECTIVE:** Follow-up AskUserQuestion (multiSelect) to pick which tasks; plan.md marks non-selected as `backlog: true`; execute runs only the selected subset.
- **REDUCTION:** Re-invoke planner with "cut to top <ceiling> tasks preserving highest-value deliverable"; re-audit; re-review.
- **SCOPE_EXPANSION:** Surface missing criteria in chat; ask user which to add; re-plan; re-audit. If user cannot answer a criterion, emit a plan-review ISSUE (see ISSUE vocabulary below).
- **HOLD:** Write `.ijfw/state/plan-hold.md` with timestamp, reason (which metrics trigger HOLD), and list of unresolved gaps. Tell user: "Plan on hold. Resume with `/ijfw-plan resume` when ready."

### ISSUE vocabulary (unified ledger)

If any routing action produces a new unresolved gap, emit a structured ISSUE with `kind: plan-review` and persist to `.ijfw/state/execute-issues.json` (unified ledger shared with Phase 4; discriminated by `kind` field).

Example entry:

```json
{
  "id": "iss_<N>",
  "kind": "plan-review",
  "mode": "SCOPE_EXPANSION",
  "gap": "User cannot specify success criterion for task 'X'",
  "status": "unresolved",
  "resolution": null,
  "created_at": "<ISO-8601>",
  "resolved_at": null
}
```

**Day-1 protection:** Every consumer treats a missing `.ijfw/state/execute-issues.json` as `{ "issues": [] }`. Canonical JS read stub:

```js
const path = ".ijfw/state/execute-issues.json";
const ledger = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { issues: [] };
```

Do NOT reference `plan-issues.json` -- the unified ledger path is always `execute-issues.json`.

Closer: `You have a <PASS|FLAG|BLOCK> -- <next action>.`

## Pre-dispatch gate (C14, mechanical)

Before the human-judgment review above, a **deterministic** rule pass runs via
the `validatePlan(planText, { strict })` library in
`mcp-server/src/orchestrator/plan-checker.js`. It's already wired into the
post-done runner that the orchestrator-LLM calls per S02 -- no new MCP tool
(the cap is at 12/12). Callers can also invoke it directly when they want a
fast pre-flight before paying the cost of full review.

The mechanical gate checks:

1. **No placeholder tokens** -- `TBD`, `FIXME`, `XXX`, `[fill me in]`,
   `<placeholder>`, `???` (WARN; promoted to BLOCK in `strict: true`).
2. **Completeness** -- plan must declare at least one `## Task` / `### Task` /
   `task_id:` block (BLOCK if zero).
3. **Acceptance criteria** -- each task block mentions `acceptance` / `done when`
   / `criteria` / `expected` (WARN if missing).
4. **No empty steps** -- list items under 20 chars of substantive content (e.g.
   "implement the thing") get WARN.
5. **Dependency sanity** -- a task referencing `depends:` / `blocked-by:` must
   point at a `task_id:` declared in the same plan (BLOCK on dangling).
6. **No test-skip contradiction** -- a task that says "add tests" and "skip the
   tests" in the same block is a BLOCK.

**On any BLOCK finding the dispatch is aborted** and the orchestrator surfaces
the findings to the user. WARN findings flow through to the human-judgment
review (Steps 2-7 above) so the planner can decide whether they matter for
this run.

This gate is intentionally syntactic / structural -- it catches the
fast-and-obvious failure modes before spending tokens on the slower
goal-alignment + scope-leak + risk-surface review that follows.

## Output contract

Emit a `gate-result` block as the **LAST** content of your output. Nothing
after it. Use `gate="plan-check"`. Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

Format:

```gate-result
{
  "schema_version": "1.0",
  "gate": "plan-check",
  "status": "<STATUS>",
  "project_type": "<from project-type-detector>",
  "lenses": [],
  "affected_artifacts": [],
  "accounting": {"duration_ms": 0, "lenses_invoked": 0, "cost_usd": null},
  "remediation": [],
  "receipts_ref": null,
  "supersedes": null,
  "gate_id": "<gate-with-colons-replaced-by-dashes>-<ts>-<rand4>",
  "emitted_at": "<ISO-8601>"
}
```
