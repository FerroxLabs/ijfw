# Landing Page Phase Pattern

A landing page is a single-purpose conversion surface: one visitor type, one promise, one CTA. Success is measured in conversion rate against a baseline, not in design awards. The dominant risk is building the page the team wants instead of the page the visitor needs.

## Phase: Think

Pin the visitor (who arrives, from what channel, in what mindset), the promise (the one thing the page asserts), and the proof (why the visitor should believe the promise). Decide the single conversion action — signup, demo, purchase, download. Everything below the fold serves that one action.

Output is a `PAGE-BRIEF.md`: visitor persona, traffic source, mindset state, promise sentence, proof list (3-5 strongest), CTA verb, post-conversion experience.

Done signal:
- Visitor persona names the channel, the device, and the emotional state at arrival
- Promise sentence is one sentence and uses the visitor's language, not internal jargon
- Proof list is ranked by strength and includes at least one form of social proof
- CTA is one verb, one outcome

## Phase: Plan

Map sections in conversion order: hero (promise + CTA) → proof (above-the-fold trust elements) → benefits (translated features) → social proof (testimonials, logos, metrics) → objection handling (FAQ, guarantee, comparison) → final CTA. Place CTAs at decision moments, not arbitrary intervals. Plan mobile-first — sections that work on a phone work everywhere; the reverse is rarely true.

Done signal:
- Wireframe with section order and CTA placement
- Each section has a one-line "what this section earns" purpose
- Mobile and desktop wireframes both exist
- Analytics events mapped per section (scroll depth, CTA click, form submit)

## Phase: Build

Copy first, design second, code third — copy length determines design which determines code. Write hero headline + subhead + CTA copy first and validate them before designing around them. Then design in the wireframe rhythm, keeping the conversion path uncluttered. Then code with semantic HTML and lean CSS.

Done signal:
- Hero copy approved before pixel work begins
- Design covers mobile, tablet, desktop breakpoints
- Code uses semantic markup, lazy-loads below-fold images, ships ≤200KB hero bundle
- All CTAs wired to conversion endpoint with success + error states
- Form validation visible inline, not on submit only

## Phase: Verify

Mobile pass on actual devices (iOS Safari + Android Chrome at minimum), not just emulator. Accessibility pass: keyboard navigation, screen-reader landmarks, color-contrast AA, form labels. Conversion-path test: click ad → land → convert → confirmation arrives. Performance: Lighthouse mobile score ≥85, LCP <2.5s, no layout shift. Cross-browser smoke (Safari, Chrome, Firefox, Edge).

Done signal:
- Real-device check passes on iOS + Android
- Lighthouse mobile ≥85, LCP <2.5s, CLS <0.1
- Accessibility audit clean (axe or equivalent, manual keyboard pass)
- Full conversion path verified end-to-end including confirmation email
- Analytics events firing on production-equivalent URL

## Phase: Ship

Deploy to production URL. Verify analytics in production (not staging). Set up the first-30-day review: conversion rate baseline, drop-off heatmap, session replays. Schedule a 7-day check (initial data sanity), a 14-day check (statistical signal on top friction), and a 30-day review (iterate or graduate).

Done signal:
- Live on production domain with HTTPS + correct canonical
- Production analytics confirmed receiving events
- Heatmap / session-replay tool installed and capturing
- 7/14/30-day review checkpoints calendared
- Rollback / kill-switch documented

## Cross-cutting notes

- **Hero is the page.** 80% of visitors decide above the fold. Spend 80% of design effort there.
- **CTA verb matters.** "Get the demo" beats "Submit." "Start free" beats "Sign up." Test these explicitly.
- **Mobile-first or die.** Most paid traffic is mobile; desktop-first designs lose 30-60% conversion on mobile.
- **Memory entries to watch:** "headline that converted," "objection that killed conversion," "channel-to-landing mismatch found." These compound across pages.
- **Ship is not done.** 30-day iteration is part of Ship — single-shot launches leave 2-3x conversion on the table.
