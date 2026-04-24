---
name: ijfw-ship
description: "Run the IJFW workflow Ship phase (Deep D6). Pre-flight, deploy, and close. Usage: /ijfw-ship"
---

Run the Ship phase of the IJFW workflow. This is the final phase -- pre-flight
checks, deployment, monitoring, rollback plan, documentation, and memory update.

**Ship checklist:**

- Changelog updated with what shipped
- Deployment steps verified (or deployment executed if automated)
- Monitoring and alerting confirmed in place
- Rollback plan documented
- User-facing documentation current
- IJFW memory updated with the full project summary

**Donahoe principles enforced at ship:**

- P15: Updates invisible to users -- no action required from them
- P20: Works on all target platforms
- P21: Pricing respects the user (no surprise costs introduced)

**Ledger gate (blocks ship):** Before the SHIP GATE runs, read `.ijfw/state/execute-issues.json`:

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

Missing file = zero issues (day-1 fresh-install protection). Resolved and absent entries do not block ship.

Before running, the SHIP GATE re-reads the original brief and confirms what was
built matches what was asked. If gaps remain, ship is held until they close.

This command invokes `ijfw-workflow` at the D6 Ship phase directly.

**GATE:** The SHIP GATE must pass before deployment proceeds -- original brief
re-read, changelog updated, monitoring confirmed, rollback plan documented.

**Confidence declaration (required before push/publish):** Every ship-readiness
claim is tagged VERIFIED / LIKELY / GUESSING / ISSUE. Ship proceeds only when
every blocking claim is VERIFIED (live-run command with raw output) or LIKELY
with explicit user acknowledgement. GUESSING or ISSUE halts the ship. Publish
operations (`git push`, `git tag v*`, `npm publish`) require the user's
explicit push-word ("push it" / "ship it" / "tag and push") -- no substitute
authorization accepted. See `feedback_push_back_on_irreversible.md`.

**Natural triggers:** "ship it", "deploy", "let's ship", "go live", "time to ship",
"wrap this up."
