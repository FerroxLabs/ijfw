# IJFW v1.5.0 — GAP-CLOSURE BRIEF (LOCKED)

**Version:** 1.5.0 (still v1.5.0 — not v1.5.1, not v1.6.0; ONE tag)
**Theme:** Gap-closure — every audited soft spot becomes real, every dimension
goes ahead-or-moat, before the tag ships.
**Locked:** 2026-05-20, via the gap-closure deep-dive brainstorm.
**Hardened:** 2026-05-20, via a 3-lens cross-audit (see
`.planning/v150-gap-closure/CROSS-AUDIT-ADJUDICATION.md`).
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
cross-system dimensions**, with **five flagship capabilities** (3 structural
moats + 2 first-mover leads), so the claim "IJFW replaces GSD + Superpowers"
is earned — then ship v1.5.0 as one tag. v1.5.0 does not ship until every
falsifiable proof below is green.

---

## The architecture spine — the state-SDK

Three "gaps" collapse into one structure. **The state-SDK is the spine of
v1.5.0**; G3 and G1 are layers on it.

### G2 — state-SDK

One `state-sdk.js` `query(verb, …)` core — a **verb facade over the
existing physical files** (`workflow.json`, `*.jsonl`, `wave-*/`,
`active-extension.json` stay; the SDK is the single *mutation surface*, not
a single file). Exposed **three ways** off one core: JS module (in-process
writers), the `ijfw state:<verb>` CLI colon-namespace (scripting/external),
`ijfw_state` MCP tool (all 13 platforms). There is no `bin/` — the CLI face
is a colon-namespace on the existing `ijfw` CLI.

**MCP cap (resolved — stays 12/12):** `ijfw_state` is created by
*absorbing* `ijfw_subagent_post_done` — post-done IS a state transition, so
it becomes a `state.subagent-post-done` verb. `ijfw_dispatch` is likewise a
**verb** (`state.dispatch-subagent`), not a tool. Net tool count unchanged.
This honors "combine before add."

**Concurrency model (must be specified in P0a):**
- One **lock hierarchy** with a single canonical acquire-order; a verb that
  touches multiple files acquires locks in that order — no deadlock.
- Every verb write is **tmp-write + atomic rename**.
- **No lock held across a subprocess spawn** — port `merge-block-aware.sh`
  to in-process JS, or pre-render the payload and spawn outside the lock.
- Long-running verbs use a **heartbeat-refreshed lock** (not a fixed 30s
  stale window that a concurrent caller would wrongly reclaim).

**Idempotency model (must be specified in P0a):**
- Each verb writes a **write-ahead intent record** (verb-id + `begin`)
  and a **commit marker** (`commit`). Replay (G1) skips committed verbs and
  rolls back partials.
- Append-style operations (summaries, violations) carry a **dedup key** —
  append is not idempotent by itself.
- **Day-1 / missing-file semantics** are defined per verb (create-or-refuse,
  explicitly).

**Observability model (must be specified in P0a):**
- Every verb emits an event to a per-subagent log — but the emit is
  **fire-and-forget, after lock release**, off the verb's critical section,
  so observability never slows a state write.
- Per-event **size cap**; the log has a **byte/line ceiling with rotation**.
- The parent consumes the log by **explicit-interval polling** (NOT
  `fs.watch` — unreliable across 13 platforms).

### G3 — enforcement-by-construction

Gate functions (verification, plan-check, checkpoint) become **preconditions
of state-advancing verbs**. `state.complete-phase` runs the verification
gate and *refuses* on a red gate. Universal hard floor across all 13
platforms via the MCP face; platform-native hooks (Claude PreToolUse/Stop,
Codex Stop) layer on as a stronger second tier.

**Verdict-fail vs execution-fail (critical — avoids an availability trap):**
- A gate **verdict-fail** (gate ran, returned red) → the verb REFUSES.
  Correct.
- A gate **execution-fail** (the gate function itself threw, or the plan
  is malformed, or a bug) → the verb MUST NOT block. Degrade to advisory +
  a loud log. A gate bug must never freeze the workflow.
- **MCP-unavailable:** a documented bypass keeps state writable. Enforcement
  is a floor, never a single point of failure.

**The enforcement ceiling — named honestly:** enforcement is *structural*
where state routes through the SDK/MCP face (the verb literally cannot
advance with a red gate); it is *best-effort* where a platform's LLM can
write files directly outside the SDK. The **per-platform enforcement
matrix** states, per platform, which of the two applies. That residual —
direct-file-write platforms — IS the ceiling, and it is disclosed, not
hidden.

### G1 — checkpoint = SDK event stream

Subagents do not "call checkpoint." Every state-SDK verb emits an event
(see G2 observability model); the parent polls the per-subagent log live.
Truncation recovery = **replay to the last committed verb** (intent/commit
markers make replay safe; partials roll back). A deterministic
`ijfw_dispatch` helper (a verb) bakes env-var passthrough + the SDK
contract into the subagent prompt.

