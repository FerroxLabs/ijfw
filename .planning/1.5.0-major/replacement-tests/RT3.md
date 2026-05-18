# Replacement Test RT3 — Multi-Domain Proof

**Verdict:** MULTI-DOMAIN-PROVEN
**Scenarios passed:** 3 / 3 (A, B, C all produced a usable starting brief; none required a software workaround)
**Date:** 2026-05-18
**Wave:** v1.5.0-major W12-E
**Tester role:** Dry-run as a non-software user, no code edits, brief production only

## Why this test exists

IJFW's unique market claim — distinct from claude-flow, BMAD, contains-cc, every other Claude orchestrator — is that it ships templates for non-software domains alongside software. RT1 and RT2 proved IJFW handles software equivalently to bare Claude. RT3 has to prove the unique claim is real: a writer / marketer / indie designer can sit down with IJFW and get to a usable starting artifact without IJFW leaking software-development assumptions into their face.

Templates audited live in:
- `claude/skills/ijfw-new-project/templates/{book,campaign,landing-page,design-system,launch}.brief.md`
- `claude/skills/ijfw-workflow/templates/{book,campaign,landing-page,design-system,launch}.phases.md`

Three were exercised this round. design-system and launch templates exist (`ls` confirms) but were not exercised in RT3 — out of scope for the three named scenarios.

---

## Scenario A — Book chapter (thriller, Ch 7)

**Template used:** `claude/skills/ijfw-new-project/templates/book.brief.md` (82 lines) — confirmed present, read in full.
**Phase pattern:** `claude/skills/ijfw-workflow/templates/book.phases.md` (63 lines) — confirmed present, read in full.
**Sample brief:** `.planning/1.5.0-major/replacement-tests/RT3-A-brief.md` (filled in with concrete content: Det. Mara Voss, antagonist reveal, ~4000 words, close-third POV, named beta-reader acceptance criterion).

### Phase walk-through (what a real user would do)

- **Think.** User pins the chapter's reason to exist: a single antagonist-reveal scene that pivots Act 2 into Act 3. They restate inherited premise/POV/themes from the parent BOOK.md so the chapter brief survives in isolation. Output is `RT3-A-brief.md`. Done signal — "premise sentence survives a 'so what?' test" — fits exactly: the chapter's premise is one sentence, falsifiable by a reader saying "so what."
- **Plan.** Chapter-internal decomposition: open the scene (procedural-tight), drive Mara to the lab, plant the small wrongness, drop the mask, choice moment. Per-beat word-count target sums to ~4000. Continuity-ledger entries from Ch 1-6 are loaded here (Aaron's prior dialogue, Mara's surveillance arrangement from Ch 5). The phase pattern explicitly calls out continuity-ledger seeding — exactly the right discipline for a mid-book chapter.
- **Build.** Draft the chapter. The phase pattern's "verify-as-you-write — at end of each chapter run a mini-verify" mapping is unusual here because the unit-of-work is one chapter, not a book — but the spirit still applies: after each scene-beat, check it against the one-line purpose and the continuity ledger.
- **Verify.** Beta-read pass. 2-3 readers from the target audience read the standalone chapter. Two passes the brief calls out: continuity audit (does anything contradict Ch 1-6?) and emotional-landing audit (does the reveal hit for someone who hasn't read prior chapters? — the author's explicit acceptance criterion).
- **Ship.** For a chapter not the whole book, "Ship" is integration: merge into the manuscript, update the master continuity ledger, update chapter status to "drafted-final," and update the spine. The phase pattern is whole-book oriented, so this re-interpretation is on the user — but the brief's acceptance criterion is self-contained enough to make it clear.

### Gaps found

- **`book.phases.md` assumes whole-book scope.** Every Done signal references "all chapters," "macro arc," "beta readers from the target audience read the FULL manuscript." A chapter-only slice (the common case for an author already mid-draft) has to re-interpret most of the phase pattern. Adding a one-line "for chapter-only work, scope each signal to the chapter" note would close this.
- **No mention of agent/editor submission as a Ship variant.** The phase pattern jumps from manuscript-complete to KDP/self-publish. The brief explicitly says "Publication target: Traditional, agented submission Q3" — a common author path — and the phase pattern has no signal for query-letter / agent-package / submission-tracking work. Authors going the traditional route get a Ship phase that doesn't fit.
- **"Word count" appears 6 times in the phase pattern, "scene" appears 0 times.** Chapter-internal craft (scene-level beats, micro-tension, dialogue/action ratio) has no surface in the phase pattern. A book-craft user would expect at least one cross-cutting note about scene-level work.
- **Continuity ledger format is unspecified.** Phase pattern says "seeded here" and "updated every chapter" but never says what format — a spreadsheet, a yaml file, a markdown table? The user has to invent it. Compare with software phase patterns which all assume `.planning/` markdown conventions.

