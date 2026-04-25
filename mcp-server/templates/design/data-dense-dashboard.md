# Data Dense Dashboard  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Information density first  -  the aesthetic of tools where the data is the UI. Every pixel that isn't carrying information is a pixel wasted. Compact row heights, monospace data values, status chips with semantic color, and minimal chrome around the content. Dark background keeps the eye on the numbers. Use for monitoring dashboards, analytics platforms, ops tooling, admin panels, and any surface where a user needs to read 40 rows of data without losing their place.

## 2. Color Palette & Roles
- `--color-bg`: #0C0C0F (page background  -  deep dark)
- `--color-surface`: #131318 (card/panel surface)
- `--color-surface-row`: #161619 (table row hover/selected)
- `--color-border`: #222228 (dividers, table borders)
- `--color-border-strong`: #2E2E36 (section separators)
- `--color-text-primary`: #E4E4EF (headings, primary data)
- `--color-text-secondary`: #6E6E82 (labels, column headers)
- `--color-text-dim`: #3E3E4E (disabled, empty state)
- `--color-accent`: #5B6EF5 (active links, primary CTA  -  indigo)
- `--color-accent-hover`: #7B8EFF (interactive accent state)
- `--color-success`: #16A34A
- `--color-success-bg`: rgba(22,163,74,0.1)
- `--color-error`: #DC2626
- `--color-error-bg`: rgba(220,38,38,0.1)
- `--color-warning`: #D97706
- `--color-warning-bg`: rgba(217,119,6,0.1)

## 3. Typography Rules
- **Display font**: Inter  -  Google Fonts  -  weights 400, 500, 600
- **Body font**: Inter  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  weights 400, 500  -  all data values, numbers, IDs, timestamps, code
- **Scale**: Display 32px / H1 24px / H2 18px / H3 14px / Body 13px / Small 11px
- **Line height**: 1.5 for body / 1.2 for display
- **Letter spacing**: 0 for body / 0.04em for uppercase column headers
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, white text, `font-weight: 500`, `border-radius: 5px`, `padding: 6px 14px`, `font-size: 13px`. Hover: `--color-accent-hover`. Secondary: `background: --color-surface`, `border: 1px solid --color-border-strong`, `color: --color-text-primary`, `border-radius: 5px`, same padding. Icon-only buttons are 28x28px, `border-radius: 5px`.

### Cards / Panels
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 6px`, `padding: 16px`. Metric card: large JetBrains Mono number top, Inter label below in `--color-text-secondary`. Table panels have `padding: 0` and let the table fill edge to edge inside the border.

### Navigation
Height 44px  -  compact. `border-bottom: 1px solid --color-border`, background `--color-bg`. Items: Inter 13px, `font-weight: 500`, `color: --color-text-secondary`. Active: `color: --color-text-primary`, left-border indicator `3px solid --color-accent`. Sidebar variant: 220px wide, `border-right: 1px solid --color-border`.

### Inputs
`background: --color-bg`, `border: 1px solid --color-border`, `border-radius: 5px`, `padding: 6px 10px`, `font-size: 13px`, `color: --color-text-primary`. Height 32px  -  compact. Focus: `border-color: --color-accent`, `box-shadow: 0 0 0 2px rgba(91,110,245,0.15)`. Search inputs prepend a 14px icon with 8px gap.

### Badges / Chips
Status chips: `padding: 2px 7px`, `border-radius: 4px`, `font-size: 11px`, `font-weight: 500`, `font-family: Inter`. Success: `background: --color-success-bg`, `color: #4ADE80`. Error: `background: --color-error-bg`, `color: #F87171`. Warning: `background: --color-warning-bg`, `color: #FCD34D`. Neutral: `background: rgba(110,110,130,0.12)`, `color: --color-text-secondary`.

## 5. Layout Principles
- **Grid**: 12-column, 16px gutters
- **Max width**: 1600px (dashboards use the full screen)
- **Section padding**: 24px vertical between panels
- **Spacing scale**: 2 / 4 / 6 / 8 / 12 / 16 / 24 / 32 / 48px (2px base unit for dense rows)
- **Whitespace philosophy**: none wasted  -  every gap is intentional breathing room between data groups

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `#0C0C0F`, Level 1 = `#131318`, Level 2 = `#181820`
- **Shadow tokens**: low = `0 1px 3px rgba(0,0,0,0.5)`; mid = `0 4px 12px rgba(0,0,0,0.6)`; none on most panels  -  borders define everything
- **Border usage**: 1px borders on all panels; hairline 1px `--color-border` between table rows; `--color-border-strong` between logical sections

## 7. Do's and Don'ts
**Do:**
- Use JetBrains Mono for every numeric value, ID, hash, timestamp, and code string
- Keep table row height at 36-40px; never pad rows to 52px in a data-dense context
- Use semantic status colors (`--color-success/error/warning`) consistently across every surface
- Right-align numeric columns; left-align text columns  -  this is a non-negotiable data table rule
- Show column header units (ms, %, $) in `--color-text-secondary` following the label

**Don't:**
- Use large section padding (80px+)  -  this is a dashboard, not a landing page
- Apply border-radius beyond 6px; compact aesthetics have sharp but not brutal edges
- Use gradients or decorative backgrounds behind data panels
- Show empty cards when data is loading  -  use skeleton rows at the correct density
- Mix monospace and proportional fonts on the same data row

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 1024px (dashboards are desktop-first; tablet is the collapse point)
- **Touch targets**: minimum 44px
- **Typography scaling**: all type stays the same; only layout collapses
- **Layout collapse**: multi-column dashboard → single column stacked panels; sidebar → top nav; tables get horizontal scroll rather than column hiding

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Data Dense Dashboard DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Data Dense Dashboard aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
