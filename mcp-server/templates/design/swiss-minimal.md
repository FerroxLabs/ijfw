# Swiss Minimal  -  DESIGN.md

## 1. Visual Theme & Atmosphere
International Swiss typographic school applied to digital product. Clean, rational, and precise  -  every element earns its place. White space is the primary design material, not a gap between things. The grid is visible in the structure even when invisible on screen. Use this aesthetic for tools, documentation sites, SaaS dashboards, and developer-facing products where clarity signals trust.

## 2. Color Palette & Roles
- `--color-bg`: #FFFFFF (page background)
- `--color-surface`: #F7F7F7 (card/panel surface)
- `--color-border`: #E2E2E2 (dividers, input borders)
- `--color-text-primary`: #111111 (headings, primary content)
- `--color-text-secondary`: #6B6B6B (supporting text, labels)
- `--color-accent`: #D42B2B (CTAs, links, highlights)
- `--color-accent-hover`: #A81E1E (interactive accent state)
- `--color-muted`: #ABABAB (placeholder text, disabled)

## 3. Typography Rules
- **Display font**: Inter  -  Google Fonts  -  weights 300, 400, 500, 700
- **Body font**: Inter  -  Google Fonts  -  weight 400, 500
- **Mono font**: JetBrains Mono  -  for code, data, terminal elements
- **Scale**: Display 64px / H1 40px / H2 28px / H3 20px / Body 16px / Small 13px
- **Line height**: 1.6 for body / 1.1 for display
- **Letter spacing**: 0 for body / -0.02em for display and H1
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;700&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: background `--color-accent`, white text, `font-weight: 500`, `border-radius: 2px`, `padding: 10px 20px`. No shadow. Hover shifts to `--color-accent-hover`. Secondary: transparent background, `1px solid --color-border`, text `--color-text-primary`.

### Cards
Background `--color-surface`, `border: 1px solid --color-border`, `border-radius: 2px`, `padding: 24px`. No shadow  -  border provides definition. Content left-aligned with a clear typographic hierarchy.

### Navigation
Height 56px, `border-bottom: 1px solid --color-border`, background `--color-bg`. Logo/wordmark left. Nav items spaced 32px apart. Active item: `font-weight: 700`, thin `2px solid --color-accent` underline.

### Inputs
`border: 1px solid --color-border`, `border-radius: 2px`, `padding: 10px 12px`, `font-size: 15px`. Focus: `border-color: --color-text-primary`, no colored ring. Placeholder: `--color-muted`.

### Badges / Chips
`border: 1px solid --color-border`, `border-radius: 2px`, `padding: 2px 8px`, `font-size: 12px`, `font-weight: 500`, uppercase text, `letter-spacing: 0.04em`. Background `--color-surface`.

## 5. Layout Principles
- **Grid**: 12-column, 24px gutters
- **Max width**: 1200px
- **Section padding**: 96px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128px
- **Whitespace philosophy**: extreme  -  sections breathe, content never crowds

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface`, Level 2 = `#EFEFEF`
- **Shadow tokens**: none for low elevation; `0 1px 3px rgba(0,0,0,0.07)` for modals only
- **Border usage**: solid 1px at every surface boundary; no decorative borders

## 7. Do's and Don'ts
**Do:**
- Let whitespace carry weight  -  resist filling every gap
- Use font weight and size exclusively for hierarchy (no color contrast as a crutch)
- Keep border-radius at 0-2px; rounding softens the system's authority
- One accent color only; never mix accent colors
- Align everything to the 8px grid

**Don't:**
- Add shadows to cards or buttons  -  they break the flat surface logic
- Use more than two font weights on a single screen
- Use decorative icons or illustration; functional icons only
- Center large blocks of body text
- Introduce gradient fills anywhere in the UI

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 40px / H1 to 28px on mobile
- **Layout collapse**: 12-col → 4-col on mobile; gutters reduce to 16px; section padding reduces to 48px

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Swiss Minimal DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Swiss Minimal aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
