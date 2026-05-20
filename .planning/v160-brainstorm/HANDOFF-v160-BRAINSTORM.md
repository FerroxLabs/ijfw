# IJFW v1.6.0 — DEEP-DIVE BRAINSTORM HANDOFF

**Created:** 2026-05-20
**For:** the next session — a **brainstorm + roadmap** session, NOT an execute session.
**Working milestone name:** v1.6.0 (the brainstorm finalises the name + version).
**Mandate (operator, verbatim intent):** "Where we have gaps, we need to address
them. Where we have weaknesses, we need to be better. Close all the gaps, be
better than the competition, be more solid where we're weak and stronger than
the rest. This gives us the roadmap. We're NOT doing it in 1.5.1."

---

## 0. STATE PIN (do not regenerate)

**Repo:** `/Users/seandonahoe/dev/ijfw` · **Branch:** `main`
**HEAD:** `78cecd1` · **Tag:** `v1.5.0` → `282bad8` (LOCAL ONLY — not pushed)
**v1.5.0 status:** ship-ready; **Phase F push (gitlab + npm publish) is
operator-gated** and still pending an explicit "yes, push".

**Test posture (all green):**
- `node --test`: 2013 tests / 2012 pass / 0 fail / 1 skip
- `npm test` (`node test.js`): 103 / 103
- `scripts/e2e-smoke.sh`: 3 gate failures, all triaged as non-bugs
  (live-session artifact / unpublished-version / codex opt-in design)

**What v1.5.0 already shipped** (so the brainstorm does not re-propose it):
foundation S1-S10 + 6 fold-ins; major W12 ~30 scope items; N-series;
W1-W5 wire-up; r19/r20/r21 cross-audits. Full inventory in
`CHANGELOG.md` `[1.5.0]` + `[1.5.0-foundation]` + `[Unreleased]` W1-W5.

**This handoff supersedes** the v1.5.1/v1.6.0 split in
`.planning/audit-cross-system/GAP-MATRIX.md` — that split assumed a tight
10-14 day v1.5.1. The operator has rejected the small version. v1.6.0 is
the ambitious "close everything + win" milestone.

---

## 1. THE BAR FOR v1.6.0

v1.5.0 closed ~7 of 8 cross-system audit dimensions and moved IJFW from a
**2.0/5** average to **~3.9/5** against Superpowers 5.1.0 + GSD 1.41.2.
That is parity-plus. **The operator does not want parity-plus. v1.6.0's
bar is: on every dimension, IJFW is the one to beat.**

Three success tests for the brainstorm to make concrete + measurable:
1. **No "documented soft spot."** Every v1.5.0 caveat ("mechanism shipped,
   not auto-exercised", "advisory not enforced", "retroactive receipt")
   either becomes fully real or is deleted. No half-shipping survives.
2. **No dimension where a competitor is cleaner.** Specifically: GSD's
   state architecture and GSD's specialist depth (the two places v1.5.0
   is genuinely *behind*).
3. **At least 2 capabilities no competitor can match** beyond today's
   cross-AI audit — net-new moat, not just gap-closing.

---

## 2. WHY A BRAINSTORM, NOT AN EXECUTE PLAN

The operator asked to "brainstorm this and dive deep" before fixing. Do
NOT walk into the next session with a pre-baked plan. The next session:
1. Runs a real deep brainstorm (ijfw-workflow Deep mode, or
   superpowers:brainstorming) over the material in §4-§6.
2. Produces a **locked brief** + a **roadmap** (phase breakdown, wave plan).
3. Only then plans execution.

The gap register below is **raw material**, not decisions. Several items
have genuine open questions (architecture forks, build-vs-skip calls) —
those are the brainstorm's job.

---

## 3. THE HONEST v1.5.0 SCORECARD (8 dimensions)

Baseline = `GAP-MATRIX.md` (2026-05-18, pre-v1.5.0-major). "Now" = post
v1.5.0-major + wire-up. Rank 1 = worst, 5 = at/above best-in-class.

