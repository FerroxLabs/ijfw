# v1.5.0 Gap-Closure — Cross-Audit Adjudication

**Date:** 2026-05-20
**Targets:** `.ijfw/memory/brief.md` + `ROADMAP-v150-GAP-CLOSURE.md` (as of
commit `67320a8`).
**Method:** 3-lens parallel cross-audit (adversarial) —
(1) completeness/coverage, (2) architecture/stability/performance,
(3) sequencing/execution-risk/strategy.
**Outcome:** 1 true blocker + 8 HIGH + ~11 MED/LOW. **All folded in**
(operator decision). Brief + roadmap revised. One tag, v1.5.0 — the
milestone-split recommendation was rejected by the operator; never-ships
risk mitigated instead.

---

## HIGH findings

| # | Finding | Disposition |
|---|---------|-------------|
| H1 | **MCP cap conflict** — `ijfw_state` has no slot; cap is 12/12, hard-tested. Found by 2 lenses independently. | FIXED — `ijfw_state` absorbs `ijfw_subagent_post_done` (→ `state.subagent-post-done` verb); `ijfw_dispatch` is a verb not a tool. Cap stays 12/12. |
| H2 | **G2 too large** — one sequential wave blocking the whole milestone (SPOF). | FIXED — P0 split into P0a (verb core + frozen API contract) + P0b (migrations + faces, parallel with P1). |
| H3 | **Locking model under-specified** — two incompatible lock models coexist; multi-lock verbs with no acquire-order = deadlock. | FIXED — brief G2 specifies one lock hierarchy + canonical acquire-order, tmp+rename, no lock across subprocess spawn, heartbeat-refreshed locks. |
| H4 | **Enforcement availability trap** — a gate exception or MCP-down freezes all state. | FIXED — brief G3 distinguishes verdict-fail (refuse) from execution-fail (degrade to advisory); MCP-unavailable bypass. |
| H5 | **Partial-migration silently lossy** — grep-gate misses `.sh` + homedir writers. | FIXED — proof G2 grep-gate covers JS + `.sh` + homedir; per-writer regression test. |
| H6 | **Agent cross-platform deploy unscheduled** — repeats the "one-platform half-ship" anti-pattern. | FIXED — roadmap P2 adds an agent-deploy wave; brief G7 states the team-engine lives MCP-side (universal), agent defs deploy per-platform. |
| H7 | **P2 not truly independent** — W4/G7 consume specific SDK verbs, not just "P0 landed." | FIXED — roadmap enumerates the verbs the P0a frozen contract must include; P2 depends on the contract. |
| H8 | **`ijfw_dispatch` surface unscoped** + over-promised cross-platform. | FIXED — it is a verb; deterministic on Claude, best-effort prompt-template elsewhere, recorded in the enforcement matrix. |

---

## ESCALATED — operator decision

| # | Finding | Disposition |
|---|---------|-------------|
| E1 | **Milestone-balloon / never-ships risk** — 11 items under a 12-row "every proof green or nothing ships" gate. Lens 3 recommended staging into v1.5.0 + a planned v1.5.1. | **OPERATOR: one tag, v1.5.0 — split rejected.** Risk mitigated instead: (a) P0a/P0b decomposition removes the bottleneck; (b) every empirical proof carries a defined pass threshold (no open-ended "improve"). |

---

## MEDIUM / LOW findings

| # | Finding | Disposition |
|---|---------|-------------|
| M1 | G1 "replay to last verb" unsafe — append verbs not idempotent. | FIXED — brief G2 idempotency model: write-ahead intent + commit markers, dedup keys for append verbs. |
| M2 | Event log unbounded growth + hot-path I/O + `fs.watch` unreliable. | FIXED — brief G2 observability model: per-event cap, log rotation, explicit poll interval, emit fire-and-forget after lock release. |
| M3 | "5 moats, none can match" over-claimed. | FIXED — brief restates honestly: 3 structural moats + 2 first-mover leads. Still clears the ≥2 bar. |
| M4 | AGENTS.md commoditization threat unaddressed. | FIXED — brief adds a competitive-response note: the moat is the runtime, not file-distribution reach. |
| M5 | G3 enforcement ceiling asserted but never named. | FIXED — brief G3 names it: structural where state routes through SDK/MCP, best-effort where the platform LLM writes files directly. |
| M6 | G4 unit-test for the 3-tier matrix missing; G7 proof under-tests domains. | FIXED — proof table: G4 adds a 3-tier unit test; G7 requires ≥3 domains + per-template schema validation. |
| M7 | CHANGELOG/lock-in reconciliation under-scoped (only #46). | FIXED — roadmap P3.3 broadened to all lock-in entries + CLAUDE.md cap/convention text + CHANGELOG. |
| M8 | W3 proof circular ("every defined boundary"). | FIXED — proof W3: boundary set enumerated in the matrix doc, test covers each. |
| M9 | G3 proof tests tiers not platforms; matrix accuracy unverified. | FIXED — proof G3: automated check that each matrix platform row maps to a real exercised path. |
| M10 | G4-after-G7 serializes longest pole behind second-longest. | FIXED — G7 split into G7-core + G7-gen; G4 depends on G7-core only. |
| L1 | Iron-Law "verbatim copy" — attribution risk. | FIXED — adopt the discipline in our own wording, not a verbatim copy. |
| L2 | G6 codex Stop UX deferred to execute-time. | FIXED — decided in the brief: status card stays opt-in; e2e gate updated to set `IJFW_CODEX_HOOK_NOTICES=1`. |
| L3 | Core-skill 55-line cap not re-verified. | FIXED — roadmap P3.3 adds a line-count assertion. |
| L4 | Day-1/missing-file verb semantics undefined. | FIXED — brief G2: defined per verb. |
| L5 | `merge-block-aware.sh` in the hot path. | FIXED — roadmap P0b ports it to in-process JS. |
| L6 | Stale-lock 30s window vs long verbs. | FIXED — brief G2: heartbeat-refreshed locks. |
| L7 | W2 on the P3 critical path. | FIXED — roadmap moves W2 to P2. |
| L8 | Ruflo absent from the 8-dimension scorecard. | FIXED — brief scorecard scoped explicitly to single-machine orchestration; Ruflo's distributed line is honestly v1.6.0. |

---

## Confirmed sound (no change needed)

- The G2-foundational → G3/W1/W3-layer → G1 dependency core is correct.
- The falsifiable-proof contract (proof ≠ tests-pass) is genuine discipline.
- G5 deferral is correctly scoped — net-new, no claim, no soft spot.
- The verb-facade concept (centralising scattered writers) is the right
  direction.

---

## Net effect

Brief + roadmap revised to absorb every finding. No finding left open. The
plan is materially more buildable: P0a's frozen contract is the single
unblock point, the architecture under-specs (locking, idempotency,
observability, enforcement failure modes) are now spelled out, and the proof
table is stronger and threshold-bounded.
