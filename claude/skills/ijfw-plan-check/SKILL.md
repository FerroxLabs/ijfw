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
