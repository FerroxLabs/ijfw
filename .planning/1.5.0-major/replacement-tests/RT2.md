# Replacement Test RT2 — Superpowers-Style TDD Task with IJFW Only

**Scenario:** A user says: *"Add a `--strict` flag to my CLI that makes warnings fail. Test-drive it."* — a small, well-bounded feature that, under Superpowers, would trigger `brainstorming → writing-plans → using-git-worktrees → test-driven-development → subagent-driven-development → verification-before-completion → requesting-code-review → finishing-a-development-branch`, with `systematic-debugging` if a failure surfaces and `receiving-code-review` after the reviewer responds. The replacement test walks the same task end-to-end using only IJFW skills/agents/commands and asks: does the user get the same (or better) RED-GREEN-REFACTOR discipline, evidence-before-claims guarantee, isolated branch hygiene, and reviewer feedback loop?

**Verdict:** **PARTIAL** — most disciplines are present, two are missing (writing-skills, receiving-code-review), one is critically softer than Superpowers (verification-before-completion is advisory at the runtime layer, gate-strict at the author layer; IJFW does not actually *block* a false DONE claim — the runtime gate only logs it), and several disciplines exist but lack a sharp natural trigger that a casual user would type.

**HIGH findings:** 3   **MEDIUM:** 5   **LOW:** 4

---

## Per-step coverage matrix

Legend: **E** = exists / **TF** = trigger fidelity / **OC** = output contract / **DM** = discipline match (rigor parity vs Superpowers) / **HO** = hand-off to next step. Each rated **Y / partial / N / N/A**.

