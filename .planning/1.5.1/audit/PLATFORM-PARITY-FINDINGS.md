# v1.5.1 Audit: Cross-platform parity + hooks

Auditor: cross-platform agent (parity + hook coverage scope)
Companion docs: `CLI-SURFACE-FINDINGS.md` (CLI internals — separate agent)
Repo HEAD audited: `main` @ post-v1.5.0 ship

---

## Summary

- **Three platforms are paper-supported, not real:** Cursor, Windsurf, and Copilot ship ONLY `mcp.json` + a rules file. No skills, no hooks, no commands, no agents. README explicitly calls them part of the "eight full-skill-tree platforms" alongside Claude Code/Codex/Gemini — that claim is false today.
- **Hermes and Wayland are real, but not in the "skill tree" sense Claude is.** They install the shared/skills/ directory (19 SKILL.md files), a Python plugin tree, and a single Python tier-2 extension-check hook. No agents. One hook event registered, vs Claude's 6 events and 11 scripts.
- **`platform-capabilities.json` only knows about 4 entries (claude / codex / gemini / shared).** Cursor, Windsurf, Copilot, Hermes, Wayland and ALL 6 tier-2 platforms are absent from the capability registry the dashboard reads. This is the root cause of the dashboard "memory panel empty for non-Claude users" issue noted in CLAUDE.md.
- **Codex is the second-most-real platform** but it has no agents (only an empty `marketplace.json` placeholder), so Team Assembly cannot produce project agents on Codex despite README claiming "Codex also gets… generated project agents from Team Assembly".
- **Platform count drift in shipped strings:** README says "fourteen platforms" (×2) AND "all 12 MCP platforms" (line 361) in the same file. `gemini-extension.json` says "13 AI coding platforms". `universal/ijfw-rules.md` correctly says 14. Three different numbers shipped to users in v1.5.0.

---

## Capability matrix

Legend: `Y` = real, `n` = absent/missing, `~` = partial / token presence only.

| Capability                  | claude | codex | gemini | cursor | windsurf | copilot | hermes | wayland | opencode | qwen | cline | kimi | openclaw | aider |
|-----------------------------|:------:|:-----:|:------:|:------:|:--------:|:-------:|:------:|:-------:|:--------:|:----:|:-----:|:----:|:--------:|:-----:|
| Dedicated repo dir          | Y      | Y     | Y      | Y      | Y        | Y       | Y      | Y       | n        | n    | n     | n    | n        | Y     |
| Native MCP register         | Y      | Y     | Y      | Y      | Y        | Y       | Y      | Y       | Y        | Y    | Y     | Y    | Y        | n     |
| Skills (SKILL.md count)     | 34     | 19    | 19     | 0      | 0        | 0       | 19¹    | 19¹     | 0        | 0    | 0     | 0    | 0        | 0     |
| Agents (md count)           | 33     | 0²    | 3      | 0      | 0        | 0       | 0      | 0       | 0        | 0    | 0     | 0    | 0        | 0     |
| Slash/CLI commands          | 22     | 22    | 19     | 0      | 0        | 0       | 6³     | 6³      | 0        | 0    | 0     | 0    | 0        | 0     |
| Hook script count           | 11     | 10    | 16     | 0      | 0        | 0       | 1      | 1       | 0        | 0    | 0     | 0    | 0        | 0     |
| Hook events registered      | 6      | 6     | 11     | 0      | 0        | 0       | 1      | 1       | 0        | 0    | 0     | 0    | 0        | 0     |
| Rules / policy file         | Y      | Y     | Y      | Y      | Y        | Y       | Y      | Y       | n        | n    | n     | n    | n        | Y     |
| In platform-capabilities.json | Y    | Y     | Y      | n      | n        | n       | n      | n       | n        | n    | n     | n    | n        | n     |
| install-target function     | Y      | Y     | Y      | Y      | Y        | Y       | Y      | Y       | Y        | Y    | Y     | Y    | Y        | Y     |

¹ Hermes/Wayland install the 19 from `shared/skills/`, copy-if-absent. Same body, no platform-specific adaptation.
² `codex/.agents/plugins/marketplace.json` is the only file in codex's agent surface — it's an empty marketplace placeholder, not actual agent definitions.
³ Hermes/Wayland declare 6 commands in `plugin.yaml` (`cross-audit`, `cross-research`, `cross-critique`, `workflow`, `handoff`, `compress`) — wired as Python handlers, not slash commands.

