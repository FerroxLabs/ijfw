<!--
Filled in by ijfw-new-project / ijfw-workflow brainstorm phase, one field at a time.
Read by ijfw-design, ijfw-plan, and ijfw-verify to scope tokens, components, and a11y gates.
-->

# Design System Brief: [system name]

> Domain: `design-system` -- a token library and component contract consumed by
> N downstream surfaces. Source of truth for what is allowed, not what is one-off.

## Brand axis

The 1-3 spectrums that define the system's visual personality. Pick a point on each.

- **Formality:** [playful  <----- O ----->  formal]
- **Density:** [airy / spacious  <----- O ----->  dense / data-rich]
- **Warmth:** [cool / clinical  <----- O ----->  warm / human]
- **Personality:** [one adjective the system optimizes for -- "trustworthy", "exciting", "calm", "sharp"]

## Scale

Numeric scales that drive every visual decision. Concrete, not vibes.

### Type scale

| Token | Size (px / rem) | Weight | Line-height | Use |
|---|---|---|---|---|
| `text-xs` | [12 / 0.75rem] | [400] | [1.4] | [captions, metadata] |
| `text-sm` | [14 / 0.875rem] | [400] | [1.5] | [body small] |
| `text-base` | [16 / 1rem] | [400] | [1.5] | [body] |
| `text-lg` | [18 / 1.125rem] | [500] | [1.5] | [emphasis body] |
| `text-xl` | [20 / 1.25rem] | [600] | [1.4] | [section title] |
| `text-2xl` | [24 / 1.5rem] | [700] | [1.3] | [page title] |
| `text-3xl+` | [32+] | [700-900] | [1.2] | [marketing display] |

### Spacing scale

[4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96] -- pick the base unit and the ratio (linear, 1.5x, golden, etc.)

### Radius / elevation

- **Radius tokens:** [`radius-sm` 4, `radius-md` 8, `radius-lg` 16, `radius-full` 9999]
- **Elevation tokens:** [`shadow-1` ... `shadow-4`] -- describe intent (resting, lifted, dialog, popover)

## Palette intent

Don't list hex codes here -- list **roles**, then assign hex once.

| Role | Intent | Hex (placeholder) |
|---|---|---|
| `bg-canvas` | base page surface | `#______` |
| `bg-surface` | raised cards / panels | `#______` |
| `fg-primary` | default body text | `#______` |
| `fg-muted` | secondary / metadata text | `#______` |
| `accent-brand` | primary CTA / brand expression | `#______` |
| `accent-success` | positive feedback | `#______` |
| `accent-warning` | caution | `#______` |
| `accent-danger` | destructive / error | `#______` |

Light + dark mode mapping is a deliverable, not an afterthought.

## Component scope (v1)

The components inside the contract for v1. Anything outside this list is "use raw HTML for now".

- [ ] Button (primary / secondary / ghost / destructive)
- [ ] Input (text / number / date)
- [ ] Select / Combobox
- [ ] Checkbox / Radio / Switch
- [ ] Card / Surface
- [ ] Dialog / Modal
- [ ] Toast / Banner
- [ ] Nav (top / side)
- [ ] Table
- [ ] [other]

Explicitly out-of-scope for v1: [list -- e.g., data viz, calendar, rich text editor]

## Accessibility floor

Non-negotiable. The system fails review if any of these regress.

- **Color contrast:** WCAG AA -- 4.5:1 minimum for body text, 3:1 for large text and UI components. AAA where cheap.
- **Focus rings:** visible on every interactive token, never `outline: none` without replacement.
- **Tap targets:** ≥44x44px on touch surfaces.
- **Motion:** respect `prefers-reduced-motion`; no essential information conveyed by motion alone.
- **Semantics:** components ship with correct ARIA roles + keyboard interaction patterns.

## Token names

Naming convention -- pick one and apply it everywhere.

- **Convention:** [`role-modifier-variant`] e.g., `bg-surface-elevated`, `fg-muted`, `accent-brand-hover`
- **Forbidden:** color words in token names (`blue-500` belongs in the palette layer, not the semantic layer).
- **Distribution format:** [CSS variables / Tailwind config / Style Dictionary / Figma tokens]

## Deliverables

- [ ] Token source-of-truth file ([JSON / CSS vars / Style Dictionary])
- [ ] Component library implementation ([React / Vue / web components / Figma library])
- [ ] Docs site with live examples + copy-pasteable snippets
- [ ] Migration guide for any pre-existing surfaces
- [ ] Versioning + changelog policy (semver, deprecation window)

## Consumers

Who is downstream of this system?

- [surface 1 -- e.g., marketing site]
- [surface 2 -- e.g., logged-in app]
- [surface 3 -- e.g., mobile native via shared tokens]

## Done When

- [ ] All v1-scoped components ship with tokens, code, and docs in one release.
- [ ] At least one production consumer surface migrated end-to-end onto the system.
- [ ] Accessibility floor verified by automated check + one manual keyboard pass.
- [ ] Light + dark mode both pass contrast on every semantic role.
- [ ] Versioning + deprecation policy is documented and signed off.
