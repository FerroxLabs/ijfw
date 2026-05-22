# v1.5.1 Audit Synthesis — Five docs rolled up

**Audit date:** 2026-05-22 (immediately post-v1.5.0 ship)
**Inputs:** 5 findings docs in `.planning/1.5.1/audit/` (CLI-SURFACE, SKILLS-AGENTS-MCP, PLATFORM-PARITY, ORPHAN-CODE, DOCS-DRIFT)
**Total HIGH findings:** ~30 across all surfaces.
**Verdict:** v1.5.0 shipped with significant surface drift. The CODE is largely solid (CHANGELOG file paths and function names all verified ✓), but the SURFACES (help, README, GUIDE, cross-platform claims, MCP descriptions, skill descriptions) are catastrophically out of sync.

---

## The four root-cause patterns

Every HIGH finding ladders up to one of these four patterns:

### Pattern 1 — LYING SURFACES (help text, README, GUIDE, skill descriptions)
The user-facing surfaces over-claim and don't match what the code actually does.

- `ijfw --help` lists 13 commands; README documents 30+; orchestrator usage block lists 15. Three competing source-of-truth files, no parity test.
- **15 pointer-stub commands** in README do nothing (workflow, handoff, compress, consolidate, metrics, mode, memory-audit, memory-why, ijfw-plan, ijfw-ship, ijfw-verify, ijfw-execute, ijfw-audit, ijfw-help, memory-consent). They print "use the X skill in agents" and exit.
- **`ijfw_memory_status` is referenced in 8 SKILL.md files** (including the codex `ijfw-doctor` health probe!) + README:427 + GUIDE.md:239 — but the tool was never registered. Tests against it silently no-op.
- README:420 says "11 in tools/list + 2 admin handlers" — all 13 are in tools/list. Architecture description is wrong.
- README:295 says "11 user-facing + 2 admin" — same lie, different page.
- `ijfw-preflight` claims "12 gates" on Claude SKILL.md and "11 gates" on codex/shared SKILL.md. Pick one.
- README + table + GUIDE + CLAUDE.md disagree on platform count (12 vs 13 vs 14 vs 15 vs 6 vs 8 — all four numbers shipped).
- Comments in `server.js:1086-1114` still say "12/12 cap" — cap is 13.
- `ijfw demo` (the best CLI command) is not in `--help`. First-time users never discover it.
- `ijfw off` is documented in README but returns "Unknown subcommand: off" (delegation never fires).
- `ijfw memory --help` returns "Unknown command: memory" (only `memory checkpoint` exists).

### Pattern 2 — WIRED-BUT-NOT-CALLED (shipped features with no runtime caller)
At least 8 v1.5.0 features have code + tests + CHANGELOG entries but no production call site. Same anti-pattern as the migration-005 bug we already caught.

