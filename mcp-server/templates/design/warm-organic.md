# Warm Organic  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Natural, approachable, and round  -  the aesthetic of products that feel like they were designed by someone who cares about you, not just your subscription. Warm sand backgrounds, earthy browns and greens, generous border-radius, and shadows that feel like sunlight rather than depth. It's professional without feeling corporate, friendly without feeling juvenile. Use for productivity tools, scheduling apps, CRMs, creator tools, internal tools, and any SaaS aimed at individuals and small teams who want calm and clarity.

## 2. Color Palette & Roles
- `--color-bg`: #FAF6F0 (page background  -  warm sand)
- `--color-surface`: #FFFFFF (card/panel surface)
- `--color-surface-tint`: #F5F0E8 (subtle tinted surface for sidebars/sections)
- `--color-border`: #E8E0D4 (dividers, input borders)
- `--color-border-focus`: #C8B89A (focused border  -  warm tan)
- `--color-text-primary`: #2D2318 (headings, primary content  -  warm espresso)
- `--color-text-secondary`: #8C7B6B (supporting text, labels)
- `--color-text-placeholder`: #BFB0A0 (placeholder text)
- `--color-accent`: #2E7D5E (CTAs, links, highlights  -  forest green)
- `--color-accent-hover`: #235F47 (interactive accent state)
- `--color-accent-light`: rgba(46,125,94,0.1) (accent tint background)
- `--color-warm`: #C4784A (secondary warm accent  -  terracotta, use sparingly)

## 3. Typography Rules
- **Display font**: Plus Jakarta Sans  -  Google Fonts  -  weights 400, 600, 700, 800
- **Body font**: Plus Jakarta Sans  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  for code, data, IDs
- **Scale**: Display 52px / H1 36px / H2 26px / H3 20px / Body 15px / Small 13px
- **Line height**: 1.7 for body / 1.2 for display
- **Letter spacing**: 0 for body / -0.01em for display
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, white text, `font-weight: 600`, `border-radius: 12px`, `padding: 11px 24px`, `font-size: 15px`. Hover: `--color-accent-hover`. Secondary: `background: --color-surface`, `border: 1px solid --color-border`, `color: --color-text-primary`, `border-radius: 12px`. Both have `box-shadow: 0 1px 3px rgba(45,35,24,0.08)` on resting state.

### Cards
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 16px`, `padding: 24px`, `box-shadow: 0 2px 8px rgba(45,35,24,0.06)`. Hover: `box-shadow: 0 4px 16px rgba(45,35,24,0.1)`, `transform: translateY(-1px)`. Featured: `border-color: --color-accent`, `border-width: 1.5px`.

### Navigation
Height 60px, `border-bottom: 1px solid --color-border`, background `--color-bg`. Logo: Plus Jakarta Sans weight 700. Nav items: 14px, `font-weight: 500`, `color: --color-text-secondary`. Active: `color: --color-accent`, `background: --color-accent-light`, `border-radius: 8px`, `padding: 6px 12px`. Sidebar variant: 240px, warm surface `--color-surface-tint`.

### Inputs
`background: --color-surface`, `border: 1.5px solid --color-border`, `border-radius: 12px`, `padding: 10px 14px`, `font-size: 15px`, `color: --color-text-primary`. Focus: `border-color: --color-border-focus`, `box-shadow: 0 0 0 3px rgba(46,125,94,0.12)`. Placeholder: `--color-text-placeholder`. Labels: 13px, `font-weight: 600`, `color: --color-text-secondary`, margin-bottom 6px.

### Badges / Chips
`background: --color-surface-tint`, `border: 1px solid --color-border`, `border-radius: 20px`, `padding: 4px 12px`, `font-size: 12px`, `font-weight: 600`, `color: --color-text-secondary`. Accent variant: `background: --color-accent-light`, `border-color: rgba(46,125,94,0.25)`, `color: --color-accent`. Warm variant: `background: rgba(196,120,74,0.1)`, `color: --color-warm`.

## 5. Layout Principles
- **Grid**: 12-column, 24px gutters
- **Max width**: 1140px
- **Section padding**: 72px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 72px
- **Whitespace philosophy**: generous  -  the warmth of the palette needs room; crowded layouts fight the aesthetic

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface` (with warm shadow), Level 2 = modal with `box-shadow: 0 24px 64px rgba(45,35,24,0.15)`
- **Shadow tokens**: low = `0 1px 4px rgba(45,35,24,0.06)`; mid = `0 4px 16px rgba(45,35,24,0.08)`; high = `0 12px 40px rgba(45,35,24,0.12)`
- **Border usage**: 1px warm borders everywhere; `--color-border-focus` on interactive states; no purely decorative borders

## 7. Do's and Don'ts
**Do:**
- Use `border-radius: 12-20px` on all interactive components  -  roundness is the system's signature
- Apply warm box-shadows (brown-tinted, low opacity) instead of neutral grey shadows
- Use the forest green accent for all positive actions; terracotta (`--color-warm`) for alerts or secondary actions only
- Give labels adequate margin from their inputs (6-8px)  -  this palette breathes
- Use `--color-surface-tint` for sidebar backgrounds and secondary panels to create gentle depth

**Don't:**
- Use cool grey shadows (`rgba(0,0,0,...)`)  -  warm shadows are load-bearing to the aesthetic
- Use border-radius below 10px on cards and buttons; it fights the organic feel
- Apply the terracotta `--color-warm` as a primary CTA  -  it reads as warning in this palette
- Use pure white or cool backgrounds; the warmth must persist across all surfaces
- Stack more than two card shadow levels in a single viewport

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px (rounded components already tend toward this)
- **Typography scaling**: Display drops to 32px / H1 to 24px on mobile; body stays 15px
- **Layout collapse**: sidebar collapses to bottom tab bar; 12-col → single column; section padding reduces to 40px; cards go full-width with 16px side margin

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Warm Organic DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Warm Organic aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
