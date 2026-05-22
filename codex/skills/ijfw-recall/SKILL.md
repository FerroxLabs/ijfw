---
name: ijfw-recall
description: "Surface relevant project memory at session start or on demand. Trigger: session start, 'recall', 'remember', 'what do you know', 'context', /recall"
---

## Execution

1. Call `ijfw_memory_recall` with the current task or goal as the query.
   If no specific query, use the last user message or the project name.

2. Also call `ijfw_metrics` to get tier sizes and last-update timestamps.

3. Present findings grouped by tier:

```
WORKING MEMORY (hot -- .ijfw/memory/)
  <N> entries found
  - <key>: <one-line summary>  [<date>]
  ...

PROJECT MEMORY (project-level decisions)
  - <key>: <one-line summary>  [<date>]
  ...

NOTHING RECALLED
  Clean slate -- no relevant entries found for "<query>".
  Start a session to begin building memory.
```

4. After presenting, offer in one line:
   > `<N> things recalled. Want the full text of any entry? (name it)`

## Rules

- Never dump raw file contents. Summarize each entry to one line.
- If memory is empty or the MCP tool is unavailable, check `.ijfw/memory/knowledge.md`
  directly -- it is plain markdown.
- Omit tiers with zero matches. Show "Clean slate" only when all tiers are empty.
- Do not fabricate entries. If recall returns nothing, say so clearly.