| # | Dimension | Was | Now | v1.6.0 target |
|---|-----------|----:|----:|---------------|
| 1 | Subagent dispatch | 2 | 3-4 | **5** — executor agent + deviation rules must actually run, not be read |
| 2 | Subagent recovery / truncation | 1 | 3 | **5** — checkpoints must be REAL-TIME, auto-injected |
| 3 | Code review pipeline | 2 | 4 | **5** — close the code-fixer loop |
| 4 | Plan → Execute | 3 | 4 | **5** — plan-checker as a hard pre-execute gate |
| 5 | Verification gate | 2 | 4 | **5** — enforced everywhere, not just post-done |
| 6 | Debug loop | 1 | 4 | **5** — field-validate the 3-layer manager |
| 7 | Specialist roster | 2 | 4 | **5** — close the depth gap deliberately |
| 8 | Cross-AI audit | 3 | 5 | **5+** — extend the moat |

Average now ~3.9. v1.6.0 target: **5.0 with a moat on #8 and 2 net-new.**

---

## 4. GAP REGISTER (things not done / half-done)

Each gap: evidence · current state · "what DECISIVE looks like" · open question.

### G1 — Checkpoint auto-injection (the one real "half" in v1.5.0)
- **Evidence:** `CHANGELOG.md` `[1.5.0]` "Dogfooding receipt" — all 38
  v1.5.0 checkpoints were *retroactively synthesised*; the subagent
  `ijfw checkpoint` CLI shipped but the dispatcher never auto-invoked it.
  Lock-in #46 explicitly scopes auto-injection to "next milestone".
- **Current:** mechanism = canonical + tested (`subagent-telemetry.js`,
  `ijfw checkpoint` CLI, `IJFW_PARENT_PROJECT_ROOT` passthrough,
  `ijfw worktree-drain`). Real-time exercise = NOT wired.
- **Decisive:** every dispatched Agent subagent writes checkpoints
  mid-run without being asked; the parent sees them live; truncation
  recovery is observed, not reconstructed. The 62% truncation rate that
  motivated S1 is actually measured falling.
- **Open question:** how does the dispatch wrapper inject the CLI call
  into a subagent it does not control the prompt of? Env-var contract?
  A wrapper skill every subagent loads? This is an architecture fork.

### G2 — state-SDK consolidation (gap-matrix v151-S09 — NOT shipped)
- **Evidence:** `.ijfw/state/*`, `.ijfw/memory/*.jsonl`, `.ijfw/wave-*/`,
  `.ijfw/active-extension.json` are written by ~6 scattered modules
  (`dispatch-planner.js`, `agents-md-blackboard.js`,
  `subagent-telemetry.js`, `verification-gate.js`, etc.).
- **Current:** no single mutation surface. GSD routes ALL state through
  `gsd-sdk query state.*` verbs — cleaner, scriptable, idempotent.
- **Decisive:** one `state-sdk.js` `query(verb, …)` dispatcher; every
  writer routes through it; every verb idempotent + concurrent-safe; a
  `bin/ijfw-state` CLI so external tooling never hand-writes JSON.
- **Open question:** is a verb-namespace SDK the right model for IJFW, or
  does IJFW's multi-platform nature want something else? This is the
  single place IJFW is genuinely *behind* — the brainstorm must resolve it.

### G3 — Runtime-honesty of the orchestrator model
- **Evidence:** `GAP-MATRIX.md` "Where we fucked up" §1-§2 — the
  "orchestrator IS the LLM session" assumption was never written down;
  ~6 features shipped as JS + tests + markdown but were never *called*.
  W1 wire-up + N-series fixed the worst, but the model still relies on
  the orchestrator-LLM *choosing* to invoke `ijfw_subagent_post_done` etc.
- **Current:** lock-in #44 says discipline must be wired OR an MCP tool
  whose output is a hard-block. But "the LLM must call the tool" is still
  trust-the-LLM. Superpowers force-injects its meta-skill every session;
  GSD's SDK verbs are the only mutation path.
- **Decisive:** the brainstorm decides IJFW's enforcement architecture
  explicitly — hook-injection? mandatory MCP gate? a daemon? — and every
  v1.4.4/v1.5.0 contract function is provably exercised.