### Wins

- **Tone is completely software-free.** Zero references to git, CI, tests, tickets, sprints. A novelist reading this would not feel patronized or alienated.
- **The continuity-ledger insight is genuinely good.** "Memory entries to watch: 'last chapter drafted,' 'next research blocker,' 'beta reader said X about chapter Y' — these survive context flushes." That's a writer-craft observation, not a software-process bolt-on. It's also where IJFW's actual memory infrastructure adds value over a paper notebook.
- **"Ship is not done" cross-cutting note.** First 90 days post-launch belong to Ship. Real publishing-industry insight — most launch-day campaigns shoot their entire bolt on T+0 and abandon their book by T+30. The phase pattern names this trap explicitly.
- **The brief template fields actually map to how authors think.** Premise / world rules / POV / themes / structure / chapter spine — this is the order of operations a working novelist follows. Nothing was contorted to fill it in.

---

## Scenario B — Campaign brief (paid course launch)

**Template used:** `claude/skills/ijfw-new-project/templates/campaign.brief.md` (88 lines) — confirmed present, read in full.
**Phase pattern:** `claude/skills/ijfw-workflow/templates/campaign.phases.md` (66 lines) — confirmed present, read in full.
**Sample brief:** `.planning/1.5.0-major/replacement-tests/RT3-B-brief.md` (filled in: 100 seats × $99, 14-day window, 5 channels, $5k budget, named kill criterion, 9 timeline beats, 7 KPIs with measurement sources).

### Phase walk-through