- **`lib/ui-review-runner.js`** — docstring claims wires 6 design libs; import block has 5. `uispec-intake` is the missing one. (Exact same dual-source pattern as the search.js/migration-005 bug.)
- **T20 `recovery/truncation.js`** — CHANGELOG claims "measured rate ≤31%, falsifiable proof published" → only its own test file imports it. Runtime-loop.js mentions it in a comment but never imports it.
- **T29 `orchestrator/debug-trident.js`** — CHANGELOG claims "every gate's failure mode covered by a Trident dissent test" → only its own test imports it.
- **`gate-result-formatter.js`** — zero production callers.
- **`lib/worktree-guards.js`** (v1.5.0-major S08) — CHANGELOG-claimed, zero callers.
- **`observability/evaluator-checkpoint-contract.js`** (v1.5.0 N4.obs M3) — CHANGELOG-claimed, zero callers.
- **`extension-registry-ws.js`** (B17 stub) — no dynamic-import gate fires it.
- **`memory/benchmark.js`** — zero callers (also CHANGELOG-claimed for T22 with `docs/MEMORY-BENCHMARK.md` that doesn't exist).
- **`bin/ijfw-memorize`** — half-feature. Self-documents that the LLM-synthesis path "emits a TODO marker instead of calling an LLM." Shipped binary writes literal `TODO` strings into user memory.

### Pattern 3 — CROSS-PLATFORM PAPER SUPPORT
Most "supported" platforms are MCP + rules only. The skills/agents/hooks surface is Claude-first with significant gaps everywhere else.

| Platform | Skills | Agents | Hooks | Commands | Status |
|---|---|---|---|---|---|
| Claude | 34 | many | many | many | ✅ Tier-1 first-class |
| Codex | 19 | empty placeholder | some | some | ⚠️ Tier-2 partial |
| Gemini | 0 | 0 | some | 0 | ⚠️ Tier-3 MCP+rules+hooks |
| Cursor | 0 | 0 | 0 | 0 | ❌ Tier-3 MCP+rules only |
| Windsurf | 0 | 0 | 0 | 0 | ❌ Tier-3 MCP+rules only |
| Copilot | 0 | 0 | 0 | 0 | ❌ Tier-3 MCP+rules only |
| Hermes | 0 | 0 | 6 declared / 1 wired | 0 | ⚠️ MCP + 1 hook |
| Wayland | 0 | 0 | 6 declared / 1 wired | 0 | ⚠️ MCP + 1 hook |

Hermes/Wayland plugin.yaml literally says "delegates to Wayland plugin source" — they're a single implementation shipped under two names.

**README:332 lists all 8 in the "eight full-skill-tree platforms" group.** That's a lie for 5 of the 8.

- **`platform-capabilities.json`** declares only 4 of the 14 platforms (claude/codex/gemini/shared). This is the structural cause of "dashboard memory panel empty for non-Claude users" — it's not graceful degradation, the registry is incomplete.
- **`codex/.agents/`** is an empty placeholder. README:223 promises "generated project agents from Team Assembly on Codex" — capability doesn't exist.
- **[CORRECTED 2026-05-22 post-operator-review]** Original audit said "8 phantom agents in `swarm-config.js`." **The deeper bug is worse:** the on-the-fly generator DOES work (`ijfw team init --brief "<book>" --archetype book` empirically produces `.ijfw/agents/chapter-writer.md` + `continuity-editor.md` + charter + workflow + Codex agent mirrors). But there are **THREE disagreeing rosters** for the same domain:
  | Source | Book agents | Convention |
  |---|---|---|
  | `fixtures/team/book.json` (USED by generator.js) | `chapter-writer`, `continuity-editor` | no prefix, 2 agents |
  | `src/team/domain-templates/book.json` (T26 claim, UNUSED by generator) | `ijfw-narrative-continuity-checker`, `ijfw-line-editor`, `ijfw-lore-keeper` | `ijfw-` prefix, 3 agents |
  | `src/swarm-config.js BOOK_BENCH` (swarm dispatcher reads this) | `ijfw-story-architect`, `ijfw-continuity-editor`, `ijfw-prose-stylist`, +2 | `ijfw-` prefix, 5 agents |
  
  **End-to-end failure:** `team init` generates `chapter-writer.md`; `swarm plan` reads BOOK_BENCH which expects `ijfw-story-architect`; names don't match; non-software swarms dispatch nothing they can actually find. **The same bug exists for content, research, design, business archetypes — VERIFIED universal 2026-05-22:**
  
  | Archetype | Generator output (fixtures/) | T26 template (UNUSED) | Swarm bench |
  |---|---|---|---|
  | book | chapter-writer, continuity-editor | ijfw-narrative-continuity-checker, ijfw-line-editor, ijfw-lore-keeper | ijfw-story-architect, ijfw-continuity-editor, ijfw-prose-stylist + 2 |
  | content | content-strategist, editor | ijfw-campaign-strategist, ijfw-copy-reviewer | ijfw-campaign-strategist, ijfw-copy-editor + 2 |
  | research | research-lead, method-reviewer | **EMPTY `[]`** | ijfw-research-lead, ijfw-data-analyst + 2 |
  | design | product-designer, visual-qa | ijfw-design-critic, ijfw-accessibility-reviewer | **CONTENT_BENCH (mis-mapped)** |
  | business | strategy-lead, risk-reviewer | **EMPTY `[]`** | **SOFTWARE_BENCH (mis-mapped)** |
  
  Additional findings beyond the triple-roster:
  - `research` and `business` T26 templates are literally empty (`agent_ids: []`)
  - `swarm-config.js` maps `design → CONTENT_BENCH`, `business → SOFTWARE_BENCH`, `mixed → SOFTWARE_BENCH` — design/business/mixed projects get bench from WRONG domain
  - Zero name overlap between generator output and dispatcher expectations in every non-software domain
  
  **This is the v1.5.0 "multi-domain by default" marketing claim collapsing in practice for ALL 5 non-software archetypes.** Triple-source-of-truth + naming-convention drift + empty T26 templates + wrong bench mappings. **The FB post draft must not ship until this is fixed.** Trident r2 (codex lens, gemini timed out) independently confirmed every HIGH and surfaced no additional bugs in this subsystem — the matrix above IS the complete problem statement.

### Pattern 4 — SOURCE-OF-TRUTH DUPLICATION
The same fact lives in multiple files that drift independently.

- Command list: in printHelp() + ORCHESTRATOR_COMMANDS Set + cross-orchestrator usage block + README + GUIDE — five separate writes, no parity check.
- Migration list: in `memory/search.js` (hardcoded) + `migration-runner.js` (readdirSync discovery). v1.5.0 INT.7 hotfix patched search.js to include 006/007/008, but the dual-pattern remains. Next migration will hit the same bug.
- Platform count: 12 / 13 / 14 / 15 / 6 / 8 — six different numbers shipped in v1.5.0 docs.
- Tool count: comments say 12/12 + 13/13 in different places.
- Test surface: `npm test` runs 1-file smoke locally. CI runs all 209 test files. Local "tests pass" doesn't mean what users think it means.

---

## Three orphan Claude agents
`claude/agents/architect.md`, `builder.md`, `scout.md` — defined but never invoked anywhere in the codebase. Either dispatch them or remove.

---

## What's actually GOOD (the good-news amid the bad)
- CHANGELOG factual claims about file paths, function names (`getValidAt`, `compareModelIds`, etc.) all VERIFY ✓ against the code.
- The code base is internally consistent (no broken imports, no syntax errors).
- The 1,518 test claim holds up — they exist, they run on CI.
- The actual MCP tools that exist (13 of them) all have working handlers.
- The migration-006/007/008 implementations work — INT.7 hotfix wired them at search time.
- The cross-AI auditing capability works end-to-end (`ijfw demo` proves it).

The product works. The surfaces around it lie.

---

## Proposed v1.5.1 wave structure (depends on scope decision)

See **PLAN-v1.5.1.md** (to be written after operator picks parity scope — Path A "honest shrink" vs Path B "build the parity").
