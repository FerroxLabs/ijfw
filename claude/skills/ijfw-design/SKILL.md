---
name: ijfw-design
description: "First-class design intelligence. Dispatches to the best available design skill (ui-ux-pro-max, frontend-design, superpowers), then layers IJFW constraints on top. Triggers: 'design', 'redesign', 'UI', 'UX', 'dashboard', 'page', 'component', 'make it look better', 'polish', 'pretty', 'professional', 'user experience', 'layout', 'visual', 'mobile-first', 'dark mode', 'accessibility', 'colors', 'typography', 'brand'."
---

# IJFW Design

## Rule 0 - Real HTML mockups, never ASCII

When asked to show a design, mockup, layout, screen, or variant, produce REAL HTML. Write to `.planning/<feature>/mockups/<variant>/index.html`, then open in the browser (platform-aware: `open` / `xdg-open` / `wslview`). Use the active `DESIGN.md` or the picked template as the source of truth -- real colors, real type scale, real spacing, real content.

ASCII wireframes in chat are a LAST-RESORT FALLBACK, permitted only when:
- The user explicitly asks for text-only ("just ASCII is fine").
- No writable filesystem is available (extremely rare -- almost never in practice).

Do not default to ASCII boxes. Do not "sketch" in chat. The entire point of this skill is on-brand visual output; ASCII wastes the `DESIGN.md` contract, the palette, the type scale, and the user's time.

Structural diagrams (Mermaid architecture, data flow, component boundaries) are the exception -- those stay as text by convention.

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
`I'll run a design pass first. Hit enter to skip, or say 'show me' to see the plan. (auto-fire in 2s)`

Auto-fire if no response in 2 seconds. One-keystroke skip accepted.
