# Brutalist Luxe  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Raw brutalism stripped of ugliness and dressed in restraint  -  the visual language of a Balenciaga campaign or a prestige print magazine that knows the rules and ignores them deliberately. Maximum contrast, visible structure, zero rounding. The grid is exposed, type is oversized, one bold accent color detonates against the monochrome field. Use for fashion, editorial, portfolio, culture, and any brand that positions itself as a category of one.

## 2. Color Palette & Roles
- `--color-bg`: #F5F5F5 (page background  -  paper white with texture suggestion)
- `--color-surface`: #FFFFFF (card/panel surface)
- `--color-surface-dark`: #0A0A0A (inverted section surface)
- `--color-border`: #0A0A0A (dividers, input borders  -  hard black)
- `--color-text-primary`: #0A0A0A (headings, primary content)
- `--color-text-inverse`: #F5F5F5 (text on dark surfaces)
- `--color-text-secondary`: #555555 (supporting text, labels)
- `--color-accent`: #E8FF00 (CTAs, highlights  -  electric yellow)
- `--color-accent-hover`: #D4E800 (interactive accent state)
- `--color-accent-on-dark`: #E8FF00 (accent on dark surfaces  -  same, still works)

## 3. Typography Rules
- **Display font**: Bebas Neue  -  Google Fonts  -  weight 400 (this face has no variants; use size for hierarchy)
- **Body font**: Inter  -  Google Fonts  -  weights 400, 500, 600
- **Mono font**: JetBrains Mono  -  for data, code, technical detail
- **Scale**: Display 96px / H1 56px / H2 36px / H3 24px / Body 16px / Small 13px
- **Line height**: 1.5 for body / 1.0 for display (Bebas Neue is tight by design)
- **Letter spacing**: 0 for body / 0.03em for display  -  Bebas benefits from slight tracking
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, `color: #0A0A0A`, `font-family: Inter`, `font-weight: 600`, `border-radius: 0`, `padding: 14px 28px`, `border: 2px solid #0A0A0A`, uppercase, `letter-spacing: 0.06em`. Hover: `background: --color-accent-hover`. Secondary: `background: transparent`, `border: 2px solid #0A0A0A`, `color: #0A0A0A`. No softening anywhere.

### Cards
`background: --color-surface`, `border: 2px solid --color-border`, `border-radius: 0`, `padding: 28px`. No shadow. Optional: thick left bar `border-left: 6px solid --color-accent`. Dark variant: `background: --color-surface-dark`, `color: --color-text-inverse`, `border-color: --color-surface-dark`.

### Navigation
Height 60px, `border-bottom: 2px solid --color-border`, background `--color-bg`. Logo in Bebas Neue 28px. Nav links: Inter `font-weight: 600`, `font-size: 13px`, uppercase, `letter-spacing: 0.08em`. Active: `background: --color-accent`, `color: #0A0A0A`, `padding: 4px 10px`.

### Inputs
`background: --color-bg`, `border: 2px solid --color-border`, `border-radius: 0`, `padding: 11px 12px`, `font-family: Inter`, `font-size: 15px`. Focus: `border-color: #0A0A0A`, `box-shadow: 4px 4px 0 #0A0A0A`. Placeholder: `--color-text-secondary`.

### Badges / Chips
`background: --color-accent`, `color: #0A0A0A`, `border: 2px solid #0A0A0A`, `border-radius: 0`, `padding: 3px 10px`, `font-size: 11px`, `font-family: Inter`, `font-weight: 600`, uppercase, `letter-spacing: 0.06em`. Inverted variant: `background: #0A0A0A`, `color: --color-accent`.

## 5. Layout Principles
- **Grid**: 12-column with 2px visible column rules optional  -  the structure is the design
- **Max width**: 1400px
- **Section padding**: 80px vertical
- **Spacing scale**: 4 / 8 / 16 / 24 / 32 / 48 / 64 / 80 / 96px
- **Whitespace philosophy**: intentional asymmetry  -  some sections are dense, others are a single headline in 40% of the viewport

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface` (with 2px border), Level 2 = offset shadow only
- **Shadow tokens**: none (flat) or offset hard shadow `4px 4px 0 #0A0A0A`  -  no blurred shadows ever
- **Border usage**: 2px solid black everywhere; borders are structural, not decorative

## 7. Do's and Don'ts
**Do:**
- Use Bebas Neue at large sizes only (36px+); below that Inter bold takes over
- Use the electric yellow accent as a weapon  -  it should feel aggressive when it appears
- Mix inverted sections (black bg) with light sections for rhythm and drama
- Let type collide with layout edges; crop is intentional
- Use the hard 4px offset shadow on interactive cards and focused inputs

**Don't:**
- Round any corner  -  `border-radius: 0` is a rule, not a suggestion
- Use more than one accent color; the yellow is the entire accent system
- Use soft drop shadows (blurred box-shadow); hard offset only
- Apply subtle animations; transitions are instant or simple slide-in
- Use imagery with busy compositions  -  high contrast or solid color photos only

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 56px / H1 to 36px on mobile; Bebas Neue stays at all sizes
- **Layout collapse**: 12-col → single column; column rules removed; padding reduces to 24px; bold borders remain

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Brutalist Luxe DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Brutalist Luxe aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
