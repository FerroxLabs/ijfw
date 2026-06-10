# Design contract

One `DESIGN.md` in your project root, and every AI on your stack builds on-brand: the same palette, the same type, no "make it look nice" prompting, and no drift where Claude ships one aesthetic and Codex ships another.

This page documents the contract itself: what it holds, how it gets created, and how each platform reads it. For the surrounding workflow, see [../README.md](../README.md).

## What `DESIGN.md` is

`DESIGN.md` is a single plain-markdown file at the root of your project. It is the durable design memory for that project: the source of truth every agent consults before it writes a line of UI. It is not infrastructure and not generated code; it is yours to edit, and it survives across sessions, platforms, and project phases.

A complete contract follows a canonical nine-section spec:

1. **Visual Theme**: the overall direction in a sentence or two.
2. **Colors**: palette with concrete values, not adjectives.
3. **Typography**: families, scale, weights.
4. **Components**: rules for buttons, cards, inputs, and the like.
5. **Layout**: grid, spacing rhythm, density.
6. **Depth**: shadow, blur, and elevation conventions.
7. **Do's**: the moves that keep work on-brand.
8. **Responsive**: how the design behaves across breakpoints.
9. **Agent Prompt Guide**: instructions written for the downstream AI, so a fresh agent picks up the contract without re-derivation.

The point of writing this down is the same as any contract: it removes ambiguity. An agent reading concrete colors, a real type scale, and explicit do's and don'ts does not have to guess what "professional" or "clean" means for this project, and two different agents reading the same file guess the same way, which is to say they don't guess at all.

## Creating one: the picker

If a project has no `DESIGN.md`, running a design task fires the `ijfw-design` picker with three options:

1. **Reference a brand.** Say "like Vercel" or "like Balenciaga." The skill detects your project's domain from `package.json` (name, description, keywords), the `README.md` lead paragraph, or the directory name, then suggests brands from a 12-domain brand atlas. Each brand is annotated with a palette hint, a typography hint, and the kind of project it best serves. Your pick is composed into a design contract.

2. **Pick a style.** Twelve opinionated templates, each a full nine-section contract:

   | Template | Best for |
   |---|---|
   | `bento-grid` | Modular card grids; Apple/Notion-style product pages |
   | `brutalist-luxe` | Raw texture with editorial restraint; fashion, architecture |
   | `cinematic-dark` | Film-grade dark UI; streaming, media, portfolio |
   | `data-dense-dashboard` | Monitoring/BI layouts optimized for density |
   | `editorial-warm` | Warm off-white magazine feel; newsletters, long-form |
   | `glassmorphic` | Frosted translucency; premium SaaS and fintech |
   | `magazine-editorial` | Print hierarchy with bold display type; publishing, agency |
   | `maximalist-vibrant` | Saturated, high-energy; consumer lifestyle brands |
   | `neo-swiss-tech` | Updated Swiss with accent color; dev tools, SaaS |
   | `swiss-minimal` | Classical Swiss typography; docs and developer sites |
   | `terminal-native` | Monospaced terminal aesthetic; CLIs, infra tools |
   | `warm-organic` | Soft curves and earthy tones; wellness, lifestyle |

3. **Blank slate.** A progressive, one-question-at-a-time brainstorm for designing from first principles.

On confirmation, the picker writes `DESIGN.md` to your project root, so future sessions skip the picker and go straight to contract-driven builds. The templates are compatible with Claude Design (claude.ai/design): dropping one into a new design system there scaffolds a UI kit in one shot.

## How it reaches every platform

The contract is a first-class surface across IJFW's platforms. The same twelve-template catalog and the same brand atlas reach each one; only the delivery mechanism differs.

**Full-skill-tree platforms** (Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot, Hermes, Wayland) ship the `ijfw-design` skill natively. The picker, the templates, and the brand atlas run locally as part of the skill tree.

**MCP-connected agents** (OpenCode, Qwen Code, Kimi Code, OpenClaw) reach the same catalog through the memory server: no local skill required, and no new tool. The picker is served over the existing `ijfw_memory_recall` tool using a colon-syntax `context_hint`:

- `context_hint: "design_template"` returns the catalog: twelve names with one-line descriptions.
- `context_hint: "design_template:<name>"` returns the full body of that template.

So any MCP-connected agent can browse the catalog, fetch a template, and write `DESIGN.md` itself. Template names are validated against a strict pattern and the file read is realpath-checked against the templates directory, so a malformed or traversal-style name returns an error rather than escaping the catalog.

**Aider** sits at the rules-only tier: it reads `DESIGN.md` once the file exists, and carries the picker instructions inline in `~/CONVENTIONS.md`.

The net effect is one contract, every agent. Once `DESIGN.md` is on disk, the platform that authored it is irrelevant: every subsequent agent, on any platform, reads the same file and builds to the same rules.

## Downstream handoff

The picker doesn't render the UI itself; it hands the locked contract to whatever specialist is best for the job. If you have `ui-ux-pro-max`, `frontend-design`, or Superpowers installed, `ijfw-design` dispatches to them with the contract already loaded, in that priority order. If none is present, it falls back to internal design heuristics and says so. Either way the downstream specialist receives `DESIGN.md` verbatim as its source of truth.

## What it is not

The contract is honest about its own limits. It is a file that agents **read**, not a designer that guarantees good taste. It removes a class of failure: aimless "make it look nice" prompting, and the cross-agent drift where each AI improvises its own aesthetic. It does not remove the agent's own quality ceiling. A weak model handed a strong contract still produces weaker output than a strong one would; the contract makes that output *consistent and on-brand*, not automatically excellent. The win is coordination and persistence, not magic.

What you get for the cost of one markdown file: every AI on your stack starts from the same palette, the same type scale, and the same component rules, and every screen added later inherits them automatically, because every agent reads from the same `DESIGN.md`.

---

Back to [../README.md](../README.md).
