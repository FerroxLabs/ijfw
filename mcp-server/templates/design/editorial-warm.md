# Editorial Warm  -  DESIGN.md

## 1. Visual Theme & Atmosphere
Magazine editorial meets warm minimalism  -  the feeling of a well-designed print publication on screen. Serif headings lend authority and permanence; generous leading invites reading rather than scanning. The warm off-white background and earthy palette create intimacy without losing professionalism. Use for newsletters, blogs, content-heavy landing pages, and any product where the prose itself is the feature.

## 2. Color Palette & Roles
- `--color-bg`: #FAF8F5 (page background  -  warm parchment)
- `--color-surface`: #F2EFE9 (card/panel surface)
- `--color-border`: #DDD8CF (dividers, input borders)
- `--color-text-primary`: #2C2420 (headings, primary content  -  warm near-black)
- `--color-text-secondary`: #7A6F66 (supporting text, labels)
- `--color-accent`: #C0622F (CTAs, links, highlights  -  terracotta)
- `--color-accent-hover`: #9E4D22 (interactive accent state)
- `--color-muted`: #B0A89E (placeholder text, disabled)
- `--color-rule`: #D8D2C8 (horizontal rules, section dividers)

## 3. Typography Rules
- **Display font**: Playfair Display  -  Google Fonts  -  weights 400, 700, 900
- **Body font**: Inter  -  Google Fonts  -  weights 400, 500
- **Mono font**: JetBrains Mono  -  for code, data, inline technical references
- **Scale**: Display 60px / H1 42px / H2 30px / H3 22px / Body 17px / Small 14px
- **Line height**: 1.75 for body / 1.15 for display headings
- **Letter spacing**: 0 for body / -0.01em for H1-H2 / 0.01em for small caps labels
- **Font loading**: `@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Inter:wght@400;500&family=JetBrains+Mono&display=swap')`

## 4. Component Stylings
### Buttons
Primary: background `--color-accent`, white text, `font-family: Inter`, `font-weight: 500`, `border-radius: 4px`, `padding: 12px 24px`. Hover: `--color-accent-hover`. Secondary: transparent, `1px solid --color-accent`, `color: --color-accent`. No shadows on either.

### Cards
Background `--color-surface`, `border: 1px solid --color-border`, `border-radius: 6px`, `padding: 32px`. Top accent line optional: `border-top: 3px solid --color-accent`. Title in Playfair Display, body in Inter.

### Navigation
Height 64px, `border-bottom: 1px solid --color-rule`, background `--color-bg`. Wordmark in Playfair Display weight 700. Nav links in Inter weight 500, `font-size: 14px`. Active: `color: --color-accent`.

### Inputs
`background: --color-bg`, `border: 1px solid --color-border`, `border-radius: 4px`, `padding: 11px 14px`, `font-size: 16px`, `font-family: Inter`. Focus: `border-color: --color-accent`, `outline: 2px solid rgba(192,98,47,0.15)`. Placeholder: `--color-muted`.

### Badges / Chips
`background: --color-surface`, `border: 1px solid --color-border`, `border-radius: 4px`, `padding: 3px 10px`, `font-size: 12px`, `font-family: Inter`, `font-weight: 500`, `color: --color-text-secondary`. Subtle and unobtrusive.

## 5. Layout Principles
- **Grid**: 12-column, 28px gutters
- **Max width**: 1100px (content column max 720px for long-form prose)
- **Section padding**: 80px vertical
- **Spacing scale**: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 80 / 120px
- **Whitespace philosophy**: generous  -  long-form content demands room to breathe

## 6. Depth & Elevation
- **Surface hierarchy**: Level 0 = `--color-bg`, Level 1 = `--color-surface`, Level 2 = `#E8E3DB`
- **Shadow tokens**: low = `0 1px 4px rgba(44,36,32,0.06)`; mid = `0 4px 16px rgba(44,36,32,0.08)`; high = none (modals use backdrop instead)
- **Border usage**: warm 1px borders throughout; `--color-rule` for horizontal dividers between sections

## 7. Do's and Don'ts
**Do:**
- Use Playfair Display for all display text, pull quotes, and section headers
- Set body text at 17px minimum  -  this aesthetic rewards reading, not scanning
- Use horizontal rules (`--color-rule`) liberally to divide content regions
- Lean into asymmetry: large serif headline + tighter caption below
- Use terracotta accent sparingly  -  one CTA per viewport maximum

**Don't:**
- Use a pure white or pure black background  -  the warmth is load-bearing
- Mix Playfair Display at small sizes (below 18px it loses authority)
- Use bold Inter for headings  -  Playfair Display owns that role
- Crowd the content column; the 720px prose limit exists for readability
- Apply accent color to decorative elements; it must signal action or importance

## 8. Responsive Behavior
- **Mobile breakpoint**: 375px
- **Tablet breakpoint**: 768px
- **Touch targets**: minimum 44px
- **Typography scaling**: Display drops to 36px / H1 to 28px / body stays 17px on mobile
- **Layout collapse**: prose column goes full-width at 768px with 20px side padding; section padding reduces to 48px

## 9. Agent Prompt Guide
Use these prompts with Claude Design or ijfw-design to stay on-system:

- **New screen**: "Build a [screen type] following the Editorial Warm DESIGN.md. Match the color tokens and type scale exactly."
- **Component**: "Add a [component] that fits the Editorial Warm aesthetic  -  reference section 4 for styling rules."
- **Variant**: "Create a [light/dark/compact] variant of this screen. Keep the same token names, adjust the values."
