# v1.5.1 HANDOFF — Execution Ready

**Date locked:** 2026-05-22
**Status:** APPROVED for execution
**Mode:** Maximum-parallel subagent swarm (peak ~20 agents simultaneous)

---

## Operator decisions (locked, no re-litigation)

| Decision | Choice | Rationale |
|---|---|---|
| Cross-platform parity scope | **Path B — Build the parity for v1.5.1** | Honest shrink isn't acceptable; close the credibility gap properly |
| Orphan code policy | **Wire each one — make CHANGELOG honest** | No half-shipping; every claim becomes true |
| Source-of-truth duplication | **Fix in v1.5.1** | Prevent the pattern from re-shipping in v1.5.x |
| Multi-domain triple-roster bug | **Elevated to W1.5 priority wave** | Operator caught it; Trident r2 (codex) confirmed; blocks FB post |
| Execution style | **Maximum-parallel swarm** | Same dispatch discipline that worked for v1.5.0 W12 + memory-moat |
| CHANGELOG retroactive edits to v1.5.0 entry | **HOLD** | No re-publish drift; v1.5.1 entry documents fixes |
| FB launch post | **HOLD until W1.5 lands** (3-4 days) | Multi-domain must be true E2E before claim ships publicly |

---

## What's in this milestone (single source of truth)

- `.planning/1.5.1/audit/CLI-SURFACE-FINDINGS.md` (5 HIGH)
- `.planning/1.5.1/audit/SKILLS-AGENTS-MCP-FINDINGS.md` (8 HIGH, 5 MED)
- `.planning/1.5.1/audit/PLATFORM-PARITY-FINDINGS.md` (5 HIGH)
- `.planning/1.5.1/audit/ORPHAN-CODE-FINDINGS.md` (8 HIGH + half-feature + footgun)
- `.planning/1.5.1/audit/DOCS-DRIFT-FINDINGS.md` (6 HIGH)
- `.planning/1.5.1/audit/SYNTHESIS.md` (~30 HIGH rolled up + universal multi-domain matrix)
- `.planning/1.5.1/audit/TRIDENT-r1-SYNTHESIS.txt` (codex confirmed no new bugs)
- `.planning/1.5.1/audit/TRIDENT-r2-TEAM-SUBSYSTEM.txt` (codex confirmed every HIGH on multi-domain)
- `.planning/1.5.1/audit/TRIDENT-r3-TEAM-GEMINI-RETRY.txt` (gemini retry pending)
- `.planning/1.5.1/PLAN-v1.5.1.md` (7 waves + ship, max-parallel execution structure)
- `.planning/1.5.1/HANDOFF-v1.5.1.md` (this doc)

---

## Wave dispatch table (read by execution orchestrator)

| Wave | Mode | Agent count | Duration | Blockers |
|---|---|---|---|---|
| W0 | sequential | 1 | 1 day | none — start now |
| W1 | PARALLEL | 6 | 3 days | W0 complete |
| W1.5 decider | sequential | 1 | <1 day | W0 complete |
| W1.5 wirers | PARALLEL | 5 | 2 days | W1.5 decider |
| W1.5 verifiers | sequential | 2 | 1 day | W1.5 wirers |
| W3 | PARALLEL | 6 | 1 week | W0 complete |
| W2 | PARALLEL | 10 | 1 week | W3 partial (registries available) |
| W4.A | sequential | 1 architect | 3 days | W1+W3 complete |
| W4.B-I | PARALLEL | 8 | 2 weeks | W4.A complete |
| W5 | PARALLEL | 6 | 3-4 days | W1+W1.5+W2+W3+W4 complete |
| W6 | sequential | 1-2 | 3-5 days | W5 complete |

**Peak concurrency:** 20+ subagents during the W1 + W1.5 + W3 swing (days 2-6 of execution).

---

## Resume protocol (if context compacts during execution)

1. Read this file
2. Read `.planning/1.5.1/state/wave.json` for current wave + subagent status
3. Read `.planning/1.5.1/PLAN-v1.5.1.md` for full task table
4. Pick up at the next non-completed wave per state file

---

## What ships in v1.5.1

- All 5 lying-surface bugs fixed (CLI honest, no pointer stubs, dead handlers removed, count drift killed)
- Multi-domain triple-roster bug resolved for all 5 non-software archetypes (book/content/research/design/business E2E working)
- All 8 orphan v1.5.0 libraries wired into runtime call sites (CHANGELOG becomes honest)
- Source-of-truth duplication eliminated (single command registry, single migration discovery, single platform-capabilities)
- Cross-platform parity built: Codex agents populated, Gemini/Cursor/Windsurf/Copilot/Hermes/Wayland get skill execution layers
- GUIDE.md fully rewritten for v1.5.x (currently v1.1-era)
- README rewritten with honest tier system + corrected counts + actually-shipping features
- Missing docs added (`PLATFORM-ENFORCEMENT.md` T16, `MEMORY-BENCHMARK.md` T22)
- npm test runs full surface locally (kills the 1-file-smoke-vs-209-CI footgun)
- 3 new parity tests (command-registry, MCP-tool-registry, platform-capabilities)
- Trident r23 cross-audit clean (or known-issues acknowledged)

---

## Definition of done for v1.5.1

- Every `ijfw <command>` in `--help` works end-to-end
- `ijfw team init --archetype <any-of-5-non-software>` generates agents the swarm dispatcher can find by name
- Every v1.5.0 CHANGELOG library claim has a verifiable runtime call site OR has been retracted
- README platform claim matches what `ijfw install` actually deploys
- One number for platform count everywhere (14)
- One number for MCP tool count everywhere (13)
- One source for command list (registry-driven)
- All 209 tests pass on `npm test` locally + CI
- Trident r23 3-lens cross-audit returns 0 HIGH (or HIGHs are explicitly accepted with rationale)
- Local 2FA publish to npm: `@ijfw/install@1.5.1` + `@ijfw/memory-server@1.5.1`

---

## What does NOT ship in v1.5.1 (scope locks)

- OIDC trusted-publisher CI publish (local 2FA stays)
- New MCP tools beyond cap 13
- New platforms beyond the 14 already deployed
- New marketing surfaces (FB post is held but not redesigned; X/LinkedIn deferred)
- Major architectural shifts (state-SDK shape is locked from v1.5.0)