- **Open question:** can a cross-platform tool (8+ agents, not all with
  the same hook surface) have GSD-grade enforcement at all? Or is
  "best-effort enforcement + honest disclosure" the actual ceiling? Name
  the ceiling.

### G4 — code-fixer loop (gap-matrix v151-S07 — partial)
- **Evidence:** recovery-sentinel pattern shipped (`worktree-recovery.js`,
  S10); a dedicated `ijfw-code-fixer` agent + 3-tier verification matrix
  (re-read / per-language syntax check / fallback) + atomic per-finding
  commits + logic-bug "requires human verification" flag did NOT ship.
- **Current:** reviewers find issues; nothing systematically fixes them
  in an isolated worktree with verification.
- **Decisive:** review → auto-fix → re-verify → atomic-commit loop, with
  the recovery sentinel making cleanup crash-safe.

### G5 — Multi-machine wave coordination
- **Evidence:** `docs/MULTI-MACHINE-DESIGN.md` — a 4-phase stub
  (distributed lock / signed checkpoints / CRDT STATE.md / cluster CLI).
- **Current:** design only, zero implementation. Deferred from v1.5.0.
- **Open question:** is multi-machine actually in v1.6.0 scope, or a
  v1.7.0 item? It is large. The brainstorm decides — but it is a real
  differentiator nobody else has.

### G6 — Codex Stop status card (E2E smoke gate #5)
- **Evidence:** `scripts/e2e-smoke.sh` gate expects the codex Stop hook
  to emit the status card; `codex/.codex/hooks/session-end.sh` gates it
  behind `IJFW_CODEX_HOOK_NOTICES=1` + token-usage (deliberate — codex
  renders Stop stdout as a visible warning).
- **Current:** test/design mismatch. Small. Either update the test to
  enable the opt-in it is testing, OR un-gate the update-nudge portion.
- **Decisive:** decide the codex Stop UX deliberately and make the gate
  match. Trivial — but it is a live ship-gate red.

### G7 — Specialist depth vs GSD (~14 agents not built)
- **Evidence:** GSD ships 33 named agents; IJFW ~20. Missing, with
  genuine leverage: doc-pipeline quartet (classifier / synthesizer /
  verifier / writer), 5-agent research roster, framework-selector,
  eval-auditor, intel-updater, user-profiler.
- **Current:** v1.5.0 added assumptions-analyzer, codebase-mapper,
  debug-session-manager + debugger, ui-auditor, extract-learnings,
  discuss-phase, roadmapper, executor. Good coverage — but not deep.
- **Decisive:** the brainstorm picks which of the ~14 are real leverage
  for IJFW's multi-domain mission and which are GSD-specific bloat. NOTE
  the anti-pattern (§9): do NOT clone all 33. Pick with intent.
- **Open question:** IJFW's roster should serve 6 domains (software,
  book, campaign, etc.), not just software. Which *domain* specialists
  are missing that GSD never had to think about?

---

## 5. WEAKNESS REGISTER (shipped, but not best-in-class)

### W1 — Plan-checker is a library, not a gate
`plan-checker.js` (`validatePlan`, 6 mechanical checks) ships *inside*
`ijfw_subagent_post_done` routing. GSD spawns a plan-checker as a hard
pre-execution gate. IJFW checks plans *after* dispatch, not *before*.
**Decisive:** plan-check BLOCKS execute on HIGH findings.

### W2 — Debug-session-manager not field-validated
C09 shipped the 3-layer debug architecture (session-manager + debugger +
DATA_START/END injection defense). The CHANGELOG does not claim it has
been dogfooded under real multi-cycle debugging. **Decisive:** a real
debugging campaign run through it, with the receipt as proof.

### W3 — Verification gate scope
`enforceVerificationGate` is strict-by-default at post-done (F4). But it
only fires at the post-done boundary. A mid-wave completion claim, or a
non-subagent context, is not gated. **Decisive:** define where the gate
MUST fire and make it fire there.

### W4 — Trident convergence is powerful but unmeasured
`runPhaseEConverge` (N01) iterates with CYCLE_SUMMARY + stall detection.
But there is no published data on convergence quality — how many cycles
typical, false-positive rate, cost per converge. **Decisive:** Trident
ships with measured convergence telemetry, turning the moat into a
provable claim.

