# v1.5.1 Plan — "Stop The Lying, Build The Parity, Fix The Foundations"

**Milestone scope (operator-approved 2026-05-22):**
- **Pattern 1 (Lying surfaces):** fix all in W1
- **Pattern 2 (Orphan code):** wire each one → make CHANGELOG honest (W2)
- **Pattern 3 (Cross-platform paper support):** BUILD the parity — Path B (W4, the big one)
- **Pattern 4 (Source-of-truth dup):** fix in v1.5.1 — single registry per surface (W3)

**Estimated calendar:** 4-6 weeks with aggressive parallelism. ~80-120 commits expected.

**Source inputs:** All 5 docs in `.planning/1.5.1/audit/` + `SYNTHESIS.md`.

---

## Wave structure (7 waves + ship) — MAX-PARALLEL EXECUTION MODE

**Operator sign-off 2026-05-22:** maximum-parallel swarm execution. Peak 16+ subagents simultaneous. Same dispatch discipline that worked for v1.5.0 W12 + memory-moat M1-M5.

**Operator decisions locked:**
1. ✅ Plan approved — execute as multi-agent parallel swarm
2. ⏸ CHANGELOG edits HELD until v1.5.1 ships (no retroactive v1.5.0 amendments)
3. ⏸ FB post HELD until W1.5 lands (3-4 days) — multi-domain claim must be true E2E first

```
W0 ─ Prep (1 day, SEQUENTIAL) ── 4 tasks
   │  guard rails: branch, scaffold, fix npm test = full surface, write handoff
   │
   ▼
═══════════════════ MASSIVE PARALLEL SWING (3-5 days, ~20 agents) ══════════════════
   │
   ├──► W1 STOP THE LYING ───── 6 parallel agents (CLI surface, dead handlers, count drift)
   ├──► W1.5 MULTI-DOMAIN FIX ── 1 sequential decider + 5 parallel wirers + 2 verifiers
   │       [credibility wave — unblocks FB post]
   └──► W3 SOURCE-OF-TRUTH ─── 6 parallel agents (registries, parity tests)
                                       │
                                       ▼
═══════════════════ ORPHAN-WIRING SWING (1 week, ~10 agents) ══════════════════════
   │
   └──► W2 WIRE OR EXPLAIN ──── 10 parallel agents (each orphan = 1 agent)
                                       │
                                       ▼
═══════════════════ PARITY BUILD (2-3 weeks, ~8 agents after design gate) ════════
   │
   └──► W4 PARITY BUILD
         ├── W4.A DESIGN (sequential 3d gate, 1 architect agent)
         └── then W4.B-I: 8 parallel platform-specific build agents
                                       │
                                       ▼
═══════════════════ DOCS REWRITE (3-4 days, 6 agents) ═════════════════════════════
   │
   └──► W5 DOCS REWRITE ─────── 6 parallel agents (one per doc)
                                       │
                                       ▼
═══════════════════ SHIP (3-5 days, sequential) ═══════════════════════════════════
   │
   └──► W6 TRIDENT + SHIP ────── Trident r23 → adjudicate → retag → local 2FA publish
```

**Peak parallelism: ~20 subagents simultaneous during W1+W1.5+W3 swing.**

**Hard ordering edges (the only sequential bottlenecks):**
- W0 → everything (guard rails first)
- W1.5.A decider gate → W1.5.B-E wirers (need to pick canonical source first)
- W4.A design gate → W4.B-I builders (need skill-execution model spec first)
- W5 → after W1+W1.5+W2+W3+W4 (docs reflect accurate state)
- W6 → after W5

**Everything else dispatches in parallel.**

**Hard dependency edges:**
- W4 starts after W1 cleanup (parity baseline must be clean)
- W5 starts after W1+W2+W3+W4 (docs need accurate state to reflect)
- W6 starts after W5

---

## Wave-W0 — Prep (1 day, sequential)

| ID | Task | Files | Notes |
|---|---|---|---|
| W0.1 | Create v1.5.1 branch from main | git | `v1.5.1-staging` |
| W0.2 | Stand up `.planning/1.5.1/` execution scaffold | filesystem | wave dirs, HANDOFF, state |
| W0.3 | Make `npm test` run full surface locally | `mcp-server/package.json` | currently runs 1-file smoke; CI runs 209 — fix this gap FIRST so all subsequent waves have guard rails |
| W0.4 | Lock the plan + commit to handoff doc | git | so context survives compaction |

---

## Wave-W1 — STOP THE LYING (3 days, 6 parallel sub-tasks)

Pattern 1 fixes. Pure surface-truth pass — no design work.

