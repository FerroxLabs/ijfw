---
name: ijfw-complete-milestone
description: "Use when a milestone is shipping and you need to archive its artifacts, generate a summary, and seed the next milestone. Trigger: 'milestone complete', 'ship milestone', 'wrap milestone', 'complete milestone <id>', /ijfw-complete-milestone."
since: '1.5.0'
---

Archive a completed milestone, capture what shipped, and surface the next milestone. Domain-agnostic -- a milestone may be a software release, a book part, a campaign wave, a design-system tier, or any other top-level project unit defined in `.planning/ROADMAP.md`.

## Inputs

- Milestone identifier (e.g. `1.5.0`, `part-two`, `wave-3`). If the user did not name one, ask once: `Which milestone are we wrapping?` Accept any string that appears as a milestone heading in `.planning/ROADMAP.md`.

## Process

1. **Verify completion.**
   - Read `.planning/ROADMAP.md`. Find the milestone block for `<id>`.
   - List every phase under that milestone. For each phase, check that it is marked complete (e.g. `[x]`, `status: complete`, `shipped`, or has a `SUMMARY.md` in `.planning/<milestone>/<phase>/`).
   - If any phase is incomplete: surface the gap and ask `Proceed anyway and treat the open phase as deferred? (y / fix first)`. Do not auto-advance.

2. **Extract learnings (dispatch agent).**
   - Dispatch `ijfw-extract-learnings` with the milestone scope. The agent reads every `SUMMARY.md`, `RETRO.md`, and commit message in `.planning/<milestone>/**` and writes `.planning/<milestone>/LEARNINGS.md` (decisions, surprises, patterns, lessons).
   - If the agent is unavailable in this runtime, write a stub `LEARNINGS.md` with `_pending: dispatch ijfw-extract-learnings when available_` and surface the gap.

3. **Generate milestone summary (dispatch skill).**
   - Dispatch `ijfw-milestone-summary` with `<id>`. The skill writes `.planning/<milestone>/SUMMARY.md` -- stats, accomplishments, timeline, contributors -- suitable for a release post, book-part wrap, campaign retro, or design-tier handoff.
   - Paste the summary's first 6 lines in-chat so the user sees what landed.

4. **Confirm with user.**
   - Show: milestone id, phase count, days elapsed (first → last commit in scope), first line of SUMMARY.md, first 3 LEARNINGS entries.
   - Ask: `Archive and seed next milestone? (yes / show full summary / hold)`.
   - On `hold`: stop. The artifacts remain in place; the user can re-run later.

5. **Archive artifacts.**
   - Move `.planning/<milestone>/` → `.planning/_archive/<milestone>/`. Preserve full directory tree. Create `.planning/_archive/` if absent.
   - Leave `SUMMARY.md` and `LEARNINGS.md` discoverable at `.planning/_archive/<milestone>/SUMMARY.md` and `.planning/_archive/<milestone>/LEARNINGS.md`.
   - Never delete -- only move. Archive is the historical record.

6. **Update ROADMAP.md.**
   - Collapse the milestone block to a single line:
     ```
     - [x] <id> -- shipped <YYYY-MM-DD>. See `.planning/_archive/<id>/SUMMARY.md`.
     ```
   - If a next milestone is already drafted in ROADMAP.md, mark it `[ ] <next-id> -- next` so it is visually surfaced.
   - If no next milestone exists, append:
     ```
     - [ ] _next milestone_ -- run `/ijfw-workflow` or `/gsd-new-milestone` to define.
     ```

7. **Write memory entry.**
   - Call `ijfw_memory_store` with:
     - `key`: `milestone_<id>_shipped`
     - `value`: first 200 chars of SUMMARY.md plus the line count of LEARNINGS.md
     - `tags`: `['milestone', 'shipped', <id>]`
   - If the MCP tool is unavailable, append the same entry to `.ijfw/memory/MEMORY.md` under a `## Milestones Shipped` section.

8. **Tag the commit (optional, with confirmation).**
   - Ask: `Tag this commit as 'milestone-<id>'? (y / custom / skip)`.
   - On `y`: run `git tag -a milestone-<id> -m "<first line of SUMMARY.md>"`.
   - On `custom`: accept the user's tag string, then tag.
   - On `skip`: continue without tagging.
   - Never push the tag automatically. Surface the push command: `git push origin milestone-<id>`.

9. **Commit the archive + roadmap change.**
   - Stage `.planning/_archive/<milestone>/`, `.planning/ROADMAP.md`, and `.ijfw/memory/MEMORY.md` (if touched).
   - Commit message:
     ```
     chore(milestone): archive <id> + seed next milestone

     - LEARNINGS.md captured (<N> entries)
     - SUMMARY.md captured (<M> lines)
     - ROADMAP.md collapsed to one-line entry
     - Memory: milestone_<id>_shipped
     ```
   - Surface the SHA back to the user.

10. **Closer.**
    - One-line receipt:
      > `You went from <id> open with <N> phases to archived with summary, learnings, memory, and tag in <M> minutes.`
    - Suggest the next move: `Run /ijfw-workflow to plan the next milestone, or /gsd-new-milestone for the full questioning loop.`

## Critical rules

- **Archive before mutating.** Always move `.planning/<milestone>/` to `.planning/_archive/<milestone>/` before collapsing ROADMAP.md. If the archive move fails, abort the roadmap edit.
- **One-line ROADMAP entry.** Collapsed milestones must be a single line with a link to the archive. This keeps ROADMAP.md constant-size as the project grows.
- **No silent skips.** If a phase is incomplete, the user must say `proceed` -- never assume.
- **Memory is mandatory.** A shipped milestone the next session can't recall is a workflow failure. If `ijfw_memory_store` is unavailable, fall back to the markdown append; never skip.
- **Tags are user-gated.** Never tag without explicit `y`. Never push tags.
- **Domain agnostic.** Phases in a book milestone (chapters), a campaign milestone (channels), or a design-system milestone (tiers) all use the same archive path and lifecycle -- do not hardcode software vocabulary.

## Output contract

Final message to the user, in this order:
1. Receipt line (`You went from ...`).
2. Archive path (`.planning/_archive/<id>/`).
3. Commit SHA.
4. Tag (if created) and the push command.
5. Suggested next move.