**`ijfw_dispatch` honest scope:** deterministic on Claude (a real subagent
dispatch primitive exists); **best-effort prompt-template** on platforms
with no subagent primitive (Codex/Gemini/Cursor/…). This split is recorded
in the per-platform enforcement matrix — not papered over as uniform.

---

## G7 — the generative roster (two layers)

Counting agents is the wrong game. GSD ships 33 static, software-only
agents. IJFW's roster is **generative**:

- **G7-core — stable software-first agents (built + shipped):**
  `doc-verifier`, `integration-checker`, `nyquist-auditor`,
  `ijfw-code-fixer` — universal, domain-agnostic leverage agents.
- **G7-gen — generative domain layer (engine, not files):** the on-demand
  team-builder is upgraded to be domain-aware — it reads the project
  brief/domain and synthesizes specialists from lightweight domain-template
  specs (software → software roster; book → narrative-continuity-checker,
  line-editor, lore-keeper; campaign → campaign-strategist, copy-reviewer).

**Cross-platform reality:** the team-engine logic lives in the MCP server —
universal across all 13 platforms. Agent *definitions* deploy as
platform-native packages where the platform supports an agent/subagent
construct; where it does not, the engine still synthesizes the team
advisory/prompt-level. This is scheduled deploy work, not an afterthought.

GSD's 33 fixed agents become a *liability* — static, mono-domain. No
33-clone; the shipped agent surface stays ~20-25, the engine generates the
rest.

---

## The five flagship capabilities — 3 structural moats + 2 first-mover leads

Honest classification (a "structural moat" needs cross-vendor orchestration
or an identity a competitor will not adopt; a "first-mover lead" is a real
edge but replicable):

**Structural moats (un-clonable without changing what the competitor is):**
1. **Cross-AI consensus code-fixer (G4)** — the fix runs through Trident
   before commit; a single-model fixer architecturally cannot replicate it.
2. **Domain-aware adaptive team synthesis (G7)** — generative roster across
   6 domains; GSD cannot follow without abandoning its static identity.
3. **Trident-powered debug (W2)** — competing-hypothesis generation needs
   the same cross-vendor orchestration; single-vendor tools cannot.

**First-mover leads (real edge, defend by staying ahead):**
4. **Trident published convergence telemetry (W4)** — measured
   cycles-to-converge / false-positive / cost. A competitor can publish
   their own numbers later; we are first and the data compounds.
5. **Live subagent truncation telemetry (G1)** — parent-observable,
   auto-recovering, measured rate. First to measure it; defendable by lead.

Plus **enforcement-by-construction (G3)** as the structural floor. The §1
bar needs ≥2 net-new moats — we ship 3 structural + 2 leads.

---

## Scope — the 12 register items, locked dispositions

| Item | Disposition |
|---|---|
| G1 checkpoint | CLOSED — SDK event stream + `state.dispatch-subagent` verb. Lead #5. |
| G2 state-SDK | CLOSED — verb-facade, tri-modal, lock/idempotency/observability models specified. |
| G3 enforcement | CLOSED — enforcement-by-construction; verdict/execution-fail split; ceiling named; matrix. |
| G4 code-fixer | CLOSED — cross-AI consensus fixer (3-tier verify + atomic commits). Moat #1. |
| G5 multi-machine | **DEFERRED** — net-new scope, v1.6.0. Foundation laid (G2 lock-aware). Not a soft spot. |
| G6 codex Stop card | CLOSED — codex Stop status card stays opt-in (codex renders Stop stdout as a visible warning — default-on is noise); the e2e gate is updated to set `IJFW_CODEX_HOOK_NOTICES=1` and test the opt-in path. |
| G7 specialist depth | CLOSED — G7-core agents + G7-gen domain engine. Moat #2. |
| W1 plan-checker gate | CLOSED — plan-check hard-BLOCKS execute on HIGH (a verb precondition). |
| W2 debug | CLOSED + ELEVATED — Trident-powered debug + field-validation receipt. Moat #3. |
| W3 verification scope | CLOSED — fires at every *enumerated* boundary; Superpowers Iron-Law discipline adopted (our own wording, not a verbatim copy). |
| W4 Trident telemetry | CLOSED — published convergence telemetry. Lead #4. |
| W5 memory | CLOSED (escalated) — published benchmarks + temporal/staleness layer. |

---

## The ship bar — 8-dimension scorecard, with ship verdicts

| # | Dimension | v1.5.0 ship verdict |
|---|-----------|---------------------|
| 1 | Subagent dispatch | AHEAD — worktree isolation + deterministic wrapper + waves |
| 2 | Subagent recovery | LEAD — live observed + measured truncation |
| 3 | Code review | MOAT — G4 cross-AI consensus fixer |
| 4 | Plan → Execute | AHEAD — W1 hard-BLOCK vs GSD sanity-check |
| 5 | Verification | AHEAD — structural verb-precondition, beyond prose Iron Law |
| 6 | Debug loop | MOAT — Trident-powered competing-hypothesis generation |
| 7 | Specialist roster | MOAT — generative domain-aware engine vs static 33 |
| 8 | Cross-AI audit | LEAD — published convergence telemetry |

