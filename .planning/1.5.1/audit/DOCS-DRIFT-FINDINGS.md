# v1.5.1 Audit: Docs vs reality drift

**Audited:** 2026-05-22  •  **Scope:** README.md, docs/GUIDE.md, CHANGELOG.md v1.5.0 entry, sample SKILL.md files, root + mcp-server CLAUDE.md
**Source of truth:** code in `installer/src/ijfw.js`, `mcp-server/src/cross-orchestrator-cli.js`, `mcp-server/src/server.js`, on-disk file existence.

---

## Summary

- **`ijfw --help` lies the worst** — `installer/src/ijfw.js:printHelp` lists ~13 commands; README + GUIDE document 30+. Top-level README commands like `ijfw cross-audit`, `ijfw cross-research`, `ijfw cross-critique`, `ijfw workflow`, `ijfw handoff`, `ijfw compress`, `ijfw memory-audit`, `ijfw memory-why`, `ijfw metrics`, `ijfw mode`, `ijfw ijfw-plan`, `ijfw ijfw-ship`, `ijfw ijfw-verify`, `ijfw ijfw-execute`, `ijfw ijfw-audit` are NOT in `printHelp`'s output — and many are *pointer stubs* (`COMMAND_ALIAS_HELP`) that say "use the X skill in agents" rather than actually running.
- **MCP tool count is wrong in README** — README:420 says "Thirteen tool endpoints (11 in `tools/list`, 2 admin handlers)"; actual server.js TOOLS array exposes **all 13 in `tools/list`** (including `ijfw_update_check` + `ijfw_update_apply`). The "admin handlers off the list" architecture is gone.
- **`ijfw_memory_status` referenced in 8+ user-facing places but RETIRED** — CHANGELOG v1.2.x retired it from `tools/list`; case handler is the only thing left. README:427, GUIDE.md:239, four claude/ skills, four codex+gemini/ skills, codex IJFW.md, gemini IJFW.md all still call it as if user-facing.
- **Platform count drift everywhere** — README says "14 platforms" + lists Cline + Aider in a 15-row table. GUIDE.md hardcodes "six platforms". CLAUDE.md says "8 AI coding agents". Repo on disk has 11 platform directories (aider, claude, codex, copilot, cursor, gemini, hermes, universal, wayland, windsurf) + Cline is helper-only. README also says "installs to 14" — Sean's live run shows the installer actually deployed to 14.
- **GUIDE.md is a v1.0/v1.1-era document** — hero image hardcoded to `v1.1.1`, claims 6 skills total, 6 platforms, no mention of Trident convergence / state SDK / memory facts / Obsidian / dataview / dream cycle. Reads as if v1.5.0 never happened.

---

## HIGH severity (docs lie about what works — user trust damage)

### HIGH-1 — `ijfw --help` (installer/src/ijfw.js:90–115) does NOT match README's documented commands
**File:line:** `installer/src/ijfw.js:90` (`printHelp`)
**Claim:** README:443–478 ships a 30+ command CLI list. README:122 instructs users (via the AI-bootstrap paste-block) to "Run `ijfw --help` -- expect the full command list".
**Reality:** `printHelp` outputs only: install, uninstall, help, preflight, dashboard, design, blackboard, codex, team, swarm, recover, cross, doctor. Missing from `--help`: update, statusline, config, insight, status, demo, import, receipt, workflow, handoff, compress, consolidate, cross-audit, cross-critique, cross-research, ijfw-audit, ijfw-execute, ijfw-help, ijfw-plan, ijfw-ship, ijfw-verify, memory-audit, memory-consent, memory-why, metrics, mode, override, extension, ui-review, memory checkpoint.
**Fix:** Regenerate `printHelp` from the same source-of-truth as `ORCHESTRATOR_COMMANDS` + `cross-orchestrator-cli.js:printUsage`. Either make `ijfw --help` delegate to the orchestrator's `printUsage` (it has the longer list at line 517) or merge them into one printer.

