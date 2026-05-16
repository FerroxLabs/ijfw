---
extends: []
scope: base
skill: ijfw-critique
---

# Screenplay / Script Critique Preset

This preset adapts `ijfw-critique` for film, television, and short-form
scripts -- features, pilots, episodes, shorts, and stage plays where
the conventions hold. It replaces the default rubric, evidence, and
output-format sections so the critique reads like coverage from a
working development executive, not like a code review.

<!-- ijfw-override: rubric -->
Evaluate the script against these criteria. Score each 1-5 and write
in the language of a story editor or showrunner.

1. **Scene-level conflict** -- Does every scene have a protagonist
   pursuing a tangible want against a tangible obstacle, with the
   scene ending in change (got it, denied, or got something worse)?
   Flag scenes that exist only to deliver information.
2. **Character agency** -- Do the leads drive events through choices,
   or are they reactive vehicles for the plot? When a character
   acts, can you trace the want and the cost? Passive protagonists
   should be called out, especially in the first and third acts.
3. **Pacing per act** -- Does each act do its structural work
   (setup, escalation, crisis, climax) at roughly the page count the
   format expects? Flag soggy middles, late inciting incidents, and
   climaxes that arrive without setup paying off.
4. **Dialogue distinctness per character** -- Cover the character
   names and read three pages aloud: can you still tell who is
   speaking? Flag characters who share vocabulary, rhythm, or
   posture without the script earning the resemblance.
5. **Visual storytelling** -- Are emotional beats rendered as images,
   blocking, and behaviour, or do characters announce their feelings
   in dialogue? Showing over telling is the rule; flag exposition
   that should be on screen instead of in the mouth.
6. **Genre conventions** -- Does the script honour or deliberately
   subvert the audience contract of its genre (thriller pace, comedy
   beats, horror dread, procedural structure)? Subversion is fine;
   accidental drift out of genre is not.

The artifact is a script. Do not treat it as code or as a marketing
deck; treat it as something a room will shoot.
<!-- ijfw-override-end -->

<!-- ijfw-override: evidence -->
Quote the script as it is written, in screenplay shorthand. Three
anchor types do most of the work:

- **Slug lines** -- e.g. `INT. WAREHOUSE -- NIGHT`. Quote the slug
  when calling out scene economy, location bloat, or geography that
  is impossible to shoot.
- **Action lines** -- the prose between slug and dialogue. Quote
  short passages (one to four lines) to evaluate visual specificity,
  overwriting, or unfilmable description (an internal feeling with
  no behaviour attached).
- **Dialogue exchanges** -- quote a 2-6 line back-and-forth, with
  character names, to evaluate distinctness, pace, or on-the-nose
  exposition.

Anchor each quote with the scene number or slug ("the diner scene on
p. 22"). Never use software locators; this is industry-standard
formatted material and should be referenced as such.
<!-- ijfw-override-end -->

<!-- ijfw-override: output-format -->
Return the critique as markdown with these four sections, in this
order:

## Conflict per scene

Walk through the script scene by scene (or in clusters for longer
scripts) and name the want, obstacle, and change for each. Flag
every scene that fails this test and propose either a cut or a
reframe.

## Character voices

For each principal, characterise their voice in two or three traits
(diction, rhythm, what they will and will not say). Quote a passage
where the voice is clearest, and a passage where the character bleeds
into another. Suggest a fix for the bleed.

## Visual specificity

Pull the most cinematic moments the script already contains and
celebrate them. Then list the beats that are currently spoken or
narrated which should instead be shown. Quote the dialogue or action
line you would convert.

## Pacing

Note the page where each act break lands, where the inciting incident
appears, and where the climax begins. Compare against format
expectations and call out the lag or rush. Recommend two or three
specific compressions or expansions.
<!-- ijfw-override-end -->
