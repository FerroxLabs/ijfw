---
name: ijfw-spec-phase
description: "Use when the user says 'spec this', 'scope this slice', 'lock requirements', 'what are we building', or before any planning / execution call where requirements are ambiguous. Produces a falsifiable SPEC.md that locks WHAT before HOW."
since: '1.5.0'
allowed-tools: Read, Write, Bash, Grep, Glob, AskUserQuestion, Agent
---

# IJFW Spec-Phase -- lock WHAT before HOW

You are the orchestrator-facing trigger that produces
`.planning/<milestone>/<phase>/SPEC.md` for the active phase. SPEC.md captures
falsifiable acceptance criteria, explicit in-scope / out-of-scope boundaries,
and dependencies -- BEFORE plan-phase touches HOW to implement.

Domain-agnostic. Same flow for: software slice ("user auth"), book chapter
("Ch4 scope, POV lock, must-cover beats"), campaign slice ("launch week 1
channel mix"), research milestone ("literature review boundaries").

## When to fire

1. User explicitly asks: "spec this", "scope this", "lock requirements".
2. plan-phase / execute-phase is requested but no SPEC.md exists for the
   active slice under `.planning/<milestone>/<phase>/`.
3. ijfw-workflow Deep path enters the Plan gate with unclear requirements.

## Process

### 1. Locate the active phase

```bash
MILESTONE=$(cat .ijfw/state/active-milestone 2>/dev/null \
  || ls -1 .planning/ | grep -E '^[0-9]' | tail -1)
PHASE=$(cat .ijfw/state/active-phase 2>/dev/null || echo "$1")
PHASE_DIR=".planning/${MILESTONE}/${PHASE}"
mkdir -p "$PHASE_DIR"
```

If `$PHASE` is unset and not supplied as argument, ASK the user which phase
to spec. Never guess.

### 2. Load context

Read in order, skipping any that don't exist:

1. `.ijfw/memory/brief.md`   -- the original ask
2. `.planning/ROADMAP.md`    -- where this phase sits
3. `.planning/<milestone>/ROADMAP.md` -- milestone-scoped roadmap
4. Any prior `SPEC.md` / `CONTEXT.md` from earlier phases in this milestone
5. `.planning/PROJECT.md`    -- non-negotiables

Extract: phase goal, declared boundaries, prior decisions that flow forward.

### 3. Identify ambiguities (gray areas)

For the phase, list:

- **What's clear**   -- requirements with one obvious interpretation.
- **What's gray**    -- decisions that could go multiple ways and would
  change the result. Each gray area is a single sentence.
- **What's decided** -- already locked in a prior phase's CONTEXT.md or SPEC.md.

If gray-area count is zero: skip Step 4 and write SPEC.md directly using
captured-as-clear requirements.

### 4. Dispatch ijfw-discuss-phase (if gray areas exist)

```
Task: ijfw-discuss-phase
Args:
  milestone: $MILESTONE
  phase: $PHASE
  gray_areas: [list of one-line ambiguities]
  prior_decisions_path: .planning/<milestone>/*/CONTEXT.md
```

The agent will interrogate the user adaptively (AMBIGUITY SCORING -- top 3-5
gray areas by impact x uncertainty), capture decisions to
`$PHASE_DIR/CONTEXT.md`, and return when the user is satisfied OR escalates.

Wait for the agent. Do NOT proceed to SPEC.md until CONTEXT.md exists.

### 5. Write SPEC.md

After CONTEXT.md is locked (or skipped if no gray areas), write to
`$PHASE_DIR/SPEC.md` with these sections:

```markdown
# SPEC -- <milestone> / <phase>
**Locked:** <ISO date>  **Status:** Ready for plan-phase

## Goal
<One-sentence outcome -- what the user can do / see / read / receive
 when this slice is shipped.>

## Acceptance Criteria
Each MUST be falsifiable (binary pass/fail; no "should" / "nice").
1. <Criterion>
2. <Criterion>

## In Scope
- <Capability / artifact / chapter section>

## Out of Scope (Deferred)
- <Mentioned but pushed to a later slice>

## Dependencies
- **Inputs:**   <Required from prior slices / external>
- **Outputs:**  <Handed to the next slice>
- **External:** <APIs, libraries, vendors, sources>

## Domain Notes
<Software: data shapes, contracts. Book: POV, tone, chapter beats.
 Campaign: audience, channel mix, KPI target.>

## Canonical References
- CONTEXT.md (this slice's decisions)
- <Any ADRs / specs / prior SPEC.md cited>
```

### 6. Commit + report

```bash
git add "$PHASE_DIR/SPEC.md"
git commit -m "spec($PHASE): lock requirements before plan-phase"
```

Report to orchestrator:

```
SPEC.md ready: <path>
Acceptance criteria: <N>
Gray areas resolved: <M>
Deferred items: <K>
Next: /ijfw-plan-phase $PHASE
```

## Anti-patterns (do not do)

- Do NOT write SPEC.md without resolving gray areas first (defeats the point).
- Do NOT include implementation details (those belong in plan-phase output).
- Do NOT silently re-decide things already locked in prior CONTEXT.md files.
- Do NOT exceed phase boundary from ROADMAP.md -- scope creep gets deferred,
  not absorbed.

## Success criteria

- SPEC.md exists at `.planning/<milestone>/<phase>/SPEC.md`.
- Every acceptance criterion is binary-falsifiable.
- In-scope / out-of-scope are explicit (no ambiguity at boundary).
- Dependencies cite concrete inputs and outputs.
- CONTEXT.md exists alongside if any gray areas were interrogated.
- Commit landed; orchestrator can hand off to plan-phase.
