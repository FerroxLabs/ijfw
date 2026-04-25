# Maximalist Vibrant  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Rich, layered, expressive  -  the energy of a design tool's own marketing site turned into a system. Multiple hues live together not in chaos but in deliberate orchestration. Gradients are bold and purposeful, type sizing is used as composition, and the overall effect is one of creative confidence. Use for creative tools, collaboration platforms, marketing-forward SaaS, launch pages, and products aimed at makers, designers, and builders who expect their software to have a personality.

## 2. Color Palette & Roles
- `--color-bg`: #0E0E14 (page background  -  near-black with purple undertone)
- `--color-surface`: #17171F (card/panel surface)
- `--color-border`: #2A2A38 (dividers, input borders)
- `--color-text-primary`: #F4F4FA (headings, primary content)
- `--color-text-secondary`: #8888A0 (supporting text, labels)
- `--color-violet`: #7C5CFC (primary gradient stop / main accent)
- `--color-pink`: #F040A0 (secondary gradient / hover accent)
- `--color-cyan`: #00D4FF (tertiary accent  -  used in gradients and highlights)
- `--color-yellow`: #FFE040 (pop accent  -  used for emphasis, badges)
- `--color-gradient-primary`: linear-gradient(135deg, #7C5CFC 0%, #F040A0 100%)
- `--color-gradient-secondary`: linear-gradient(135deg, #00D4FF 0%, #7C5CFC 100%)
- `--color-accent`: #7C5CFC (default single-color accent for links/focus)
- `--color-accent-hover`: #9B80FF (interactive accent state)

## 3. Typography Rules
- **Display font**: DM Sans  -  Google Fonts  -  weights 400, 500, 700, 900
- **Body font**: DM Sans  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  for code, data, metrics
- **Scale**: Display 72px / H1 48px / H2 32px / H3 22px / Body 16px / Small 13px
- **Line height**: 1.55 for body / 1.05 for display
- **Letter spacing**: -0.01em for body / -0.03em for display and H1
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700;900&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-gradient-primary`, white text, `font-weight: 700`, `border-radius: 10px`, `padding: 12px 28px`. Hover: lighten gradient via `filter: brightness(1.1)`. Secondary: `background: rgba(124,92,252,0.12)`, `border: 1px solid rgba(124,92,252,0.4)`, `color: #9B80FF`, `border-radius: 10px`. Both have gradient hover glow.

### Cards
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 16px`, `padding: 28px`. Featured cards: gradient border via `background: linear-gradient(--color-surface, --color-surface) padding-box, --color-gradient-primary border-box`, `border: 2px solid transparent`. Hover: `transform: translateY(-2px)`, mild shadow.

### Navigation
Height 64px, `background: rgba(14,14,20,0.8)`, `backdrop-filter: blur(12px)`, `border-bottom: 1px solid --color-border`. Logo can use gradient fill on wordmark text. Nav items: DM Sans 15px, `color: --color-text-secondary`. Active: gradient underline 2px or full gradient text via `background-clip: text`.

### Inputs
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 10px`, `padding: 12px 14px`, `color: --color-text-primary`, `font-size: 15px`. Focus: `border-color: --color-violet`, `box-shadow: 0 0 0 3px rgba(124,92,252,0.2)`. Placeholder: `--color-text-secondary`.

### Badges / Chips
Gradient: `background: --color-gradient-primary`, white text, `border-radius: 20px`, `padding: 4px 12px`, `font-size: 12px`, `font-weight: 700`. Yellow pop: `background: --color-yellow`, `color: #0E0E14`, same shape. Muted: `background: rgba(124,92,252,0.15)`, `color: #9B80FF`.

## 5. Layout Principles
- **Grid**: 12-column, 24px gutters
- **Max width**: 1280px
- **Section padding**: 96px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128px
- **Whitespace philosophy**: balanced  -  dense sections alternate with open hero areas; gradients fill the void

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface`, Level 2 = `#1F1F2A`
- **Shadow tokens**: low = `0 4px 16px rgba(0,0,0,0.4)`; mid = `0 8px 32px rgba(0,0,0,0.5)`; glow = `0 0 32px rgba(124,92,252,0.3)`
- **Border usage**: 1px `--color-border` as baseline; gradient borders for featured/hero components

## 7. Do's and Don'ts
**Do:**
- Use the gradient as a design element in its own right  -  full-bleed gradient sections are welcome
- Mix accent colors deliberately; violet is primary, pink secondary, cyan tertiary  -  not interchangeable
- Use DM Sans weight 900 for display text; it punches at this size
- Apply the gradient border technique for cards that need to feel premium
- Use `--color-yellow` as a true pop accent  -  one badge or highlight per section maximum

**Don't:**
- Use all four accent colors in one component  -  each component gets at most two
- Make the background lighter than `#17171F`  -  contrast is the foundation here
- Apply gradient to body text; gradient is reserved for display and interactive elements
- Round corners beyond 20px (chips/badges) or 16px (cards); circular shapes break the grid feel
- Use flat single-color CTAs  -  this palette earns its gradients

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 44px / H1 to 32px on mobile; weight 900 preserved
- **Layout collapse**: 12-col → single column; gradient hero sections go full-width; padding reduces to 48px

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Maximalist Vibrant DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Maximalist Vibrant aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
