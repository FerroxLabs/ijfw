# Bento Grid  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Card grid with varied sizes as the primary design language  -  the aesthetic of modern portfolio sites, SaaS landing pages, and personal product showcases. Visual hierarchy is established through card size rather than typographic scale or color. A 3-column grid where some cards span 2 columns, some span 2 rows, and feature cards command both. Neutral backgrounds keep the cards themselves as the composition. Use for landing pages, portfolio sites, feature showcases, personal sites, and any layout where the arrangement of content is itself the story.

## 2. Color Palette & Roles
- `--color-bg`: #0F0F12 (page background  -  dark neutral)
- `--color-surface`: #18181C (standard card)
- `--color-surface-alt`: #1E1E24 (alternate card for variety)
- `--color-surface-light`: #F4F4F6 (light card variant for contrast inversion)
- `--color-border`: #2C2C34 (card borders, dividers)
- `--color-text-primary`: #EEEEF2 (headings, primary content)
- `--color-text-secondary`: #88889A (supporting text, labels)
- `--color-text-on-light`: #18181C (text on light cards)
- `--color-accent`: #6F6FFF (CTAs, highlights  -  periwinkle)
- `--color-accent-hover`: #8F8FFF (interactive accent state)
- `--color-accent-on-light`: #4040CC (accent on light card surfaces)
- `--color-separator`: #232328 (between grid cells, hairline rules)

## 3. Typography Rules
- **Display font**: Inter  -  Google Fonts  -  weights 300, 400, 600, 700
- **Body font**: Inter  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  for stats, metrics, code callouts inside cards
- **Scale**: Display 56px / H1 40px / H2 26px / H3 18px / Body 15px / Small 12px
- **Line height**: 1.6 for body / 1.1 for display
- **Letter spacing**: 0 for body / -0.025em for display
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, white text, `font-weight: 600`, `border-radius: 10px`, `padding: 10px 22px`. Hover: `--color-accent-hover`. Secondary: transparent, `border: 1px solid --color-border`, `color: --color-text-primary`, `border-radius: 10px`. Inside dark cards: secondary button uses `border-color: rgba(255,255,255,0.15)`. Inside light cards: use `--color-accent-on-light`.

### Cards
Standard: `background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 16px`, `padding: 28px`, `overflow: hidden`. Span-2 (wide): same styles, `grid-column: span 2`. Span-2 (tall): `grid-row: span 2`. Feature card (2x2): both spans. Light card: `background: --color-surface-light`, `color: --color-text-on-light`. Hover on all: `border-color: rgba(111,111,255,0.3)`, `box-shadow: 0 0 0 1px rgba(111,111,255,0.15)`.

### Navigation
Height 60px, `background: rgba(15,15,18,0.8)`, `backdrop-filter: blur(12px)`, `border-bottom: 1px solid --color-border`. Sticky. Logo: Inter weight 700. Nav items: 14px, `color: --color-text-secondary`. Active: `color: --color-text-primary`. CTA button right-aligned.

### Inputs
`background: --color-surface-alt`, `border: 1px solid --color-border`, `border-radius: 10px`, `padding: 10px 14px`, `font-size: 14px`, `color: --color-text-primary`. Focus: `border-color: --color-accent`, `box-shadow: 0 0 0 3px rgba(111,111,255,0.15)`. Placeholder: `--color-text-secondary`.

### Badges / Chips
`background: rgba(111,111,255,0.12)`, `border: 1px solid rgba(111,111,255,0.25)`, `color: --color-accent-hover`, `border-radius: 20px`, `padding: 3px 10px`, `font-size: 12px`, `font-weight: 500`. On light cards: `background: rgba(64,64,204,0.08)`, `border-color: rgba(64,64,204,0.2)`, `color: --color-accent-on-light`.

## 5. Layout Principles
- **Grid**: 3-column bento with `gap: 16px`; CSS grid with `grid-template-columns: repeat(3, 1fr)`
- **Max width**: 1200px
- **Section padding**: 80px vertical for page sections; cards are flush within the grid
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 28 / 32 / 48 / 64 / 80px
- **Whitespace philosophy**: structured  -  the gaps between cards are the whitespace; inside cards is purposeful density

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = card (`--color-surface`), Level 2 = modal/popover
- **Shadow tokens**: resting = none (border only); hover = `0 4px 20px rgba(0,0,0,0.4)`; modal = `0 24px 64px rgba(0,0,0,0.6)`
- **Border usage**: 1px on every card; the border is what gives the bento grid its grid legibility

## 7. Do's and Don'ts
**Do:**
- Design card contents individually  -  each card is a mini composition with its own hierarchy
- Use span-2 and span-2-row assignments to create visual rhythm and feature emphasis
- Mix dark and light cards to create contrast and visual anchoring points in the grid
- Keep the gap consistent (16px)  -  irregular gaps break the bento grid logic
- Let large metric numbers or illustrations fill the card edge-to-edge on tall cards

**Don't:**
- Use the same size for all cards  -  uniform grids lose the bento benefit entirely
- Add thick outer padding around the grid; the card borders define the structure
- Place navigation or chrome inside the bento grid area
- Use more than two distinct card backgrounds in the same grid section
- Apply heavy shadows to resting cards  -  the hover state needs contrast headroom

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 36px / H1 to 26px on mobile
- **Layout collapse**: 3-col grid → 2-col at 768px → 1-col at 375px; span overrides reset (all cards become 1-col at mobile); gap reduces to 10px

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Bento Grid DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Bento Grid aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
