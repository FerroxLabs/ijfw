# IJFW v1.5.0 — GAP-CLOSURE BRIEF (LOCKED)

**Version:** 1.5.0 (still v1.5.0 — not v1.5.1, not v1.6.0)
**Theme:** Gap-closure — every audited soft spot becomes real, every dimension
goes ahead-or-moat, before the tag ships.
**Locked:** 2026-05-20, via the gap-closure deep-dive brainstorm.
**Supersedes:** the v1.4.0 brief; the `GAP-MATRIX.md` v1.5.1/v1.6.0 split.

---

## Mandate (operator, verbatim intent)

"Close all the gaps, be better than the competition, be more solid where
we're weak and stronger than the rest. We don't just close the gaps; we make
everyone else have the gaps. We are addressing and fixing all of this in
1.5.0. That's why we are not pushing anything yet."

---

## Goal

Take IJFW from **parity-plus (~3.9/5)** to **ahead-or-moat on all 8
cross-system dimensions**, with **five flagship capabilities no competitor
can match**, so the claim "IJFW replaces GSD + Superpowers" is earned — then
ship v1.5.0 as one tag. v1.5.0 does not ship until every falsifiable proof
below is green.

---

## The architecture spine — the state-SDK

Three "gaps" collapse into one structure. **The state-SDK is the spine of
v1.5.0**; G3 and G1 are layers on it.

- **G2 — state-SDK.** One `state-sdk.js` `query(verb, …)` core. A **verb
  facade over the existing physical files** (`workflow.json`, `*.jsonl`,
  `wave-*/`, `active-extension.json` stay) — but every state write routes
  through a verb. Every verb is **idempotent**, **observable** (emits an
  event), and **lock-aware**. Exposed **three ways** off one core: JS
  module (in-process writers), `bin/ijfw-state` CLI (scripting/external),
  `ijfw_state` MCP tool (all 13 platforms). Beats GSD's CLI-only,
  Claude-bound, single-machine SDK on tri-modal access + observability +
  multi-machine-readiness.

- **G3 — enforcement-by-construction.** Gate functions (verification,
  plan-check, checkpoint) become **preconditions of state-advancing
  verbs**. `state.complete-phase` runs the verification gate and *refuses*
  on a red gate. Universal hard floor across all 13 platforms via the MCP
  face — not trust-the-LLM. Platform-native hooks (Claude PreToolUse/Stop,
  Codex Stop) layer on as a stronger second tier. Ship a **published
  per-platform enforcement matrix** as a trust artifact. The honest
  enforcement ceiling is named — and hit, not sat below.

- **G1 — checkpoint = SDK event stream.** Subagents do not "call
  checkpoint." Every state-SDK verb emits an event to a per-subagent log;
  the parent tails it live (= live subagent telemetry). Truncation
  recovery = replay to the last completed verb. A deterministic
  `ijfw_dispatch` helper bakes env-var passthrough + the SDK contract into
  the subagent prompt, so injection is not LLM-prose. Truncation rate is
  measured for free — shown falling vs the 62% baseline.

---

## G7 — the generative roster (not a static agent count)

Counting agents is the wrong game. GSD ships 33 static, software-only
agents. IJFW's roster is **generative**:

- **Stable software-first core (built + shipped):** `doc-verifier`,
  `integration-checker`, `nyquist-auditor`, `ijfw-code-fixer` — universal,
  domain-agnostic leverage agents.
- **Generative domain layer (engine, not files):** the on-demand
  team-builder is upgraded to be genuinely **domain-aware** — it reads the
  project brief/domain and synthesizes the right specialists from
  lightweight domain-template specs (software → software roster; book →
  narrative-continuity-checker, line-editor, lore-keeper; campaign →
  campaign-strategist, copy-reviewer).

GSD's 33 fixed agents become a *liability* — static, mono-domain. IJFW's
adaptive engine cannot be matched without GSD abandoning its identity. No
33-clone; the shipped surface stays small (§ anti-patterns).

---

## The five flagship moats (§1 bar #3 — needs ≥2; we ship 5)

1. **Trident + published convergence telemetry (W4)** — Claude Consensus
   already clones the *mechanism*; it cannot clone published proof-of-
   quality (cycles-to-converge, false-positive rate, cost-per-converge).
