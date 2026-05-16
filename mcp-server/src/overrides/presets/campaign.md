---
extends: []
scope: base
skill: ijfw-critique
---

# Campaign / Marketing Copy Critique Preset

This preset adapts `ijfw-critique` for marketing campaigns, product
launches, email sequences, sales pages, ad copy, and other
persuasion-driven artifacts. It replaces the default rubric,
evidence, and output-format sections so the critique focuses on
whether the copy moves the reader to act.

<!-- ijfw-override: rubric -->
Evaluate the campaign against these criteria. Score each 1-5 and
write in language a copywriter or founder will recognise -- not the
language of software engineering.

1. **Call-to-action clarity** -- After the reader finishes, do they
   know exactly one next step? Is the CTA verb-led, specific, and
   placed where momentum is highest, or is it buried, hedged, or
   multi-headed?
2. **Audience fit** -- Does the copy speak to the named segment in
   their own vocabulary, status concerns, and objections? Generic
   "you" with no anchor is a fail; over-narrow jargon that excludes
   the segment is also a fail.
3. **Hook strength** -- Does the opening earn the next sentence?
   Test the first 1-2 lines: do they promise something specific
   enough to make the reader stay, or do they warm up before saying
   anything?
4. **Persuasion arc** -- Is there a recognisable shape (problem,
   stakes, promise, proof, offer, close), and does each beat carry
   weight? Flag missing beats and beats that repeat without adding.
5. **Channel-appropriate format** -- Email reads like email; a
   landing page reads like a landing page; a paid ad reads like an
   ad. Length, density, and rhythm should match the medium and
   placement.
6. **Claim defensibility** -- Every superlative ("best", "only",
   "guaranteed") and every number needs a believable source or a
   concrete demonstration nearby. Unsupported claims cost trust.

The artifact is copy, not software. Do not evaluate it as if it were
a product or codebase; evaluate how it sells.
<!-- ijfw-override-end -->

<!-- ijfw-override: evidence -->
Quote the actual words on the page. Pull out three anchor passages
for almost every campaign you review:

1. The **headline** (or subject line, or ad hook).
2. The **CTA** in its surrounding sentence.
3. The **close** -- the final paragraph or sign-off before the CTA.

Quote them in full, then say what they do or fail to do. If the
campaign has multiple sections (hero, social proof, FAQ, footer), name
the section before the quote so the writer can navigate.

Never cite by line number, file path, or any technical locator. The
campaign is read top to bottom by a human; speak in those terms
("the second paragraph", "the testimonial block", "the P.S. line").
<!-- ijfw-override-end -->

<!-- ijfw-override: output-format -->
Return the critique as markdown with these five sections, in this
order:

## Hook

Quote the opening line(s). Does it earn the next sentence? What
would a sharper version look like?

## Promise

What is the campaign actually offering the reader, in plain language?
Is the promise specific, believable, and worth their attention?

## Proof

What proof does the copy bring -- testimonials, case studies,
numbers, demonstration, third-party validation? Where is proof
missing where it would land hardest?

## CTA

Quote every call-to-action verbatim. Are they consistent in
language? Is the primary CTA unambiguous? Where should it appear
that it currently does not?

## Friction points

List the moments the reader is most likely to stall, doubt, or close
the tab. Quote the exact phrase that creates the friction, and
suggest a replacement.
<!-- ijfw-override-end -->