### HIGH-2 — README lists `ijfw cross-audit` / `ijfw cross-research` / `ijfw cross-critique` as top-level CLI commands but they're slash-shaped pseudo-commands
**File:line:** README:411 "Codex command aliases with Claude parity" + README:459 "`ijfw cross-audit <file>` Slash-style terminal alias for the same Trident path."
**Reality:** Confirmed working — `parseCommandAlias` (`cross-orchestrator-cli.js:304–319`) routes `cross-audit`/`cross-critique`/`cross-research` to `parseCrossAlias`. OK, **these three do work.** But README lists them *side-by-side* with the pointer-stub commands below (HIGH-3) so users can't tell which actually run.
**Fix:** Visually separate "real commands" from "skill pointer stubs" in the README CLI table.

### HIGH-3 — 15 documented `ijfw <command>` invocations are pointer stubs that just tell you to use a skill instead
**File:line:** `cross-orchestrator-cli.js:222–283` `COMMAND_ALIAS_HELP` registry + README:409 (slash command list) + cross-platform parity table at README:553.
**Claim:** README presents these as commands: `workflow`, `handoff`, `compress`, `consolidate`, `ijfw-audit`, `ijfw-execute`, `ijfw-help`, `ijfw-plan`, `ijfw-ship`, `ijfw-verify`, `memory-audit`, `memory-consent`, `memory-why`, `metrics`, `mode`. GUIDE.md:197 says "**End every significant session with `ijfw handoff`.**" as a habit recommendation. GUIDE.md:188 says "`ijfw metrics`" returns "Tokens, cost, routing mix, session totals."
**Reality:** When invoked from shell, every one of these just prints a one-line "Use the ijfw-X skill in agents" pointer (sample: workflow → "Use the ijfw-workflow skill in agents. Terminal helpers: ijfw team init, ijfw swarm plan, ijfw swarm prepare."). `ijfw metrics` does NOT print tokens/cost — it prints "Open the dashboard with: ijfw dashboard start. Agent-side metrics are available through ijfw_metrics." This is the worst kind of doc lie: the command runs without error but does nothing the docs promise.
**Fix:** Either (a) implement the commands for real (terminal `ijfw metrics` should call the same `ijfw_metrics` MCP path and print a table), (b) mark them in docs as "in-agent only", or (c) error loudly with the pointer instead of pretending to be a command. GUIDE.md `ijfw handoff` daily-driver promotion must be retracted.

### HIGH-4 — README claims `ijfw_memory_status` as a user-facing MCP tool; tool was retired
**File:line:** README:427 documents `ijfw_memory_status` in the "Thirteen tool endpoints" table; GUIDE.md:239 documents `ijfw memory status` as a daily-driver command.
**Reality:** server.js TOOLS array (lines 952–1119) lists 11 named tools + `UPDATE_CHECK_TOOL` + `UPDATE_APPLY_TOOL`. NO `ijfw_memory_status`. CHANGELOG.md:1183 (v1.2.x): "**`ijfw_memory_status` retired** to free the MCP tool slot. The case handler is preserved for backward compatibility; the tool no longer appears in `tools/list`."
**Fix:** README:427 row removed; replace with `ijfw_memory_prelude` reference (where the status text now lives per the retirement note). Same for GUIDE.md:239.