---

## HIGH severity — paper-supported platforms missing critical features

### H1. Cursor / Windsurf / Copilot are claimed as full-skill-tree, ship as rules+MCP only
**Claim:** README:332 — *"The eight full-skill-tree platforms (Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot, Hermes, Wayland) ship the picker + 12 templates + brand atlas natively."*
**Reality:** Cursor's repo dir contains `.cursor/mcp.json` + `.cursor/rules/ijfw.mdc` + a `.cursorrules` file. **Zero skills, zero hooks, zero commands, zero agents, zero design templates as files.** Same for Windsurf (just `mcp_config.json` + `.windsurfrules`) and Copilot (`.vscode/mcp.json` + `copilot-instructions.md`).
**Impact:** Users on Cursor/Windsurf/Copilot have NO local design-template picker. The picker exists only through MCP `ijfw_memory_recall context_hint:design_template` — which is the same path README:332 explicitly admits is the *fallback* for the "1.1.7 additions" (OpenCode/Qwen/Kimi/OpenClaw). So the rhetorical distinction between the "eight full-skill-tree" group and the "1.1.7 additions" group is fiction at the file-system level.
**Files implicated:** `cursor/`, `windsurf/`, `copilot/`, README.md:332.

### H2. `platform-capabilities.json` covers 3 of 14 platforms
**Claim:** Dashboard surfaces per-platform capability state.
**Reality:** `platform-capabilities.json` declares only claude / codex / gemini / shared. Cursor, Windsurf, Copilot, Hermes, Wayland, OpenCode, Qwen, Cline, Kimi, OpenClaw, Aider have no entry.
**Impact:** Anything in the dashboard or doctor that iterates `platform-capabilities.platforms` silently skips 11 of 14 platforms. This explicitly matches the CLAUDE.md note: *"Non-Claude-only users see populated cost tiles but empty memory panels — graceful degradation."* It's not graceful: the registry is wrong.
**Files implicated:** `platform-capabilities.json`.

### H3. Codex has no agents on disk, but README promises "generated project agents"
**Claim:** README:223 — *"Codex also gets Claude-parity command aliases and generated project agents from Team Assembly."*
**Reality:** `codex/.agents/plugins/marketplace.json` is the only file in codex's agent surface. There are no agent `.md` files in `codex/`. Team Assembly on Codex therefore writes to a directory that has no priors; whether it works at runtime depends on installer + MCP, but the repo has no Codex agent templates equivalent to Claude's 33.
**Impact:** Codex users invoking Team Assembly get no project-scoped agent templates with first-class Codex framing; they get whatever Team Assembly's generic generator produces.
**Files implicated:** `codex/.agents/plugins/marketplace.json` (only file), README.md:223.

### H4. Platform-count drift in user-facing strings
**Claim:** Inconsistent.
**Reality:**
- README.md:608 says "fourteen platforms" and lists all 14.
- README.md:664 footer: "fourteen platforms".
- README.md:361 (memory-prelude table): "all 12 MCP platforms".
- `gemini/extensions/ijfw/gemini-extension.json:4`: "13 AI coding platforms".
- `universal/ijfw-rules.md:4`: "14 platforms" (correct).
**Impact:** Three different platform counts shipped to users in v1.5.0. The 12 figure (README:361) is closest to ground truth since Aider has no MCP and Copilot's MCP is project-scoped — but it should be either "12 MCP" or "14 total" consistently.
**Files implicated:** README.md:361, gemini-extension.json:4, plus future-proofing of universal/ijfw-rules.md (already correct).

---

## MED severity — parity gaps that don't break the user, but worth closing

### M1. Hermes/Wayland share 100% of skill bodies via `shared/skills/`
The 19 `shared/skills/<name>/SKILL.md` files are copied verbatim to both `~/.hermes/skills/` and `~/.wayland/skills/`. There's no Hermes-specific or Wayland-specific framing. This is fine for many skills (`ijfw-commit`, `ijfw-status`) but `ijfw-team` and `ijfw-workflow` likely benefit from per-platform invocation hints. Worth a pass.

