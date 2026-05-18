# Launch Phase Pattern

A launch is a coordinated one-shot event with a fixed T-zero, multiple stakeholders, irreversible-on-the-day decisions, and a narrow blast radius for mistakes. Unlike a campaign (a window) or a release (recurring), a launch is a singular orchestrated moment. The dominant risk is misaligned readiness — one stream not-ready takes down the whole launch.

## Phase: Think

Pin the launch window (date + time + duration), the irreducible risks (what could fail catastrophically), and the abort conditions (what triggers a no-go). Define what "launched" means precisely — is it the press release going live, the product going GA, the keynote starting, the partner press hitting? Pin a single owner who can call go/no-go.

Output is a `LAUNCH-CHARTER.md`: T-zero datetime + timezone, definition of launched, top 5 risks with mitigations, abort conditions (named, measurable), go/no-go owner, blast-radius assessment.

Done signal:
- T-zero is one datetime with timezone, not a range
- "Launched" is a single observable event
- Abort conditions are measurable (not "if things go wrong")
- Single go/no-go owner identified and committed

## Phase: Plan

Build a reverse-chronology timeline from T-zero backward: T-7d, T-3d, T-1d, T-4h, T-1h, T-0, T+1h, T+24h. Every stakeholder gets named milestones with explicit handoffs. Asset list: press release, blog post, social posts, email blast, in-product banner, support docs, FAQ, internal comms. Comms tree: who tells whom, in what order, when.

Done signal:
- Reverse-timeline with every milestone, owner, and dependency
- Comms tree with primary + backup contact per stakeholder
- Asset list with owner, status, and freeze-date per asset
- Ops runbook started (deploy steps, monitoring dashboards, on-call rotation)
- Dry-run scheduled at T-3d or earlier

## Phase: Build

Produce assets per the timeline. Build the ops runbook — exact commands, dashboards, escalation paths. Stand up monitoring with the metrics that define success and the alarms that define failure. Stage everything: assets in CMS, posts in scheduler, code on a release branch, ops runbook in shared doc. Nothing fires yet.

Done signal:
- All assets at "final" status, locked at freeze-date
- Ops runbook complete with named on-call rotation
- Monitoring dashboards live, alarms configured and routed
- Release branch / staged artifacts ready
- Communications scheduled (drafts loaded in tools, not yet sent)

## Phase: Verify

Dry-run end-to-end: walk the runbook, send to seed channels, validate the comms tree by paging the backup contacts. Comms readiness: every external party briefed, every internal team aware. Asset QA: every link, every embed, every byline. Go/no-go gate: structured meeting at T-24h with each stream lead saying GO or NO-GO with evidence.

Done signal:
- Dry-run completed; gaps fixed and re-tested
- Every comms-tree contact confirmed reachable
- Every asset link validated against production destinations
- T-24h go/no-go meeting held with explicit GO from each stream lead
- Rollback / unlaunch procedure rehearsed and timed

## Phase: Ship

T-zero coordination: a single coordinator on a single channel, runbook open, dashboards visible. Execute the runbook step-by-step, confirm each step before the next. Live monitoring through T+1h critical window, T+24h sustained watch. Post-launch retro within 7 days while memory is fresh — what fired correctly, what didn't, what near-misses to flag for next launch.

Done signal:
- T-zero executed per runbook with confirmed completion of each step
- Definition-of-launched event observed and confirmed
- T+1h monitoring window: no critical alarms, or alarms triaged with action
- T+24h sustained check: success metrics tracking to forecast
- Stakeholder thank-you / debrief comms sent
- Retro held within 7 days; learnings filed for next launch

## Cross-cutting notes

- **One coordinator, one channel.** Launches die when coordination splits across three Slack threads and a Zoom call. One human, one room.
- **The dry-run is the launch.** If you skip the dry-run, you ARE doing the dry-run at T-zero with customers watching.
- **Abort conditions are sacred.** Pre-declare them in Think. At T-zero, emotional momentum will fight the abort decision — pre-commitment wins.
- **Memory entries to watch:** "near-miss caught at dry-run," "comms-tree gap," "metric that surprised us in T+1h." These compound across launches.
- **Retro within 7 days or skip it.** Beyond a week, memory degrades and learning is lost — the retro is part of Ship, not optional follow-up.
