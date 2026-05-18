---
name: ijfw-ui-spec
description: "Use when the user says: 'ui spec', 'design contract', 'ui audit setup', 'lock the design', 'visual contract', 'ui review setup', or '/ijfw-ui-spec'. Produces UI-SPEC.md as the visual design contract before any frontend or visual-artifact build, and dispatches ijfw-ui-auditor as the final 6-pillar gate."
since: '1.5.0'
allowed-tools: Read, Write, Bash, Grep, Glob, AskUserQuestion, Agent
---

# IJFW UI-Spec -- lock the visual contract before build

Produce `.planning/<milestone>/<phase>/UI-SPEC.md` as the design contract for
the active slice, then dispatch `ijfw-ui-auditor` as the final 6-pillar gate
after implementation lands.

Domain-agnostic. Same flow for: a web UI slice ("settings page"), a book
chapter layout ("Ch4 spread + typography"), a campaign deck ("launch deck
8 slides"), a brand system ("v2 token refresh"). UI-SPEC.md is the visual
counterpart to SPEC.md.

## When to fire

1. User explicitly asks: "ui spec", "design contract", "ui audit setup",
   "lock the design", or invokes `/ijfw-ui-spec`.
2. ijfw-workflow Deep path enters a frontend or visual-artifact build with
   no UI-SPEC.md present.
3. plan-phase is requested for a slice tagged `ui:*` or `visual:*` and no
   UI-SPEC.md exists.

## Process

### 1. Locate the active slice

```bash
MILESTONE=$(cat .ijfw/state/active-milestone 2>/dev/null \
  || ls -1 .planning/ | grep -E '^[0-9]' | tail -1)
PHASE=$(cat .ijfw/state/active-phase 2>/dev/null || echo "$1")
PHASE_DIR=".planning/${MILESTONE}/${PHASE}"
MOCKUP_DIR="${PHASE_DIR}/mockups"
mkdir -p "$PHASE_DIR" "$MOCKUP_DIR"
```

If `$PHASE` is unset and no argument supplied, ASK which slice to spec.
Never guess.

### 2. Load context

Read in order, skipping any that don't exist:

1. `.ijfw/memory/brief.md`                 -- the original ask
2. `DESIGN.md`                             -- existing design contract (root)
3. `.planning/<milestone>/<phase>/SPEC.md` -- locked WHAT for this slice
4. `.planning/<milestone>/<phase>/CONTEXT.md` -- discuss-phase decisions
5. Any prior `UI-SPEC.md` in earlier slices of this milestone
6. `.planning/PROJECT.md`                  -- non-negotiables

Extract: brand direction, declared surfaces, prior token decisions, the
critical surfaces that must visualise.

### 3. Trigger ijfw-design if no design contract exists

If neither `DESIGN.md` nor a prior `UI-SPEC.md` lives in the repo, defer
to the `ijfw-design` skill to pick a direction (brand / template / blank
slate) and persist `DESIGN.md`. Resume from Step 4 once design pass landed.

### 4. Generate critical-surface HTML mockups

Identify 1-3 critical surfaces from SPEC.md acceptance criteria (e.g. the
empty dashboard, the destructive-confirm modal, the cover spread, the
opening slide). For each, write a standalone HTML file to:

```
$MOCKUP_DIR/<surface-name>/index.html
```

Use real tokens from `DESIGN.md` -- real colors, real type scale, real
spacing, real content. ASCII wireframes are not acceptable here; this
is the contract the auditor will grade against.

If the `ijfw-design` skill is available, invoke it via the skill router and
pass the surface list. Otherwise produce mockups inline using DESIGN.md tokens.

Optional live preview:
```bash
ijfw design start --no-open 2>/dev/null && \
  ijfw design push "$MOCKUP_DIR"/*/index.html
```

### 5. Write UI-SPEC.md

Write to `$PHASE_DIR/UI-SPEC.md`:

```markdown
# UI-SPEC -- <milestone> / <phase>
**Locked:** <ISO date>  **Status:** Ready for build  **Auditor:** ijfw-ui-auditor

## 1. Layout & Hierarchy
- **Primary surfaces:** <list>
- **Focal point per surface:** <where the eye lands first>
- **Breakpoints:** <e.g. 375 / 768 / 1440 -- or N/A for print>
- **Grid / column structure:** <12-col, asymmetric, single-column, etc>

## 2. Typography & Reading Flow
- **Font stack:** <heading / body / mono>
- **Type scale:** <list of allowed sizes -- e.g. 12 / 14 / 16 / 20 / 28 / 40>
- **Weights:** <list of allowed weights -- e.g. 400 / 600>
- **Line-height + measure:** <body line-height, max line length>

## 3. Color & Contrast (WCAG AA, 4.5:1 body / 3:1 large)
- **Tokens:** <fg / bg / accent / muted / destructive -- hex values>
- **60 / 30 / 10 distribution:** <dominant / secondary / accent>
- **Contrast pairs:** <list each pair with measured ratio>
- **Dark mode policy:** <required / optional / N/A>

## 4. Spacing & Rhythm
- **Spacing scale:** <e.g. 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64>
- **Arbitrary values policy:** <forbidden | exceptions list>
- **Vertical rhythm:** <baseline grid, section spacing>

## 5. Component Consistency
- **Design system / registry:** <shadcn | custom | next-forge | none>
- **Components in use:** <button, modal, table, etc -- the closed set>
- **Variants per component:** <e.g. button: primary / secondary / ghost / destructive>
- **Tokens applied:** <how components consume the token set>

## 6. Interaction & Motion
- **States covered per interactive element:** default / hover / focus /
  active / disabled / loading / error / empty
- **Motion budget:** <duration cap, easing, reduced-motion fallback>
- **Destructive-action pattern:** <confirm modal | undo | type-to-confirm>

## Critical Surfaces (Auditor evidence targets)
| Surface | Mockup | What the auditor MUST check |
|---|---|---|
| <name> | `mockups/<name>/index.html` | <one-line check> |

## Copywriting Contract
- **CTAs:** <exact strings -- "Save changes" not "Submit">
- **Empty states:** <surface -> copy>
- **Error states:** <surface -> copy>

## Registry Safety (if shadcn or third-party blocks in use)
| Block | Registry | Reviewed? |
|---|---|---|
| <block> | <url> | <yes/no> |

## Out of Scope (Deferred to later slice)
- <intentionally not addressed this slice>

## Canonical References
- DESIGN.md
- SPEC.md (`<path>`)
- CONTEXT.md (`<path>`)
```

### 6. Commit the contract

```bash
git add "$PHASE_DIR/UI-SPEC.md" "$MOCKUP_DIR"
git commit -m "ui-spec($PHASE): lock visual contract before build"
```

### 7. After build lands -- dispatch ijfw-ui-auditor

Once implementation commits land for this slice (executor reports DONE),
dispatch the auditor as the final visual gate:

```
Task: ijfw-ui-auditor
Args:
  phase: $PHASE
  ui_spec_path: $PHASE_DIR/UI-SPEC.md
  source_scope: <comma-separated dirs, e.g. src,app,components>
  dev_server_url: <optional, e.g. http://localhost:3000>
```

Wait for the auditor. It writes `$PHASE_DIR/UI-REVIEW.md` with per-pillar
PASS / FLAG / BLOCK verdicts. Surface its top-level verdict to the user:

- **PASS** -- ship is unblocked.
- **FLAG** -- ship may proceed; record follow-ups in CONTEXT.md.
- **BLOCK** -- ship is blocked; fix and re-dispatch the auditor.

## Anti-patterns (do not do)

- Do NOT write UI-SPEC.md without DESIGN.md tokens -- the contract has
  nothing to enforce.
- Do NOT produce ASCII wireframes as the critical-surface mockups; they
  defeat the auditor's evidence loop.
- Do NOT skip dispatching ijfw-ui-auditor after build -- the contract
  without the gate is half-shipped.
- Do NOT include implementation details (component code, framework
  choices); those belong to plan-phase output.

## Success criteria

- `UI-SPEC.md` exists at `.planning/<milestone>/<phase>/UI-SPEC.md`.
- All 6 pillars populated with concrete values (no TBDs).
- At least one critical-surface HTML mockup written under `mockups/`.
- Contract commit landed on the active branch.
- `ijfw-ui-auditor` dispatched after the build commit and verdict
  surfaced to the user.
