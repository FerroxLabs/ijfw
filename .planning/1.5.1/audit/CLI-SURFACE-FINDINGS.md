# v1.5.1 CLI Surface Audit — Pre-Swarm Findings

Captured from in-session investigation before parallel audit dispatch.
This is the seed input for Wave-A1.

## Source-of-truth situation (it's a mess)

There are **THREE different help/usage blocks** for the same CLI surface, and they don't agree:

1. `installer/src/ijfw.js:90 printHelp()` — lists **13** commands
2. `installer/src/ijfw.js:51 ORCHESTRATOR_COMMANDS` — Set of **36** delegated commands
3. `mcp-server/src/cross-orchestrator-cli.js` — orchestrator prints its OWN usage block on "Unknown command" with **15** commands

None of the three lists match. No test enforces parity.

## Confirmed bugs / lies in v1.5.0 ship

### BUG-1: `ijfw off` is broken
- `cross-orchestrator-cli.js:397` handles `args[0] === 'off'` as uninstall alias
- `installer/src/ijfw.js:51 ORCHESTRATOR_COMMANDS` does NOT include `'off'` → delegation never fires
- Result: `ijfw off` returns "Unknown subcommand: off" even though it's documented in README

### BUG-2: `ijfw memory --help` returns "Unknown command: memory"
- `memory` is NOT a top-level command in the orchestrator
- Only `ijfw memory checkpoint <label>` actually works
- README and pointer-stub `ijfw memory-audit` both imply a richer surface that doesn't exist

### BUG-3: `ijfw --help` hides the killer demo
- `ijfw demo` produces real, immediate value (runs Trident on a sample, shows critical/high findings)
- It is NOT listed in `printHelp()`
- First-time users running `ijfw --help` never discover it — marketing bug

### BUG-4: 8 pointer-stub commands lie about the CLI surface
The following commands accept input and print "use the X skill" but do no actual work:
- `ijfw workflow` → "use the ijfw-workflow skill in agents"
- `ijfw handoff` → "use the ijfw-handoff skill in agents"
- `ijfw memory-audit` → "use the ijfw-memory-audit skill"
- `ijfw ijfw-verify` → "Run: ijfw preflight"
- `ijfw compress` → "use the ijfw-compress skill"
- `ijfw consolidate` → "use the ijfw-handoff skill"
- `ijfw mode` → "Inspect with ijfw config --audit"
- `ijfw metrics` → "Open dashboard"

Decision needed: remove from `ORCHESTRATOR_COMMANDS`, or keep as silent redirects.

### BUG-5: Help shows plumbing instead of value
Current `--help` lists `blackboard`, `codex`, `team`, `swarm`, `recover` as primary commands.
These are coordination/plumbing — 99% of users will never type them.
Meanwhile `demo`, `status`, `update`, `receipt`, `import` (all user-valuable) are hidden.

## Confirmed working but HIDDEN from `--help`

These all work standalone but are not advertised:
- `ijfw demo` — Trident tour, shows real findings
- `ijfw status` — JSON run history
- `ijfw update` — self-upgrade
- `ijfw version` — version string
- `ijfw receipt last` — print latest Trident receipt
- `ijfw import <tool>` — migrate from claude-mem / cursor-rules
- `ijfw memory checkpoint <label>` — namespace one-off
- `ijfw cross-audit / cross-critique / cross-research` — top-level aliases of `cross <mode>`
- `ijfw statusline / config / insight / extension / override / ui-review` — plumbing

## Recommended Tier 1/2/3 split

### Tier 1 — primary CLI surface (~10 commands in `--help`)
```
GET STARTED   install · uninstall · doctor · update
USE IT        demo · cross · dashboard · preflight
EXPLORE       help · commands · --version
```

### Tier 2 — coordination surface (via `ijfw commands`)
```
status · recover · team · swarm · blackboard · receipt · memory · import · design
```

### Tier 3 — plumbing (via `ijfw config` or hidden)
```
statusline · config · codex · extension · override · insight · ui-review
```

### REMOVE from CLI entirely (or silent redirect)
```
workflow · handoff · memory-audit · ijfw-verify · compress · consolidate · mode · metrics
```

## Beyond CLI — what else needs auditing

This file only covers CLI surface. Parallel agents are checking:
- MCP tool surface (13 tools — all documented? all working?)
- Skills surface across 14 platforms (orphan detection, cross-platform parity)
- Agents surface in `claude/agents/` (orphan detection, tool validation)
- Wired-but-not-called code (like the migration 005 bug we just fixed)
- README/GUIDE/CHANGELOG claims vs actual code
- Cross-platform parity (claude features missing in codex/gemini/etc.)
- Hook coverage across platforms
- Stale TODO/FIXME/DEPRECATED markers
- Test surface gaps
