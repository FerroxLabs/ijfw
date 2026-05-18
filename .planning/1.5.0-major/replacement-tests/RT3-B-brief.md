<!--
Filled in by ijfw-new-project / ijfw-workflow brainstorm phase, one field at a time.
Read by ijfw-roadmapper, ijfw-plan, and ijfw-verify to schedule sends and measure success.
RT3 fixture: paid course launch — "Better PR Briefs for Engineering Teams"
-->

# Campaign Brief: Better PR Briefs Launch (Cohort 01)

> Domain: `campaign` -- marketing / outreach work. No code shipped; deliverables
> are messages, sends, and measured response. Source of truth for objective and offer.

## Objective

Sell 100 seats of the "Better PR Briefs for Engineering Teams" self-paced course at $99 within a 14-day launch window, generating $9,900 gross with a hard CAC ceiling of $50/seat.

Distinguish **business outcome** from **campaign output**. We want the outcome — 100 paid seats and a self-sustaining waiting-list for Cohort 02. Not "ad impressions" and not "list growth in the abstract."

## Audience segment(s)

| Segment | Size (approx) | Why this campaign matters to them | Where they already are |
|---|---|---|---|
| Senior engineering managers at 50-500 person SaaS cos | ~25,000 reachable | They sign off on quarterly OKR-style PR/comms briefs and get burned when marketing rewrites them away from technical truth | LinkedIn, Hacker News, Lenny's newsletter ecosystem, eng-management Slack groups |
| Director-of-Eng / VPE at Series A-C startups | ~6,000 reachable | They're newly accountable for company narrative around launches and don't have a comms hire yet | LinkedIn, founder/operator Substacks, podcasts (Lenny, Eng Mgmt Weekly) |

Primary segment: `Senior engineering managers at 50-500 person SaaS cos` — larger pool, higher intent, more likely to expense $99 without approval.

## Channels

Ranked by where the audience actually lives, not where it's easiest to publish.

1. Email to existing list (~4,200 subscribers, eng-leadership newsletter, ~38% open rate)
2. LinkedIn organic — author's 18k follower account, 4 posts over the window
3. Targeted LinkedIn ads — lookalike of past course buyers, $3,000 budget cap
4. Two podcast guest spots booked in week 1 with discount code attribution
5. One Hacker News "Show HN" for the free chapter (single shot, day 3)

Cross-channel sequencing: Email + LinkedIn organic carry the narrative beats; paid ads sustain awareness mid-window; podcasts + HN drive cold-audience top-of-funnel. Channel 2 reinforces channel 1 (recipients also follow on LinkedIn and see message echoed).

## Messaging pillars

3-5 ideas every touchpoint should reinforce. Not slogans -- positions.

- **PR briefs are an engineering deliverable, not a marketing one.** You wouldn't let marketing write your design doc.
- **Bad briefs cost shipping velocity.** Every mistranslated launch generates support load, sales-team back-channel asks, and re-work.
- **There is a template-driven way to do this that takes 30 minutes per launch, not 3 hours.** This course teaches that template.
- **$99 is a tax-deductible expense your CFO will not blink at.** No procurement, no annual contract, no demo call.

## Call-to-action

ONE primary CTA across the campaign. Secondary CTAs only if they don't compete for the same click.

- **Primary CTA:** "Get the course — $99, lifetime access"
- **Destination:** `https://betterprbriefs.com/enroll` (Stripe checkout, single-click for returning customers)
- **Secondary CTA (optional):** "Read the free first chapter" (email gate, fed into a 5-email nurture sequence for not-ready buyers)

## Success metrics

| Metric | Type | Target | Measurement source |
|---|---|---|---|
| Email open rate | leading | ≥40% | ConvertKit |
| Email click-through to enroll page | leading | ≥6% | ConvertKit + GA4 |
| LinkedIn post engagement rate | leading | ≥4% | LinkedIn native analytics |
| Enroll-page conversion rate (visit → checkout) | lagging | ≥8% | GA4 + Stripe |
| Paid enrollments | lagging | 100 seats | Stripe |
| Gross revenue | lagging | $9,900 | Stripe |
| CAC | lagging | ≤$50/seat | Stripe + ad spend ledger |

Kill criterion: If by day 7 we are under 30 paid seats AND email click-through is below 3%, pause all paid spend, retro the offer/landing page, and decide whether to extend, pivot the price, or end the cohort at whatever it lands.

## Timeline

- **Start:** Mon, June 1 (pre-launch tease email + LinkedIn post)
- **End:** Sun, June 14 (last-call email at 6pm, checkout closes midnight PT)
- **Key beats:**
  - May 28 (T-4): Internal seed-list test send
  - June 1 (T+0): Launch email + LinkedIn announcement
  - June 3: "Show HN" + first podcast episode airs
  - June 5: Free-chapter unlock email
  - June 8: Mid-cycle social proof email (testimonial from beta cohort)
  - June 11: Second podcast airs
  - June 13: Last-call email AM
  - June 14: Final last-call email PM + checkout closes
  - June 18: Post-mortem note filed

## Budget hint

- **Hard spend:** $5,000 total — $3,000 LinkedIn ads, $1,200 podcast sponsorship slots, $400 design freelancer for OG/ad creative, $400 buffer
- **Soft spend:** ~40 hours founder time across the window (writing, recording, responding)
- **Cost-per-acquisition ceiling:** $50/seat (so paid channel must deliver ≥60 of 100 seats if it spends the full $3k)

## Done When

- [ ] All scheduled sends have been deployed on their planned dates.
- [ ] Leading metrics have been measured at planned checkpoints (not just at the end).
- [ ] The conversion target is hit, OR the kill criterion has been honestly declared.
- [ ] A post-mortem note is filed answering: what we'd repeat, what we'd cut, what surprised us.
- [ ] List health is intact -- unsubscribe rate ≤0.8%, spam complaint rate ≤0.05% across the window.
