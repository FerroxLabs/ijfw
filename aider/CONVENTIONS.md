# IJFW Conventions for Aider

Aider doesn't have native MCP, so IJFW's memory + cross-audit tools aren't
available inside Aider sessions. These conventions carry the IJFW spirit
(disciplined workflow, terse output, no scope creep) into the Aider chat.

## Workflow

- One question at a time. Don't dump multi-step plans before user signs off.
- Lead with the answer. No restating the question.
- For multi-file changes, propose the plan in chat FIRST. Wait for user "go".

## Code

- Match existing style. Don't refactor adjacent code that wasn't asked for.
- No speculative abstractions. Three similar lines beats a premature helper.
- No error handling for impossible scenarios. Trust internal code.
- Default to writing no comments. Only add WHEN the WHY is non-obvious.

## Memory + cross-audit

Aider sessions don't see IJFW's persistent memory. After significant work:

- Run `ijfw cross audit <file>` in your terminal to get Trident review.
- Use `ijfw_memory_store` from Claude/Codex/Gemini sessions to persist
  decisions Aider makes -- they won't survive otherwise.

## Scope

Stay in the lane the user asked for. If you spot adjacent issues, mention them
in chat -- don't fix them silently.

## DESIGN picker

If the user asks for a design contract and no `DESIGN.md` exists, suggest one
of the 12 IJFW curated templates (alphabetical):

bento-grid, brutalist-luxe, cinematic-dark, data-dense-dashboard,
editorial-warm, glassmorphic, magazine-editorial, maximalist-vibrant,
neo-swiss-tech, swiss-minimal, terminal-native, warm-organic.

Aider has no MCP client, so it cannot fetch the template body itself. Ask the
user to run this in any MCP-capable sibling CLI on their machine (Claude Code
/ Codex / Gemini / Cursor / Windsurf / Copilot / Hermes / Wayland / OpenCode /
Qwen / Kimi / OpenClaw) and paste the output back into the Aider chat:

    ijfw_memory_recall({ context_hint: "design_template:<name>" })

Once the user pastes the body, Aider writes `DESIGN.md` at the project root
and picks it up automatically on the next turn.
