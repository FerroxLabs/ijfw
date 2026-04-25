# Cinematic Dark  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Film-inspired luxury dark  -  the aesthetic of a well-funded production company's website or a prestige tech brand's launch page. Near-absolute black background, cool grey surfaces, silver-white type. Every element is considered and spaced as if a cinematographer approved the composition. Use for flagship product launches, AI products, high-end SaaS, portfolio sites, and anything where first impression must signal quality and ambition.

## 2. Color Palette & Roles
- `--color-bg`: #080808 (page background  -  near-total black)
- `--color-surface`: #111114 (card/panel surface  -  cool dark)
- `--color-surface-mid`: #1A1A1F (elevated panels, modals)
- `--color-border`: #242428 (dividers, input borders)
- `--color-border-subtle`: #1C1C20 (lightest surface separator)
- `--color-text-primary`: #F0F0F2 (headings, primary content  -  silver white)
- `--color-text-secondary`: #6E6E78 (supporting text, labels)
- `--color-accent`: #D4D4D8 (CTAs, links  -  cool silver)
- `--color-accent-hover`: #FFFFFF (interactive accent state  -  full white)
- `--color-muted`: #3A3A40 (placeholder text, disabled)

## 3. Typography Rules
- **Display font**: Inter  -  Google Fonts  -  weights 200, 300, 400, 600
- **Body font**: Inter  -  Google Fonts  -  weights 300, 400
- **Mono font**: JetBrains Mono  -  for data, stats, technical callouts
- **Scale**: Display 72px / H1 48px / H2 32px / H3 22px / Body 16px / Small 13px
- **Line height**: 1.65 for body / 1.05 for display
- **Letter spacing**: 0.01em for body / -0.03em for display / 0.12em for small caps labels
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;600&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: #F0F0F2`, `color: #080808`, `font-weight: 500`, `border-radius: 3px`, `padding: 12px 28px`, `letter-spacing: 0.01em`. Hover: `background: #FFFFFF`. Secondary: transparent, `border: 1px solid --color-border`, `color: --color-text-primary`. No colored accents  -  this palette is intentionally achromatic.

### Cards
Background `--color-surface`, `border: 1px solid --color-border-subtle`, `border-radius: 6px`, `padding: 32px`. No shadow  -  dark backgrounds absorb light, borders define. For featured cards: `border-color: --color-border`, subtle inner glow `box-shadow: inset 0 1px 0 rgba(255,255,255,0.04)`.

### Navigation
Height 64px, `border-bottom: 1px solid --color-border-subtle`, background `rgba(8,8,8,0.85)`, `backdrop-filter: blur(12px)`. Sticky. Logo weight 300. Nav items: Inter 14px, `color: --color-text-secondary`. Hover: `color: --color-text-primary`. Active: `color: #FFFFFF`.

### Inputs
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 4px`, `padding: 11px 14px`, `font-size: 15px`, `color: --color-text-primary`. Focus: `border-color: #404048`, `box-shadow: 0 0 0 3px rgba(255,255,255,0.04)`. Placeholder: `--color-muted`.

### Badges / Chips
`background: --color-surface-mid`, `border: 1px solid --color-border`, `border-radius: 3px`, `padding: 3px 9px`, `font-size: 11px`, `font-weight: 500`, `color: --color-text-secondary`, `letter-spacing: 0.06em`, uppercase. Understated  -  status, not decoration.

## 5. Layout Principles
- **Grid**: 12-column, 32px gutters
- **Max width**: 1440px
- **Section padding**: 120px vertical
- **Spacing scale**: 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128 / 160px
- **Whitespace philosophy**: extreme  -  cinema uses darkness as framing; UI should too

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface`, Level 2 = `--color-surface-mid`
- **Shadow tokens**: low = `0 2px 8px rgba(0,0,0,0.5)`; mid = `0 8px 32px rgba(0,0,0,0.7)`; high = `0 24px 64px rgba(0,0,0,0.9)`
- **Border usage**: very subtle (1px at 14% opacity on surfaces); let darkness define depth more than borders

## 7. Do's and Don'ts
**Do:**
- Use Inter at weight 200-300 for large display text  -  ultra-light type on black is cinematic
- Let large sections be mostly empty; negative space is composition
- Use full-bleed sections with edge-to-edge dark backgrounds
- Treat any imagery as frames  -  high contrast, desaturated, or masked
- Apply `backdrop-filter: blur` for sticky nav only; not for cards

**Don't:**
- Introduce any color accent  -  the achromatic palette is intentional and load-bearing
- Use shadows that are lighter than the surface (no glows, no coloured light)
- Round corners aggressively; max 6px maintains the cinematic edge
- Add animation that feels playful; motion should feel slow and deliberate
- Use more than three font weights on any single screen

## 8. Responsive Behavior
- **Mobile breakpoint**: 390px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 44px / H1 to 32px on mobile; letter-spacing tightens slightly
- **Layout collapse**: 12-col → single column; section padding reduces to 64px; nav collapses to hamburger

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Cinematic Dark DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Cinematic Dark aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