- **Think.** User pins audience (senior eng managers at 50-500p SaaS), objective (100 paid seats × $99 in 14 days = $9,900), and the message ("PR briefs are an engineering deliverable, not a marketing one"). Phase pattern's stranger-test for audience and named abort threshold both surface in the brief.
- **Plan.** Channel mix sequenced (email + LinkedIn organic carry the narrative, paid sustains awareness, podcast + HN top-of-funnel). Per-channel asset list (subject lines × 9 emails, LinkedIn posts × 4, ad creative variants × 3, podcast talking points × 2). Tracking plan: UTM scheme per channel, Stripe conversion events, ConvertKit + GA4 dashboard.
- **Build.** Produce all 30-ish assets to "final" status. Single-source-of-truth copy doc so message tweaks propagate (this is one of the strongest cross-cutting notes — drift is the #1 killer of multi-asset campaigns).
- **Verify.** Proofread, brand check, legal sign-off (probably skippable for $99 course but the phase pattern names it correctly for regulated industries), seed-list test send received on mobile + desktop, conversion path tested iOS Safari → Android Chrome → desktop, analytics events validated.
- **Ship.** Schedule the sequence, T+0 launch, first-24h dashboard review, daily check-ins through window, kill-switch authority pre-declared. Post-mortem within 7 days.

### Gaps found

- **No native a/b testing surface.** Email campaigns at this size routinely a/b test subject lines and send times. The phase pattern's "best-performing subject line" memory entry implies it but neither the brief nor the phase pattern has a place to record variant copy or define the split.
- **Compliance is named but not scoped.** "Legal review trigger for regulated industries (finance, health, claims-heavy copy)" — but no checklist of what to look for. A solo course launcher with no legal team doesn't know whether they need to worry about CAN-SPAM/GDPR/CASL disclosures in their nurture sequence.
- **"Channel that overdelivered / flopped and why" memory entries are great in principle but have no schema.** The user has to decide what counts as overdelivery and what shape the memory entry takes. Software phase patterns have clearer artifact conventions.
- **CAC and budget math is implicit.** The brief template asks for hard spend, soft spend, and CAC ceiling, but the phase pattern never tells the user to re-compute CAC at the day-7 check or to define a paid-spend-pause heuristic distinct from the campaign kill criterion. The two failure modes (campaign failing overall vs. paid channel failing while organic carries) are different decisions.

### Wins

- **The brief enforces sharpness in exactly the right places.** "Distinguish business outcome from campaign output" — almost no marketing brief template surfaces this distinction. It catches the most common rookie error (optimizing for impressions, declaring victory on reach, missing zero revenue).
- **Kill criterion is required, not optional.** This is the single discipline that separates competent marketers from the rest. The brief makes it a required field, not a "nice to have."
- **Cross-channel sequencing is named as a first-class concern.** "Does channel 2 reinforce channel 1, or run independent?" — this is exactly the kind of decision that beginner campaigns skip and then wonder why their reach didn't compound.
- **Send-time discipline cross-cutting note.** "A 9am Tuesday email and a 9pm Tuesday email are different campaigns." Specific, opinionated, actionable, and the kind of thing a working email marketer would underline.
- **Retro is part of Ship, not optional.** Same discipline as the book template's "first 90 days post-launch belong to Ship." Consistent philosophy across domains.

---

## Scenario C — Landing page sketch (Mac clipboard app)

**Template used:** `claude/skills/ijfw-new-project/templates/landing-page.brief.md` (90 lines) — confirmed present, read in full.
**Phase pattern:** `claude/skills/ijfw-workflow/templates/landing-page.phases.md` (67 lines) — confirmed present, read in full.
**Sample brief:** `.planning/1.5.0-major/replacement-tests/RT3-C-brief.md` (filled in: ClipKit Mac app, single CTA "Download for Mac (Apple Silicon)", 5 named objections with on-page answers, hero structure spec, mobile/Mac-app device-mismatch caveat, perf budget LCP <2.0s).

### Phase walk-through

- **Think.** User pins visitor persona (Apple Silicon Mac power-user, copies 200+ times/day, has tried at least one prior clipboard manager), the promise ("Your clipboard, finally with a memory"), proof list ranked (testimonials, MacStories/DF mention, opt-in usage data), and the single CTA verb ("Download"). Brief and Think phase line up tightly.
- **Plan.** Wireframe sections in conversion order: hero → proof → benefits → social proof → objection handling → final CTA. Mobile and desktop wireframes both. Per-section "what this section earns" line. Analytics events mapped (scroll depth at 25/50/75/100%, CTA click, download-start event).
- **Build.** Copy first (hero headline + subhead + CTA approved before pixels), then design across breakpoints, then code semantic HTML / lean CSS. Hero bundle ≤200KB; though the brief sets a tighter 250KB whole-page budget to enable hero-first paint under 2.0s.
- **Verify.** Real-device mobile pass on iOS Safari + Android Chrome. Lighthouse mobile ≥85. Accessibility: keyboard nav, screen-reader landmarks, color-contrast AA, form labels (for the soft email-me-the-link CTA). Conversion path: click → land → download triggered → analytics event fires. Cross-browser smoke.
- **Ship.** Deploy to clipkit.app. Verify analytics in production. Heatmap + session-replay installed. 7/14/30-day review checkpoints calendared. Rollback documented (CDN purge, prior version pinned).

### Gaps found

- **No native a/b testing surface — same gap as campaign.** Landing-page work is one of the highest-leverage a/b testing surfaces ("Get the demo" vs "Try free for 14 days") and the phase pattern's cross-cutting note names this explicitly — "CTA verb matters... Test these explicitly" — but provides no place to record variants or split logic in either brief or phase pattern.
- **App-download landing pages are a recognized special case that isn't called out.** The brief had to invent a "mobile context caveat" because a Mac-app landing page can't fulfill its CTA on the mobile device showing the page. SaaS/web-app landing pages don't have this problem. A one-line acknowledgment in the brief template — "for native-app downloads, the mobile CTA may differ from the desktop CTA; specify both" — would close this.
- **SEO is unmentioned.** Title tag, meta description, OG image, canonical URL, schema markup — none are surfaced in the brief or phase pattern. A landing page that ranks for "best mac clipboard manager" is a different beast than one that only serves paid traffic.
- **"Performance budget: LCP <2.5s" in the phase pattern, but no guidance on how to measure or fail-on-regression.** A working web perf engineer would expect at least a pointer to Lighthouse CI or web.dev/measure. The brief gets specific (LCP, CLS, weight in KB), the phase pattern stays at the conceptual level.

### Wins

- **"One CTA. If you need two, you have two pages."** Strongest single line in any of the three brief templates. Catches the most common landing-page failure mode in the first paragraph.
- **Mobile-first constraints are concrete and opinionated.** Tap targets ≥44px, single column <768px, no autoplay with sound, no layout shift. These aren't aspirational — they're checkboxes a freelancer can hand to a junior designer.
- **Above-fold structure is enumerated.** Headline + subhead + CTA + proof, four items, visible without scrolling on 720px laptop. Removes the "what goes above the fold" debate.
- **Objection handling as a table.** Forces the user to enumerate fears explicitly and place an answer on the page. This is a missing rung in most landing-page tools — they ask for "value props" not "things the visitor is afraid of."
- **"Hero is the page" cross-cutting note.** 80% of visitors decide above the fold; spend 80% of effort there. Calibrates effort allocation against where the conversion math actually happens.

---

## Cross-scenario findings

### HIGH — would block the "any domain" claim

None found. All three scenarios produced a usable starting brief without IJFW leaking software-development tone or assumptions into the user's face. The "multi-domain proof" claim survives this test.

### MEDIUM — friction that a real user would hit

- **Sub-project scope is unspecified across all three domains.** Book Ch 7, single email in a campaign, single section of a landing page — the templates and phase patterns assume whole-project scope. A user working on a slice has to re-interpret the Done signals. Add a one-line "for sub-project work, scope each signal to the slice" note in each phase pattern.
- **A/B testing has no surface in campaign or landing-page templates.** Both phase patterns name the discipline ("test these explicitly," "best-performing subject line") but provide nowhere to record variants. Add a single-table "Variants under test" section to both brief templates.
- **Memory-entry suggestions are great but unscoped.** "Channel that overdelivered" / "headline that converted" / "beta reader said X about chapter Y" — these are great prompts but the user has to invent the storage format. Either provide a one-line template per memory entry type, or commit to "use ijfw_memory_store with these tags."

### LOW — polish

- **Book phase pattern is whole-book biased.** Chapter-only and short-form (essay, short story) users will re-interpret most signals. One sentence acknowledging the slice case fixes this.
- **Traditional-publishing path missing from book Ship phase.** Query-letter / agent-submission / on-sub-tracking is a real workflow that the current Ship phase doesn't recognize. Add a "Ship variants" cross-cutting note.
- **Landing-page brief should call out app-download as a recognized variant.** The mobile-context mismatch is a real and recurring case that the brief currently makes the user discover.
- **Landing-page phase pattern should reference Lighthouse CI / web.dev/measure explicitly.** "Performance budget" without a measurement pointer is aspirational.
- **No SEO surface in landing-page brief or phase pattern.** Even a single-CTA download page benefits from title/meta/OG/schema discipline.
- **"Done When" checkboxes use the same bracket pattern as the rest of the templates.** Minor: a renderer-aware checklist syntax (`- [ ]`) is used consistently and renders well in GitHub/IDE preview. Confirmed working as intended; flagged only as a polish observation.

---

## Summary

- **IJFW DID produce a usable starting brief in 3/3 scenarios.** All three briefs (RT3-A, RT3-B, RT3-C) contain concrete, opinionated, domain-appropriate content that a working novelist, marketer, or indie Mac developer could pick up and use.
- **Top issue across scenarios: A/B testing has no first-class surface in campaign or landing-page templates.** Both name it in cross-cutting notes; neither provides a recording structure. This is the single most common gap a real user would hit on day 2.
- **Second-tier issue: sub-project scope.** All three phase patterns assume whole-project work; slice-of-project users (Ch 7 of a book, single email of a campaign, single section of a page) have to re-interpret Done signals. A one-line scope-acknowledgment in each phase pattern closes this.
- **The unique multi-domain claim survives the test.** No software-centric tone bleed, no git/CI/test assumptions leaking into non-software domains. Each template feels like it was written by someone who has actually done that work, not by a software engineer guessing at adjacent fields.
- **Estimated effort to close HIGH findings:** Zero hours — no HIGH findings.
- **Estimated effort to close all MEDIUM findings:** ~3-4 hours total: ~30 min per MEDIUM × 3, plus testing the resulting template changes against this same RT3 dry-run.
- **Recommended follow-up:** Land MEDIUM fixes in a v1.5.0-major polish wave (W12-F or post-W12). LOW items can ride in routine doc maintenance.
