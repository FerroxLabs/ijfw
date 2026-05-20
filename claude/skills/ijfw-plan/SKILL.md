---
name: ijfw-plan
description: "Use when the user says 'plan this', 'plan it', 'make a plan', 'let's plan', 'draft a plan', 'how should we tackle this', 'break this down', or invokes '/ijfw-plan'. Produces a falsifiable PLAN.md (software, book, campaign, design, research) with task breakdown, dependency wave-table, and success criteria — gated by validatePlan() + ijfw-plan-checker before dispatch."
since: '1.5.0'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent
---

# IJFW Plan — domain-agnostic plan authoring

You are the orchestrator-facing trigger that turns a brief (and optionally a
SPEC.md / research notes) into an executable PLAN.md. Plan output is the same
shape across domains: software slice, book chapter, marketing campaign, design
system release, research milestone. The deliverables differ; the structure
doesn't.

This skill is the body for the `/ijfw-plan` slash command. Both paths land
here. Slash invocation may pass `[brief description]` as `$1`.

## When to fire

1. User explicitly asks: "plan this", "plan it", "make a plan", "let's plan",
   "draft a plan", "break this down".
2. `/ijfw-plan` slash command is invoked.
3. ijfw-workflow Deep path enters the Plan gate after Discovery + Research.
4. ijfw-spec-phase has emitted SPEC.md and the user wants HOW next.

If `.ijfw/memory/brief.md` is missing AND no SPEC.md exists for the active
slice, ask one clarifying question first: `What are we planning? (one
sentence)`. Never guess.

## Inputs (read in order, skip missing)

1. `.ijfw/memory/brief.md` — original ask + success criteria.
2. `.ijfw/memory/research.md` — anything Discovery / Research surfaced.
3. `.planning/<milestone>/<phase>/SPEC.md` — locked acceptance criteria.
4. `.planning/<milestone>/<phase>/CONTEXT.md` — decisions resolved in discuss.
5. `.planning/ROADMAP.md` — where this slice sits in the bigger arc.
6. `.planning/PROJECT.md` — non-negotiables.

Detect domain from brief language and project layout:
- Software: `package.json`, `pyproject.toml`, `Cargo.toml`, source dirs.
- Book / chapter: `manuscript/`, `chapters/`, `outline.md`, prose-heavy brief.
- Campaign / launch: `campaign/`, `assets/`, calendar / channel language.
- Design system: `tokens/`, `components/`, design-ops language.
- Research: `notes/`, `papers/`, "review the literature" framing.

Domain choice changes vocabulary, NOT the output shape.

## Output location

If a phase is active (`.ijfw/state/active-milestone` + `.ijfw/state/active-phase`
both exist), write to `.planning/<milestone>/<phase>/PLAN.md` and also mirror
the task list to `.ijfw/memory/plan.md` for the runtime gate to read.

Otherwise write the primary plan to `.ijfw/memory/plan.md`.

## PLAN.md shape (same for every domain)

```markdown
---
domain: software | book | campaign | design-system | research
time_budget: HOUR_1 | HOUR_2_3 | HOUR_4_5 | HOUR_6_PLUS
brief_ref: .ijfw/memory/brief.md
spec_ref: .planning/<milestone>/<phase>/SPEC.md  # optional
created_at: <ISO-8601>
---

# PLAN — <slice name>

## Goal
<One-sentence outcome — what ships when this plan completes.>

## Success Criteria
1. <Falsifiable, binary pass/fail.>
2. <...>

## Tasks

### Task task_id: T01 — <verb-noun title>
- **Deliverable:** <file path / chapter draft / asset / dataset>
- **Acceptance:** <done when ...>
- **Touches:** <file paths / chapter sections / channels>
- **Depends:** <task_id> | none
- **Risk:** low | medium | high — <one-line reason>

### Task task_id: T02 — ...

## Dependency Wave Table

| Wave | Tasks (parallel within wave) | Gates between waves |
|------|------------------------------|---------------------|
| W1   | T01, T02                     | none                |
| W2   | T03 (depends T01)            | T01 acceptance met  |
| W3   | T04, T05 (depends T02, T03)  | T03 acceptance met  |

## Out of Scope (Deferred to backlog)
- <Mentioned in brief but cut from this slice; reason.>
```

Multi-domain examples (substitute deliverables, keep the shape):

- **Software task:** Deliverable = `src/auth/login.ts` + test file. Acceptance
  = `npm test -- login` exit 0. Touches = `src/auth/`, `tests/auth/`.
- **Book task:** Deliverable = `chapters/04-draft.md`. Acceptance = beats 1-7
  from outline covered, POV consistent, word count ±10% of target. Touches =
  `chapters/04-*`, `outline.md`.