| Superpowers step | IJFW skill/agent | Path | Lines | since: | E | TF | OC | DM | HO | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| brainstorming | ijfw-workflow (Quick FRAME/WHY/SHAPE/STRESS/LOCK) | `claude/skills/ijfw-workflow/SKILL.md` | 528 | unset | Y | Y (`brainstorm`, `quick idea`, `build`, `plan` all trigger) | Y (`.ijfw/memory/brief.md`) | Y (5 disciplined moves + 6 deep modules; arguably stronger than Superpowers' single skill) | Y (LOCK routes to PLAN) | **MATCH** |
| writing-plans | ijfw-plan command + ijfw-workflow Plan phase + plan-checker.js lib + ijfw-plan-checker agent + ijfw-plan-check skill | `claude/commands/ijfw-plan.md` (40), `claude/skills/ijfw-plan-check/SKILL.md` (220), `claude/agents/ijfw-plan-checker.md` (113), `mcp-server/src/orchestrator/plan-checker.js` | — | plan-check skill **NO since**, plan-checker agent `since: 1.5.0` | Y | Y (`/ijfw-plan`, `make a plan`, `let's plan this`) | Y (`.ijfw/memory/plan.md` + `PLAN-CHECK.md` + structured `gate-result` block) | Y (mechanical pre-dispatch gate + 6-step human review + four-mode routing + ISSUE vocabulary — richer than Superpowers' single-skill template) | Y (PASS/FLAG/BLOCK + routes to EXECUTE) | **MATCH-PLUS** |
| subagent-driven-development | ijfw-workflow EXECUTE + ijfw-executor agent + post-done-runner | `claude/skills/ijfw-workflow/SKILL.md` §EXECUTE, `claude/agents/ijfw-executor.md` (144), `mcp-server/src/orchestrator/post-done-runner.js`, `runtime-loop.js` | — | executor `since: 1.5.0` | Y | partial (no top-level `subagent`/`parallel` trigger; only fires when user is already inside workflow) | Y (4-value Status block, `Attempts:` field, branch naming, MCP-tool callback) | Y (3-attempt cap + Rules 1-4 deviation taxonomy + two-stage review = stronger than Superpowers') | Y (`routeDecision.action` table proceeds to review or escalates) | **MATCH-PLUS** |
| test-driven-development | ijfw-tdd skill | `claude/skills/ijfw-tdd/SKILL.md` | 103 | `1.5.0` | Y | partial (`tdd`, `test first`, `red green refactor`, `/ijfw-tdd` — but the scenario phrase **"test-drive it"** is **not** an explicit trigger) | Y (3 explicit green-lights + anti-pattern list) | Y (Iron Law on first line; RED/GREEN/REFACTOR enforced; 6 anti-patterns named with WHY) | partial (no "next: invoke ijfw-verify" pointer; no automatic hand-off into executor for GREEN) | **MATCH** (gap = trigger surface and no explicit verify hand-off) |
| verification-before-completion | ijfw-verify skill + verification-gate.js + ijfw_subagent_post_done | `claude/skills/ijfw-verify/SKILL.md` (137), `mcp-server/src/orchestrator/verification-gate.js`, `post-done-runner.js` | — | verify skill **NO since** | Y | Y (`done`, `tests pass`, `shipped`, `ready to merge`, `phase complete`) | Y (12-row claim→evidence table + VERIFIED/LIKELY/GUESSING/ISSUE tagging) | partial — **runtime gate is ADVISORY-ONLY** (line 5 of verification-gate.js: "ADVISORY ONLY — never throws, never blocks") whereas Superpowers' "Iron Law" is taught as absolute. The skill body is strict; the safety net under it is soft. | Y (downstream tools read `verification-violations.jsonl`) | **MATCH-WITH-CAVEAT** (HIGH finding below) |
| requesting-code-review | ijfw-review skill + cross-audit (ijfw-cross-audit skill + Phase E auto-fire) + 5 specialist agents | `claude/skills/ijfw-review/SKILL.md` (42), `claude/skills/ijfw-cross-audit/SKILL.md` (76), specialist agents (doc-verifier, pattern-mapper, security-auditor, integration-checker, nyquist-auditor) | — | review skill **NO since** | Y | Y (`review`, `code review`, `PR review`, `/ijfw-review` + cross-audit triggers) | Y (severity-coded one-liners + `gate-result` block; Phase E writes `CROSS-AUDIT-r<N>.md`) | Y (multi-lens consensus + auto-fire after VERIFY) | Y (Phase E routes PASS/CONDITIONAL/FAIL into SHIP or fix-wave) | **MATCH** |
| using-git-worktrees | Agent `isolation:'worktree'` + worktree-provision.js + dispatch-helpers.md + ijfw-workflow §EXECUTE | `mcp-server/src/orchestrator/worktree-provision.js`, `claude/skills/ijfw-workflow/lib/dispatch-helpers.md` | — | code only; no since: tag on lib doc | Y | N (no skill/command named for worktrees; user never *invokes* it directly — it's plumbing) | Y (deterministic `wave/<id>/<sub>` branches + 4-value status) | Y (auto-provision of node_modules via execFile + `--ignore-scripts`; better than Superpowers) | Y (post-done runner picks up the branch) | **MATCH-PLUS** (rigor) / **gap** (no user-facing trigger surface) |
| dispatching-parallel-agents | ijfw-workflow EXECUTE §Wave Dispatch + dispatch-planner.js (`parsePlan`/`buildManifest`) | `claude/skills/ijfw-workflow/SKILL.md` lines 240-274, `mcp-server/src/dispatch-planner.js` | — | inline contract; no standalone skill | Y | partial (`/ijfw-execute`, `execute the plan`; no `dispatch agents in parallel` shortcut) | Y (4-value Status block per sub-wave) | Y (deterministic wave manifest + isolation resolver + branch naming + status routing) | Y (post-done MCP tool fans into review/escalate) | **MATCH** |
| finishing-a-development-branch | ijfw-ship skill (no SKILL.md — command-only) + ijfw-workflow §SHIP + ledger gate + cross-audit hook | `claude/commands/ijfw-ship.md` (62), `claude/skills/ijfw-workflow/SKILL.md` §SHIP | — | no since: | Y | Y (`ship it`, `deploy`, `let's ship`, `time to ship`) | Y (atomic commit + tag + memory write + announcement copy) | Y (ship gate blocks on unresolved `execute-issues.json`; confidence tags required) | Y (memory write + announcement) | **MATCH** |
| receiving-code-review | — | — | — | — | **N** | N | N | N | N | **MISSING** (HIGH finding below) |
| systematic-debugging | ijfw-debug skill + ijfw-debugger agent + ijfw-debug-session-manager agent | `claude/skills/ijfw-debug/SKILL.md` (52), `claude/agents/ijfw-debugger.md` (238), `claude/agents/ijfw-debug-session-manager.md` (217) | — | both agents `since: 1.5.0`; skill **NO since** | Y | Y (`debug`, `broken`, `not working`, `fix this bug`, `/debug`) | Y (6-step skill output + 5 structured terminator headers from debugger + state-checkpoint schema from session-manager) | Y (3-layer architecture: reproduce → instrument → root-cause; prompt-injection defense via DATA_START/DATA_END; HYPOTHESES.md log; two-strikes rule; checkpoint resume across context resets — substantially deeper than Superpowers' single skill) | Y (debugger emits ROOT_CAUSE_FOUND / TDD_CHECKPOINT / CHECKPOINT_REACHED / INVESTIGATION_INCONCLUSIVE / DEBUG_COMPLETE; session manager routes to specialist review) | **MATCH-PLUS** |
| writing-skills | — | — | — | — | **N** | N | N | N | N | **MISSING** (HIGH finding below) |

---

## Findings

### HIGH — blocks the all-in-one claim

#### H1. `verification-before-completion` runtime is ADVISORY, not blocking
**Evidence:** `mcp-server/src/orchestrator/verification-gate.js` line 4-6 verbatim: *"ADVISORY ONLY — never throws, never blocks. Returns { ok: true } or { ok: false, violation: string, claim: string }."* Violations are written to `verification-violations.jsonl` for future pattern detection only. Meanwhile `ijfw-verify/SKILL.md` line 87-89 explicitly states *"The runtime gate is the safety net. It is not the gate. This skill is the gate."* and warns *"If you find yourself thinking 'the runtime gate will catch it' — that thought is the Iron-Law violation."*
**Impact:** Superpowers users feel verification-before-completion as a binding rule because no plumbing exists below it to soften the consequences. IJFW users see *both* a binding skill instruction and a logged-but-permitted runtime escape hatch. For the scenario, if the implementer subagent emits `Status: DONE Tests: 3 pass / 0 fail` without actually running `npm test` in the same message, the runtime tool will *flag it in a JSONL file* and downstream pattern detection may eventually reroute it to `DONE_WITH_CONCERNS` — but the immediate-turn protection is solely the skill's text. That is a real-vs-claimed gap. Superpowers replaces with a single absolute rule; IJFW splits that into "rule + audit log".
**Fix:** (a) promote `checkVerificationGate` to a hard block at the post-done-runner level when the claim is an unsupported `DONE` *and* no `Bash` verification call is present in the same message — i.e. route to `redispatch_needs_context` with `missing: 'verification-evidence'` instead of just logging; (b) update `ijfw-verify/SKILL.md` to remove the "advisory" framing now that it bites; OR (c) document the split clearly in the all-in-one claim ("IJFW provides verification-before-completion at the author layer; runtime is advisory by design").

#### H2. No `writing-skills` equivalent
**Evidence:** `grep -lri 'writing.skills\|skill.author\|skill.development\|skill creation' /Users/seandonahoe/dev/ijfw/claude/` returned **zero hits**. Skill creation lives entirely under external plugins (`skill-creator:skill-creator`, `plugin-dev:skill-development`).
**Impact:** A power-user of Superpowers who builds their own skills (Sean's own meta-workflow includes "write a skill for X" as a normal move) has no IJFW counterpart. For the TDD scenario specifically, this is low-blast-radius — the user does not need to write a new skill to add `--strict`. But for the all-in-one claim, it is a real gap: a Superpowers user who decides mid-task "I should formalize this as a skill" cannot stay inside IJFW.
**Fix:** Add `claude/skills/ijfw-skill-author/SKILL.md` — small skill that produces a SKILL.md from a brief, enforces the IJFW conventions (`since:` tag, narration marker, line cap, output contract gate-result, trigger fidelity self-check). Triggers: `write a skill`, `new skill`, `formalize this as a skill`, `/ijfw-skill-author`.

#### H3. No `receiving-code-review` equivalent
**Evidence:** `grep -lri 'receiving.code.review\|code review feedback\|review feedback' /Users/seandonahoe/dev/ijfw/claude/` returned **zero hits**. `ijfw-review/SKILL.md` (42 lines) is purely the *reviewer-side* output contract. There is no skill that teaches the *implementer side* how to receive feedback rigorously (verify before agreeing, push back on technically questionable suggestions, avoid performative agreement).
**Impact:** In the TDD scenario, after `ijfw-review` flags `L42: [warn] no test for empty-string input`, the implementer's next move is implicit. Superpowers has a dedicated skill that says: don't just implement, verify the claim first; if you disagree, say so with evidence; technical rigor over performative agreement. Without that, IJFW implementers default to "agree and implement", which silently drops the rigor half of code review. This is the partner of H1: false DONEs and uncritical fix-on-feedback are the two sides of the same anti-pattern.
**Fix:** Add `claude/skills/ijfw-review-respond/SKILL.md` (or rename `ijfw-review` to `ijfw-review-author` and add `ijfw-review-respond` alongside). Required moves: (a) read each finding, (b) reproduce it locally, (c) classify as confirmed / partially-confirmed / disputed, (d) for disputed, write a 2-line rebuttal with evidence, (e) for confirmed, RED-GREEN it via `ijfw-tdd` before claiming `addressed`. Triggers: `respond to review`, `address review`, `review came back`, `/ijfw-review-respond`.

### MEDIUM — friction that breaks the smooth experience

#### M1. `ijfw-tdd` is not auto-fired by the natural scenario phrase "test-drive it"
**Evidence:** `ijfw-tdd/SKILL.md` description triggers are: `tdd, test first, red green refactor, /ijfw-tdd`. The scenario phrase is **"Test-drive it."** — a phrase a user will absolutely type and which Superpowers' `test-driven-development` description does cover ("before writing implementation code" — broad enough to fire on the scenario; Superpowers' skill name itself maps to the verb "test-drive"). IJFW will under-fire here.
**Fix:** Add `test-drive`, `test-drive it`, `tdd it`, `drive with tests` to the description triggers. One-line edit.

#### M2. `ijfw-tdd` has no explicit hand-off to `ijfw-verify` for the GREEN gate
**Evidence:** `ijfw-tdd/SKILL.md` ends with the "Final rule" anti-pattern check at line 100-103; no "Next: invoke ijfw-verify with the test output" pointer. Move 2 says "Paste the pass output" but does not invoke the Iron Law.
**Fix:** Add 2-line "## After GREEN" section pointing to `ijfw-verify` so the test-run output is logged as VERIFIED evidence, not just inline chat text.

#### M3. `ijfw-debug`, `ijfw-verify`, `ijfw-review`, `ijfw-plan-check`, `ijfw-ship` are all **missing `since:` tags**
**Evidence:** Inspected with `grep -r "since:" /Users/seandonahoe/dev/ijfw/claude/skills/ijfw-*/SKILL.md`. Confirmed missing on the five named skills.
**Impact:** Update-discovery (which skills are new in this version) becomes opaque. The agents largely have `since:` set; the skills don't. Inconsistent.
**Fix:** Add `since:` tag to each of the five.

#### M4. `using-git-worktrees` has no user-facing trigger
**Evidence:** Worktrees are *plumbing* in IJFW — the user does not invoke them; the dispatcher picks `isolation:'worktree'` based on plan markers. There is no skill or command named for worktrees. By contrast, a Superpowers user can type "use a worktree for this" and get the skill body. In IJFW, asking for one mid-flow yields a hand-edit of the plan markdown.
**Impact:** For the scenario, this is fine — the dispatcher decides correctly. But it means users *exploring* the system can't discover the worktree machinery without reading the lib docs.
**Fix:** Add `claude/commands/ijfw-worktree.md` (50 lines) that explains the dispatch-helpers.md contract and the auto-provisioning, with triggers `worktree`, `isolate this`, `/ijfw-worktree`. Skill body itself is unchanged.

#### M5. `dispatching-parallel-agents` likewise has no top-level trigger
**Evidence:** `/ijfw-execute` covers the umbrella ("execute the plan"), but the user has no way to say "fan out N agents in parallel" without already being inside the EXECUTE phase of the workflow.
**Fix:** Either add a `parallel` keyword to `/ijfw-execute`'s description or add a wave-status command (`/ijfw-wave status`) — both visible from outside the workflow.

### LOW — polish

#### L1. `ijfw-review/SKILL.md` (42 lines) is thinner than the reviewer-discipline of Superpowers' `requesting-code-review` (which includes self-checklist before sending, criteria for when review is needed). IJFW's is "output contract for the reviewer". Useful but narrower scope. Consider clarifying its scope vs cross-audit.

#### L2. `ijfw-verify` description does not mention `--strict`-style flag scenarios. The 12-row evidence table is dense for newcomers. Consider a starter recipe.

#### L3. Multiple skills (`ijfw-tdd`, `ijfw-review`) begin with `<!-- IJFW: narration-not-applicable -->` markers — useful for the framework, noisy for human readers. Hide via a build step or move to a sidecar metadata file.

#### L4. Naming inconsistency: `ijfw-plan-check` (the auditor skill) vs `ijfw-plan-checker` (the agent). They do different things (skill = human-facing audit gate; agent = pre-dispatch re-spec detector). Distinct names would help: e.g. rename agent to `ijfw-respec-detector`.

---

## What IJFW does BETTER than Superpowers (in this scenario)

1. **3-layer debugger architecture.** `ijfw-debugger` + `ijfw-debug-session-manager` (238 + 217 lines) — explicit Layer 1 deterministic reproduction, Layer 2 targeted instrumentation, Layer 3 falsifiable hypothesis — plus a persistent `HYPOTHESES.md` log that survives context resets, two-strikes rule, and prompt-injection defense via `DATA_START`/`DATA_END` markers. Superpowers' `systematic-debugging` is a single skill body without the multi-cycle checkpoint orchestrator. **Material win.**
2. **Pre-dispatch mechanical plan-check (`plan-checker.js`)** — 6 syntactic/structural rules (placeholders, completeness, acceptance criteria, empty steps, dependency sanity, test-skip contradictions) — runs *before* tokens are spent on goal-alignment review. Plus an `ijfw-plan-checker` *agent* that grep-checks "NEW" claims against the live codebase to catch re-specs. Superpowers' `writing-plans` has no such pre-flight.
3. **Four-mode plan-review routing** (SELECTIVE / REDUCTION / SCOPE_EXPANSION / HOLD) with deterministic metric-driven default selection. Superpowers' plan-review is more open-ended.
4. **3-attempt fix cap on the executor** (`ijfw-executor.md` lines 73-87) with explicit per-issue counter and a hard escalation signal via the `Attempts:` field in the Status block. Catches the truncation pattern Superpowers' `subagent-driven-development` does not have a structural defense for.
5. **Worktree auto-provisioning via `worktree-provision.js`** — detects node/python/rust/go, runs install with `--ignore-scripts` for supply-chain safety. Superpowers' worktree skill is more procedural.
6. **Cross-audit Phase E auto-fire** — multi-lens consensus runs automatically after VERIFY, before SHIP, with auditor selection + reachability probes + per-phase synthesis files. Superpowers does not ship this.
7. **Memory recall at every workflow entry point** — Sutherland's "feel smarter and more in control" baked into the protocol via `ijfw_memory_recall`. Superpowers is memory-agnostic.

---

## Summary

- IJFW currently covers **10/12** Superpowers-equivalent disciplines fully, with 1 covered-but-soft (verification-before-completion runtime is advisory) and 2 missing (writing-skills, receiving-code-review).
- **Top 3 fixes that would make this REPLACES-SUPERPOWERS:**
  1. **(H1)** Promote `checkVerificationGate` to a hard block at the post-done-runner level for unsupported `DONE` claims with no in-message verification command. This is the single most load-bearing fix because verification-before-completion is the discipline Superpowers users invoke most often as a *rule*, not a suggestion.
  2. **(H3)** Ship `ijfw-review-respond` (or `ijfw-review-author` + `ijfw-review-respond` split). The implementer side of code review is the silent-failure half of the loop and IJFW currently has no answer for it.
  3. **(H2)** Ship `ijfw-skill-author`. Small skill, large reach — closes the loop on "IJFW can be its own meta-tool" and removes the only reason a power user would still reach for an external skill-creator plugin mid-flow.
- **Estimated effort to close all HIGH findings:** ~1 day total. H1 = 2 hours (one branch in `post-done-runner.js` to route on `!ok` from `checkVerificationGate` to `redispatch_needs_context` + matching update to `ijfw-verify/SKILL.md`). H2 = 3 hours (~80-line skill modeled on `ijfw-tdd`'s shape + triggers + output contract). H3 = 3 hours (~100-line skill including the reproduce/classify/rebut/RED-GREEN protocol). M1-M5 are all ≤30 minutes each, batchable into 2 hours of polish. LOW items can wait for a future cleanup wave.
- **Net verdict:** **PARTIAL** today, **REPLACES-SUPERPOWERS** after one focused day of work targeting H1+H2+H3 plus the M1/M2/M3 polish. The core engine is already there; the gaps are around the edges and one critical promotion of an advisory rule to a binding one.