### M2. Codex hook event drift vs Claude
Claude registers 6 events: `SessionStart`, `PreCompact`, `Stop`, `PreToolUse` (3 scripts!), `PostToolUse`, `UserPromptSubmit`.
Codex registers 6 events: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (2 scripts), `PostToolUse`, `Stop`, `PermissionRequest`.
**Codex has PermissionRequest, Claude doesn't.** **Claude has PreCompact + sandbox-nudge + compute-nudge, Codex doesn't.** This is a deliberate platform-API delta — but worth documenting in `platform-capabilities.json` so the dashboard can show parity rows.

### M3. Gemini has 11 hook events but no compute-nudge / sandbox-nudge equivalents
Gemini hooks: `SessionStart`, `SessionEnd`, `BeforeAgent`, `BeforeTool` (3 scripts incl. compute-nudge), `AfterTool`, `AfterAgent`, plus `before-model`, `after-model`, `notification`, `pre-compress`, `session-start-dashboard`, `user-prompt-submit-capture`, `observation-capture` per dir listing. Actually Gemini has the **richest hook surface** of any platform — richer than Claude. The compute-nudge IS there as `before-tool-compute-nudge.sh`. So this is OK; just note that Gemini, not Claude, is the hook-coverage leader.

### M4. Hermes installer wires hook into config.yaml, but only one event
`installHermes` calls `mergeYamlHook(dst, 'plugins/ijfw/hooks/pre_tool_use_extension_check.py', ctx.ts)`. That's the only hook. Hermes plugin.yaml declares 6 hook capabilities (`on_session_start`, `pre_llm_call`, `pre_tool_call`, `post_tool_call`, `post_llm_call`, `on_session_end`) but only `pre_tool_call` is wired. Five capabilities declared, one delivered.

### M5. Wayland identical to Hermes
Same 5-of-6 hook gap. Same shared/skills directory. Same Python plugin tree. Same single tier-2 hook. The two are siblings (Hermes plugin.yaml literally says "Hermes shim delegates to Wayland plugin source"). If we're going to keep both as tier-1, document that they're a single implementation; if we're consolidating, this is an obvious candidate.

### M6. Codex no longer has "agents/" repo dir but README implies one
The `codex/agents/` directory does not exist. Only `codex/.agents/plugins/marketplace.json`. Either create the parity directory or remove the README implication.

### M7. Tier-2 platforms have no rules file beyond MCP config
OpenCode, Qwen, Cline, Kimi, OpenClaw install only an MCP config entry. The universal/ijfw-rules.md exists but no installer step copies it into those platforms' rules locations (where they have one). Result: an OpenCode user installs IJFW, gets the MCP server, but their model has no rules-file context unless they paste the universal file manually.

---

## LOW severity — cosmetic, doc cleanup

### L1. README:608 lists tier-2 platforms in a different order than CANONICAL_ORDER
`install-flow.js` CANONICAL_ORDER puts wayland before hermes; README lists hermes first. Aesthetic, not functional.

### L2. `gemini-extension.json:4` description says "11-event hooks" but Gemini hooks.json has 11+ events including notification, pre-compress, observation-capture. Close enough; if exact count matters, recount.

### L3. The `.shared/skills/` set (19) does NOT match Claude's 34 — and that's by design — but the table in README:223 says "19 on Codex/Gemini, 22 on Claude Code." Actual Claude count is **34 skills**, not 22. README:223 conflates skills with commands (22 commands on Claude). Worth fixing.

### L4. Hermes/Wayland `AGENTS.md` exists at the repo dir top level but ships nothing actionable: it's an IJFW context-marker file (`ijfw_version: 1.3.1`, `primary_type: software`). Versions are stale (1.3.1) vs current 1.5.0.

### L5. `plugin.yaml` `version: 1.3.1` on both hermes and wayland — stale vs v1.5.0.

### L6. README:308 references "Cline ships as opt-in today pending live VS Code runtime verification" — Cline's status hasn't moved in multiple milestones. Either promote or demote.

### L7. `aider/CONVENTIONS.md` comment says *"Aider MCP support last verified: 2026-05-06"* — re-verify or move the date.

---

## Recommended tier system

Today's `install-flow.js` CANONICAL_ORDER bundles all 14 platforms into one list. The shipping reality is three tiers:

