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
