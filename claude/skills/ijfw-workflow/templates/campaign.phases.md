# Campaign Phase Pattern

A campaign is a coordinated multi-asset push with a fixed audience, a measurable objective, and a hard window. Unlike a product, it has a defined end date and its success is measured against pre-declared KPIs. The dominant risk is asset-channel mismatch and uncoordinated launch timing.

## Phase: Think

Pin three things before anything else: the audience (one persona, sharp enough that a stranger can describe them), the objective (one measurable outcome — leads, signups, sales, awareness lift), and the core message (one sentence the audience will be able to repeat). Everything else flows from these.

Output is a `CAMPAIGN-BRIEF.md` with audience, objective + KPI target + measurement method, message, success/abort thresholds, and budget envelope.

Done signal:
- Audience is one sentence specific enough to fail a stranger test
- Objective has a number and a deadline ("500 demo signups by June 30")
- Message survives the elevator-pitch test
- Abort threshold is named (when do we kill mid-flight?)

## Phase: Plan

Map channels to audience reach (email, social, paid, organic, partnerships, events). Sequence them — most campaigns need a teaser → reveal → sustain → close arc, not a single blast. Enumerate every asset needed per channel (subject lines, headlines, hero images, copy variants, landing pages, ad creative, follow-up sequences). Identify dependencies and owners.

Done signal:
- Channel mix justified against audience media habits
- Sequence diagram with date for each touchpoint
- Asset list per channel with owner and due date
- Tracking plan: UTM scheme, conversion events, dashboard ready

## Phase: Build

Asset production per channel, on the sequence schedule. Build with the asset list as ground truth — no drift, no scope creep without re-Plan. Each asset gets a draft → review → final state. Keep a single source of truth for copy variants so a last-minute message tweak propagates everywhere.

Done signal:
- All assets at "final" status with sign-off
- Landing pages live (but behind a staging URL until Ship)
- Tracking pixels and analytics events verified firing
- Send/post calendar populated with exact send times

## Phase: Verify

Proofread every asset (typos kill credibility). Brand check (logos, colors, voice consistency). Legal review trigger for regulated industries (finance, health, claims-heavy copy). Test sends to internal seed list. QA the conversion path on every device (click ad → land → convert without breaks). Verify analytics events fire on the live path, not just staging.

Done signal:
- Zero typos or broken links in any asset
- Legal sign-off recorded where required
- Seed-list test send received and inspected on mobile + desktop
- Full conversion path tested on iOS Safari, Android Chrome, desktop
- Analytics events validated end-to-end

## Phase: Ship

Schedule the sequence. Launch. Monitor the first 24 hours intensely — open rates, click rates, conversion rates, error rates. Have a rollback plan: pause-send authority, kill-switch on paid spend, swap-creative on underperformers. Daily check-ins for the duration of the campaign window.

Done signal:
- All sends scheduled and confirmed in each platform
- T+0 launch executed
- First-24h dashboard reviewed; pacing within ±20% of forecast or adjustment made
- Daily check-in cadence calendared through campaign window
- Post-campaign retro scheduled within 7 days of end date

## Cross-cutting notes

- **Send-time discipline.** A 9am Tuesday email and a 9pm Tuesday email are different campaigns. Don't drift.
- **Asset version drift.** When the message tweaks, every asset must update. Use a single copy-source-of-truth doc.
- **Abort threshold is non-negotiable.** Pre-declare it in Think. Mid-campaign emotional attachment kills the abort decision.
- **Memory entries to watch:** "best-performing subject line," "channel that overdelivered," "channel that flopped and why." These compound across campaigns.
- **The retro IS part of Ship.** Skipping the retro within 7 days loses 80% of the learning.
