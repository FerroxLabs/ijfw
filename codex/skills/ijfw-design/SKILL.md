---
name: ijfw-design
description: "First-class design intelligence. Dispatches to the best available design skill (ui-ux-pro-max, frontend-design, superpowers), then layers IJFW constraints on top. Triggers: 'design', 'redesign', 'UI', 'UX', 'dashboard', 'page', 'component', 'make it look better', 'polish', 'pretty', 'professional', 'user experience', 'layout', 'visual', 'mobile-first', 'dark mode', 'accessibility', 'colors', 'typography', 'brand'."
---

# IJFW Design

## Rule 0 - Real HTML mockups, never ASCII

When asked to show a design, mockup, layout, screen, or variant, produce REAL HTML and use the live design companion when a shell is available:

1. Start the companion with `ijfw design start` (or `ijfw design start --no-open` in CI/headless sessions). It serves `http://localhost:<port>/design`.
2. Write standalone HTML variants under `.planning/<feature>/mockups/<variant>/index.html` or `.planning/brainstorm/<option>.html`.
3. Push the active variant with `ijfw design push <file.html>`. The open browser reloads automatically.
4. When comparing options, create a tabbed `viewer.html` that loads option files from `/design/files/<name>.html`, then push the viewer and its option files together: `ijfw design push .planning/brainstorm/*.html`.

Use the active `DESIGN.md` or the picked template as the source of truth -- real colors, real type scale, real spacing, real content. Prefer DESIGN.md tokens first, then the chosen template/brand direction, then internal heuristics.

ASCII wireframes in chat are a LAST-RESORT FALLBACK, permitted only when:
- The user explicitly asks for text-only ("just ASCII is fine").
- No writable filesystem is available (extremely rare -- almost never in practice).

Do not default to ASCII boxes. Do not "sketch" in chat. The entire point of this skill is on-brand visual output; ASCII wastes the `DESIGN.md` contract, the palette, the type scale, and the user's time.

Structural diagrams (Mermaid architecture, data flow, component boundaries) are the exception -- those stay as text by convention.

## Live Visual Loop

For UI/design brainstorming, offer the live companion before SHAPE:
`This is visual. Want me to open a live preview while we brainstorm?`

If declined, continue with durable design notes in `DESIGN.md` or the current planning artifact and do not start a local server. If accepted, start the companion immediately and push a placeholder or first option so the user sees the loop working. For each design choice, update the HTML and run `ijfw design push <file.html>`; do not merely say where the file is. For multi-option viewers, push every supporting `.html` file so iframe tabs can resolve through `/design/files/`. If the companion cannot start, fall back to opening the HTML file directly and report the path.

The companion is for transient visual feedback: fast previews, option comparison, and live browser reloads. `DESIGN.md` is durable design memory: tokens, rationale, constraints, critiques, and handoff notes that should survive sessions, platforms, and project phases. Do not treat a pushed preview as the source of truth; persist decisions in `DESIGN.md`.

## Durable Design Intelligence Commands

Use the durable `ijfw design` commands whenever the work needs a design contract, not just a preview. These commands are project-agnostic: they can apply to UI, content layout, brand systems, documents, diagrams, presentations, marketing surfaces, product packaging, or other non-code visual artifacts.

- `ijfw design init` -- create or refresh `DESIGN.md` from detected project context, an existing template, or a chosen brand/style direction.
- `ijfw design plan` -- turn the current goal into a visual plan with scope, surfaces, constraints, success criteria, and DESIGN.md updates to make.
- `ijfw design audit` -- inspect the current design contract or artifact for consistency, accessibility, hierarchy, brand fit, and missing decisions.
- `ijfw design critique` -- challenge the design direction, naming weak assumptions, visual risks, and alternatives before execution.
- `ijfw design polish` -- propose refinements that improve visual quality while preserving the existing direction.
- `ijfw design normalize` -- reduce drift by aligning colors, typography, spacing, tone, components, or layout patterns back to the contract.
- `ijfw design bolder` -- explore a stronger or more distinctive version of the direction while keeping the project constraints visible.
- `ijfw design quieter` -- explore a calmer, more restrained version for dense, operational, editorial, or high-trust contexts.
- `ijfw design handoff` -- summarize the durable state: selected direction, open questions, accepted/rejected choices, artifact links, and next visual tasks.

