# Neo Swiss Tech  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Modern Swiss grid discipline fused with tech product precision  -  the aesthetic of tools used by engineers who care about their environment. Mid-dark background that isn't a full terminal black, cool grey palette that's systematic rather than decorative, one electric accent that marks exactly what matters. Tight spacing signals density of thought without feeling cramped. Use for developer tools, productivity apps, command palettes, dashboards, and any product that must feel fast and deliberate.

## 2. Color Palette & Roles
- `--color-bg`: #141414 (page background  -  precise dark grey)
- `--color-surface`: #1C1C1C (card/panel surface)
- `--color-surface-raised`: #242424 (elevated panels, popovers)
- `--color-border`: #323232 (dividers, input borders)
- `--color-border-focus`: #4A4A4A (focused/active border)
- `--color-text-primary`: #EBEBEB (headings, primary content)
- `--color-text-secondary`: #737373 (supporting text, labels)
- `--color-text-tertiary`: #484848 (disabled, placeholder)
- `--color-accent`: #3B82F6 (CTAs, links, active states  -  electric blue)
- `--color-accent-hover`: #60A5FA (interactive accent state)
- `--color-accent-dim`: rgba(59,130,246,0.12) (accent tint backgrounds)
- `--color-success`: #22C55E
- `--color-error`: #EF4444

## 3. Typography Rules
- **Display font**: DM Sans  -  Google Fonts  -  weights 400, 500, 700
- **Body font**: DM Sans  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  for code, metrics, IDs, timestamps
- **Scale**: Display 52px / H1 36px / H2 26px / H3 20px / Body 14px / Small 12px
- **Line height**: 1.6 for body / 1.1 for display
- **Letter spacing**: 0 for body / -0.02em for display / 0.04em for uppercase labels
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, white text, `font-weight: 500`, `border-radius: 6px`, `padding: 8px 18px`, `font-size: 14px`. Hover: `background: --color-accent-hover`. Secondary: `background: --color-surface-raised`, `border: 1px solid --color-border`, `color: --color-text-primary`, `border-radius: 6px`. Ghost: transparent, `color: --color-text-secondary`, hover `color: --color-text-primary`.

### Cards
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 8px`, `padding: 20px`. Active/selected: `border-color: --color-accent`, `background: rgba(59,130,246,0.04)`. No shadow on resting state; `box-shadow: 0 2px 8px rgba(0,0,0,0.4)` on hover.

### Navigation
Height 52px, `border-bottom: 1px solid --color-border`, background `--color-bg`. Items: DM Sans 13px, `font-weight: 500`, `color: --color-text-secondary`. Active: `color: --color-text-primary`, `background: --color-surface`, `border-radius: 6px`, `padding: 5px 10px`. Keyboard shortcut hints visible inline.

### Inputs
`background: --color-bg`, `border: 1px solid --color-border`, `border-radius: 6px`, `padding: 8px 12px`, `font-size: 14px`, `color: --color-text-primary`. Focus: `border-color: --color-accent`, `box-shadow: 0 0 0 3px --color-accent-dim`. Placeholder: `--color-text-tertiary`.

### Badges / Chips
`background: --color-surface-raised`, `border: 1px solid --color-border`, `border-radius: 4px`, `padding: 2px 8px`, `font-size: 11px`, `font-family: JetBrains Mono`, `color: --color-text-secondary`. Accent variant: `background: --color-accent-dim`, `border-color: rgba(59,130,246,0.3)`, `color: --color-accent-hover`.

## 5. Layout Principles
- **Grid**: 12-column, 20px gutters
- **Max width**: 1280px
- **Section padding**: 64px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64px
- **Whitespace philosophy**: tight but breathing  -  data-forward sections use 4px base unit; marketing sections use 8px base unit

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `#141414`, Level 1 = `#1C1C1C`, Level 2 = `#242424`
- **Shadow tokens**: low = `0 1px 4px rgba(0,0,0,0.5)`; mid = `0 4px 16px rgba(0,0,0,0.6)`; high = `0 12px 40px rgba(0,0,0,0.7)`
- **Border usage**: 1px borders at every level transition; no border on same-level adjacencies

## 7. Do's and Don'ts
**Do:**
- Use the electric blue accent precisely  -  it points to exactly one action at a time
- Show keyboard shortcuts, IDs, and technical metadata using JetBrains Mono
- Build compact 52px nav and 48px input height; every pixel of height counts
- Use the 4px spacing base unit for dense data tables; switch to 8px for content sections
- Surface `--color-success` and `--color-error` for any status output  -  they're in the system

**Don't:**
- Round corners beyond 8px  -  this aesthetic is about precision, not friendliness
- Use the accent color for more than one primary CTA per viewport
- Mix DM Sans and JetBrains Mono on the same line (alternating is fine; inline mixing is not)
- Use gradients for fills; single flat accent color only
- Add decorative shadows to resting cards  -  shadow is reserved for interaction state

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 32px / H1 to 24px on mobile; body stays 14px
- **Layout collapse**: sidebar → bottom sheet; 12-col → single column; command palette hides keyboard hints; section padding reduces to 32px

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Neo Swiss Tech DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Neo Swiss Tech aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
