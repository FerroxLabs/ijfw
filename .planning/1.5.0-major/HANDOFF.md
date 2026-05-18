# IJFW v1.5.0 (major) — "The All-in-One That Just Fucking Works"

**Status:** Scope approved 2026-05-18. v1.5.0-foundation locally tagged was deleted; full v1.5.0 ships with this scope.
**Theme:** Replace GSD and Superpowers with one install. Software, books, campaigns, design — any domain. Zero config.
**Foundation:** v1.5.0-foundation (16 items, 1428/1428 tests, Trident r14 PASS) is already on `main` at `c45cb2c..HEAD`. This handoff layers 30 NEW items on top.

---

## The thesis

IJFW v1.4.4 + v1.5.0-foundation shipped the orchestration scaffolding. The cross-system audit (R1-R4) proved it works on most dimensions, but the all-in-one claim ("one install, every domain, zero config") needs the next 30 items to be REAL. After this milestone:

- **GSD users have no reason to keep GSD** — IJFW does the workflows, phases, roadmaps, milestones, code review, debug-session-manager, specialists, and ships them across 14 platforms (GSD ships Claude-only).
- **Superpowers users have no reason to keep Superpowers** — IJFW does the Iron Law verification, brainstorming, TDD, writing-plans discipline, plus cross-AI audit + memory + parallel-worktree dispatch + 14 platforms (Superpowers ships to 4).
- **Multi-domain users have no alternative** — IJFW is the only AI orchestration layer that ships book/campaign/design/landing-page templates alongside software.

The audit confirmed: we're stronger at workflows (auto-picker), memory (only one with it), cross-AI (we invented it; GSD borrowed it), and multi-platform (14 vs 1 or 4). We need to absorb GSD's specialist discipline + Superpowers' verification rigor + ship multi-domain templates to complete the all-in-one claim.

---

## Scope: 30 items + 3 replacement tests

### Bucket A: Discipline lifts from Superpowers + GSD (10 items, ~12-19 dev-days)

| ID | Item | Source | Files | Effort |
|----|------|--------|-------|--------|
| **S01** | S1 worktree → parent checkpoint visibility (env-var passthrough + drain-before-cleanup) | R3 finding | `checkpoint-cli.js`, `subagent-telemetry.js`, `extension.js`, new `wave-cli.js` drain hook, new e2e test | 3-5d |
| **S02** | Runtime-loop MCP tools (force orchestrator-LLM to call contract functions, not on honor) | R3 finding | new `runtime-loop.js`, `post-done-runner.js`, 2 MCP tools in `server.js`, `ijfw-workflow/SKILL.md` updates | 4-6d |
| **S03** | Description-as-trigger CSO discipline (rewrite frontmatters, add preflight lint) | Superpowers | 10 SKILL.md frontmatters + `scripts/lint/check-skill-descriptions.sh` | 0.5d |
| **S04** | Iron Law verification + Common Failures + Rationalization tables in ijfw-verify | Superpowers | `claude/skills/ijfw-verify/SKILL.md` rewrite | 1d |
| **S05** | Adversarial reviewer framing ("don't trust the report") | Superpowers | `prompts/spec-reviewer.md`, `prompts/quality-reviewer.md` | 0.5d |
| **S06** | "Bad work is worse than no work" + escalation invitation in implementer brief | Superpowers | `lib/dispatch-helpers.md`, implementer prompt template | 0.5d |
| **S07** | GSD deviation rules + 3-attempt fix cap (cross-worktree budget via S1 telemetry) | GSD | NEW `claude/agents/ijfw-executor.md` + `status-protocol.js` `Attempts:` field | 1-2d |
| **S08** | 3 worktree safety guards (cwd-drift, abs-path containment, protected-ref deny-list) | GSD | NEW `lib/worktree-guards.js` + integration in checkpoint-cli/extension | 1-2d |
| **S09** | Self-check protocol (verify claimed files+commits exist before reporting) | GSD | `dispatch-helpers.md` + runtime-loop post-DONE check | 1d |
| **S10** | Recovery-sentinel pattern for worktree cleanup | GSD | NEW `lib/worktree-recovery.js` | 1d |

### Bucket B: New inventions only we can do (5 items, ~13-20 dev-days)

| ID | Item | Source | Files | Effort |
|----|------|--------|-------|--------|
| **N01** | Multi-lens consensus convergence (CYCLE_SUMMARY × cross-AI roster) | IJFW invention | `cross-orchestrator.js` new `runPhaseEConverge`, divergence detection, stall breaker | 3-5d |
| **N02** | Cross-AI checkpoint resume (claude truncates → resume as gemini/codex) | IJFW invention | `runtime-loop.js` resume logic, AI selection heuristic, telemetry hooks | 3-5d |
| **N03** | Trident as a service (expose `ijfw_cross_audit_converge` as MCP tool) | IJFW invention | `server.js` MCP tool wiring, docs/CROSS-AUDIT-API.md | 2-3d |
| **N04** | Memory-backed deviation patterns (failure modes feed forward) | IJFW invention | `memory-feedback.js` extension, deviation-pattern detector | 2-3d |
| **N05** | Live wave dashboard intervention (click to redispatch/swap AI/block) | IJFW invention | `dashboard-server.js` POST endpoints, `dashboard-client-waves.html` interactive controls | 3-4d |

