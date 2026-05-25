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
- Auto-fired by `ijfw-workflow` at brainstorm-LOCK and plan-LOCK with intent context (v1.4.4 N7).

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
| DISCIPLINE  | Per-domain discipline rules (code \| narrative \| business \| design \| research) |

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

## Discipline Block Population (v1.5.2 Wave 5B)

The `DISCIPLINE` marker block is populated by
`mcp-server/src/orchestrator/agents-md-blackboard.js::populateDisciplineBlock`
at brainstorm-LOCK and plan-LOCK in `ijfw-workflow`. It injects per-domain
rules so every agent operating in the project gets domain-appropriate
discipline guidance without manual configuration.

### Block content shape

The block body is the raw text of the matching
`claude/skills/ijfw-agents-md/templates/discipline-<type>.md` file, written
verbatim between the markers. For `unknown` or `mixed` project types the body
is intentionally empty (markers present, body empty — this is the correct
state, not an error).

Example for a `code` project (abbreviated):

```
<!-- IJFW-DISCIPLINE-START -->
# Code Discipline

Working code only. Finish the job. Plausibility is not correctness.
…
<!-- IJFW-DISCIPLINE-END -->
```

### Write rules

1. The populator replaces content **only** between
   `<!-- IJFW-DISCIPLINE-START -->` and `<!-- IJFW-DISCIPLINE-END -->` markers.
2. **Never write outside those markers.** Uses `mergeFile()` from
   `merge-block-aware.js` with `DISCIPLINE` as the block name — same mechanism
   as MEMORY/ROUTING/AGENTS/BLACKBOARD.
3. **Same `withFsLock` tier-#8 AGENTS.md lock** as `populateBlackboardBlock` —
   both writers serialise on the single §3 #8 lock so concurrent fires cannot
   interleave their writes.
4. **Idempotency**: re-running `populateDisciplineBlock` on unchanged project
   type produces byte-identical output; git sees no diff noise. The template
   files are static; the content written is purely a function of `projectType`.
5. **Empty-body contract**: if `selectDisciplineTemplate` returns an empty
   string (for `unknown` or `mixed` types), `mergeFile` still writes the
   block — the marker pair is present in AGENTS.md with an empty body. This
   is intentional: consumers can detect the block's presence without needing
   to distinguish "block absent" from "block empty".

### Auto-fire trigger

`ijfw-workflow` fires `populateDisciplineBlock` at:

- **brainstorm-LOCK** — when the brainstorm output is locked and project type
  is known (or inferable from the repo).
- **plan-LOCK** — when the plan is locked, to refresh discipline context after
  any type reclassification that may have occurred during planning.

These are the same LOCK hooks that fire `populateBlackboardBlock` and
intent-aware seeding — the three fires are sequential within the same lock
acquisition to preserve the §3 ordering invariant.

### Conditional activation (project-type detection)

When `projectType` is not supplied explicitly, `populateDisciplineBlock` calls
`detectProjectTypeFromRepo(projectRoot)` from `discipline-selector.js` to
infer the type. Detection priority:

1. `.ijfw/memory/brief.md` frontmatter `type` key — highest fidelity, set by
   brainstorm-LOCK.
2. Well-known file/dir signals (existsSync only, no glob):
   - `code`: `package.json`, `tsconfig.json`, `Cargo.toml`, `go.mod`,
     `pyproject.toml`, `setup.py`, `Gemfile`, or any `*.csproj` in root.
   - `narrative`: `chapters/` or `manuscript/` directory present.
   - `business`: root entry starting with `pitch-deck` or `business-plan`, or
     any `*.numbers` file.
   - `design`: root entry starting with `figma-`, any `*.sketch` file, or
     `design-system/` directory.
   - `research`: `research/` or `notebooks/` directory, or any `*.ipynb` file.
   - `unknown`: fallback when no signal matches.

---

## Intent-aware seeding (v1.4.4 N7)

When AGENTS.md is being **created fresh** (file missing), the bootstrap is fed
`intent` context from the active brainstorm/plan output (`.ijfw/memory/brief.md`
if present). The bootstrap merges that intent into the initial AGENTS.md body
under a `## Project intent (seeded from brainstorm)` H2 so every subagent has
project goals visible from the first session.

### Rules

1. **Fresh creation only.** If `AGENTS.md` already exists, intent seeding does
   NOT run — idempotent by design. Existing files receive brainstorm context
   as a BLACKBOARD block update instead (see "BLACKBOARD Block Population").
2. **brief.md is optional.** If `.ijfw/memory/brief.md` is absent, bootstrap
   proceeds from the static template without the intent section.
3. **Placement.** The intent section is inserted after the YAML frontmatter
   and before any IJFW-managed marker blocks. User-authored content added
   later is never moved.
4. **Auto-fire trigger.** `ijfw-workflow` fires this skill at brainstorm-LOCK
   and plan-LOCK with the `intent` context. The skill self-detects whether
   AGENTS.md exists to decide seed vs. blackboard-update path.

---

## Platform adapter creation (v1.4.4 N7)

IDE is detected via `mcp-server/src/ide-detect.js` (shipped in v1.4.3 B18).
When the skill runs and the detected platform file is missing, it is created
from the matching adapter template.

| Detected IDE | Missing file    | Template source                        |
|---|---|---|
| Claude       | `CLAUDE.md`     | `templates/CLAUDE.md.adapter.tmpl`     |
| Gemini       | `GEMINI.md`     | `templates/GEMINI.md.adapter.tmpl`     |
| Hermes       | `HERMES.md`     | `templates/HERMES.md.adapter.tmpl`     |
| Wayland      | `WAYLAND.md`    | `templates/WAYLAND.md.adapter.tmpl`    |

### Adapter body

```
# <IDE>

All project conventions live in [AGENTS.md](./AGENTS.md). Read it first.
```

### Rules

1. **Idempotent.** If `<IDE>.md` already exists, it is never touched.
2. **Detection required.** Adapter is only created when `ide-detect.js`
   positively identifies the platform — never speculatively.
3. **Template resolution.** Templates live in the repository root
   `templates/` directory. If the template is absent, the adapter is written
   inline from the body above rather than failing.
4. **Auto-fire trigger.** Same LOCK hook that fires intent seeding also runs
   the adapter-creation check, so a fresh Claude session always bootstraps
   both AGENTS.md content and a matching CLAUDE.md pointer.

---

## Don'ts

- Do not write outside the five marker blocks.
- Do not replace the whole file; the merger is block-scoped by design.
- Do not write a `.bak` restore unless the user explicitly confirms.
