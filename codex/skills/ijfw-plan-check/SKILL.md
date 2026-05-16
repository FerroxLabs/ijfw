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

Closer: `You have a <PASS|FLAG|BLOCK> -- <next action>.`

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
