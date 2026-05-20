# IJFW v1.5.0 — GAP-CLOSURE ROADMAP

**Locked:** 2026-05-20 · **Hardened:** 2026-05-20 (3-lens cross-audit) ·
**Brief:** `.ijfw/memory/brief.md` ·
**Adjudication:** `CROSS-AUDIT-ADJUDICATION.md`

This roadmap dependency-orders the 12 register items into phases. It is the
input to `writing-plans` / `/gsd-plan-phase`. Every item carries its
falsifiable proof with a defined pass threshold (see brief). v1.5.0 ships —
as ONE tag — only when every proof is green.

---

## Dependency logic

- **P0a (state-SDK verb core) is foundational** and ends with a **frozen
  verb API contract**. That contract — not "all of P0" — is what unblocks
  every downstream phase.
- **P0b (writer migrations + CLI + MCP face) runs parallel to P1** once the
  contract is frozen — it is not a blocker for P1/P2.
- **G3 / W1 / W3 are one coherent layer** — "gates as verb preconditions."
- **G1 depends on G3's dispatch wrapper** + the P0a event model.
- **P2 items each consume specific verbs** — those verbs MUST be in the P0a
  frozen contract (enumerated below). P2 is not "independent of P0," it is
  "independent of the P1 enforcement layer."
- **G4 depends on G7-core** (needs the `ijfw-code-fixer` agent only) — NOT
  the whole generative engine.
- **W2 runs in P2** (depends only on the shipped debug stack + Trident).
- **P3 is pure proof-walk + cross-audit + ship-gate** — no feature work.

### Verbs the P0a frozen contract MUST include

So downstream phases are genuinely unblocked, P0a's contract enumerates at
minimum: workflow/wave verbs; gate-precondition hooks (verification,
plan-check, checkpoint); `state.subagent-post-done`; `state.dispatch-subagent`;
event/telemetry-emit verbs (consumed by W4 + G1); roster/team-synthesis
verbs (consumed by G7). If a P2 item needs a verb not in the contract, it is
not yet unblocked — surface it before P0a freezes.

---

## PHASE 0 — Foundation

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| **P0a** | state-SDK verb core | `state-sdk.js` verb dispatcher; lock hierarchy + canonical acquire-order; tmp+rename writes; heartbeat-refreshed locks; idempotency model (write-ahead intent + commit markers, dedup keys for append verbs); day-1/missing-file semantics per verb; observability model (capped events, rotated log, fire-and-forget after lock release, explicit poll interval). **Ends with a FROZEN verb API contract.** | sequential — blocks all |
| **P0b** | migrations + faces | Migrate all state writers — JS (`dispatch-planner`, `wave-state`, `agents-md-blackboard`, `subagent-telemetry`, `active-extension-writer`) **and the shell hooks** (`compute-nudge.sh`, `pre-tool-use-extension-check.sh`) — to route through verbs; port `merge-block-aware.sh` to in-process JS; `bin/ijfw-state` CLI; `ijfw_state` MCP tool **absorbing `ijfw_subagent_post_done`** (cap stays 12/12). | parallel with P1 |

**P0a exit:** frozen verb contract published.
**P0b exit:** grep-gate (JS + `.sh` + homedir) green; per-writer regression
tests green; concurrent + deadlock test green; CLI + MCP in e2e-smoke.

---

## PHASE 1 — The spine (depends on P0a frozen contract)

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| P1.1 | **G3 enforcement** | Gates as preconditions of state-advancing verbs; **verdict-fail refuses / execution-fail degrades to advisory** (a gate bug never freezes the workflow); MCP-unavailable bypass; per-platform enforcement matrix doc that **names the ceiling** (structural vs best-effort per platform). | parallel ┐ |
| P1.1 | **W1 plan-check gate** | `validatePlan` becomes a precondition verb; plan-check hard-BLOCKS execute on HIGH findings, pre-dispatch. | parallel ├ |
| P1.1 | **W3 verification scope** | Verification gate fires at every **enumerated** boundary (mid-wave, non-subagent, post-done) — boundary set listed in the enforcement-matrix doc; adopt Superpowers Iron-Law discipline in our own wording (no verbatim copy). | parallel ┘ |
| P1.2 | **G1 telemetry** | SDK event stream → per-subagent log; parent polls live; truncation recovery = replay to last committed verb (partials roll back); `state.dispatch-subagent` verb — deterministic on Claude, best-effort prompt-template elsewhere (recorded in the matrix). | after P1.1 |

