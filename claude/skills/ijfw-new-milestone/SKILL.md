---
name: ijfw-new-milestone
description: "Use when the user says: 'new milestone', 'next milestone', 'plan milestone', 'start milestone', 'begin v1.2', 'kick off next release', 'next chapter', 'next campaign wave', 'next design tier', /ijfw-new-milestone"
since: '1.5.0'
---

# IJFW New Milestone

Kick off a new milestone cycle on an existing project. Brownfield equivalent of project bootstrap: project exists, prior milestones shipped, you need a scoped plan for the next iteration.

Domain-agnostic. Works for software releases (v1.2 → v1.3), book chapters (Ch 4 → Ch 5), campaign waves (Wave 2 → Wave 3), design-system tiers (Foundation → Components → Patterns).

Optional `$ARGUMENTS`: milestone name (e.g. `v1.6 Notifications`, `Chapter 5: Adversarial Models`). Ask inline if absent.

## 1 — Load prior context

Read in order:
- `.planning/PROJECT.md` — core value, validated outcomes, decisions
- `.planning/ROADMAP.md` — what shipped, last milestone number/name
- `.planning/MILESTONES.md` — historical log (if present)
- `.planning/STATE.md` — pending todos, blockers carried forward
- Latest `.planning/<prior-milestone>/LEARNINGS.md` (if present) — dispatch `ijfw-extract-learnings` agent on the prior milestone first if missing; learnings inform what to do differently this cycle.

If `.planning/ROADMAP.md` is absent, dispatch `ijfw-roadmapper` agent to scaffold one from `PROJECT.md`, then resume here.

## 2 — Determine next milestone identifier

Parse the last milestone from `MILESTONES.md` or `ROADMAP.md`. Suggest the next per project convention:
- Semver: `v1.5 → v1.6` (minor) / `v1.5 → v2.0` (major)
- Chapter / Wave: `N → N+1`
- Free-form: ask the user

Confirm before writing anything.

## 3 — Gather scope (adaptive)

Ask one open question: `What do you want to ship in this milestone? (one sentence)`

Then probe by domain bucket (pick what fits, skip the rest):
- **Capabilities** — new functionality / features / chapters / campaign assets
- **Quality** — coverage, perf, accessibility, edit passes, brand consistency
- **Trust** — security, audits, fact-checks, compliance, source alignment
- **Ecosystem** — integrations, partners, distribution channels, platform support
- **Reduction** — deprecations, cuts, tightening, scope-creep kills

Per activated bucket ask: `Table stakes vs differentiators?` Table stakes go in; differentiators debated.

If prior `LEARNINGS.md` exists, surface its top 3 "do differently" items and ask which to act on.

## 4 — Verify understanding before writing

Present a summary block and ask for confirmation:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 IJFW ► MILESTONE SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Milestone: <identifier> — <name>

Goal: <one sentence>

In scope:
  - <bucket>: <item 1>, <item 2>
  - <bucket>: <item 3>

Out of scope (explicit):
  - <thing user declined>

Learnings applied:
  - <from prior LEARNINGS.md>

Success criteria (top-level):
  1. <observable outcome>
  2. <observable outcome>
  3. <observable outcome>
```

Ask: "Does this capture it? (looks good / adjust)". Loop until confirmed.

## 5 — Write artifacts

Atomically create/update:

- `.planning/<milestone>/HANDOFF.md` — skeleton with: identifier, goal, scope buckets, success criteria, "what shipped last", "what's deferred from last", initial plan-item list. This is the durable per-milestone home.
- `.planning/PROJECT.md` — append `## Current Milestone: <id>` block with goal + target buckets. Update the footer timestamp.
- `.planning/STATE.md` — reset `status` to `planning`, zero progress counters, preserve accumulated context (decisions, blockers, todos).
- `.planning/ROADMAP.md` — append milestone entry with placeholder phase list (filled in step 6).

HANDOFF.md skeleton:

```markdown
# Handoff — <Milestone Identifier>

Updated: <ISO date>
Goal: <one sentence>

## Inputs
- Prior milestone: <id> (LEARNINGS: <path or "n/a">)
- Carried forward: <pending blockers from prior STATE.md>

## Scope (in)
- <bucket>: <item>, <item>
- <bucket>: <item>

## Out of scope (explicit)
- <item> — <reason>

## Success criteria
1. <observable>
2. <observable>
3. <observable>

## Plan items (filled by ijfw-spec-phase + ijfw-discuss-phase per item)
- [ ] <item-id>: <title> — status: pending
- [ ] <item-id>: <title> — status: pending

## Resume protocol
Next session: read this file, run `/ijfw-execute <item-id>` for the first
pending item. Each item completes atomically with its own commit.
```

## 6 — Per-item clarification (dispatch downstream)

For each scope item that is non-trivial, route through:

1. `ijfw-spec-phase` skill — clarify WHAT the item delivers (success-vs-ambiguity check). Writes per-item `SPEC.md`.
2. `ijfw-discuss-phase` agent — gather context on HOW (constraints, approach, edge cases). Updates the SPEC and/or writes per-item `DISCUSS.md`.

Trivial items (one-line task, low ambiguity, no cross-cutting risk) skip both and go straight into HANDOFF.md as plan items.

Do not plan execution here. That belongs to `ijfw-plan` for each item once spec + discuss land.

## 7 — Commit

Two commits, atomic per concern:

```bash
git add .planning/PROJECT.md .planning/STATE.md
git commit -m "docs(<milestone>): start milestone — goal + scope"

git add .planning/<milestone>/HANDOFF.md .planning/ROADMAP.md
git commit -m "docs(<milestone>): handoff skeleton + roadmap entry"
```

If any `SPEC.md` / `DISCUSS.md` files landed in step 6, commit those per-item with their own atomic commits (the dispatched skill/agent handles its own commit).

## 8 — Hand off, emit:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 IJFW ► MILESTONE <id> INITIALIZED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Milestone: <id> — <name>
Items: <N> planned (<M> spec'd, <K> discussed)
Artifacts:
  - .planning/<milestone>/HANDOFF.md
  - .planning/PROJECT.md (updated)
  - .planning/ROADMAP.md (updated)
  - .planning/STATE.md (reset)

Next: `/ijfw-plan <first-item-id>` to plan execution of the first item.
```

## Invariants

- Never overwrite a non-empty `HANDOFF.md` without explicit "yes, overwrite"; use it as input if present.
- Never delete prior milestone directories — they're historical record; archival is separate explicit action.
- Domain words (phase / chapter / wave / tier) come from `PROJECT.md`'s "Project type" — never hardcoded.
- All artifacts plain markdown. Positive framing: "Ready to plan" not "nothing planned yet".

## Downstream skills/agents referenced

- `ijfw-roadmapper` (agent, W12-B C03) — scaffolds initial ROADMAP.md when absent
- `ijfw-spec-phase` (skill, W12-B C05) — per-item WHAT clarification
- `ijfw-discuss-phase` (agent, W12-B C05) — per-item HOW context
- `ijfw-extract-learnings` (agent, W12-B C06) — prior-milestone learnings
- `ijfw-plan` (existing) — per-item execution planning (user calls after this skill exits)
