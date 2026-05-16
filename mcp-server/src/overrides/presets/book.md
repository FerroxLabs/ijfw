---
extends: []
scope: base
skill: ijfw-critique
---

# Book / Long-form Prose Critique Preset

This preset adapts `ijfw-critique` for evaluating manuscripts, chapters,
short stories, and other long-form prose. It replaces the default
rubric, evidence, and output-format sections so the critique focuses
on craft of language rather than software artifacts.

<!-- ijfw-override: rubric -->
Evaluate the prose against these criteria. Score each 1-5 and explain
in plain language; the writer is not a programmer.

1. **Clarity of voice** -- Is the narrator's perspective consistent
   from paragraph to paragraph? Does the voice feel like one mind
   speaking, or does it drift between registers without intent?
2. **Pacing** -- Do scenes breathe where they should and compress
   where they should? Flag pages where summary smothers scene, or
   where scene drags past its emotional beat.
3. **Scene specificity** -- Are settings rendered through sensory
   detail that only this scene could have, or does the prose lean on
   generic furniture (a room, a street, a window)?
4. **Dialogue authenticity** -- Does each character sound distinct
   when their attribution is removed? Are speech rhythms tied to
   biography, mood, and stakes, or do they all sound like the author?
5. **Character motivation** -- Can the reader name what each
   point-of-view character wants in this passage, and what is in the
   way? If motivation is absent or interchangeable, call it out.
6. **Sentence variety** -- Are sentences shaped to the moment? Look
   for monotony of length, repeated opening structures, and reliance
   on the same conjunctions or verbs of being.

Do not evaluate code quality or technical correctness; the artifact
is prose. If the writer included code samples inside fiction (a
hacker character, a thriller subplot), treat them as narrative
texture, not as systems to audit.
<!-- ijfw-override-end -->

<!-- ijfw-override: evidence -->
Ground every observation in the manuscript itself. Quote a 1-2
sentence passage with a chapter and page reference (or section
heading where pages are absent). Example shape:

> Chapter 3, p. 47: "The kitchen smelled like onions and old rain."

Then say what the passage does well or fails to do. Never cite by
file path, function name, or line number; this is a manuscript, not a
codebase. Avoid bullet-only feedback that floats free of the page --
the writer needs to find the exact passage you mean.

When a pattern repeats across the manuscript, quote two or three
short examples from different chapters rather than one long block;
the spread itself is the evidence.
<!-- ijfw-override-end -->

<!-- ijfw-override: output-format -->
Return the critique as markdown with these four sections, in this
order:

## Voice

What does the narrator sound like, and where does that voice waver?
Quote the clearest example of the voice working, and the clearest
example of it slipping.

## Pacing

Map the energy of the passage. Where does it move, where does it
stall, and what should be cut or expanded? Reference chapters or
scenes by name.

## Specificity

Where does the prose earn its world through sensory detail, and where
does it rely on placeholders? Quote a strong line and a generic line
side by side.

## Suggested cuts

List 3-7 specific passages that could be deleted or compressed
without losing meaning. Quote the opening words of each so the writer
can find them quickly.
<!-- ijfw-override-end -->
