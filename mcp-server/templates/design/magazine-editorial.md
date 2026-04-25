# Magazine Editorial  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Editorial flow and feature-story hierarchy  -  the visual grammar of a digital magazine where the article itself is the product. Mixed typography is the design technique: condensed headers command attention, serif body text rewards sustained reading, pull quotes interrupt and anchor. Newsprint-warm background. Structured column grids simulate the multi-column layouts of long-form print journalism. Use for media publications, long-form content platforms, newsletters, digital magazines, and any product where writing is the primary value delivered.

## 2. Color Palette & Roles
- `--color-bg`: #F8F5EE (page background  -  newsprint warm)
- `--color-surface`: #FFFFFF (article card, feature surface)
- `--color-surface-tint`: #F1EDE4 (sidebar, secondary section background)
- `--color-border`: #DDD6C8 (dividers, column rules)
- `--color-border-rule`: #C8BFB0 (strong section rules, column separators)
- `--color-text-primary`: #1A1612 (headings, bylines  -  warm near-black)
- `--color-text-body`: #2E2822 (body text  -  slightly lighter for long reads)
- `--color-text-secondary`: #7A6F62 (labels, captions, datelines)
- `--color-accent`: #B5292A (CTAs, section tags, highlights  -  editorial red)
- `--color-accent-hover`: #8C1E1E (interactive accent state)
- `--color-pull-quote`: #3D3530 (pull quote text  -  distinct from body)
- `--color-byline`: #5C5148 (byline, source attribution)

## 3. Typography Rules
- **Display font**: Barlow Condensed  -  Google Fonts  -  weights 600, 700, 800 (headlines, section labels)
- **Body font**: Merriweather  -  Google Fonts  -  weights 300, 400, 700 (long-form article body)
- **Mono font**: JetBrains Mono  -  for inline data, pull statistics, code
- **Scale**: Display 72px / H1 48px / H2 32px / H3 22px / Body 18px / Caption 13px
- **Line height**: 1.85 for body (Merriweather needs room) / 1.0 for Barlow Condensed display
- **Letter spacing**: 0 for body / 0.01em for display / 0.1em for uppercase section tags
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Merriweather:wght@300;400;700&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: `background: --color-accent`, white text, `font-family: Barlow Condensed`, `font-weight: 700`, `border-radius: 3px`, `padding: 10px 24px`, `letter-spacing: 0.06em`, uppercase. Hover: `--color-accent-hover`. Secondary: `background: transparent`, `border: 2px solid --color-border-rule`, `color: --color-text-primary`, `font-family: Barlow Condensed`, `font-weight: 600`.

### Cards
Article card: `background: --color-surface`, `border-bottom: 2px solid --color-border-rule`, `border-radius: 0`, `padding: 24px 0`. Title in Barlow Condensed 700, body preview in Merriweather 300. Byline in Inter or system-sans 13px `--color-byline`. Feature card: full-width `border-top: 4px solid --color-accent`.

### Navigation
Height 52px, `border-bottom: 2px solid --color-text-primary`, background `--color-bg`. Publication name in Barlow Condensed weight 800, `font-size: 22px`, uppercase. Section nav below: 44px, `border-bottom: 1px solid --color-border`, items in Barlow Condensed 600 13px uppercase, `letter-spacing: 0.08em`. Active: `color: --color-accent`.

### Inputs
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 2px`, `padding: 10px 12px`, `font-family: Merriweather`, `font-size: 15px`. Focus: `border-color: --color-accent`, `box-shadow: none`. Placeholder: `--color-text-secondary`. Search bar uses Barlow Condensed.

### Badges / Chips
Section tags: `background: --color-accent`, `color: white`, `border-radius: 2px`, `padding: 3px 8px`, `font-family: Barlow Condensed`, `font-weight: 700`, `font-size: 11px`, uppercase, `letter-spacing: 0.08em`. Neutral tag: `background: --color-surface-tint`, `border: 1px solid --color-border`, `color: --color-text-secondary`.

## 5. Layout Principles
- **Grid**: multi-column editorial  -  3-col primary (content / content / sidebar) plus full-width feature rows
- **Max width**: 1280px (prose column max 680px for article body)
- **Section padding**: 64px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96px
- **Whitespace philosophy**: structured  -  whitespace is column gutters and inter-article rules, not empty margins

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface` (white), Level 2 = `--color-surface-tint`
- **Shadow tokens**: low = `0 1px 4px rgba(26,22,18,0.06)`; mid = none; high = `0 8px 32px rgba(26,22,18,0.1)` for featured overlays
- **Border usage**: horizontal rules are the primary separator; `--color-border-rule` for strong breaks, `--color-border` for subtle ones; vertical column rules optional

## 7. Do's and Don'ts
**Do:**
- Use Barlow Condensed weight 800 for all headlines  -  the condensed proportions are the system's voice
- Set Merriweather body text at 18px with `line-height: 1.85`  -  this typeface is designed for long reads
- Use pull quotes as layout anchors: Barlow Condensed 700, large (28-36px), `color: --color-pull-quote`, `border-left: 4px solid --color-accent`
- Include bylines, datelines, and reading-time labels using `--color-byline` and `font-size: 13px`
- Use `border-top: 4px solid --color-accent` to mark feature-tier articles visually

**Don't:**
- Use Merriweather for UI labels or navigation  -  it's a reading typeface, not a UI typeface
- Use rounded corners; this aesthetic is flush and ruled, not soft
- Apply decorative gradients; the warmth comes from the paper tones, not color effects
- Shrink body type below 17px; Merriweather at small sizes loses its authority
- Mix editorial red accent with a secondary accent; one signal color for editorial emphasis

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 44px / H1 to 32px / body stays 17px (down from 18px) on mobile
- **Layout collapse**: 3-col → single column at 768px; sidebar becomes collapsed section at bottom; column rules become horizontal dividers; prose column goes full-width with 20px padding

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Magazine Editorial DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Magazine Editorial aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