Prefer this split:
- Use `ijfw design start/open/status/stop/push/clear` for the live companion loop.
- Use `ijfw design init/plan/audit/critique/polish/normalize/bolder/quieter/handoff` for durable design reasoning and `DESIGN.md` memory.

## Step 1 - Check DESIGN.md

Check project root for `DESIGN.md`. If it exists:
- Treat it as the design contract; pass it verbatim to the downstream specialist as source of truth.
- Skip the picker entirely. Write the design-pass sentinel and proceed.

## Step 2 - No DESIGN.md: Three-Option Picker

MCP-only platforms (OpenCode, Qwen Code, Kimi Code, OpenClaw) access the same picker via `ijfw_memory_recall({context_hint: 'design_template[:<name>]'})`. Aider reads `DESIGN.md` once written.

Present exactly three options. Wait for user selection before proceeding. If the user's input doesn't match a valid template name or brand, re-prompt with the numbered list.

### Option 1: Reference a brand ("like Vercel", "like Apple", "like Stripe")
- Detect project domain from: `package.json` name/description/keywords, first paragraph of `README.md`, or project directory name.
- Load `data/brand-atlas.json` (skill-relative) -- 12 domains x 3-5 brands.
- Match keywords against domain entries; offer 3-5 brand suggestions from the best-fit domain.
- If no domain match, offer a cross-domain sample (one brand per aesthetic tier).
- User picks a brand -> compose a downstream prompt using that brand's `aesthetic`, `palette_hint`, and `typography_hint` fields.
- Offer to write the composed design contract to project root as `DESIGN.md` so future sessions skip the picker.

### Option 2: Pick a style (12 curated templates)
List the 12 templates from `templates/design/` with a one-line description each (names are the filenames without `.md`: swiss-minimal, editorial-warm, terminal-native, cinematic-dark, glassmorphic, brutalist-luxe, maximalist-vibrant, neo-swiss-tech, data-dense-dashboard, warm-organic, bento-grid, magazine-editorial).

User picks -> read `templates/design/<pick>.md` -> use as design contract for this session. If the pick is unknown, show the numbered list again and ask for a valid name.
Offer to write it to project root as `DESIGN.md` so future sessions skip the picker.

### Option 3: Blank slate
Defer to the downstream specialist's native brainstorm flow. No preloaded template or brand.

## Step 3 - Dispatcher

Priority order -- best available wins:
1. **ui-ux-pro-max** -- check `enabledPlugins` in `~/.claude/settings.json` for `ui-ux-pro-max@`
2. **frontend-design** -- check `enabledPlugins` for `frontend-design@claude-plugins-official`
3. **superpowers design** -- check `enabledPlugins` for `superpowers@claude-plugins-official`
4. **Internal fallback** -- `node scripts/search.js "<query>" --design-system` (skill-relative)

Force internal: set `IJFW_PREFER_INTERNAL=1`. If no external skill found, emit:
`For richer design output, install ui-ux-pro-max. I'm using internal heuristics now.`

## Step 4 - IJFW Constraint Layer

Append these invariants to any downstream output IJFW itself generates (components, scripts, config):
- **Real HTML mockups, never ASCII** -- see Rule 0 above; enforce on downstream specialists too
- **Zero deps in IJFW code** -- dashboards, MCP server, installer use system font stacks and no CDN
- **User DESIGN.md may import custom fonts** -- templates in `templates/design/` include Google Fonts `@import` by design; that's the user's design contract, not IJFW infrastructure
- **Positive framing** -- never "broken", always "ready to sharpen"
- **Platform segregation** -- Claude/Codex/Gemini as first-class; no mixed-platform assumptions
- **ASCII-only source** -- no unicode in IJFW code or config files (applies to source, not rendered mockup content)
- **4.5:1 contrast minimum** -- both light and dark themes (WCAG AA)

## Design Pass Gate

When complete, write `.ijfw/design-pass.json`:
```json
{"ts": "<ISO>", "query": "<goal>", "source": "<external|internal>", "skill": "<name>"}
```
Preflight gate `design-pass` checks for this sentinel on UI file changes.

## Graduated Offer (Quick mode)

Before any UI code is written, emit:
`I'll run a design pass first. Say "show me" to open it, or "skip" to continue.`

Wait for the user's next turn. One-word `show me` opens the design pass; `skip` continues without the visual companion.
