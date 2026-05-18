---
name: ijfw-ship
description: "Use when the user says 'ship it', 'ship this', 'release', 'publish', 'launch', 'deploy', 'go live', 'wrap this up', 'time to ship', or invokes '/ijfw-ship'. Domain-aware release — software (test → tag → push → publish), book (final edit → format → KDP / agent / Substack), campaign (review → schedule → launch → first-24h monitor), landing page (deploy → analytics → mobile + a11y re-check), design system (publish → announce → adoption). Reads the issue ledger, runs the SHIP gate, requires the user's push-word for irreversible ops."
since: '1.5.0'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Agent
---

# IJFW Ship — domain-aware release closer

You are the orchestrator-facing trigger that closes a slice and pushes it
into the world. Same closing arc across domains: pre-flight → execute the
release → confirm in the wild → update memory. The verb "ship" differs by
domain; the discipline doesn't.

This skill is the body for the `/ijfw-ship` slash command. Both paths land
here.

## When to fire

1. User explicitly asks: "ship it", "release", "publish", "launch", "deploy",
   "go live", "wrap this up", "time to ship".
2. `/ijfw-ship` slash command is invoked.
3. ijfw-workflow Deep path enters the Ship gate after Verify.

## Domain detection

Detect from project layout + brief language:

| Domain         | Signals                                                | Ship verb       |
|----------------|--------------------------------------------------------|-----------------|
| software       | `package.json` / `pyproject.toml` / `Cargo.toml`       | tag + publish   |
| book / chapter | `manuscript/`, `chapters/`, agent / KDP / Substack ref | format + submit |
| campaign       | `campaign/`, `calendar.md`, channel language           | schedule + send |
| landing page   | `next.config.*`, `astro.config.*`, deploy host configs | deploy + verify |
| design system  | `tokens/`, `components/`, registry / npm package       | publish + announce |

If the domain is ambiguous, ask one AskUserQuestion: `What are we shipping?`
with the five options above. Never guess.

## Pre-ship checklist (domain-aware)

### Software
- CHANGELOG.md updated with what's in this release.
- Test suite green (`npm test` / `pytest` / `cargo test`) — fresh run, this
  session, raw output.
- Version bumped in `package.json` / equivalent.
- Tag drafted (`v<MAJOR>.<MINOR>.<PATCH>`); push deferred until push-word.
- Rollback plan documented (`npm deprecate` / `cargo yank` / revert + retag).

### Book / chapter
- Manuscript final edit pass done.
- Format pass complete (epub / pdf / docx, depending on channel).
- Front-matter (title page, copyright, dedication, ISBN if owned) present.
- Cover + back-cover copy finalised.
- Target channel decided: Amazon KDP, agent submission, Substack, direct.
- Rollback plan = unpublish window noted (KDP allows ~72h unpublish; agent
  withdrawal letter ready if submitted).

### Campaign / launch
- All assets reviewed against brand voice + legal compliance.
- Send schedule locked (calendar + timezone).
- Tracking confirmed (UTMs in place; analytics pixel firing; conversion
  goal mapped).
- First-24h monitoring plan + owner identified.
- Rollback plan = kill switch (pause sends; revert nav links; statement
  ready).

### Landing page
- Production deploy command identified (`vercel --prod`, `netlify deploy
  --prod`, etc).
- Analytics live and verified (real pageview registered in dashboard).
- Mobile re-check: iPhone + Android viewport screenshot.
- Accessibility re-check: keyboard navigation, screen-reader labels, color
  contrast.
- Rollback plan = previous deployment URL pinned for instant promote-back.

### Design system
- Package version bumped + CHANGELOG entry written.
- Visual regression suite green (Chromatic / Loki / Percy).
- Migration guide drafted for consumers if breaking change.
- Announcement copy drafted (Slack / Discord / mailing list).
- Rollback plan = `npm deprecate <pkg>@<version>` script ready.

## Donahoe principles enforced at ship

- **P15:** Updates invisible to users — no action required from them.
- **P20:** Works on all target platforms.
- **P21:** Pricing respects the user (no surprise costs introduced).

## Ledger gate (BLOCKS ship)

Before the SHIP gate proper, read `.ijfw/state/execute-issues.json`:

```bash
read_issues() {
  local f=".ijfw/state/execute-issues.json"
  [ -f "$f" ] || { printf '{"issues":[]}'; return; }
  cat "$f"
}
```

If any entry has `status: unresolved` (any `kind`), ship is refused:

```
ISSUE: ship-blocked-by-unresolved-issues
  count: <N>
  ids: [iss_001, iss_002]
  action: resolve all issues before shipping
```

Missing file = zero issues (day-1 fresh-install protection).

## SHIP gate — brief reconciliation

Before any push / send / publish, re-read `.ijfw/memory/brief.md` and confirm
what was built matches what was asked. If gaps remain, ship is held until
they close.

## Cross-audit gate (Trident, optional but recommended)

Before irreversible release ops, recommend invoking `ijfw-cross-audit` as a
second-opinion gate on the release diff / final draft / campaign brief.
Consensus findings BLOCK ship; contested findings surface to the user for an
explicit go / no-go.

## Confidence declaration (required before push / publish)

Every ship-readiness claim is tagged VERIFIED / LIKELY / GUESSING / ISSUE.
Ship proceeds only when every blocking claim is VERIFIED (live-run command
with raw output) or LIKELY with explicit user acknowledgement. GUESSING or
ISSUE halts the ship.

Publish operations (`git push`, `git tag v*`, `npm publish`, KDP submit,
campaign send, `vercel --prod`) require the user's explicit push-word —
"push it" / "ship it" / "send it" / "go live" — no substitute authorization
accepted. See `feedback_push_back_on_irreversible.md`.

## Release-mechanics offload (software domain)

For software releases, dispatch `ijfw-release-eng` so version-bump / tag /
push / publish-watch / smoke-rollback don't fragment orchestrator context:

```
Task: ijfw-release-eng
Args:
  target_version: <semver>
  publish_target: npm | container | github-release
```

Watch the agent's exit; if smoke fails post-publish, follow its rollback
recipe.

## Post-ship close-out

After the release lands successfully:

1. Update `.ijfw/memory/` with the ship summary (what shipped, what's next).
2. Write `.planning/<milestone>/SHIPPED.md` if a milestone is active.
3. If software: confirm tag visible on remote (`git ls-remote --tags`).
4. If book: confirm channel listing live (KDP dashboard / agent receipt).
5. If campaign: confirm first sends went out; monitoring dashboard pinned.
6. If landing page: confirm production URL serves the new build.
7. If design system: confirm package version resolves on the public registry.

## Output contract

Emit a `gate-result` block as the LAST content of your output. Use
`gate="ship"`. Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

Format follows the v1.5.0 gate-result schema (see ijfw-plan-check for the
canonical example).

## Anti-patterns (do not do)

- Do NOT push / publish without the user's explicit push-word.
- Do NOT skip the ledger gate — unresolved issues block ship for a reason.
- Do NOT claim "shipped" without VERIFIED confirmation the release is live.
- Do NOT bypass the brief reconciliation just because the plan said "done".
- Do NOT mix domains' checklists — use the one that matches the project.

## Success criteria for this skill

- Pre-ship checklist for the detected domain is complete.
- Ledger gate passed (no unresolved issues).
- SHIP gate passed (brief reconciled).
- User issued an explicit push-word before any irreversible op.
- Release landed and was VERIFIED in the wild.
- Memory + milestone docs updated.
- `gate-result` block emitted last.