| ID | Task | Files | Parallel? |
|---|---|---|---|
| W1.A | Fix `ijfw off` (add to ORCHESTRATOR_COMMANDS) + add `ijfw demo` to help + restructure `printHelp()` with Tier-1/2/3 split + add `ijfw commands` verb | `installer/src/ijfw.js` | ✓ |
| W1.B | Remove 15 pointer-stub commands from `ORCHESTRATOR_COMMANDS` + clean up their README mentions | `installer/src/ijfw.js`, `README.md` | ✓ |
| W1.C | Kill `ijfw_memory_status` — remove dead handler + remove from 8 SKILL.md files + README:427 + GUIDE.md:239. Replace each callsite with `ijfw_metrics` (real health probe). | `mcp-server/src/server.js:2041`, 8× SKILL.md, README, GUIDE | ✓ |
| W1.D | Reconcile counts: 12/12→13/13 in server.js comments; 12/13/14/15/6/8 → single source 14; ijfw-preflight gate count (12 vs 11) → pick one and align both SKILL.md files | `mcp-server/src/server.js:1086-1114`, README ×4, GUIDE, CLAUDE.md, SKILL.md ×2 | ✓ |
| W1.E | Fix `ijfw memory --help` — promote `memory` to real namespace with `--help` OR rename `memory checkpoint` to top-level `ijfw checkpoint` | `cross-orchestrator-cli.js`, README | ✓ |
| W1.F | Fix README:420 + README:295 — both say "11 tools/list + 2 admin" — both are wrong, all 13 in tools/list | `README.md` | ✓ |

**Acceptance:**
- `ijfw --help` shows 10 user-valuable commands with `demo` first
- `ijfw off` works
- `ijfw memory --help` works (or `memory` removed as a namespace)
- Every README `ijfw <cmd>` example actually runs end-to-end
- Tool count is 13 everywhere
- Platform count is one number everywhere

---

## Wave-W1.5 — MULTI-DOMAIN FIX (3-4 days, sequential)

**The credibility wave.** Until this wave lands, the v1.5.0 MULTI-DOMAIN-PROVEN claim is false and the FB launch post can't ship. Trident r2 (codex lens) confirmed every non-software archetype is end-to-end broken.