### Bucket C: All-in-one completeness (15 items, ~18-26 dev-days)

| ID | Item | Source | Files | Effort |
|----|------|--------|-------|--------|
| **C01** | `ijfw-new-project` skill (multi-domain project bootstrap) | GSD adapted | NEW `claude/skills/ijfw-new-project/SKILL.md` | 1d |
| **C02** | `ijfw-new-milestone` skill (roadmap-driven milestone planning) | GSD adapted | NEW `claude/skills/ijfw-new-milestone/SKILL.md` | 1d |
| **C03** | `ijfw-roadmapper` agent (ROADMAP.md generation + phase derivation) | GSD adapted | NEW `claude/agents/ijfw-roadmapper.md` | 1d |
| **C04** | `ijfw-complete-milestone` skill (archive + summary + next-milestone seed) | GSD adapted | NEW `claude/skills/ijfw-complete-milestone/SKILL.md` | 1d |
| **C05** | `ijfw-spec-phase` skill + `ijfw-discuss-phase` agent (ambiguity scoring, adaptive questioning) | GSD adapted | NEW skill + agent | 1.5d |
| **C06** | `ijfw-extract-learnings` agent (post-phase mining → memory) | GSD adapted | NEW agent | 0.5d |
| **C07** | `ijfw-milestone-summary` skill (onboarding doc from artifacts) | GSD adapted | NEW skill | 0.5d |
| **C08** | `ijfw-ui-spec` phase + `ijfw-ui-auditor` agent (6-pillar visual audit) | GSD adapted | NEW skill + agent | 2d |
| **C09** | `ijfw-debug-session-manager` + `ijfw-debugger` agents (3-layer w/ DATA_START/END defense) | GSD adapted | 2 NEW agents + restructured `ijfw-debug/SKILL.md` | 3-4d |
| **C10** | `ijfw-assumptions-analyzer` agent (surfaces hidden brief/plan assumptions) | GSD adapted | NEW agent | 0.5d |
| **C11** | `ijfw-codebase-mapper` agent (parallel mapping → .planning/codebase/) | GSD adapted | NEW agent | 1d |
| **C12** | Domain templates: `claude/skills/ijfw-new-project/templates/{book,campaign,landing-page,design-system,launch}.brief.md` | IJFW original | 5 NEW templates | 2d |
| **C13** | Domain phase patterns: per-domain recipes in ijfw-workflow | IJFW original | `ijfw-workflow/templates/{book,campaign,...}.phases.md` | 2d |
| **C14** | Pre-dispatch plan-checker gate (no-placeholders + completeness) | Superpowers + GSD | `mcp-server/src/orchestrator/plan-checker.js` + MCP tool | 1.5d |
| **C15** | TDD skill: `ijfw-tdd` (RED-GREEN-REFACTOR enforcement) | Superpowers | NEW `claude/skills/ijfw-tdd/SKILL.md` | 1d |

### Replacement-test drives (3 tests, ~2-3 days sequential)

| ID | Test | Source | Acceptance |
|----|------|--------|------------|
| **RT1** | GSD-style multi-phase software build entirely with IJFW | replacement claim | Driver runs `discover → spec → plan → execute → review → ship`. Documents every place IJFW falls short of GSD's UX. Findings become in-milestone fixes. |
| **RT2** | Superpowers-style TDD task entirely with IJFW | replacement claim | Driver runs brainstorming → writing-plans → TDD execute → verification flow. Same finding loop. |
| **RT3** | Multi-domain proof (one non-software project) | "any domain" claim | Driver produces: book chapter outline / marketing campaign brief / landing-page sketch + spec. Artifact published as evidence. |

---

## Wave 12 execution plan

```
Wave 12-A0 (sequential prelude — 2 items):
  S01 — worktree blindness fix      [unblocks every dispatch]
  S02 — runtime-loop MCP tools      [converts 6 advisory → wired]

Wave 12-A (parallel after A0 — 8 items):
  S03 S04 S05 S06 S07 S08 S09 S10   [Bucket A discipline lifts]

Wave 12-B (parallel after A — 7 items):
  C01 C02 C03 C04 C05 C06 C07       [Bucket C: PM + spec/discuss + summary]

Wave 12-C (parallel after B — 5 items):
  N01 N02 N03 N04 N05               [Bucket B: new inventions]

Wave 12-D (parallel after C — 8 items):
  C08 C09 C10 C11 C12 C13 C14 C15   [Bucket C remaining + domain templates + TDD + plan-checker]

Wave 12-E (sequential — 3 replacement tests):
  RT1 → RT2 → RT3                   [each finds + fixes gaps in same session]

Phase D: merge all wave branches + CHANGELOG + dogfooding receipt (≥12 checkpoint files for lock-in #42)
Phase E: Trident r15 auto-fire — uses N01's CYCLE_SUMMARY convergence (will iterate until 0 HIGH)
Phase F: delete v1.5.0 tag locally (already done), retag at final HEAD, push to gitlab → CI publish stage (S8 from foundation)
```

