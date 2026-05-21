---
name: ijfw-milestone-summary
description: "Use when the user asks for a milestone summary, milestone recap, or to summarize a milestone -- or runs /ijfw-milestone-summary. Trigger: 'milestone summary', 'summarize milestone', 'milestone recap', 'onboard someone to this release', 'what shipped in v<X>', invoked by ijfw-complete-milestone."
since: '1.5.0'
---

Produce an onboarding doc for someone joining mid-stream. Output: `.planning/<milestone>/SUMMARY.md`.

Domain-agnostic: "what shipped" means chapters drafted for a book, launches that landed for a campaign, features released for software, episodes recorded for a podcast. Adapt the noun to the project type.

## Step 1 -- Resolve milestone

Argument is the milestone slug (e.g. `1.5.0`, `q2-launch`, `book-draft-2`). If absent:
1. Read `.ijfw/state/workflow.json` -- use the current milestone field.
2. Else read `.planning/ROADMAP.md` -- pick the active milestone.
3. Else list directories under `.planning/` and ask which one.

Set `MS="<resolved-slug>"`. Set `OUT=".planning/${MS}/SUMMARY.md"`.

## Step 2 -- Inventory artifacts

Read whatever exists, skip whatever doesn't. Missing files are normal -- the doc adapts.

- `.planning/ROADMAP.md` -- scope, dates, status of each item.
- `.planning/${MS}/SUMMARY.md` -- prior version (overwrite guard, see Step 6).
- `.planning/${MS}/**/SUMMARY.md` -- per-item outcomes.
- `.planning/${MS}/**/LEARNINGS.md` -- per-item decisions (written by ijfw-extract-learnings / C06).
- `.planning/${MS}/**/VERIFICATION.md` -- gaps, deferred items.
- `CHANGELOG.md` -- the `${MS}` entry if present.
- Git log for the milestone tag range:
  - If `v${MS}` tag exists: `git log --oneline v${MS}` and `git log v${MS}~1..v${MS} --stat`.
  - Else: `git log --since="<earliest .planning/${MS}/ commit date>" --oneline`.
  - Else: skip git stats.

## Step 3 -- Synthesize

Compose the doc with these six sections in this order. Plain English. No jargon a new contributor wouldn't know.

### What shipped
One paragraph, 3-5 sentences. Lead with the user-visible outcome ("v1.5.0 shipped runtime honesty + pluggability completion -- the workflow now self-audits, dispatches parallel subagents, and runs cross-model critique unattended"). Avoid implementation detail. Adapt the noun:
- software: features shipped
- book: chapters drafted, edits landed
- campaign: launches that landed, channels lit up
- podcast: episodes recorded and published
- research: papers drafted, experiments concluded

### Scope shipped
Table of items in the milestone -> outcome. Pull item names from ROADMAP.md scope list; pull outcomes from per-item SUMMARY.md `one_liner` (fall back to first H1 sentence). Status column: `done | partial | deferred`.

```
| Item   | Outcome                          | Status   |
|--------|----------------------------------|----------|
| <name> | <one-liner>                      | done     |
```

### Scope deferred
List items that were planned but cut. For each: name, one-line rationale (from LEARNINGS.md "deferred" sections, RETROSPECTIVE.md, or VERIFICATION.md gaps), and where it lives next (`v<next>` backlog, indefinitely parked, etc.).

If nothing was deferred: say so in one line. Do not pad.

### Key decisions
Aggregate from per-item LEARNINGS.md. For each decision: one-line restatement + link to the source file. Format:

```
- **<decision>** -- <one-line rationale>. See [<phase>/LEARNINGS.md](<relative-path>).
```

Top 5-7 only. If LEARNINGS.md files are absent (C06 hasn't run), fall back to CONTEXT.md or SUMMARY.md "decisions" sections; if neither, list the empty section with a one-line note "decisions log not captured for this milestone".

### Known gaps / followups
From VERIFICATION.md gaps, RETROSPECTIVE.md "what to improve", and any open issues tagged with the milestone. Each item: one line, with severity if obvious (`blocking | annoying | nice-to-have`).

### How to continue
One paragraph for someone picking up next. Cover: (1) where to start reading next (next milestone's ROADMAP or active HANDOFF), (2) the single command/skill to invoke (`/ijfw-workflow`, `/gsd-new-milestone`, etc.), (3) any state file they should load. End with one sentence on the next milestone's working title if known.

## Step 4 -- Stats footer (only if git data available)

Append after the six sections:

```
---
Timeline: <start-date> -> <end-date> (<duration>)
Commits:  <N>
Files:    <N> changed (+<ins> / -<del>)
Authors:  <comma-separated list>
```

Skip silently if no tag and no date range could be determined.

## Step 5 -- Length & tone gate

Cap at ~400 lines of output markdown. If a section runs long, summarize and link to the source artifact rather than inlining. Tone is operator-direct: facts first, no celebration, no hedging. Adjectives must earn their keep.

## Step 6 -- Write & commit

If `${OUT}` already exists and the caller did not pass `--overwrite`:
- Standalone invocation: ask the user `SUMMARY.md exists for ${MS}. Overwrite or view existing?`
- Invocation from ijfw-complete-milestone (C04): overwrite without prompt -- the milestone is closing and the summary must reflect final state.

Write the file. Then commit on the current branch:

```
git add ".planning/${MS}/SUMMARY.md"
git commit -m "docs(${MS}): milestone summary for onboarding"
```

## Step 7 -- Output to caller

Print the resolved path and a 3-line excerpt of "What shipped" so the calling skill (or user) can verify the result inline without re-reading the file.

```
Wrote: .planning/${MS}/SUMMARY.md
What shipped: <first 3 lines of the section>
```

## Notes

- Standalone-runnable: works without a parent skill in context.
- Called by ijfw-complete-milestone (C04); also runnable by hand any time after a milestone is mostly done.
- Pulls from C06 output (per-phase LEARNINGS.md). If C06 hasn't run, the "Key decisions" section degrades gracefully.
- Domain-agnostic: never assume software. Detect from PROJECT.md / brief / file types and adapt the noun.
- This skill writes one doc and stops. It does NOT archive the milestone, advance state, or tag releases -- those belong to ijfw-complete-milestone.
