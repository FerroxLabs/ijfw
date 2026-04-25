# Glassmorphic  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Frosted glass and layered depth  -  surfaces that feel suspended in front of a rich background rather than sitting on a flat plane. The blur and translucency create a sense of atmosphere and space that flat design cannot achieve. Works best over gradient backgrounds (dark or vibrant light). Use for dashboards, mobile-inspired web apps, SaaS onboarding flows, and landing pages that need a contemporary, tactile feel without resorting to skeuomorphism.

## 2. Color Palette & Roles
- `--color-bg-start`: #0F0C29 (gradient background start  -  deep indigo)
- `--color-bg-end`: #302B63 (gradient background end  -  mid purple)
- `--color-bg-gradient`: linear-gradient(135deg, #0F0C29 0%, #302B63 60%, #24243E 100%)
- `--color-surface`: rgba(255,255,255,0.08) (frosted card surface)
- `--color-surface-hover`: rgba(255,255,255,0.12) (interactive surface state)
- `--color-border`: rgba(255,255,255,0.18) (frosted border)
- `--color-border-strong`: rgba(255,255,255,0.28) (active/focused border)
- `--color-text-primary`: #F2F2F7 (headings, primary content)
- `--color-text-secondary`: rgba(242,242,247,0.55) (supporting text, labels)
- `--color-accent`: #7C6FFF (CTAs, links  -  soft violet)
- `--color-accent-hover`: #9B91FF (interactive accent state)
- `--color-blur`: blur(16px) (primary backdrop filter value)

## 3. Typography Rules
- **Display font**: Inter  -  Google Fonts  -  weights 300, 400, 600, 700
- **Body font**: Inter  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  for data, stats, code snippets
- **Scale**: Display 56px / H1 40px / H2 28px / H3 20px / Body 15px / Small 13px
- **Line height**: 1.6 for body / 1.1 for display
- **Letter spacing**: 0 for body / -0.02em for display
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, white text, `font-weight: 600`, `border-radius: 10px`, `padding: 11px 24px`. Hover: `--color-accent-hover`. Secondary: `background: rgba(255,255,255,0.1)`, `border: 1px solid --color-border`, `color: --color-text-primary`, `backdrop-filter: blur(8px)`. Both have `border-radius: 10px`.

### Cards
`background: --color-surface`, `backdrop-filter: blur(16px)`, `-webkit-backdrop-filter: blur(16px)`, `border: 1px solid --color-border`, `border-radius: 16px`, `padding: 28px`. Hover state shifts to `--color-surface-hover`. Top highlight: `box-shadow: inset 0 1px 0 rgba(255,255,255,0.15)`.

### Navigation
Height 60px, `background: rgba(15,12,41,0.6)`, `backdrop-filter: blur(20px)`, `border-bottom: 1px solid --color-border`. Sticky. Nav items: Inter 14px, `color: --color-text-secondary`. Active: `color: --color-text-primary`, `background: rgba(255,255,255,0.08)`, `border-radius: 8px`, `padding: 6px 14px`.

### Inputs
`background: rgba(255,255,255,0.06)`, `backdrop-filter: blur(8px)`, `border: 1px solid --color-border`, `border-radius: 10px`, `padding: 11px 14px`, `color: --color-text-primary`, `font-size: 15px`. Focus: `border-color: --color-border-strong`, `box-shadow: 0 0 0 3px rgba(124,111,255,0.2)`. Placeholder: `--color-text-secondary`.

### Badges / Chips
`background: rgba(124,111,255,0.15)`, `border: 1px solid rgba(124,111,255,0.3)`, `color: #B5AFFF`, `border-radius: 8px`, `padding: 3px 10px`, `font-size: 12px`, `font-weight: 500`. Status variants shift the rgba hue only.

## 5. Layout Principles
- **Grid**: 12-column, 24px gutters
- **Max width**: 1200px
- **Section padding**: 80px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 80px
- **Whitespace philosophy**: balanced  -  glass surfaces need breathing room but the gradient fills the void

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = gradient bg, Level 1 = `blur(16px)` card, Level 2 = `blur(24px)` modal
- **Shadow tokens**: low = `0 4px 16px rgba(0,0,0,0.3)`; mid = `0 8px 32px rgba(0,0,0,0.4)`; high = `0 24px 48px rgba(0,0,0,0.5)`
- **Border usage**: always present on glass surfaces  -  the 1px rgba border is what defines the glass edge

## 7. Do's and Don'ts
**Do:**
- Always set a rich gradient or image background  -  frosted glass needs something behind it to blur
- Use `-webkit-backdrop-filter` alongside `backdrop-filter` for Safari support
- Layer cards at slightly different blur levels to create visual depth hierarchy
- Use `rgba` borders consistently  -  hard opaque borders destroy the glass effect
- Keep border-radius in the 12-20px range; glass surfaces should feel soft

**Don't:**
- Use glassmorphic surfaces on a flat solid background  -  the effect collapses
- Stack more than three blur layers (each adds GPU cost and visual noise)
- Use high-saturation opaque backgrounds for cards  -  it fights the blur
- Mix sharp-cornered and glass-rounded components on the same screen
- Apply `backdrop-filter` to components that overlap scrolling content (causes jank)

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 36px / H1 to 26px on mobile
- **Layout collapse**: 12-col → single column; cards stack vertically; border-radius reduces slightly to 12px; blur intensity stays identical

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Glassmorphic DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Glassmorphic aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
