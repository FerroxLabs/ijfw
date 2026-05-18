# Design System Phase Pattern

A design system is a long-lived shared substrate: tokens, components, patterns, and docs that other surfaces consume. Its quality is judged by adoption — a beautiful system nobody uses is a failed system. The dominant risk is shipping in isolation from the consumers who'll have to refactor to adopt it.

## Phase: Think

Pin the brand axis (what visual character must every component carry), the scale (how many surfaces consume this — one product, a product family, a multi-brand portfolio), and the token taxonomy (what gets named — color, space, type, radius, shadow, motion, elevation). Name a "north-star" consumer surface to validate against.

Output is a `SYSTEM-CHARTER.md`: brand axis, consumer surfaces enumerated, token categories chosen, accessibility floor (WCAG level), composition philosophy (atomic / compound / headless).

Done signal:
- Brand axis is one sentence a designer can recite ("warm, confident, restrained")
- Consumer surfaces named with owner per surface
- Token categories agreed (not "we'll figure it out as we go")
- Accessibility floor declared and non-negotiable

## Phase: Plan

Prioritize components by consumer demand, not by alphabetical or "easy first." Survey the north-star surface and rank components by frequency × pain. Set the accessibility floor per component (focus states, keyboard handling, ARIA, contrast). Plan token JSON schema before any code — schema changes mid-build are expensive.

Done signal:
- Component priority list with consumer-frequency justification
- Per-component a11y requirements documented
- Token JSON schema agreed and frozen
- Versioning + breaking-change policy declared (semver discipline)

## Phase: Build

Tokens first, then primitives (Button, Input, Text), then compounds (Card, Modal, Form), then patterns (DataTable, NavShell). Build with the north-star surface as the live consumer — every component lands in the consumer the same week it lands in the system. Docs are part of "built," not a follow-up.

Done signal:
- Token JSON published and consumed by primitives
- Each component has: code, a11y compliance, Storybook/docs page, usage examples, do/don't guidance
- North-star surface successfully consumes each component as it lands
- Changeset / changelog discipline running (no silent breaking changes)

## Phase: Verify

Contrast pass (every text-on-bg combination, every state). Multi-density check (default + compact density if supported). Component audit against consumer surfaces: are people reimplementing what we ship? That's a signal the API is wrong. Cross-browser visual regression. Performance: bundle size per component, tree-shake validation.

Done signal:
- 100% of text-on-bg combinations pass WCAG floor
- Visual regression baseline established (Chromatic or equivalent)
- Consumer surface audit finds zero reimplementations of system components
- Bundle-size budget documented per component
- Migration guide drafted for breaking changes

## Phase: Ship

Publish package (npm, internal registry, Figma library). Announce to consumers with migration guidance and office-hours support window. Adoption is the deliverable — track which surfaces upgrade, support the first 3-5 adopters hands-on, harvest feedback into a v-next backlog.

Done signal:
- Package published to registry with version tag + changelog
- Figma library published in sync with code
- Announcement comms sent to consumer teams
- Office-hours / Slack support channel staffed for first 2 weeks
- Adoption tracker exists (which surfaces on which version)
- v-next backlog seeded from first-30-day adopter feedback

## Cross-cutting notes

- **Adoption is the only metric that matters.** A system with 100 components and 0 adopters is worth less than a system with 10 components and 5 surfaces consuming them.
- **Token schema changes are expensive.** Freeze schema before primitives, treat schema changes as breaking.
- **Reimplementation is a signal.** When consumers reimplement what you ship, the system API is wrong — fix the API, don't lecture the consumer.
- **Memory entries to watch:** "consumer team friction point," "component API regret," "token rename request." These shape v-next.
- **Ship is ongoing.** A design system is never done — Ship is the steady-state phase, not a one-time milestone.