2. **Cross-AI consensus code-fixer (G4)** — the fix runs through Trident
   before commit; no single-model fixer (GSD's) can replicate it.
3. **Live subagent truncation telemetry (G1)** — parent-observable,
   auto-recovering, published falling rate; nobody else measures this.
4. **Domain-aware adaptive team synthesis (G7)** — generative roster
   across 6 domains vs GSD's static 33.
5. **Trident-powered debug (W2, elevated)** — when a hypothesis stalls,
   codex + gemini generate *competing* hypotheses cross-lens; GSD's
   single-model debugger structurally cannot follow.

Plus **enforcement-by-construction (G3)** as the structural floor under
all of it.

---

## Scope — the 12 register items, locked dispositions

| Item | Disposition |
|---|---|
| G1 checkpoint auto-injection | CLOSED — SDK event stream + `ijfw_dispatch` wrapper. Moat. |
| G2 state-SDK | CLOSED — verb-facade, tri-modal, observable, lock-aware. |
| G3 enforcement ceiling | CLOSED — enforcement-by-construction + tiered hooks + matrix. |
| G4 code-fixer loop | CLOSED — cross-AI consensus fixer (3-tier verify + atomic commits). Moat. |
| G5 multi-machine | **DEFERRED** — net-new scope, v1.6.0. Foundation laid (G2 lock-aware). Not a soft spot: nothing claimed, nothing half-shipped. |
| G6 codex Stop card | CLOSED — decide codex Stop UX, e2e gate #5 goes green. |
| G7 specialist depth | CLOSED — generative domain-aware team engine + software core. Moat. |
| W1 plan-checker gate | CLOSED — plan-check hard-BLOCKS execute on HIGH (a verb precondition). |
| W2 debug field-validation | CLOSED + ELEVATED — Trident-powered debug + field-validation receipt. Moat. |
| W3 verification gate scope | CLOSED — fires at every boundary; Superpowers Iron-Law framing adopted. |
| W4 Trident telemetry | CLOSED — published convergence telemetry. Moat. |
| W5 memory | CLOSED (escalated) — published benchmarks + temporal/staleness layer. |

**Fresh-audit context (2026-05-20):** Superpowers 5.1.0 still current (no
new release); GSD 1.42.3 patch-only (no new agents). Cross-AI: IJFW is
**ahead** of GSD, not behind — GSD's `gsd-review` is plan-only; Trident
audits diffs. New tier-1 entrant **Ruflo** (53k stars, distributed
multi-machine federation) validates the G5-defer call. **mem0** now
publishes memory benchmarks + does temporal handling — this escalated W5
from "weakness" to a real gap.

---

## The ship bar — 8-dimension scorecard, with ship verdicts

| # | Dimension | v1.5.0 ship verdict |
|---|-----------|---------------------|
| 1 | Subagent dispatch | AHEAD — worktree isolation + deterministic wrapper + waves |
| 2 | Subagent recovery | MOAT — live observed + measured truncation |
| 3 | Code review | MOAT — G4 cross-AI consensus fixer; no single-model fixer can replicate |
| 4 | Plan → Execute | AHEAD — W1 hard-BLOCK vs GSD sanity-check |
| 5 | Verification | AHEAD — structural verb-precondition, beyond prose Iron Law |
| 6 | Debug loop | MOAT — Trident-powered competing-hypothesis generation |
| 7 | Specialist roster | MOAT — generative domain-aware engine; GSD's static 33 can't follow |
| 8 | Cross-AI audit | MOAT — published convergence telemetry |

v1.5.0 ships only when **all three hold**: (1) every falsifiable proof
below is green — no documented soft spot survives; (2) no competitor
cleaner on any of the 8 dimensions; (3) ≥2 net-new moats — we ship 5.

---

## Falsifiable proof contract (the antidote to "tests pass ≠ feature fires")

Every item ships with a falsifiable proof. v1.5.0 does NOT ship until every
row is green. This table is a HARD ship gate.

| Item | Proof it is actually closed |
|---|---|
| G2 | Grep-gate test: zero state writes bypass the SDK. Concurrent-write test passes. `bin/ijfw-state` + `ijfw_state` MCP both exercised in e2e-smoke. |
| G3 | Test proves `state.complete-phase` REFUSES on a red verification gate, via the MCP path. Enforcement-matrix doc exists; e2e checks each tier. |
| G1 | A real dispatched subagent run produces a per-subagent event log the parent reads live. A simulated truncation is RECOVERED from the last verb in a test. Truncation-rate metric emitted, shown falling vs the 62% baseline. |
| G4 | Seeded bug → review → auto-fix → Trident-verified → atomic commit, end-to-end in a test. |
| G5 | G2 lock-awareness has a passing lock test. Multi-machine itself explicitly out — no claim, no soft spot. |
| G6 | e2e-smoke gate #5 goes green. |
| G7 | A software project and a book project run through the team engine and get provably DIFFERENT, domain-appropriate rosters (asserted). Each software core agent has a test. |
| W1 | plan-check BLOCKS execute on a seeded HIGH finding — test proves dispatch does not proceed. |
| W2 | A real multi-cycle debug campaign receipt committed; the loop demonstrably used multi-lens competing hypotheses. |
| W3 | Tests prove the verification gate fires at every defined boundary (mid-wave, non-subagent), not just post-done. |
| W4 | Published convergence telemetry artifact — cycles-to-converge, false-positive rate, cost — emitted by a real Trident run. |
| W5 | Published memory benchmark numbers + a temporal/staleness test proving stale facts are detected/decayed. |

---

## Anti-patterns / non-negotiables

- No 33-agent clone. Shipped agent surface stays ~20-25; the *engine*
  generates domain specialists, it does not bloat the file count.
- Combine before add (CLAUDE.md MCP-tool rule). MCP cap respected.
- No regression to single-tree dispatch — worktree isolation stays.
- No full-process GATE bolted onto Quick mode — keep the Quick/Deep picker.
- No graphviz in SKILL.md (unparseable for 7 non-Claude platforms).
- Node floor stays 18; no Anthropic-specific SDK deps.
- Core skill `ijfw-core/SKILL.md` hard cap: 55 lines.
- Startup report: positive framing only.
- **No half-shipping.** Every feature has a runtime caller AND a green
  falsifiable proof. v1.5.0 ships with zero documented soft spots.

---

## Done when

Roadmap (`.planning/v150-gap-closure/ROADMAP-v150-GAP-CLOSURE.md`) executed
→ every falsifiable-proof row green → Trident milestone cross-audit clean
→ e2e-smoke green → CHANGELOG/lock-in stale refs reconciled to v1.5.0 →
operator authorizes Phase F → push + npm publish.
