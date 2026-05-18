---
name: ijfw-agents-md
description: "Maintain canonical AGENTS.md (open spec). Trigger: 'agents.md', 'update AGENTS.md', or auto-fired by ijfw-team after agent generation."
context: fork
model: sonnet
---

# IJFW AGENTS.md Manager

Maintains a project's `AGENTS.md` per the open spec at https://agents.md/.
AGENTS.md is the canonical agent-instructions surface across every IJFW host
(Claude, Gemini, Codex, Wayland, Hermes, Cursor, Windsurf, Copilot). Each
platform-specific file (`CLAUDE.md`, `GEMINI.md`, `WAYLAND.md`, etc.) is a
thin adapter that points here.

---

## When to Invoke

- User says: "agents.md", "update AGENTS.md", "regenerate agents file".
- Auto-fired by `ijfw-team` after generating agents to `.ijfw/agents/`.
- Auto-fired by session-start hooks to refresh memory + agents blocks.

---

## Marker Block Taxonomy (reserved -- do not break)

The file is segmented by four IJFW-managed regions. Content outside markers
is user-authored and untouched.

| Block       | Purpose                                                  |
|-------------|----------------------------------------------------------|
| MEMORY      | Pointer to project memory + last handoff summary         |
| ROUTING     | Peer-skill routing rules (workflow, design, etc.)        |
| AGENTS      | Auto-generated agent definitions from `.ijfw/agents/`    |
| BLACKBOARD  | Reserved for Pillar B (multi-CLI orchestration); empty   |

Each block is delimited by `<!-- IJFW-<NAME>-START -->` /
`<!-- IJFW-<NAME>-END -->` markers. Replace inside; never overwrite.

---

## Frontmatter Contract (typed)

YAML frontmatter at top of file follows the JSON Schema at
`schema/agents-md-frontmatter.json`. Keys that A1 may write or hoist:

- `ijfw_version`, `ijfw_schema` (required when present)
- `type`, `primary_type`, `secondary_types`, `confidence` (A3 writes)
- `detected_at`, `signals` (A3 writes)
- `compute_trust` (vm_only | subprocess), `compute_net` (deny | allow)

Wayland reads `compute_trust` + `compute_net` to set per-project sandbox
defaults. Env vars override only when explicitly set.

---

## Merge Mechanics

1. Use `scripts/lock.sh` -- PID lockfile + atomic rename guarantees
   concurrent invocations serialise without clobbering.
2. `lock.sh` invokes `scripts/merge-block-aware.sh <path> <BLOCK> <content>`
   which replaces marker-bounded regions atomically.
3. If `AGENTS.md` is absent, the merger seeds it from
   `templates/AGENTS.md.tmpl`.
4. If markers are absent in an existing file, they are appended at the end
   (user content stays intact).

---

## Spec Subset IJFW Commits To

YAML frontmatter at top + GitHub-style heading slugs (lowercase, hyphenated).
This is the load-bearing subset of the open AGENTS.md spec; section anchors
remain stable for cross-tool references.

---

## BLACKBOARD Block Population (v1.4.4 Pillar B activation)

The reserved `BLACKBOARD` marker block is now populated by
`mcp-server/src/orchestrator/wave-state.js::checkpointWave` after every wave
checkpoint. This activates Pillar B (multi-CLI orchestration) without requiring
any manual skill invocation.

### Block content shape

```json
{
  "state_path": ".ijfw/wave-<waveId>/STATE.md",
  "last_completions": [
    "<waveId>: <summary line 1>",
    "<waveId>: <summary line 2>",
    "<waveId>: <summary line 3>"
  ]
}
```

- `state_path` — JSON pointer to the active wave's STATE.md.
- `last_completions` — last N=3 completion summaries (configurable; default 3).
  Drawn from the `body` field of each wave's STATE.md, newest first.

### Write rules

1. The populator replaces content **only** between
   `<!-- IJFW-BLACKBOARD-START -->` and `<!-- IJFW-BLACKBOARD-END -->` markers.
2. **Never write outside those markers.** Use `merge-block-aware.sh` with
   `BLACKBOARD` as the block argument — same mechanism as MEMORY/ROUTING/AGENTS.
3. **Idempotency**: serialise the JSON with stable key order + `\n` terminator.
   Re-running on unchanged STATE.md produces byte-identical output; git sees no
   diff noise.
4. If no wave STATE.md exists yet, write an empty JSON object `{}` inside the
   block rather than omitting the block entirely (markers must remain present).

---

## Don'ts

- Do not write outside the four marker blocks.
- Do not replace the whole file; the merger is block-scoped by design.
- Do not write a `.bak` restore unless the user explicitly confirms.