| ID | Task | Files | Notes |
|---|---|---|---|
| W1.5.A | Pick the single canonical roster source per domain | design doc | Two options: (a) make `src/team/domain-templates/` authoritative + delete fixtures; (b) keep fixtures + make T26 derive from them. Recommend (a) — T26 was the v1.5.0 design intent, just never wired. |
| W1.5.B | Wire generator.js to load from chosen single source | `mcp-server/src/team/generator.js` | Replace FIXTURE_DIR with the canonical path; update loadTeamTemplate; ensure DOMAIN_SPECIALIST_AGENT_IDS feeds into createTeamAssembly. |
| W1.5.C | Populate empty T26 templates | `src/team/domain-templates/research.json`, `business.json` | Both currently `agent_ids: []`. Pick the right 2-4 agents per domain. |
| W1.5.D | Fix swarm-config.js wrong bench mappings | `mcp-server/src/swarm-config.js` | `design → CONTENT_BENCH` should be `→ DESIGN_BENCH` (which doesn't exist yet — build it). `business → SOFTWARE_BENCH` should be `→ BUSINESS_BENCH`. `mixed → SOFTWARE_BENCH` is debatable — probably right but needs rationale. |
| W1.5.E | Align naming convention across generator output + swarm dispatch | both files | Pick `ijfw-` prefix or no prefix. Recommend `ijfw-` prefix to match Claude agent name convention. Migrate all 5 archetype outputs. |
| W1.5.F | Build a `team init → swarm plan → swarm dispatch` end-to-end test per archetype | new test file | Currently nothing exercises this whole chain. Each archetype: init, plan, verify swarm finds all generated agents by name, dispatch produces output. Run on CI. |
| W1.5.G | Re-run Trident r3 with both codex + gemini on the fix | `ijfw cross audit` | Validates the fix structurally before merge. Retry gemini explicitly since r2 timed out. |
| W1.5.H | Update CHANGELOG v1.5.0 retroactive caveat OR amend MULTI-DOMAIN-PROVEN claim | `CHANGELOG.md` | Honest framing: "v1.5.0 shipped multi-domain SCAFFOLDING; v1.5.1 closes the end-to-end loop." |

**Acceptance for W1.5:**
- `ijfw team init --archetype book` generates agents whose names MATCH what `ijfw swarm plan` expects
- Same for content, research, design, business
- End-to-end test per archetype passes on CI
- Trident r3 (codex + gemini) returns 0 HIGH on this subsystem
- FB post can ship truthfully

---

## Wave-W2 — WIRE OR EXPLAIN (1 week, 10 parallel sub-tasks)

Pattern 2 fixes. Each orphan gets a runtime call site OR a documented removal.

| ID | Task | Approach |
|---|---|---|
| W2.A | Wire `uispec-intake` into `lib/ui-review-runner.js` imports | 5-min fix — add to import block, use in the 6-pillar audit pipeline |
| W2.B | Wire T20 `recovery/truncation.js` into `runtime-loop.js` error-handling path | Replace the existing comment-only reference with a real import + call site; verify truncation rate is measured into receipt |
| W2.C | Wire T29 `orchestrator/debug-trident.js` into gate-failure handler | When `verification-gate` fails, dispatch debug-trident for 2nd opinion before BLOCK |
| W2.D | Wire `gate-result-formatter.js` into status emission | Replace ad-hoc gate-result formatting with the formatter; consolidate output style |
| W2.E | Wire `lib/worktree-guards.js` into `dispatchSubagent` worktree-creation path | Apply cwd-drift + abs-path containment + protected-ref deny-list as preconditions of worktree spawn |
| W2.F | Wire `observability/evaluator-checkpoint-contract.js` into checkpoint emission | Validate every checkpoint envelope against the contract before write |
| W2.G | Wire `extension-registry-ws.js` dynamic-import gate on extension activation | Add the gate that the B17 stub anticipated |
| W2.H | Wire `memory/benchmark.js` into `ijfw metrics` + write `docs/MEMORY-BENCHMARK.md` | Surface recall@k / MRR / NDCG@10 / p95 latency in metrics output |
| W2.I | Fix `bin/ijfw-memorize` half-feature | Two choices: (a) implement the LLM-synthesis path (drop the literal `TODO` marker); (b) remove binary entirely. Recommend (a) since binary is referenced in docs. |
| W2.J | Resolve 3 orphan Claude agents (`architect.md`, `builder.md`, `scout.md`) | Either dispatch from somewhere appropriate OR remove |

**Acceptance:**
- Every v1.5.0 CHANGELOG library claim has a verifiable runtime call site
- No `bin/` script ships writing literal `TODO` markers
- `docs/MEMORY-BENCHMARK.md` and `docs/PLATFORM-ENFORCEMENT.md` both exist (the two missing files claimed in CHANGELOG)

---

## Wave-W3 — SOURCE-OF-TRUTH REFACTOR (1 week, 6 parallel sub-tasks)

Pattern 4 fixes. Structural prevention of future drift bugs.

| ID | Task | Files |
|---|---|---|
| W3.A | Build `installer/src/command-registry.js` — single JSON manifest with every command (name, tier, owner, description, status). `printHelp()`, `ORCHESTRATOR_COMMANDS`, and a README-generator all derive from it. | New file + 3 consumers |
| W3.B | Drop hardcoded migration list in `memory/search.js`; use `migration-runner.js` `readdirSync` discovery as single source. Migration N+1 won't re-trigger the search.js drift bug. | `mcp-server/src/memory/search.js`, `migration-runner.js` |
| W3.C | Expand `platform-capabilities.json` to all 14 platforms with capability metadata (memory, hooks, skills, agents, commands, mcp). Dashboard reads from this single registry — fixes "empty panel for non-Claude users" structurally. | `mcp-server/platform-capabilities.json` + dashboard reader |
| W3.D | Single platform-count constant (`PLATFORM_COUNT = 14`); all docs and CLI surfaces reference it via template substitution or a docs build step. | `mcp-server/src/constants.js` + docs templating |
| W3.E | Make `npm test` run the full 209-file surface locally. Add `npm run test:smoke` for the 1-file quick check. Update CONTRIBUTING. | `mcp-server/package.json` |
| W3.F | Add parity tests: `test-command-registry-parity.js` (printHelp matches registry matches ORCHESTRATOR_COMMANDS), `test-mcp-tool-registry.js` (description matches handler behavior), `test-platform-capabilities-parity.js` (every install target has a capability entry) | New test files |

**Acceptance:**
- Three writes of the command list collapse to one
- Migration discovery is single-source
- Platform capability registry covers all 14 deployed platforms
- `npm test` matches what CI runs
- 3 new parity tests fail CI if registries drift again

---

## Wave-W4 — CROSS-PLATFORM PARITY BUILD (2-3 weeks, the big one)

Pattern 3 fixes — Path B. Build actual skill/agent/hook surfaces across all 8 named tier-1 platforms.

### W4.A — DESIGN phase (3 days, sequential — gates everything else)
Write per-platform skill-execution model spec. Cursor/Windsurf/Copilot don't have a native skill primitive — we have to design one.

Options to evaluate per platform:
- (a) **MCP-tool-per-skill** — each skill becomes an MCP tool the agent can invoke
- (b) **Rules-file-with-trigger-keywords** — skill content embedded in rules file, model self-selects
- (c) **Hybrid** — small set of MCP tools that load skill content on demand from a registry

Output: `docs/PLATFORM-SKILL-EXECUTION-MODEL.md` — definitive design doc per platform.

### W4.B — Codex parity uplift (3 days, parallel-friendly)
Port the ~15 Claude skills missing from Codex. Bring Codex from 19 → 34 to match Claude. Most are mechanical port work.

### W4.C — Gemini skill layer (4 days)
Build skill-execution layer using existing Gemini hooks + new skill registry. Likely Option (c) hybrid.

### W4.D — Cursor skill layer (4 days)
Likely Option (a) MCP-tool-per-skill. Each skill becomes a callable tool exposed via MCP.

### W4.E — Windsurf skill layer (3 days)
Same approach as Cursor — Windsurf is structurally similar.

### W4.F — Copilot skill layer (3 days)
Limited surface. Likely Option (b) rules + MCP-call patterns only.

### W4.G — Consolidate Hermes/Wayland (2 days)
They're already one implementation. Either: rename to make Hermes a thin wrapper, OR formally deprecate one. Wire the 6 declared hooks (currently only 1 wired).

### W4.H — Codex agents (3 days)
Populate `codex/.agents/` with actual agent files (not just placeholder marketplace.json). Match the Claude agents set where Codex's tool surface allows.

### W4.I — Resolve 8 phantom swarm-config agents (2 days)
Each of `ijfw-story-architect`, `ijfw-continuity-editor`, `ijfw-copy-editor`, `ijfw-data-analyst`, `ijfw-prose-stylist`, `ijfw-research-lead`, plus 3rd-party refs — either build the agent files OR remove from swarm-config. Without these, non-software swarms (book/research/campaign) dispatch nothing.

**Acceptance:**
- All 8 tier-1 platforms have a working skill execution path (whatever shape that takes for each)
- Codex has agent parity with Claude
- Non-software swarms (book, research, campaign) dispatch real agents
- Marketing claim "8 first-class platforms" is honest

---

## Wave-W5 — DOCS REWRITE (3-4 days, parallel by doc)

| ID | Task | Files |
|---|---|---|
| W5.A | GUIDE.md full rewrite for v1.5.x | `docs/GUIDE.md` (currently v1.1-era, basically dead) |
| W5.B | README rewrite — honest tier system + corrected counts + actually-shipping features | `README.md` |
| W5.C | Write `docs/PLATFORM-ENFORCEMENT.md` (T16, missing) | new file |
| W5.D | Write `docs/MEMORY-BENCHMARK.md` (T22, missing) — auto-generated from `memory/benchmark.js` output ideally | new file |
| W5.E | Marketing graphic refresh per the spec we already wrote (1,649 things, 1,287 findings, 14 platforms named) | external (Sean handles via ChatGPT) |
| W5.F | CHANGELOG v1.5.0 retroactive amendment block — close the orphan-claim loop honestly | `CHANGELOG.md` |

---

## Wave-W6 — TRIDENT + SHIP (3-5 days)

| ID | Task |
|---|---|
| W6.A | Final regression sweep on full test surface |
| W6.B | Trident r23 — 3-lens cross-audit on entire v1.5.0→v1.5.1 diff |
| W6.C | Adjudicate r23 findings + close any HIGHs |
| W6.D | Retag v1.5.1 |
| W6.E | Phase F — local 2FA publish to npm (same flow that worked for v1.5.0; skip the OIDC dance) |

---

## Total task count

- W0: 4 tasks
- W1: 6 tasks (parallel)
- W2: 10 tasks (parallel)
- W3: 6 tasks (parallel)
- W4: 9 tasks (mostly parallel after W4.A design)
- W5: 6 tasks (parallel)
- W6: 5 tasks

**~46 tasks total.** With aggressive parallel dispatch (3-5 subagents per wave), realistic ship date is **~4 weeks** from W0 start.

---

## What does NOT get fixed in v1.5.1

Listed here so it's explicit and doesn't sneak back as scope creep:
- ❌ Marketing collateral beyond the graphic refresh (FB post is done; X/LinkedIn deferred)
- ❌ Hosted publisher key registry (still v1.6.0 backlog from v1.4.0 era)
- ❌ Tier-2 runtime mediation hooks beyond Claude (deferred from v1.5.0)
- ❌ OIDC trusted-publisher CI retry — local 2FA ships v1.5.1
- ❌ Major new MCP tools (slot 14+) — keep cap at 13 unless one of the parity-build needs it

---

## Halt protocol

If at any point during execution we discover a NEW class of bug not covered by the 4 patterns above, halt the wave, write up the finding to `.planning/1.5.1/audit/`, and re-scope before continuing. No silent expansion.

---

**Ready for sign-off.**