### HIGH-5 — 8 SKILL.md files instruct agents to "Call `ijfw_memory_status`" — a tool MCP clients can no longer enumerate
**Files (verified greps):**
- `claude/skills/ijfw-memory-audit/SKILL.md:8`
- `claude/skills/ijfw-recall/SKILL.md:11`
- `codex/skills/ijfw-status/SKILL.md:22`
- `codex/.codex/IJFW.md:87`
- `gemini/extensions/ijfw/skills/ijfw-status/SKILL.md:22`
- `gemini/extensions/ijfw/skills/ijfw-doctor/SKILL.md:13`
- `gemini/extensions/ijfw/skills/ijfw-memory-audit/SKILL.md:8`
- `gemini/extensions/ijfw/skills/ijfw-recall/SKILL.md:11`
- `gemini/extensions/ijfw/IJFW.md:71`
**Reality:** The case handler still works if a client knows the name (server.js:2041) — but `tools/list` doesn't advertise it, so any well-behaved MCP client (including Claude Code) won't render it. Agents told to "Call ijfw_memory_status" will silently fail to find the tool, then hit the fallback degraded behavior in the skill ("If unreachable…").
**Fix:** Sweep all 8 references → replace with `ijfw_memory_prelude` with `detail_level: 'summary'`. (Note: codex `ijfw-doctor` SKILL is ironic — the very skill that's supposed to verify integration health uses a retired tool as its first probe.)

### HIGH-6 — README:438 + CLAUDE.md:26 contradict server.js on what's in tools/list vs admin
**Claim README:420:** "Thirteen tool endpoints (11 in `tools/list`, 2 admin handlers) at the CLAUDE.md cap of 13."
**Claim README:438:** "Hard cap at 13 (raised 12 → 13 in v1.5.0 memory-moat to land `ijfw_memory_facts`…)"
**Reality:** `mcp-server/src/server.js:952` — the TOOLS const includes all 13: memory_recall, memory_store, memory_search, memory_prelude, memory_facts, prompt_check, metrics, cross_project_search, UPDATE_CHECK_TOOL, UPDATE_APPLY_TOOL, run, state, cross_audit_converge. **All 13 ship via `tools/list`.** There are no "off-list admin handlers" anymore — the air-gapped update flow uses tool calls like everything else.
**Fix:** README:420 → "Thirteen tool endpoints, all in `tools/list`." Remove the "+ 2 admin handlers" framing. CLAUDE.md:26 mentions the 13 cap correctly but the README explanation of how they split is wrong.

### HIGH-7 — GUIDE.md is fossilised at v1.1.x and missing nearly every v1.2–v1.5 feature
**File:line:** `docs/GUIDE.md` (entire file).
**Examples of staleness:**
- Hero image (line 2): hardcoded `releases/download/v1.1.1/ijfw-hero.png`.
- Line 43 + 513: "Claude Code, Codex, Gemini, Cursor, Windsurf, and Copilot" — **6 platforms**. No Hermes, Wayland, OpenCode, Qwen, Kimi, OpenClaw, Cline, Aider. README claims 14.
- Line 277: "Only the core IJFW skill (around 55 lines) is always loaded" — matches.
- Lines 281–315 skill reference: lists ~15 skills; actual claude/skills/ has 34 directories. Missing: ijfw-agents-md, ijfw-complete-milestone, ijfw-compute, ijfw-metrics, ijfw-milestone-summary, ijfw-new-milestone, ijfw-new-project, ijfw-plan, ijfw-receiving-review, ijfw-ship, ijfw-spec-phase, ijfw-tdd, ijfw-ui-spec, ijfw-writing-skills.
- No mention of: `ijfw_state` (slot 11), `ijfw_cross_audit_converge` (slot 12), `ijfw_memory_facts` (slot 13), `ijfw_run` sandbox, memory moat (Obsidian / dataview / A-Mem / dream cycle / temporal facts), state-SDK verb facade, swarm/blackboard/team CLI, design companion, statusline, codex sync-agents, multi-domain workflow (book/launch/research/campaign templates), `ijfw cross project-audit`, `--chunk` flag.
- Line 213 "Three quick wins" command examples reference `ijfw memory store "..."` and `ijfw memory recall "..."` — these commands DO NOT EXIST. `cross-orchestrator-cli.js:452` only matches `memory checkpoint`. (Verified: there is no `ijfw memory store` or `ijfw memory recall` handler.) GUIDE's "Win 2: Your first memory round-trip (45 seconds)" example is broken.
- Line 240 `ijfw memory search --scope all "<query>"` doesn't exist either — there is `ijfw_memory_search` MCP tool only.
- Line 537: "Does it work on Windows? Yes. Git Bash (bundled with Git for Windows) is the supported shell." README/preflight contradicts: README:52 says "Node-native end to end -- no bash, no WSL, no Git for Windows shell required."
**Fix:** GUIDE.md needs a from-scratch rewrite to v1.5.0 baseline. This is the single biggest doc-debt item. Highest priority because `ijfw help` ships GUIDE.md as the "full guide" — it's the canonical user-facing documentation.

### HIGH-8 — GUIDE.md's Win 2 (the memory round-trip — IJFW's headline value-prop) uses commands that don't exist
**File:line:** GUIDE.md:88, 94, 237–240.
**Claim:** `ijfw memory store "..."` and `ijfw memory recall "..."` and `ijfw memory status` and `ijfw memory search --scope all "..."`.
**Reality:** The ONLY `ijfw memory <sub>` matcher in `cross-orchestrator-cli.js:452` is `ijfw memory checkpoint <label>`. There is no `store`, `recall`, `status`, or `search` subcommand. These belong to MCP tool calls inside an agent, not the terminal CLI.
**Fix:** Replace with: "From inside Claude Code: `ijfw_memory_store(...)` via the MCP tool, or just say 'remember that we pin npm packages'. From terminal: there is no shell-side memory CLI today — this is in-agent only." Or: implement actual shell-side `ijfw memory store|recall` (clean addition; could route through the MCP server).

---

## MED severity (stale numbers, version refs, broken examples)

### MED-1 — Platform-count inconsistency across docs
- README:25 "Fourteen AI coding agents"; README:484 "Fourteen platforms, one install" with 15 rows in the table.
- README:480 "**Fourteen platforms, one install, one workflow**" — table immediately below has 15 rows (Cline is row 13, Aider is row 14, Universal is row 15). Cline is opt-in.
- GUIDE.md:43 + 513 "**six platforms**".
- CLAUDE.md:4 "**8 AI coding agents**" — also lists only 8 platform directories.
- Repo on disk: 10 active platform directories + aider/, opencode skill bundles via MCP server, Cline opt-in helper. The "14" advertised in README matches what `ijfw install` actually deploys per Sean's live run.
**Fix:** Pick one number (Sean says "14 platforms actually deployed"), propagate across README/GUIDE/CLAUDE.md/mcp-server CLAUDE.md.

### MED-2 — CHANGELOG.md v1.5.0 references docs that don't exist
- CHANGELOG.md:377 "Per-platform enforcement matrix (`docs/PLATFORM-ENFORCEMENT.md`)" — file does NOT exist. (Closest extant file is `docs/ENFORCEMENT-MATRIX.md`.)
- CHANGELOG.md:412 "Result table in `docs/MEMORY-BENCHMARK.md`" — file does NOT exist.
**Fix:** Either ship the files (T16 + T22 deliverables both claim to have shipped them) or correct the path in CHANGELOG. Since both are claimed as part of T16/T22 ship items, this is also a code-completeness issue, not just doc drift.

### MED-3 — README claims `n` skills don't match shipped reality
- README:484 "22 on-demand skills" (Claude Code) — actual `claude/skills/`: **34 directories**.
- README:485 "19 skills" (Codex) — actual `codex/skills/`: **19 directories** ✓ matches.
- README:486 "19 skills" (Gemini) — actual `gemini/extensions/ijfw/skills/`: needs recount but verified existence of more than 10 toml command bundles.
- README:415 "**On-demand skills**: workflow, memory, commit, handoff, review, critique, compress, team setup, debug, cross-audit, design ..., recall, dashboard, preflight, and more." — list is incomplete and doesn't reflect 34 actual claude skills.
**Fix:** Generate skill counts from disk before each release. Add a preflight gate.

### MED-4 — CLAUDE.md (root) is outdated: lists 8 platforms, hangs on v1.4.0 handoff
**File:line:** `/Users/seandonahoe/dev/ijfw/CLAUDE.md:4` ("8 AI coding agents") + lines 8–16 (only 8 platform dirs listed; missing aider) + lines 37–47 (ijfw-memory block is full of v1.4.0/v1.4.1 era content).
**Fix:** Bump "8" → "14" (or whatever matches the agreed number), add `aider/` to the structure list, regenerate the memory block.

### MED-5 — README:480 header says "Fourteen platforms" but the table that follows has 15 rows
Sub-count drift — Universal is item 15 in the table at README:498 but the header is "Fourteen". Either drop Universal from the count or update header to 15.

### MED-6 — README:Cline row says install via `bash scripts/install.sh cline`
**File:line:** README:496.
**Reality:** Repo no longer has `scripts/install.sh`; install is via `installer/dist/install.js` (Node-native, per README:52 itself).
**Fix:** Replace with the right Node-native opt-in invocation.

### MED-7 — README:393 importers claim
**Claim:** "Importers in v1.0: `claude-mem` (full, SQLite). `rtk` (metrics-only, opt-in). More tools land through point releases."
**Reality:** I did not exhaustively verify rtk, but the framing is v1.0-era; should at minimum be moved out of "v1.0" framing into "currently shipped".

### MED-8 — README:362 statusLine claim shows `1.5.1 available`
README:362 example output literally shows `^ 1.5.1 available  |  #####..... 49% left` — confusing because v1.5.0 is the shipped version and 1.5.1 isn't out yet. Choose example numbers that won't look stale on the day a v1.5.1 ships.

### MED-9 — CHANGELOG line 251 says "RETAGGED" + Memory-moat amendment claims tools-cap raised 12→13, but README line 438 says the cap raise was tied to `ijfw_memory_facts` landing
These are consistent in content but the *historical sequence* documented in CHANGELOG (12→13 happened in retag) vs README ("cap is FULLY POPULATED at 13/13") needs one cleanup pass for tense.

### MED-10 — README:493 `ijfw_memory_search` reference in design picker context overlaps the Cold-tier discussion
README:332 says any MCP-connected agent can pick a template via `ijfw_memory_recall` (`context_hint: "design_template"`). Verified in server.js:955 description. ✓ This works. But: same paragraph's "Aider reads `DESIGN.md` ... carries picker instructions inline in `~/CONVENTIONS.md`" — verify in aider config; aider/CONVENTIONS.md exists but the precise wording around picker instructions should be verified by the platform-parity audit.

### MED-11 — GUIDE.md:537 Windows claim contradicts README:52
GUIDE.md says Git Bash supported shell; README says no bash/WSL/Git Bash needed (pure Node). Pick one truth.

### MED-12 — CHANGELOG v1.5.0 claim about MCP tool counts
CHANGELOG.md:473 D1-D5 docs scrub says "README MCP-tool count 10→12". Memory-moat amendment further raised to 13. The line in CHANGELOG is in the post-tag-day section, which is fine, but anyone reading the changelog top-down sees "12" before "13" and may misremember the current cap. Add a "current cap: 13" closing line.

### MED-13 — README:411 "Codex command aliases with Claude parity: the same 22 command files ship under `codex/commands/`" — verified at 22 ✓ matches. No fix.

### MED-14 — README:213 mentions Anthropic skill cost lever "55-line core" — `claude/skills/ijfw-core/SKILL.md` is **54 lines** (verified). Within the 55 hard cap; CLAUDE.md:23 says "Currently 53 lines" — both off by one or two. Tiny issue but auditable. CLAUDE.md should say 54.

### MED-15 — README:362 statusLine 4-line table: "Memory prelude | First turn, all 12 MCP platforms"
12 doesn't match anything else in the README (which uses 14). And "MCP platforms" is a fuzzy phrase — count of platforms that have an MCP server registered? Be explicit.

---

## LOW severity (cosmetic, minor typos, formatting)

### LOW-1 — README:5 CI badge URL uses `therealseandonahoe` (correct per the v1.4.1-shipped memory note) ✓
The memory record showed `therealseandonahoe1` was a previous incorrect path; current README is correct. No action.

### LOW-2 — GUIDE.md:2 hero image URL hardcoded to v1.1.1 release
Should reference `main` or latest tag.

### LOW-3 — Two different cross-orchestrator help messages
`installer/src/ijfw.js:printHelp` and `cross-orchestrator-cli.js:printUsage` (line 517) are two separate help printers. Different content. Pick one canonical printer.

### LOW-4 — README:443 "ijfw install Install IJFW into your AI coding agents." — but the npm package binary is `ijfw-install` (verified in installer/package.json). The bin `ijfw` can also run `install` subcommand. Slight UX confusion; documented OK.

### LOW-5 — CHANGELOG.md v1.5.0 dating
Line 251: "## [1.5.0] -- 2026-05-19 (MAJOR — "The All-in-One That Just Fucking Works") — RETAGGED". Memory-moat amendment line 253 says "2026-05-21". The RETAGGED suffix is informative but a casual reader sees two date stamps. Add a one-line "current released artifact: tag v1.5.0 at <SHA>, ships <date>" line.

### LOW-6 — README:Trident "six independent training lineages" claim
README:318 lists six lineages: OpenAI, Google, Anthropic, Alibaba, DeepSeek, Moonshot. ijfw-cross-audit/SKILL.md lists codex/gemini/claude/deepseek/qwen/kimi/opencode/aider/copilot. Count matches (6 lineages, more auditors than lineages). OK ✓.

### LOW-7 — README:485 "(`.codex-plugin/plugin.json`)" — verify path exists exactly; if codex moved to a different plugin manifest location since v1.4, fix.

### LOW-8 — README:46 PowerShell URL hardcodes `gitlab.com/therealseandonahoe/ijfw` — depends on remote consistency.

### LOW-9 — README:332 "1.1.7 additions" — old version references in current shipping docs. Not wrong, but visually dated.

### LOW-10 — README:489 Copilot `.github/copilot-instructions.md` — verify still correct for 2026 Copilot. (Out of doc-audit scope; flag for platform-parity audit.)

### LOW-11 — `mcp-server/CLAUDE.md` is generic 7-line "Project Context" boilerplate — it does NOT claim 13 tools or describe anything specific. **It is empty of MCP-specific guidance.** A v1.5.1 cleanup item could populate this with the actual MCP tool roster + cap policy, mirroring the lock-in language from the root CLAUDE.md.

---

## Per-doc summary

### README.md  [HIGH: 7, MED: 8, LOW: 6]
- All HIGH findings concern: 13-tool architecture description, retired `ijfw_memory_status` documented as live, pointer-stub commands listed as real CLI commands, platform-count inconsistencies, GUIDE.md drift.
- File path: `/Users/seandonahoe/dev/ijfw/README.md`

### docs/GUIDE.md  [HIGH: 1 (catastrophic — whole file stale), MED: 3, LOW: 2]
- Stuck at v1.1.x baseline. Hero image, skill list, platform list, command examples, FAQ Windows claim all wrong. `ijfw memory store` / `ijfw memory recall` examples literally do not work.
- Highest single-file rewrite priority because `ijfw help` ships this file as the canonical guide.
- File path: `/Users/seandonahoe/dev/ijfw/docs/GUIDE.md`

### CHANGELOG.md v1.5.0 entry (lines 251–572)  [HIGH: 0, MED: 3, LOW: 1]
- Most factual claims verified:
  - `getValidAt`, `getHistory`, `getAllFactsWithWindows` exist in `mcp-server/src/memory/temporal.js` ✓
  - `compareModelIds` exists in `mcp-server/src/model-refresh.js:97` ✓
  - All claimed M1–M5 + INT.x file paths exist on disk ✓
  - `cross-audit-chunker.js`, `shasum-verify.js`, `atomic-io.js`, `memory-facts-handler.js`, `skill-telemetry.js`, `skill-telemetry-sink.js` all exist ✓
- Missing/incorrect:
  - `docs/PLATFORM-ENFORCEMENT.md` (claimed T16) — NOT on disk (closest is `ENFORCEMENT-MATRIX.md`)
  - `docs/MEMORY-BENCHMARK.md` (claimed T22) — NOT on disk
  - Internal MCP-tool-count narrative drifts between 12 and 13 across the entry
- File path: `/Users/seandonahoe/dev/ijfw/CHANGELOG.md`

### SKILL.md files  [HIGH: 1 (8 files), MED: 1, LOW: 0]
- Sample of 10+ skills audited.
- `ijfw-core/SKILL.md` matches the 55-line cap (currently 54). ✓
- `ijfw-compress/SKILL.md` correctly uses measured-per-artifact framing post-v1.5.0 audit. ✓
- `ijfw-cross-audit/SKILL.md` lists six lineages + correct env knobs. ✓
- `ijfw-design/SKILL.md` describes design companion accurately. ✓
- **CRITICAL DRIFT (HIGH-5 above):** 8 skill files across claude/, codex/, gemini/ reference `ijfw_memory_status` which is no longer enumerable via tools/list.
- `codex/skills/ijfw-doctor/SKILL.md` "Call `ijfw_memory_status`" as integration health probe is especially ironic.

### CLAUDE.md (root + mcp-server)  [HIGH: 0, MED: 2, LOW: 1]
- Root `/Users/seandonahoe/dev/ijfw/CLAUDE.md`: says "8 AI coding agents", structure list missing `aider/`, memory block frozen at v1.4.0/v1.4.1 handoff. Line 23 says "Currently 53 lines" but ijfw-core/SKILL.md is now 54.
- `/Users/seandonahoe/dev/ijfw/mcp-server/CLAUDE.md`: 7-line generic boilerplate. Should at minimum mention the 13-tool cap and the verb facade.

---

## Recommended v1.5.1 doc-fix order (highest impact first)

1. **GUIDE.md rewrite** — single biggest doc-debt; ships as the canonical `ijfw help` output (HIGH-7, HIGH-8).
2. **Sweep `ijfw_memory_status` → `ijfw_memory_prelude`** across 8 skill files + README:427 + GUIDE.md:239 (HIGH-4, HIGH-5).
3. **Reconcile `ijfw --help` with `cross-orchestrator-cli.js:printUsage`** — single source of truth (HIGH-1, LOW-3).
4. **Decide policy on pointer-stub commands**: implement, deprecate, or relabel (HIGH-3).
5. **Fix MCP tool-count architecture description** in README:420 + README:438 (HIGH-6).
6. **Propagate one platform count** (likely 14) across README, GUIDE, CLAUDE.md (MED-1, MED-4, MED-5).
7. **Ship the two missing docs** `docs/PLATFORM-ENFORCEMENT.md` + `docs/MEMORY-BENCHMARK.md` (MED-2).
8. **Refresh CLAUDE.md (root + mcp-server)** for v1.5.0 reality (MED-4, LOW-11).
9. **Skill-count audit** — generate from disk, validate in preflight (MED-3).

## Notes for caller / synthesis doc

- Marketing graphic numbers (742 things / 1,382 findings / "+ 9 MORE platforms") vs current (1,649 / 1,287 / 14): the only thing in the docs that mirrors the graphic prose is README:14–17 ("742 things, 95% token savings | 1,382 findings"). Update the README hero-block prose to match the new dashboard numbers when Sean updates the graphic.
- The audit found NO evidence of `getValidAt` / `getHistory` / `getAllFactsWithWindows` / `compareModelIds` being missing — all four exist as exported functions at the claimed paths.
- The audit found NO evidence of memory-moat M1–M5 files being missing — all are on disk.
- Test counts (104/104, 59/59, 100/100+1) in CHANGELOG:334 are point-in-time and not independently verified here (would require running `npm test`); flagged as believable but not cross-checked.
