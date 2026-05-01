# IJFW memories in Obsidian

IJFW writes memories as **plain markdown with YAML frontmatter**. That format is the same one Obsidian uses for vault notes, so the memory directory works as an Obsidian vault out of the box -- no conversion, no plugins, no rewrites.

## Open the memory dir as a vault

```
~/.claude/projects/<your-project-folder>/memory/
```

In Obsidian: **File -> Open vault -> Open folder as vault** -> point at the path above.

You will get:
- Every memory as a note. The `name` from frontmatter renders as the title.
- Frontmatter visible in property view (`name`, `description`, `type`).
- Full-text search across all your memories.
- Graph view of links (works with the `MEMORY.md` index file already).

## What works in 1.2.5

- **YAML frontmatter** -- `name`, `description`, `type` rendered as Obsidian properties.
- **Plain markdown bodies** -- structured rules with `**Why:**` and `**How to apply:**` sections render natively.
- **`MEMORY.md` index** -- one-line links per memory, navigable from the file explorer. Standard `[Title](file.md)` markdown links render and click through correctly in Obsidian; backlinks and graph view show the connections.
- **Type-based filtering** -- search `type: feedback` or `type: project` in Obsidian's full-text search to slice the memory base by category.
- **Recall reads files directly** -- the `ijfw_memory_recall` MCP tool reads memory files by filename, not by parsing `MEMORY.md`. You can hand-edit either the index or individual memory files in Obsidian without breaking IJFW. Add a memory by hand: drop a new `{type}_{slug}.md` file with valid frontmatter and the next session will recall it.

## Native-Obsidian polish on the roadmap

The format is portable and works today. The polish layer that makes Obsidian *feel* native -- `[[wikilinks]]` in the index for first-class backlinks, inline `#tags`, an `aliases:` field, a sample `.obsidian/` config in the memory dir -- is queued for a future release. Memories you have today carry forward; nothing breaks.

## Layout

```
memory/
├── MEMORY.md                      # Index file -- one-line per memory
├── feedback_antisycophancy.md     # Individual memory file
├── feedback_no_public_roadmap.md
├── project_donahoe_loop.md
├── reference_codex_hooks_schema.md
└── user_role.md
```

Files are named `{type}_{slug}.md` so an alphabetical sort groups them by type. Add or remove memories at any time -- IJFW reads them on the next session through the `ijfw_memory_recall` MCP tool.

## Editing memories from Obsidian

You can edit memory files directly in Obsidian. IJFW re-reads them on every session and respects manual changes. If you want a memory to survive Obsidian-side renames, keep the file slug stable (the `name` frontmatter field is the user-visible title and can change freely).

Removing a memory: delete the file. On next session, IJFW will skip it. To stop a memory from being recalled but keep it on disk for reference, set `disabled: true` in the frontmatter.

## Why we like this

Memory should not be locked inside a tool. Plain markdown + YAML means your IJFW memories are portable -- to Obsidian, to any text editor, to grep, to the next note tool you discover. IJFW orchestrates the writing and recall but never owns the format.
