# IJFW Conventions for Pi

<!-- Pi MCP support last verified: 2026-05-28 against https://pi.dev/.
     Pi has no native MCP client (build as extension or skill). When Pi adds
     native MCP, regenerate this file and consider promoting Pi from
     rules-only to full-skill tier in installer/src/install-targets-8-14.js
     and add the MCP wiring path. -->

Pi has no native MCP, so IJFW's memory + cross-audit tools aren't available
inside Pi sessions out of the box. These conventions carry the IJFW spirit
(disciplined workflow, terse output, no scope creep, no half-shipping) into
Pi's terminal harness. Pi loads this file at startup from `~/.pi/agent/`,
parent directories, and the current working directory -- exactly where IJFW
installs it.

## Workflow

- One question at a time. Don't dump multi-step plans before the user signs off.
- Lead with the answer. No restating the question.
- For multi-file changes, propose the plan in chat FIRST. Wait for the user "go".
- Terse output. The diff is the deliverable, not your prose about the diff.

## Code

- Match existing style. Don't refactor adjacent code that wasn't asked for.
- No speculative abstractions. Three similar lines beats a premature helper.
- No error handling for impossible scenarios. Trust internal code; validate only at system boundaries.
- Default to writing no comments. Only add when the WHY is non-obvious (a hidden constraint, a subtle invariant, a workaround for a specific bug).
- Never write multi-paragraph docstrings. One short line max.

## Memory + cross-audit

Pi sessions don't see IJFW's persistent memory by default. After significant work:

- Run `ijfw cross audit <file>` in a separate terminal to get a Trident review across two model families.
- Use `ijfw_memory_store` from a Claude/Codex/Gemini session (where MCP is native) to persist decisions Pi makes -- they won't survive otherwise.
- Or build a Pi extension that bridges to the IJFW MCP memory server (`~/.ijfw/mcp-server/src/server.js`). Pi's extension API supports tool registration; the bridge is the cleanest path to native parity.

## Scope

Stay in the lane the user asked for. If you spot adjacent issues, mention them in chat -- don't fix them silently. No drive-by refactors. No backwards-compatibility shims for code that isn't shipped yet.

## DESIGN picker

If the user asks for a design contract and no `DESIGN.md` exists in the project root, suggest one of the 12 IJFW curated templates (alphabetical):

apple-glass, anthropic, bauhaus, brutalist, calm, dark-mode, document, editorial, glassmorphism, minimal, neo-brutalist, terminal

Show 3 options matching the project's vibe; let the user pick. Then write `DESIGN.md` to project root. Every IJFW-connected agent reads the same visual contract -- you keep them consistent.

## Executing actions with care

Carefully consider blast radius before destructive ops. Local edits and tests are safe; check with the user before `rm -rf`, force pushes, dropping tables, sending messages, or anything visible to others or hard to reverse.

When you hit an obstacle, find the root cause rather than bypassing safety checks (no `--no-verify`, no force-push to main). If you encounter unfamiliar state, investigate before deleting -- it may be the user's in-progress work.
