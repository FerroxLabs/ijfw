<!--
Filled in by ijfw-new-project / ijfw-workflow brainstorm phase, one field at a time.
Read by ijfw-design, ijfw-plan, and ijfw-verify to scope copy, layout, and conversion checks.
RT3 fixture: Mac clipboard manager with AI dedupe — single CTA download page.
-->

# Landing Page Brief: ClipKit for Mac — Download

> Domain: `landing-page` -- a single page with a single job. If it has more
> than one CTA competing for the click, it isn't a landing page yet.

## Product

What is being offered on this page?

- **Name:** ClipKit
- **Category:** Mac app (native, Apple Silicon)
- **Price / commitment:** Free download with 14-day full-feature trial, then $19 one-time purchase. No subscription.

One-sentence pitch from the visitor's perspective:
"Your clipboard finally remembers what you copied — and quietly merges the dupes you didn't know were dupes."

## Target visitor

- **Who:** Developers, designers, and writers on Apple Silicon Macs who copy/paste constantly (200+ times a day) and have at least once lost an important snippet because the clipboard only holds one item.
- **What they were doing 30 seconds before landing:** Either (a) scrolled past a tweet from a developer they follow recommending ClipKit, (b) Googled "best Mac clipboard manager 2026" after losing a snippet, or (c) clicked a Setapp-alternative comparison article.
- **What they already believe is true:** macOS's built-in clipboard is a glaring omission; they've tried at least one clipboard manager before (Paste, Maccy, Alfred) and either bounced off the price or the UI.
- **What they fear is true about this offer:** That it's another menubar app that bloats RAM, that the "AI" part is gimmick marketing, or that one-time purchase means abandonment within a year.

## Promise

- **Promise:** "Every copy you've made today, one keystroke away — and ClipKit silently merges near-duplicates so your history stays clean."
- **Time horizon:** Useful within 30 seconds of launch; the AI dedupe value compounds over the first week.
- **Reversibility:** Free 14-day trial, instant uninstall (drag to trash, no leftovers), one-time $19 with 30-day no-questions refund.

## Proof

- **Social proof:** "5,200+ Mac users", three named developer testimonials with photo + role, two press mentions (MacStories, Daring Fireball link mention).
- **Demonstration:** A short autoplaying-on-hover (not autoplay-on-load) screen capture: cmd-shift-V opens the history palette, fuzzy search filters to the right snippet, AI-dedupe banner shows "12 near-duplicates merged this week."
- **Authority:** Notarized + signed by Apple Developer ID, App Sandbox enabled, badge proof. Indie developer with a prior shipped app (linked).
- **Data:** "Saves the average user 22 minutes a week" — from opt-in anonymized usage metrics across the beta cohort.

## Objection handling

| Objection | Answer on page | Where it lives (above/below fold) |
|---|---|---|
| "Another menubar app that hogs RAM" | Inline stat: "<40MB resident memory" + "0.1% average CPU" with a screenshot of Activity Monitor. | Below fold, feature block 2 |
| "AI is just marketing fluff" | Plain-English explanation: "Dedupe runs on-device using a small embedding model; nothing leaves your Mac. Here's exactly what it merges and what it never touches." | Below fold, feature block 3 (with link to a deeper "How the AI works" page) |
| "$19 means you'll abandon it next year" | Commitment line: "ClipKit has been updated every month since launch. Major version upgrades are free for life. If we ever stop shipping, the app keeps working — no server dependency." | Below fold, footer area + repeated in pricing inline |
| "I already use Paste / Maccy / Raycast" | Side-by-side comparison card (3 rows: history depth, on-device AI dedupe, one-time price). | Below fold, social proof block |
| "Apple Silicon only? My team has Intel Macs" | Honest disclosure with a "notify me when Intel support ships" email capture. | Footer (not above the fold — primary segment is Apple Silicon by design) |

## Single CTA

- **Primary CTA:** "Download for Mac (Apple Silicon)"
- **Destination:** Direct `.dmg` download from `https://clipkit.app/download/latest` (signed, notarized; download count event fires before file delivery)
- **Friction:** 0 fields, 1 click. No email gate.
- **Soft CTA for not-ready (optional):** "Get release notes by email" link in the footer only — must not appear above the fold or compete visually with the download button.

## Above-fold structure

What is visible without scrolling on a 720px-tall laptop?

1. **Headline:** "Your clipboard, finally with a memory."
2. **Subhead:** "ClipKit remembers everything you've copied today and quietly merges the duplicates — fully on-device, Apple Silicon native."
3. **Primary CTA:** Big "Download for Mac (Apple Silicon)" button, system blue, with a small "Free 14-day trial · $19 one-time · macOS 14+" line directly below.
4. **Proof element:** A still-frame of the history palette open over a real macOS desktop, with a hover-to-play affordance and "5,200+ Mac users" badge tucked in the corner.

## Mobile-first constraints

- **Single column at <768px.** No horizontal scroll, ever.
- **Tap targets ≥44px.** CTA button is 56px tall × min 240px wide on mobile.
- **No autoplay video with sound.** Demo is hover-on-desktop, tap-to-play-on-mobile. No layout shift after first paint (image dimensions reserved at SSR).
- **Mobile context caveat:** This is a Mac app. The mobile CTA changes to "Email me the download link" since the visitor can't install on their phone — the friction increase is justified by the device mismatch.
- **Performance budget:** Target LCP <2.0s on throttled 4G, page weight <250KB (hero image AVIF, no web fonts beyond system stack).

## Done When

- [ ] A first-time visitor can state the promise back after 5 seconds on the page.
- [ ] The primary CTA is the only call-to-action above the fold on mobile and desktop. (Mobile CTA variant noted above is acceptable — same intent, device-appropriate fulfillment.)
- [ ] All listed objections are explicitly addressed somewhere on the page.
- [ ] Performance budget is met (LCP <2.0s, CLS <0.05, weight <250KB) on a throttled mobile run.
- [ ] Conversion rate (visit → download click) is measured against a baseline target: ≥18% for direct/referral traffic, ≥6% for paid traffic.
