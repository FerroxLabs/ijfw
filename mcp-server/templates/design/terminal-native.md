# Terminal Native  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Developer terminal aesthetic  -  the UI feels like it was born in a shell session and grew into a product. Monospace everywhere, dark to the bone, single neon accent cutting through the black. Information density is a feature, not a problem. Use for CLIs with web UIs, developer tools, API explorers, monitoring dashboards, and any product where the primary user has a `.zshrc` file.

## 2. Color Palette & Roles
- `--color-bg`: #0D0D0D (page background  -  terminal black)
- `--color-surface`: #161616 (card/panel surface)
- `--color-surface-raised`: #1E1E1E (elevated panels, dropdowns)
- `--color-border`: #2A2A2A (dividers, input borders)
- `--color-text-primary`: #E8E8E8 (headings, primary content)
- `--color-text-secondary`: #7A7A7A (supporting text, labels, comments)
- `--color-accent`: #00FF88 (CTAs, active states, highlights  -  terminal green)
- `--color-accent-hover`: #00CC6E (interactive accent state)
- `--color-accent-dim`: rgba(0,255,136,0.12) (accent tint for backgrounds)
- `--color-error`: #FF4C4C (error states)
- `--color-warning`: #FFB020 (warning states)

## 3. Typography Rules
- **Display font**: JetBrains Mono  -  Google Fonts  -  weights 400, 700, 800
- **Body font**: JetBrains Mono  -  Google Fonts  -  weight 400, 500
- **Mono font**: JetBrains Mono  -  everything is mono; this is the system
- **Scale**: Display 48px / H1 32px / H2 24px / H3 18px / Body 14px / Small 12px
- **Line height**: 1.65 for body / 1.2 for display
- **Letter spacing**: 0 for body / -0.01em for display
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap')`

## 4. Component Stylings
### Buttons
Primary: background `--color-accent`, `color: #000000`, `font-family: JetBrains Mono`, `font-weight: 700`, `border-radius: 3px`, `padding: 9px 18px`, `font-size: 13px`. Hover: `--color-accent-hover`. Secondary: transparent, `border: 1px solid --color-accent`, `color: --color-accent`. Both uppercase with `letter-spacing: 0.04em`.

### Cards
Background `--color-surface`, `border: 1px solid --color-border`, `border-radius: 4px`, `padding: 20px`. Optional left accent bar: `border-left: 2px solid --color-accent`. Content uses strict monospace hierarchy.

### Navigation
Height 48px, `border-bottom: 1px solid --color-border`, background `--color-bg`. Items in JetBrains Mono 13px. Active: `color: --color-accent`. Prompt-style separator (`>` or `$`) can precede the active item.

### Inputs
`background: #111111`, `border: 1px solid --color-border`, `border-radius: 3px`, `padding: 9px 12px`, `font-family: JetBrains Mono`, `font-size: 13px`, `color: --color-text-primary`. Focus: `border-color: --color-accent`, `box-shadow: 0 0 0 2px --color-accent-dim`. Cursor blink effect on focus optional.

### Badges / Chips
`background: --color-accent-dim`, `border: 1px solid rgba(0,255,136,0.25)`, `color: --color-accent`, `border-radius: 3px`, `padding: 2px 8px`, `font-size: 11px`, `font-weight: 700`, uppercase. Error variant uses `--color-error` at same opacity ratios.

## 5. Layout Principles
- **Grid**: 12-column, 16px gutters
- **Max width**: 1280px
- **Section padding**: 48px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64px
- **Whitespace philosophy**: tight  -  every pixel used; silence is still legible

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg` (#0D0D0D), Level 1 = `--color-surface` (#161616), Level 2 = `--color-surface-raised` (#1E1E1E)
- **Shadow tokens**: low = `0 1px 3px rgba(0,0,0,0.6)`; mid = `0 4px 12px rgba(0,0,0,0.8)`; glow = `0 0 12px rgba(0,255,136,0.15)`
- **Border usage**: every surface boundary gets a 1px border; glow border optional on active/selected state

## 7. Do's and Don'ts
**Do:**
- Use monospace for everything  -  mixing sans-serif breaks the terminal frame
- Use the neon accent at full saturation for interactive elements only
- Show raw data, hex values, and technical strings without sanitizing the aesthetic
- Use `--color-error` and `--color-warning` for semantic status, not decoration
- Embrace information density; pack data into compact rows

**Don't:**
- Round corners beyond 4px  -  terminal UIs are sharp
- Use gradients anywhere in the layout
- Add imagery or illustration; icons must be outline/stroke only
- Use the accent color as a background fill for large areas
- Lighten the background to improve "accessibility"  -  contrast lives in the text colors

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 28px / body stays 14px  -  monospace reads small
- **Layout collapse**: sidebar collapses to bottom drawer; grid goes single column; padding reduces to 16px

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Terminal Native DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Terminal Native aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
