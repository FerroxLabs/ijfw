<!-- IJFW: narration-not-applicable -->
---
name: ijfw-review
since: '1.5.0'
description: "Use when the user asks for a review of any artifact -- code diff, PR, book chapter, campaign brief, landing-page copy, or design tokens. Trigger: review, code review, review this, PR review, review my X, review chapter, review brief, review page, /ijfw-review"
---

Domain-agnostic critique. One-line findings, severity-tagged, with a written `REVIEW.md` artifact.

## Severity vocabulary (all domains)

- **BLOCK** -- must-fix before ship. Bug, data loss, broken claim, factual error, WCAG violation, missing CTA.
- **FLAG** -- should discuss. Risky choice, weak evidence, voice break, ambiguous audience, fragile coupling.
- **NIT** -- polish. Phrasing, micro-spacing, naming, redundancy.

Format per finding: `<LOC>: [SEVERITY] <one-line problem>. <one-line fix>.`
`<LOC>` is `file:line` for code, `<section>` or `<page>` for prose/design.

## Domain checklists

### Software (code diff / PR)
- Null & undefined handling, error paths, retry/backoff semantics.
- Security boundaries: input validation, authz, secret leakage, path traversal.
- Test coverage: happy path + at least one failure case per public surface.
- Concurrency: race conditions, idempotency, ordering assumptions.
- Public API: backward compatibility, types, naming.

### Book chapter
- Continuity with prior chapters (character state, world facts, timeline).
- Voice / POV consistency.
- Pacing: scene-vs-summary ratio, dwell on stakes.
- Character beats: motivation legible, agency visible.
- Stakes: what is at risk on this page, why now.

### Campaign brief
- Audience: named, specific, has a current alternative.
- Message-to-channel fit: format matches where the audience already is.
- CTA: single, frictionless, measurable.
- KPI coverage: leading + lagging indicator named.
- Kill criteria: the condition under which you stop spending.

### Landing page (copy + layout)
- Promise -> proof -> CTA alignment in the first viewport.
- Mobile-readiness: tap targets >= 44px, no horizontal scroll, hero readable at 375px.
- Accessibility: WCAG AA contrast 4.5:1 body / 3:1 large text; alt text on meaningful images; keyboard reachable CTA.
- Conversion-path friction: number of decisions before primary CTA.

### Design artifact (tokens / mockup)
- Token consistency: every color/space/radius/shadow resolves to a defined token.
- Contrast: WCAG AA on every text-on-surface pair.
- Type scale: modular ratio respected; no orphan sizes.
- Spacing rhythm: 4/8 baseline (or declared grid) respected.

## Output rules

- Lead with BLOCK findings, then FLAG, then NIT.
- No praise for meeting baseline expectations.
- Max 10 findings unless the caller asks for exhaustive.
- If nothing found: `Clean. Reviewed <N> <units> across BLOCK/FLAG/NIT gates. No findings.`

## Artifact-write contract (MANDATORY)

Every review MUST write a `REVIEW.md` to a predictable path so the artifact is durable and resumable:

- **Software review of a planned unit of work**: `.planning/<milestone>/<phase-dir>/REVIEW.md`
- **Software review without a planning context** (ad-hoc PR): `REVIEW.md` at the repo root, or `<branch>-REVIEW.md` if reviewing a named branch.
- **Standalone artifact** (chapter, brief, page, design file): write `<artifact-basename>-REVIEW.md` alongside the artifact. Example: `chapter-7.md` -> `chapter-7-REVIEW.md`.

### REVIEW.md required sections

```markdown
# Review: <artifact name>

Reviewed: <ISO-8601 timestamp>
Reviewer: ijfw-review
Domain: <software | book | campaign | landing | design>

## Summary
<2-4 sentences. Headline verdict + the single most important thing to fix.>

## BLOCK findings (must-fix)
- <LOC>: <one-line problem>. <one-line fix>.

## FLAG findings (should-discuss)
- <LOC>: <one-line problem>. <one-line fix>.

## NIT findings (polish)
- <LOC>: <one-line problem>. <one-line fix>.
```

If a section has no findings, keep the header and write `(none)` underneath -- absence is a signal, not a typo.

## Second opinion

For high-stakes artifacts the caller can request a multi-lens audit via `/cross-audit` -- this fans the same artifact across Trident (codex / gemini / claude) and converges on a consensus verdict. Use it when stakes warrant a second pair of eyes.

## Output contract

Emit a `gate-result` block as the **LAST** content of your output. Nothing
after it. Use `gate="swarm-review"`. Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

`affected_artifacts` MUST include the absolute path to the `REVIEW.md` that was written.

Format:

```gate-result
{
  "schema_version": "1.0",
  "gate": "swarm-review",
  "status": "<STATUS>",
  "project_type": "<from project-type-detector>",
  "lenses": [],
  "affected_artifacts": ["<absolute path to REVIEW.md>"],
  "accounting": {"duration_ms": 0, "lenses_invoked": 0, "cost_usd": null},
  "remediation": [],
  "receipts_ref": null,
  "supersedes": null,
  "gate_id": "<gate-with-colons-replaced-by-dashes>-<ts>-<rand4>",
  "emitted_at": "<ISO-8601>"
}
```