**Scorecard scope:** these 8 dimensions are **single-machine orchestration**.
Distributed/multi-machine (Ruflo's distributed federation) is deliberately a
v1.6.0 line — "ahead-or-moat on all 8" means single-machine; it does not
claim to beat every competitor on every axis.

v1.5.0 ships only when **all three hold**: (1) every falsifiable proof below
is green — no documented soft spot survives; (2) no competitor cleaner on
any of the 8 single-machine dimensions; (3) ≥2 net-new moats — we ship 3
structural + 2 leads.

---

## Falsifiable proof contract (HARD ship gate)

Every item ships with a falsifiable proof, each with a **defined pass
threshold set at plan time** (the never-ships mitigation — no open-ended
"improve"). v1.5.0 does NOT ship until every row is green.

| Item | Proof it is actually closed |
|---|---|
| G2 | Grep-gate test covers JS **and `.sh`** writers **and homedir paths** — zero state writes bypass the SDK. Each migrated writer has a regression test (spy throws if raw `writeFile` is hit). Concurrent-write + multi-lock **deadlock** test passes. `ijfw state:<verb>` CLI + `ijfw_state` MCP exercised in e2e-smoke. |
| G3 | Test proves `state.complete-phase` REFUSES on a red verification verdict via the MCP path. Separate test proves a gate **exception** degrades to advisory (does NOT block). Enforcement-matrix doc exists; an automated check confirms every platform row maps to a real exercised hook/MCP path. |
| G1 | A real dispatched subagent run produces a per-subagent event log the parent polls live. A simulated truncation is RECOVERED to the last committed verb; a partially-applied verb rolls back; an append verb does not double-apply on replay. Truncation rate measured and reported; **pass threshold: ≤ 31% (at least halving the 62% baseline)**. |
| G4 | Seeded bug → review → auto-fix → Trident-verified → atomic commit, end-to-end in a test. Plus a unit test for the 3-tier verification matrix independent of the e2e run. |
| G5 | G2 lock-awareness has a passing lock test. Multi-machine explicitly out — no claim, no soft spot. |
| G6 | e2e-smoke gate #5 goes green with `IJFW_CODEX_HOOK_NOTICES=1` set — the opt-in path is what is tested. |
| G7 | A software project and **≥2 non-software domains** (e.g. book, campaign) run through the team engine and get provably different, domain-appropriate rosters. Every shipped domain-template spec passes a schema-validation test. Each G7-core agent has a test. Agents deploy to their target platform packages (verified in e2e-smoke). |
| W1 | plan-check BLOCKS execute on a seeded HIGH finding — test proves dispatch does not proceed. |
| W2 | A real multi-cycle debug campaign receipt committed; the loop demonstrably used multi-lens competing hypotheses (codex + gemini). |
| W3 | The boundary set is enumerated in the enforcement-matrix doc; a test covers each enumerated boundary (mid-wave, non-subagent, post-done). Iron-Law discipline present in the verification skill (our wording). |
| W4 | Published convergence-telemetry artifact — cycles-to-converge, false-positive rate, cost — emitted by a real Trident run. |
| W5 | Published memory benchmark numbers + a temporal/staleness test proving stale facts are detected/decayed. |

---

## Competitive-response notes

- **AGENTS.md commoditization:** the `AGENTS.md` open standard is making
  "one config across N agents" an industry default — IJFW's *file-distribution
  reach* will commoditize. IJFW's defensible layer is the **runtime** —
  memory, Trident, orchestration, the state-SDK spine — not the config files.
  v1.5.0's moats are deliberately runtime moats; positioning must follow.
- **Ruflo (tier-1 entrant):** leads on distributed federation + compliance
  audit. v1.5.0 does not contest that ground (see scorecard scope); G2 is
  built lock-aware so the v1.6.0 distributed line is a cheap follow.

---

## Anti-patterns / non-negotiables

- No 33-agent clone. Shipped agent surface ~20-25; the engine generates the
  rest. Combine before add — MCP cap stays 12/12.
- No regression to single-tree dispatch — worktree isolation stays.
- No full-process GATE on Quick mode — keep the Quick/Deep picker.
- No graphviz in SKILL.md (unparseable for 7 non-Claude platforms).
- Node floor stays 18; no Anthropic-specific SDK deps; zero new prod deps.
- Core skill `ijfw-core/SKILL.md` hard cap: 55 lines — re-verified in the P3
  ship-gate (currently 53; only 2 lines of headroom).
- Startup report: positive framing only.
- **No half-shipping.** Every feature has a runtime caller AND a green
  falsifiable proof. v1.5.0 ships with zero documented soft spots.

---

## Done when

Roadmap (`.planning/v150-gap-closure/ROADMAP-v150-GAP-CLOSURE.md`) executed
→ every falsifiable-proof row green at its defined threshold → Trident
milestone cross-audit clean → e2e-smoke green → core-skill ≤55 lines →
all stale CHANGELOG / lock-in / CLAUDE.md forward-refs reconciled to v1.5.0
→ operator authorizes Phase F → push + npm publish.