**Exit:** G3/W1/W3/G1 proofs green (brief proof table).

---

## PHASE 2 — Moats & depth (depends on P0a contract; overlaps P1 + P0b)

| Wave | Item | Scope | Mode |
|------|------|-------|------|
| P2 | **W4 Trident telemetry** | Instrument `runPhaseEConverge` via P0a event verbs; publish a convergence-telemetry artifact — cycles-to-converge, false-positive rate, cost. | parallel |
| P2 | **W5 memory** | Memory benchmark harness + published numbers (vs mem0/Zep/Graphiti 2026); temporal/staleness layer — stale facts detected/decayed. | parallel (most independent) |
| P2 | **G7-core** | Build software core agents `doc-verifier`, `integration-checker`, `nyquist-auditor`, `ijfw-code-fixer`; each with a test. | parallel |
| P2 | **G7-gen** | Domain-aware upgrade to the on-demand team-builder (MCP-server-side, writes roster state via P0a verbs); domain-template specs for ≥3 domains, each schema-validated. | parallel (gates nothing) |
| P2 | **G4 cross-AI code-fixer** | review → fix (3-tier verify: re-read / syntax-check / fallback) → **Trident-verify** → atomic per-finding commit; logic-bug human-flag; recovery-sentinel cleanup. | after **G7-core** only |
| P2 | **Agent cross-platform deploy** | Deploy the new agent definitions into the platform-native packages that support agent/subagent constructs; installer manifest updates; per-platform packaging tests. | after G7-core |
| P2 | **G6 codex Stop** | Update e2e-smoke gate #5 to set `IJFW_CODEX_HOOK_NOTICES=1` and test the opt-in path (status card stays opt-in by design). | parallel (anytime) |
| P2 | **W2 Trident-powered debug** | Elevate the debug loop: stalled hypothesis → codex + gemini generate competing hypotheses cross-lens; run a real multi-cycle debug campaign; commit the receipt. | parallel (debug stack already shipped) |

**Exit:** W4/W5/G7/G4/G6/W2 + deploy proofs green.

---

## PHASE 3 — Proof & ship (depends on P1 + P2; no feature work)

| Wave | Item | Scope |
|------|------|-------|
| P3.1 | **Falsifiable-proof verification** | Walk the brief proof table; every row green at its defined threshold. Any red = not done. |
| P3.2 | **Trident milestone cross-audit** | Full-milestone cross-audit (`--chunk` for the large diff); close all HIGH/MED/LOW. |
| P3.3 | **Ship-gate close-out** | e2e-smoke green; `ijfw-core/SKILL.md` ≤ 55 lines (assertion); audit **all** lock-in entries + CLAUDE.md convention/cap text + CHANGELOG `[1.5.0]` for stale "v1.5.1"/"next milestone" forward-refs and reconcile to v1.5.0; retag v1.5.0 at final HEAD. |
| P3.4 | **Phase F (OPERATOR-GATED)** | `git push gitlab main` + tag; CI OIDC npm publish. Requires explicit operator "yes, push". |

---

## Net-new scope explicitly OUT of v1.5.0

- **G5 multi-machine** — net-new feature, v1.6.0. Foundation laid (G2
  lock-aware). Not a soft spot: nothing claimed, nothing half-shipped.
- **Compliance-grade audit logging** (Ruflo parity) — v1.6.0 candidate.
- **Distributed agent federation** (Ruflo parity) — v1.6.0, paired with G5.

---

## Wave parallelism summary

```
P0a (frozen contract) ──┬──► P1.1 ──► P1.2 ───────────────┐
                        ├──► P0b (migrations+CLI+MCP) ─────┤
                        └──► P2 (W4·W5·G7-core·G7-gen·G6·W2)│
                                 └─► G4 + deploy (after G7-core) ──► P3
```

P0a's frozen contract is the single unblock point — P0b, P1, and P2 all run
off it. P3 waits for P1 + P2. Never-ships risk is mitigated by (a) this
decomposition removing the P0 bottleneck and (b) every empirical proof
carrying a defined pass threshold (brief proof table).