### Tier-1: Full integration (skills + hooks + commands + native plugin surface)
- **Claude Code** — 34 skills, 33 agents, 22 commands, 11 hook scripts across 6 events. Flagship. Real.
- **Codex** — 19 skills, 22 commands, 10 hook scripts across 6 events. Real. **Missing: agents directory.**
- **Gemini** — 19 skills, 3 agents, 19 commands (.toml), 16 hook scripts across 11 events. **Richest hook surface.** Real.

### Tier-2: Plugin + hook integration (Python plugin, shared skills, one hook wired)
- **Hermes** — single Python tier-2 extension-check hook, 19 shared skills copied verbatim, 6 commands as Python handlers (not slash commands). Real but thin.
- **Wayland** — identical to Hermes. Consolidate or document.

### Tier-3: Rules + MCP only (no skills, no hooks, no commands, no agents)
- **Cursor**, **Windsurf**, **Copilot** — currently misclassified in README as "full-skill-tree." Honest classification = Tier-3.

### Tier-4: MCP only (no rules, no skills, no hooks)
- **OpenCode**, **Qwen Code**, **Cline**, **Kimi Code**, **OpenClaw**. Each installer just merges the MCP config in. Should be installer-named "MCP-only platforms" and described that way in README.

### Tier-5: Rules-only (no MCP at all)
- **Aider** — explicitly documented as MCP-less in `aider/CONVENTIONS.md`. Already honest.

### Concrete action proposal for v1.5.1
1. Add `tier` field to every entry in `platform-capabilities.json`; backfill the missing 11 entries with `{ tier, skillsCount, hookCount, agentsCount, commandsCount }`.
2. Rewrite README:332 to reflect the actual three-tier reality (Tier-1 ships local picker + templates as files; Tier-2/3/4 reach the catalog via MCP).
3. Fix README:223 — separate skills count (34) from commands count (22) on Claude.
4. Promote either Cursor or Windsurf to real Tier-1 (add at minimum 5 priority skills as `.mdc` rules-fragments OR `.windsurfrules` includes) **or** demote both to Tier-3 honestly.
5. Either consolidate Hermes+Wayland (Hermes.plugin.yaml already says "delegates to Wayland plugin source") or invest in real Hermes-specific surfaces.
6. Wire the missing Hermes/Wayland hook events (5 of 6 declared-but-not-wired). Each is a 30-line Python handler.
7. Pick one platform count (12 MCP / 14 total) and search-replace every shipped string.
8. Bump Hermes/Wayland `plugin.yaml` to 1.5.0 and refresh AGENTS.md `ijfw_version` from 1.3.1.

---

## Appendix: file evidence

- Claude full skill tree: `claude/skills/` (34 dirs), `claude/agents/` (33 .md), `claude/commands/` (22 .md), `claude/hooks/scripts/` (11 .sh/.js).
- Codex full surface: `codex/skills/` (19 dirs), `codex/commands/` (22 .md), `codex/.codex/hooks/` (10 .sh).
- Gemini full surface: `gemini/extensions/ijfw/skills/` (19), `agents/` (3), `commands/` (19 .toml), `hooks/` (16 .sh).
- Cursor surface: `cursor/.cursor/mcp.json`, `cursor/.cursor/rules/ijfw.mdc`, `cursor/.cursorrules`. **Three files total.**
- Windsurf surface: `windsurf/mcp_config.json`, `windsurf/.windsurfrules`. **Two files total.**
- Copilot surface: `copilot/.vscode/mcp.json`, `copilot/copilot-instructions.md`. **Two files total.**
- Hermes surface: `hermes/HERMES.md`, `hermes/config.yaml.template`, `hermes/AGENTS.md`, `hermes/plugins/ijfw/` (Python plugin tree with 1 hook), `hermes/test_extension_check.py`. Skills come from `shared/skills/`.
- Wayland surface: identical structure to Hermes under `wayland/`.
- Aider surface: `aider/aider.conf.yml`, `aider/CONVENTIONS.md`. **Two files. No MCP. Documented as such.**
- Tier-2 (OpenCode/Qwen/Cline/Kimi/OpenClaw): **no repo directories**. Pure installer-side MCP-config merges per `installer/src/install-targets-8-14.js` lines 122-232.

End of audit.
