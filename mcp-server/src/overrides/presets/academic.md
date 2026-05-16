---
extends: []
scope: base
skill: ijfw-critique
---

# Academic / Research Writing Critique Preset

This preset adapts `ijfw-critique` for academic papers, dissertations,
literature reviews, conference submissions, and grant proposals. It
replaces the default rubric, evidence, and output-format sections so
the critique focuses on the standards of scholarly argument.

<!-- ijfw-override: rubric -->
Evaluate the manuscript against these criteria. Score each 1-5 and
write feedback at the level of detail a reviewer for a respectable
journal would expect.

1. **Argument structure** -- Is there a thesis the rest of the paper
   visibly supports? Can you reconstruct the argument as a numbered
   chain of claims, or does the paper drift between adjacent topics
   without a load-bearing spine?
2. **Evidence sufficiency** -- For each major claim, is there enough
   data, primary source, or prior result to carry the weight asked of
   it? Distinguish claims that are demonstrated, claims that are
   merely asserted, and claims that are smuggled past the reader.
3. **Citation density and relevance** -- Are sources cited where the
   reader needs them, not just sprinkled in the introduction? Are
   the cited works the canonical anchors for their claims, or are
   they convenience citations that look right but do not say what is
   implied?
4. **Definitional precision** -- Are key terms defined before they
   are used, and used consistently after? Watch for slippage between
   neighbouring concepts that the field treats as distinct.
5. **Methodological transparency** -- Could a reader of the same
   discipline reproduce the analysis from what is on the page?
   Sample size, instrument, coding scheme, inclusion criteria, and
   procedure must be legible.
6. **Audience appropriate for field** -- Does the prose pitch itself
   to readers of the named field at the named level, without either
   over-explaining undergraduate fundamentals or omitting context a
   sibling subfield would need?

The artifact is scholarship. Do not evaluate it as software or as
marketing; evaluate it as an argument that has to survive informed
peer scrutiny.
<!-- ijfw-override-end -->

<!-- ijfw-override: evidence -->
Quote the manuscript itself. For each observation, anchor with one
or more of these passage types:

- The **thesis statement** -- the sentence (often near the end of the
  introduction) that names what the paper is arguing.
- A **citation pattern** -- two or three nearby in-text citations
  that together reveal whether sourcing is load-bearing or decorative.
- A **gap-claim** -- a sentence asserting that the literature has
  not yet addressed something. These deserve scrutiny: is the gap
  real, or constructed by narrow framing?

Quote 1-2 sentences and give a locator the author can find: section
heading, paragraph position within the section, or page if the
manuscript is paginated. Never refer to source lines, files, or
other software locators; this is a paper.
<!-- ijfw-override-end -->

<!-- ijfw-override: output-format -->
Return the critique as markdown with these five sections, in this
order:

## Thesis

Quote the thesis as written, then restate the argument in your own
words. If the thesis cannot be located or cannot be paraphrased
without addition, say so.

## Evidence

For each major claim, name the evidence the paper offers and judge
whether it is sufficient. Flag claims that rest on a single source
where the field expects triangulation.

## Method

Summarise the method as a reader of the discipline would reconstruct
it from the page. Note every place a competent reader would still
have to guess.

## Limitations

What does the paper acknowledge, and what does it omit that a
reviewer would press on? Be specific about which population, scope,
or condition the conclusions cannot legitimately reach.

## Missing citations

List the works (or kinds of works) the argument needs but does not
cite. Where possible, name the author or paradigm by surname rather
than a placeholder; if you cannot, describe the work specifically
enough that the author can search for it.
<!-- ijfw-override-end -->
