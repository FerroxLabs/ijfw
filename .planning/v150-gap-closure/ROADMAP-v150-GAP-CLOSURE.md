# IJFW v1.5.0 — GAP-CLOSURE ROADMAP

**Locked:** 2026-05-20 · **Brief:** `.ijfw/memory/brief.md` ·
**Handoff (input):** `HANDOFF-v150-GAP-CLOSURE.md`

This roadmap dependency-orders the 12 register items into 4 phases. It is
the input to `writing-plans` / `/gsd-plan-phase`. Every item carries its
falsifiable proof (see brief). v1.5.0 ships only when every proof is green.

---

## Dependency logic

- **G2 (state-SDK) is foundational** — G3, G1, W1, W3 all depend on it
  (gates and telemetry are verbs / events on the SDK).
- **G3 / W1 / W3 are one coherent layer** — "gates as verb preconditions."
- **G1 depends on G3's dispatch wrapper** + G2's event stream.
- **W4 / W5 / G7 / G6 are independent of the enforcement layer** — they
  start the moment G2 lands and run parallel to P1.
- **G4 depends on G7** (needs the `ijfw-code-fixer` agent) + Trident.
- **W2 depends on the shipped debug stack** + Trident — runs in P3.

---

## PHASE 0 — Foundation (blocks the spine)

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| P0 | **G2 state-SDK** | `state-sdk.js` verb core; migrate all ~6 state writers (`dispatch-planner`, `agents-md-blackboard`, `subagent-telemetry`, `verification-gate`, etc.) to route through verbs; idempotent + event-emitting + lock-aware verbs; `bin/ijfw-state` CLI; `ijfw_state` MCP tool (combine-before-add — single tool, `verb` param). | sequential |

**Exit:** grep-gate test green (no write bypasses the SDK); concurrent-write
test green; CLI + MCP exercised in e2e-smoke.

---

## PHASE 1 — The spine (depends on P0)

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| P1.1 | **G3 enforcement** | Gate functions become preconditions of state-advancing verbs; `state.complete-phase` refuses on red gate; per-platform enforcement matrix doc; native hooks (Claude PreToolUse/Stop, Codex Stop) as tier-2. | parallel ┐ |
| P1.1 | **W1 plan-check gate** | `validatePlan` becomes a precondition verb; plan-check hard-BLOCKS execute on HIGH findings, pre-dispatch. | parallel ├ P1.1 |
| P1.1 | **W3 verification scope** | Verification gate fires at every boundary (mid-wave, non-subagent), not just post-done; adopt Superpowers Iron-Law framing + adversarial spec-reviewer wording verbatim. | parallel ┘ |
| P1.2 | **G1 telemetry** | SDK event stream → per-subagent log; parent tails live; truncation recovery = replay to last verb; deterministic `ijfw_dispatch` helper; truncation-rate metric vs 62% baseline. | after P1.1 |

**Exit:** G3/W1/W3/G1 proofs green (see brief table).

---

## PHASE 2 — Moats & depth (starts when P0 lands; overlaps P1)

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| P2 | **W4 Trident telemetry** | Instrument `runPhaseEConverge`; emit a published convergence-telemetry artifact — cycles-to-converge, false-positive rate, cost-per-converge. | parallel |
| P2 | **W5 memory** | Memory benchmark harness + published numbers (vs mem0/Zep/Graphiti 2026); temporal/staleness layer — stale facts detected/decayed. | parallel (fully independent) |
| P2 | **G7 team engine + core agents** | Domain-aware upgrade to the on-demand team-builder; build software core agents `doc-verifier`, `integration-checker`, `nyquist-auditor`; domain-template specs for book/campaign/etc. | parallel |
| P2 | **G4 cross-AI code-fixer** | `ijfw-code-fixer` agent (3-tier verify: re-read / syntax-check / fallback); review → fix → **Trident-verify** → atomic per-finding commit; logic-bug human-flag; recovery-sentinel for crash-safe cleanup. | after G7 |
| P2 | **G6 codex Stop** | Decide codex Stop UX; make e2e-smoke gate #5 match (enable the opt-in it tests, or un-gate the update-nudge). | parallel (anytime) |

**Exit:** W4/W5/G7/G4/G6 proofs green.

---

## PHASE 3 — Proof & ship (depends on P1 + P2)

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| P3.1 | **W2 Trident-powered debug** | Elevate the debug loop: stalled hypothesis → codex + gemini generate competing hypotheses cross-lens; run a real multi-cycle debug campaign through it; commit the receipt. | sequential |
| P3.2 | **Falsifiable-proof verification** | Walk the brief proof table; every row must be green. Any red = not done. | sequential |
| P3.3 | **Trident milestone cross-audit** | Full-milestone cross-audit (`--chunk` for the large diff); close all HIGH/MED/LOW. | sequential |
| P3.4 | **Ship-gate close-out** | e2e-smoke green; reconcile stale CHANGELOG `[1.5.0]` + lock-in #46 "v1.5.1"/"next milestone" refs to v1.5.0; retag v1.5.0 at final HEAD. | sequential |
| P3.5 | **Phase F (OPERATOR-GATED)** | `git push gitlab main` + tag; CI OIDC npm publish. Requires explicit operator "yes, push". | sequential — gated |

---

## Net-new scope explicitly OUT of v1.5.0

- **G5 multi-machine** — net-new feature, v1.6.0. Foundation laid (G2
  lock-aware). Not a soft spot: nothing claimed, nothing half-shipped.
- **Compliance-grade audit logging** (Ruflo parity) — v1.6.0 candidate.
- **Distributed agent federation** (Ruflo parity) — v1.6.0, paired with G5.

---

## Wave parallelism summary

```
P0 ──────────────► P1.1 ──► P1.2 ──┐
   └──────────────► P2 (W4·W5·G7·G6) ──► P2 (G4) ──┴──► P3
```

P2 does not wait for the spine — the parallelism win. P3 waits for both.