### Coordination invariants

- Wave 12-A0 MUST land first. S07 (3-attempt cap), N01 (multi-lens convergence), N02 (cross-AI resume), N04 (memory feedback), N05 (intervention) all depend on S01 + S02.
- Every Wave 12 subagent dispatched as `Agent({ isolation: 'worktree' })`. After S01 lands, checkpoints will actually survive worktree cleanup.
- Reserved markers in shared files (`ijfw-workflow/SKILL.md` will see edits from S03, S05, S06, C05, C09 — pre-seed `<!-- IJFW-A-DISCIPLINE -->`, `<!-- IJFW-C-MILESTONES -->`, etc.).

### Truncation strategy (this milestone proves S01 + S07 work end-to-end)

- Wave 12-A0 lands → S01 + S02 + S07 working.
- Wave 12-A and onwards: every subagent uses `ijfw checkpoint` CLI. When subagent truncates, orchestrator reads checkpoint from PARENT's `.ijfw/wave-W12-*/` (because S01 fix means checkpoints land in parent dir).
- 3-attempt cap (S07) bounds runaway behavior. Cross-AI checkpoint resume (N02) handles persistent failures by swapping AIs.

---

## Cost estimate

| Bucket | Items | Serial dev-days | Parallel wall-clock |
|--------|-------|------------------|---------------------|
| A (discipline lifts) | 10 | 12-19 | ~4-6 hrs |
| B (new inventions) | 5 | 13-20 | ~5-8 hrs |
| C (all-in-one completeness) | 15 | 18-26 | ~6-10 hrs |
| Replacement tests | 3 | 2-3 | sequential |
| Phase D-E-F | — | 0.5-1 | 1 hr |
| **Total v1.5.0 (major)** | **33** | **45-69 dev-days** | **~17-27 wall-clock hrs** |

For comparison: v1.5.0-foundation was 16 items / 14.5 dev-days serial / ~6 wall-clock hrs. This is ~3× bigger — real major version scope.

---

## Locked architectural decisions (additive to v1.4.0-v1.5.0 foundation lock-ins #1-42)

43. **Replacement claim is acceptance-tested, not asserted.** RT1, RT2, RT3 are required Phase E gates. Failing any test = the all-in-one claim isn't real; fix in-milestone.
44. **Discipline is wired, not advisory.** Every v1.5.0-major feature has either a runtime caller in JS OR is invoked as an MCP tool the orchestrator-LLM is REQUIRED by skill text to call. No exceptions.
45. **Domain templates are first-class.** Software, book, campaign, landing-page, design-system, launch all have brief templates + phase patterns shipped in `claude/skills/ijfw-new-project/templates/` and `ijfw-workflow/templates/`.
46. **Cross-worktree checkpoint visibility is the canonical S1 path.** S01's env-var passthrough + drain-before-cleanup IS the dispatch model. Shared-tree dispatch is a fallback for explicitly-flagged single-agent flows.
47. **Multi-lens consensus is the canonical Phase E.** Single-shot Phase E is the fallback. Default Trident behavior is convergence-loop with divergence detection.
48. **Memory feeds forward.** Every BLOCKED / 3-attempt-cap-hit / divergence-detected event writes a memory entry that the next phase's planner reads. Failure modes become first-class signals.

---

## Pre-execution checklist

- [x] Foundation (v1.5.0-foundation 16 items) shipped to `c45cb2c..HEAD` on main
- [x] Cross-system audit complete (R1-R4 docs in `.planning/audit-cross-system/`)
- [x] Local v1.5.0 tag deleted (will retag at final v1.5.0-major HEAD)
- [x] Wave 12-A0 prelude scope locked (S01 worktree fix + S02 runtime-loop MCP)
- [ ] Wave 12-A0 dispatched
- [ ] Wave 12-A through 12-E executed
- [ ] Phase D merge + CHANGELOG
- [ ] Phase E Trident r15 (uses N01 convergence)
- [ ] Phase F ship via CI publish (requires npmjs trusted-publisher operator setup per `docs/CI-PUBLISH.md`)

---

## Resume prompt for next session

> Continue IJFW v1.5.0 (major) per `.planning/1.5.0-major/HANDOFF.md`. **PREREQ:** v1.5.0-foundation is on `main` at `HEAD~N..c45cb2c`. v1.5.0 local tag was deleted; will retag at final major HEAD. Read full handoff. Wave 12-A0 prelude is foundational (S01 + S02) — must land before anything else. Then Wave 12-A (8 parallel), 12-B (7 parallel), 12-C (5 parallel), 12-D (8 parallel), 12-E (3 replacement tests sequential). Phase D merge + CHANGELOG. Phase E Trident r15 with N01 multi-lens convergence. Phase F ship via CI publish.