- **Campaign task:** Deliverable = `campaign/launch-week/email-1.html`.
  Acceptance = subject line + preview text + body locked, links tracked.
  Touches = `campaign/launch-week/`, `analytics/utm-plan.md`.
- **Design system task:** Deliverable = `tokens/color.v2.json`. Acceptance =
  contrast ratios meet WCAG AA, dark-mode pair validated. Touches = `tokens/`,
  `docs/migration.md`.

## Time-budget question (Deep only)

Before drafting, ask one AskUserQuestion to lock the time budget:

```json
{
  "question": "How much focused time do we have for this slice?",
  "header": "Time budget",
  "options": [
    { "label": "≤ 1 hour",  "description": "Up to 3 tasks; smallest viable slice" },
    { "label": "2-3 hours", "description": "Up to 7 tasks; one feature end-to-end" },
    { "label": "4-5 hours", "description": "Up to 12 tasks; meaningful slice with polish" },
    { "label": "6+ hours",  "description": "Unlimited tasks; full milestone scope" }
  ]
}
```

Record the choice in PLAN.md frontmatter as `time_budget`. The pre-dispatch
gate uses it to detect budget overrun.

## Pre-dispatch gate (mechanical, MUST RUN)

Before handing the plan to execute, run the deterministic gate that's wired
into the existing `ijfw_state` MCP tool's `subagent.post-done` verb routing
(v1.5.0 T13 — single state-SDK face, cap stays 12/12):

```js
// Library — no new MCP tool needed (cap is 12/12).
const { validatePlan } = require('./mcp-server/src/orchestrator/plan-checker.js');
const planText = fs.readFileSync('.ijfw/memory/plan.md', 'utf8');
const { findings, blocked } = validatePlan(planText, { strict: false });
```

The gate checks (all defined in `plan-checker.js`):

1. **No placeholder tokens** — `TBD`, `FIXME`, `XXX`, `[fill me in]`,
   `<placeholder>`, `???` (WARN; BLOCK in strict).
2. **Completeness** — at least one `## Task` / `### Task` / `task_id:` block
   (BLOCK if zero).
3. **Acceptance criteria** — each task mentions `acceptance` / `done when` /
   `criteria` / `expected` (WARN if missing).
4. **No empty steps** — list items under 20 chars of substantive content WARN.
5. **Dependency sanity** — `depends:` references must resolve to a declared
   `task_id:` (BLOCK on dangling).
6. **No test-skip contradiction** — "add tests" + "skip tests" in the same
   block is a BLOCK.

If `blocked === true`, surface findings and STOP. Do not dispatch.

## Pre-dispatch reality check (agent)

Dispatch `ijfw-plan-checker` against the live codebase / manuscript / asset
tree to catch re-spec of work that already exists:

```
Task: ijfw-plan-checker
Args:
  plan_path: .ijfw/memory/plan.md
  repo_root: .
```

Agent flags "NEW file" / "MODIFY <symbol>" claims that already exist. Reduces
the v1.4.4-era pain of subagents discovering duplication mid-stream.

## Output contract

After both gates pass (or with WARN-only findings explicitly acknowledged),
emit a `gate-result` block as the LAST content of your output. Use
`gate="plan"`. Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

Format follows the v1.5.0 gate-result schema (see ijfw-plan-check for the
canonical example).

## Resume intent

If user says `resume`, `resume plan`, `/ijfw-plan resume`, or `continue plan`:

1. Load `.ijfw/state/plan-hold.md`. If missing: reply `No plan on hold. Start
   a fresh plan with /ijfw-plan.` and stop.
2. Echo the recorded reason + unresolved gaps so the user knows what blocked.
3. AskUserQuestion: `Has this changed? Unblock and continue, or keep on hold?`
   - Unblock + continue → re-run pre-dispatch gate, re-offer review.
   - Keep on hold → no-op, close.
4. On unblock: annotate `.ijfw/state/plan-hold.md` with `resolved_at: <now>`
   (or delete), re-run pre-dispatch gate.

## Anti-patterns (do not do)

- Do NOT skip the pre-dispatch gate — that's the whole point of having it.
- Do NOT write implementation code inside PLAN.md — that's execute's job.
- Do NOT silently absorb scope from the brief that wasn't in SPEC.md —
  surface it as a scope leak, ask the user, then either expand SPEC.md or
  defer.
- Do NOT exceed the time-budget ceiling without flagging budget_overrun.
- Do NOT invent task_ids that don't resolve — every `depends:` must point
  somewhere real.

## Success criteria for this skill

- PLAN.md exists at the correct path for the domain.
- Every task has a deliverable, acceptance criterion, and touched-artifact
  list.
- Dependency wave-table is consistent (no inversions).
- `validatePlan()` returns `blocked: false`.
- `ijfw-plan-checker` agent has run and findings are addressed.
- `gate-result` block emitted last.
