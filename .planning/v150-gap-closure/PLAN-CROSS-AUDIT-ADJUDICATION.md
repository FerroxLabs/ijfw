# v1.5.0 Build Plan — Cross-Audit Adjudication

**Date:** 2026-05-20
**Target:** `BUILD-PLAN-v150-GAP-CLOSURE.md` (first draft).
**Method:** 3-lens parallel adversarial cross-audit —
(1) task completeness & contract falsifiability,
(2) dependency & wave correctness (parallel-collision check),
(3) dispatch-brief executability by a fresh subagent.
**Outcome:** 0 blockers + 9 HIGH + 8 MED/LOW. **All fixed** — the plan was
rewritten in the same commit.

---

## HIGH findings

| # | Finding | Disposition |
|---|---------|-------------|
| H1 | **T1 contract under-specified** — `### verb:` format graded but never mandated; `grep -c ≥17` checks count not contents; the 4 cross-cutting models treated as one-line afterthoughts → T2-T20 churn. (3 lenses.) | FIXED — T1 rewritten: mandates the exact per-verb template (5 sub-fields), requires literal schemas (lock list, intent/commit JSON, event JSON, gate-failure rule), and ships a contract-validator test that checks sub-field presence, not just count. |
| H2 | **`bin/ijfw-state` vs `ijfw state` contradiction** — brief still said `bin/ijfw-state`; T1 generates the contract from the brief → would codify the wrong face. | FIXED — brief + roadmap reconciled to `ijfw state:<verb>` colon-namespace; T1 brief states it explicitly. |
| H3 | **T12 CLI mechanism mismatch** — `cli-run.js` is a shim over `dispatch/colon-syntax.js` (`namespace:command`), not a `state <verb>` parser. | FIXED — T12 names `dispatch/colon-syntax.js`; `state` is a colon-namespace (`ijfw state:<verb>`). |
| H4 | **T15 ∥ T17 file collision** — both Modify `state-sdk.js` in a parallel wave. | FIXED — Wave C is now fully sequential `T15→T16→T17→T18`. |
| H5 | **T6 / T19 file collision** — both Modify `dispatch-planner.js` across overlapping waves. | FIXED — T19 now `Depends on: T15, T6`. |
| H6 | **T11 wave-table contradiction** — listed before T12 though it depends on T12's CLI. | FIXED — Wave B ordered `T12 → T11`. |
| H7 | **CLI + agent-deploy e2e-smoke gates missing** — brief proofs require them; no task added them. | FIXED — T12 adds an `ijfw state:` e2e-smoke gate; T30 adds an agent-deploy e2e-smoke gate. |
| H8 | **T13 leaves stale `ijfw_subagent_post_done` callers** — `server.js` case + tests/docs not swept. | FIXED — T13 adds a grep-sweep across `claude/`, `docs/`, tests; verify asserts zero stale refs. |
| H9 | **T1 four cross-cutting models vague** — lock order / record schemas would be re-invented by T3/T4/T5. | FIXED — folded into H1's T1 rewrite: each model is now a literal, concrete artifact in the contract. |

---

## MEDIUM / LOW findings

| # | Finding | Disposition |
|---|---------|-------------|
| M1 | T23 temporal layer already exists (`temporal.js`, `staleness.js`, migration `004`). | FIXED — T23 rescoped to gap-fill (decay-on-retrieval) with a test that must fail against pre-task HEAD. |
| M2 | T28 "gate #5" is not a named thing in `e2e-smoke.sh`. | FIXED — T28 references the actual failing line ("Codex Stop did NOT emit status card"); verify targets it. |
| M3 | T24 "wire any that are not" gave no wiring contract. | FIXED — T24 specifies the contract: an explicit software-core agent set in `generator.js`; verify checks all 4 ids resolve to existing `.md` files. |
| M4 | TDD red→green meaningless for non-code tasks (T1, docs, agent `.md`, shell). | FIXED — execution-model rules now exempt non-code tasks; `verify:` is the direct contract. |
| M5 | T30 named `scripts/build.js` (does not exist). | FIXED — corrected to `installer/scripts/build.js` / installer manifest (locate via recon). |
| M6 | T20 62% baseline unsourced / not reproducible. | FIXED — T20 builds a fixed truncation-simulation corpus; the rate is measured over it. |
| L1 | Wave B could start after T4 not T5 (minor). | NOTED — kept Wave B on full Wave A: T9 routes `event.emit` (T5). Dependency is genuine. |
| L2 | Most file paths confirmed accurate (`atomic-io.js`, `jsonl-rotation.js`, `worktree-recovery.js`, `runPhaseEConverge` in `cross-orchestrator.js`). | No change. |

---

## Confirmed sound

- The Wave A→F dependency spine and the verb-contract-freeze-before-binding
  approach are correct.
- T1's frozen contract is genuinely sufficient to unblock B/C/E — once
  hardened per H1.
- Most file paths and the reuse of existing libs are accurate.

---

## Net effect

The build plan was rewritten in full. Every parallel-collision risk is
eliminated (collision rule + serialized Wave C + corrected dependencies),
T1 is now a hard, contents-checked contract that prevents swarm-wide churn,
and every task has an accurate, falsifiable `verify:` command. The plan is
dispatch-ready for `superpowers:subagent-driven-development`.