### W5 — Memory: strong, but is it the best?
3-tier (hot/warm/cold) + cross-project + facts + dedup + embedding cache.
The H5 batch compared against mem0/Zep/Graphiti. **Open question for the
brainstorm:** re-audit memory specifically against the 2026 state of
those systems — is IJFW's memory actually ahead, or just adequate?

---

## 6. COMPETITIVE MAP — what to beat

**AHEAD (defend + extend the moat):**
- Cross-AI audit (Trident) — nobody else has multi-lens consensus.
- Platform reach — ~13 agents installed vs Superpowers ~3, GSD Claude-only.
- Multi-domain — book/campaign/landing-page/etc. are first-class.
- Memory — 3-tier; competitors have none / flat files.
- Quick/Deep auto-picker — "smarter not slower".
- Trust model — Ed25519 signing, provenance, air-gapped updates.

**AT RISK (parity today, will lose without work):**
- Subagent dispatch + recovery — GSD's executor is a real running agent.
- Code review — GSD's worktree-isolated code-fixer is best-in-class.
- Debug — GSD's 3-layer is the reference; IJFW matched the shape, not the miles.

**BEHIND (must close):**
- State architecture — GSD `gsd-sdk query state.*` (see G2).
- Specialist depth — GSD 33 vs IJFW ~20 (see G7).

**For the brainstorm:** the competitor facts in `GAP-MATRIX.md` /
`SUPERPOWERS-AUDIT.md` / `GSD-AUDIT.md` are dated 2026-05-18. **Consider
re-running the cross-system audit fresh** — Superpowers + GSD may have
shipped new versions; new competitors (other agent frameworks) may
warrant a look. Fresh competitive intel is a candidate first wave.

---

## 7. BRAINSTORM AGENDA (next-session deep dive)

Work these in order. Each produces a decision recorded in the brief.

1. **Scope the milestone.** Is v1.6.0 "close all gaps" (G1-G7 + W1-W5),
   or is multi-machine (G5) split to v1.7.0? Name + version the milestone.
2. **Resolve the architecture forks** — the items with open questions:
   - G1: how does the dispatcher auto-inject checkpointing?
   - G2: is a verb-namespace state-SDK right for IJFW?
   - G3: what is IJFW's *honest* enforcement ceiling across 8 platforms?
   These three are load-bearing; the rest depends on them.
3. **Specialist roster decision (G7).** Pick the exact agents to build.
   Apply the §9 anti-pattern (no 33-agent clone). Include *domain*
   specialists competitors never needed.
