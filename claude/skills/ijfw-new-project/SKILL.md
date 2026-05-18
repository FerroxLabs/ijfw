---
name: ijfw-new-project
description: "Bootstrap a fresh project of any domain -- software, book, marketing campaign, landing page, design system, or product launch. Trigger: 'new project', 'start a project', 'bootstrap project', 'init a project', 'scaffold a project', /ijfw-new-project"
since: '1.5.0'
---

# IJFW New Project

Domain-agnostic bootstrap. Software is one domain; book, campaign,
landing-page, design-system, and launch are first-class peers. The end state
is the same: a confirmed brief, durable memory, and a clear next move.

## Step 1 -- Detect domain (one question, max)

Read the user's first line. Map silently:

| Phrase contains | Domain |
|---|---|
| "app", "site", "API", "service", "CLI", "library", "tool" | `software` |
| "book", "chapter", "manuscript", "novel", "essay collection" | `book` |
| "campaign", "ad", "funnel", "email sequence", "drip" | `campaign` |
| "landing page", "one-pager", "splash", "lead magnet" | `landing-page` |
| "design system", "component library", "brand kit", "tokens" | `design-system` |
| "launch", "release plan", "PR/FAQ", "go-to-market" | `launch` |

If no signal, ask once: `One word: software / book / campaign / landing-page / design-system / launch?`
Accept aliases. Do not interrogate. Do not assume software.

## Step 2 -- Memory recall

Call `ijfw_memory_recall` with the project name + domain. If matches return,
surface up to 3 relevant prior decisions inline:

> `I remember: <project> -- <decision>. Want me to apply that pattern here?`

If empty, say `clean slate -- no prior context` and continue. Never silent.

## Step 3 -- Brief skeleton

Write `.ijfw/memory/brief.md` from the domain template:

- `software`         -> `claude/skills/ijfw-new-project/templates/software.brief.md`
- `book`             -> `claude/skills/ijfw-new-project/templates/book.brief.md`
- `campaign`         -> `claude/skills/ijfw-new-project/templates/campaign.brief.md`
- `landing-page`     -> `claude/skills/ijfw-new-project/templates/landing-page.brief.md`
- `design-system`    -> `claude/skills/ijfw-new-project/templates/design-system.brief.md`
- `launch`           -> `claude/skills/ijfw-new-project/templates/launch.brief.md`

If the template file is absent in this checkout, fall back to a minimal
skeleton (goal / audience / success criteria / out-of-scope / first move).
Templates are the contract; the skill must still produce a brief if they
haven't shipped yet.

The skeleton fields are domain-shaped, not software-shaped:
- `book` -> premise / reader / chapter spine / voice / publication target
- `campaign` -> offer / audience / channels / KPI / objection map
- `landing-page` -> promise / proof / CTA / scroll narrative / metric
- `design-system` -> tokens / primitives / patterns / governance / consumers
- `launch` -> PR/FAQ / target date / channels / readiness gates

## Step 4 -- Socratic fill (one question at a time)

Walk the user through the brief in order. ONE question per turn. Echo back
every 3 turns: `So far: <2-line recap>. Yes?`

Never paste the empty template and wait. Never dump a numbered list. The
brainstorm-discipline invariants from `ijfw-workflow` apply: one question,
no offscreen research, no silent advance, visible deliverable.

If the user gives a thin answer, do one 5-Why drill, then move on. If they
say `enough` or `skip`, stop filling and move to LOCK with what you have.

## Step 5 -- ROADMAP stub (optional, prompted)

After brief is full, ask once: `Want a milestone roadmap stub now, or jump to first move?`

On `roadmap`: write `.planning/ROADMAP.md` with 3-5 milestones inferred from
the brief. Each milestone is one line: name + success criterion. No tasks
yet -- that belongs to `ijfw-plan` per milestone.

On `jump`: skip ROADMAP. The brief alone is enough to start.

Mark the active milestone with `.planning/<milestone>/` directory + an empty
`MILESTONE.md` placeholder. Future planning skills key off this directory.

## Step 6 -- Persist + LOCK

Call `ijfw_memory_store` with:

- `key`: `project_meta`
- `value`: JSON object `{domain, name, brief_path, created_at, milestone}`

This is the single source of project type identity for downstream skills.
`ijfw-design`, `ijfw-plan-check`, `ijfw-workflow`, `ijfw-verify`, and
`ijfw-ship` all read `project_meta.domain` to adapt their checklists.

Paste the brief back in-chat (max 8 lines) and end:

> `Project locked. Brief at .ijfw/memory/brief.md. Domain: <domain>.`
> `Next: <recommended-next-skill>` (software -> `ijfw-plan`, book -> chapter outline, campaign -> offer matrix, etc.)

## Step 7 -- Seed AGENTS.md (idempotent)

Invoke the `ijfw-agents-md` skill with intent context (brief.md). It will
seed AGENTS.md and the platform adapter (CLAUDE.md, GEMINI.md, etc.) only
if those files are absent. Already-present files are left untouched.

## Domain non-negotiables

- Do not assume software. Phrases like "tests", "deploy", "CI" are
  domain-specific; do not surface them outside `software` / `landing-page`.
- Do not require git. A book or campaign project may have no repo at all.
  Skip git-dependent steps gracefully; tell the user once if skipped.
- Do not write code. This skill produces a brief, a memory record, and an
  optional roadmap. Implementation belongs to downstream skills.

## Output format

```
DOMAIN:   <detected or chosen>
BRIEF:    .ijfw/memory/brief.md (<N> lines)
ROADMAP:  .planning/ROADMAP.md (<N> milestones) | skipped
MEMORY:   project_meta stored
NEXT:     <recommended next skill or command>
```