4. **The moat question.** Name ≥2 net-new capabilities no competitor can
   match (success test #3, §1). Cross-AI audit telemetry (W4) is one
   candidate; what else? (Distributed swarm? Domain-aware verification?
   Memory-as-a-service?)
5. **Re-audit the field.** Decide whether to spawn a fresh
   Superpowers/GSD/new-competitor audit as wave 1.
6. **Sequencing.** Dependency-order G1-G7 + W1-W5 into waves. G2 and G3
   are likely foundational (everything downstream touches state +
   enforcement).
7. **Measurability.** For each gap, define the *falsifiable* proof it is
   closed (a test, a receipt, a measured metric) — v1.5.0's lesson was
   "tests pass ≠ feature fires".
8. **Lock the brief.** Domain = software/tooling; format = the technical
   brief template. Write `.ijfw/memory/brief.md` + a roadmap.

---

## 8. CANDIDATE SCOPE BUCKETS (raw — NOT decided)

Do not treat as a plan. Brainstorm fodder only.

- **Bucket R — Runtime honesty:** G1 (checkpoint auto-inject), G3
  (enforcement architecture), W3 (gate scope).
- **Bucket S — State + structure:** G2 (state-SDK), W1 (plan-check gate).
- **Bucket L — Loop completion:** G4 (code-fixer), W2 (debug field-validate).
- **Bucket A — Audit moat:** W4 (Trident telemetry), audit re-run,
  net-new audit capability.
- **Bucket D — Depth:** G7 (specialist roster), domain specialists.
- **Bucket M — Multi-machine:** G5 (if in scope).
- **Bucket P — Polish:** G6 (codex Stop), any new cross-audit findings.

---

## 9. ANTI-PATTERNS / NON-NEGOTIABLES

From `GAP-MATRIX.md` "Anti-patterns to AVOID" + IJFW principles. The
brainstorm must respect these:

- **Do NOT clone GSD's 66-skill / 33-agent surface.** Cap ~25 skills /
  ~20-25 agents. Pick with intent. Combine before adding (CLAUDE.md
  MCP-tool rule generalises).
- **Do NOT regress to single-tree dispatch.** Worktree isolation stays.
- **Do NOT bolt the full-process GATE onto Quick mode.** The Quick/Deep
  auto-picker is a DX win — keep it.
- **Do NOT adopt graphviz decision trees in SKILL.md** — unparseable for
  the 7 non-Claude platforms.
- **Do NOT raise the Node floor** past 18, or chase Anthropic-specific
  SDK deps.
- **No half-shipping.** Every v1.6.0 feature has a runtime caller OR a
  hard-block MCP signal — AND a falsifiable proof it fires (§7.7). This
  is the lesson v1.5.0's checkpoint caveat taught.
- **Core skill `ijfw-core/SKILL.md` hard cap: 55 lines.**
- **Startup report: positive framing only.**

---

## 10. EVIDENCE & REFERENCE INDEX

- `CHANGELOG.md` — `[1.5.0]`, `[1.5.0-foundation]`, `[Unreleased]` W1-W5:
  the complete v1.5.0 feature inventory.
- `.planning/audit-cross-system/GAP-MATRIX.md` — the 8-dimension matrix +
  the 10-item v151-S backlog + "where we fucked up" honesty section.
  **Dated 2026-05-18 — pre-v1.5.0-major. Read with that in mind.**
- `.planning/audit-cross-system/SUPERPOWERS-AUDIT.md` — Superpowers 5.1.0.
- `.planning/audit-cross-system/GSD-AUDIT.md` — GSD 1.41.2.
- `.planning/audit-cross-system/IJFW-CURRENT.md` — IJFW pre-major state.
- `.planning/v150-wireup/HANDOFF-v150-WIREUP-COMPLETE.md` — the wire-up +
  r19/r20/r21 cross-audit record (§11 = W5).
- `.planning/audit-v1.5.0/` — the 8-engine deep-dive audit (~393 KB).
- `docs/MULTI-MACHINE-DESIGN.md` — the G5 stub design.
- `docs/DESIGN.md`, `README.md` — current architecture.

---

## 11. RESUME PROTOCOL — START THE NEXT SESSION HERE

```
This session is the v1.6.0 DEEP-DIVE BRAINSTORM. Full handoff:
.planning/v160-brainstorm/HANDOFF-v160-BRAINSTORM.md — read it first,
top to bottom.

State: v1.5.0 is ship-ready (tag v1.5.0 → 282bad8, local only, Phase F
push still operator-gated). HEAD 78cecd1. Tests fully green.

Task: run a DEEP brainstorm (ijfw-workflow Deep mode OR
superpowers:brainstorming) over the gap register (§4), weakness register
(§5), and competitive map (§6). Work the §7 agenda in order. Resolve the
3 architecture forks (G1 dispatcher checkpoint injection, G2 state-SDK,
G3 enforcement ceiling) — they are load-bearing. Produce a LOCKED brief
+ a roadmap (phase/wave breakdown with falsifiable proof per gap).

The bar (§1): not parity-plus. v1.6.0 makes IJFW the one to beat on every
dimension, with ≥2 net-new capabilities no competitor can match.

Do NOT pre-bake a plan. Brainstorm first. Respect the §9 anti-patterns.
Do NOT push v1.5.0 — that is a separate operator-gated decision.
```

**First actions for the next session:**
1. Read this handoff fully.
2. Read `GAP-MATRIX.md` (note: pre-major; the "Now" column in §3 here is
   the current truth).
3. Decide whether to spawn a fresh cross-system competitive audit
   (Superpowers / GSD / new entrants) as wave 1 — recommended; the
   existing audits are 2+ days and one major release stale.
4. Open the brainstorm. Deep mode. Conversation or guided — operator's call.
