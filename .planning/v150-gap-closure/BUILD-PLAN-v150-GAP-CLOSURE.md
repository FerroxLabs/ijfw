# IJFW v1.5.0 Gap-Closure — Swarm Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use
> `superpowers:subagent-driven-development` to execute this plan. Dispatch
> one fresh subagent per task; two-stage review (spec compliance, then code
> quality) after each. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all 11 active v1.5.0 gap-register items behind the
state-SDK spine, so v1.5.0 ships as one tag with every falsifiable proof
green.

**Architecture:** A verb-facade state-SDK (`state-sdk.js`) is the spine.
G3 makes gate functions preconditions of state-advancing verbs; G1 makes
the SDK event stream the live subagent telemetry. Moats (G4/G7/W2/W4) and
memory (W5) build on the frozen verb contract.

**Tech Stack:** Node.js ≥18 (ESM), `node --test`, Bash, Markdown. Zero new
production deps. MCP server at `mcp-server/src/`.

**Inputs:** Brief `.ijfw/memory/brief.md` · Roadmap
`ROADMAP-v150-GAP-CLOSURE.md` · Cross-audits `CROSS-AUDIT-ADJUDICATION.md`
+ `PLAN-CROSS-AUDIT-ADJUDICATION.md`.

---

## Granularity & execution model

This is a **swarm-dispatch plan**, not a literal-code plan. The milestone
spans 5 subsystems / 34 tasks; each task is a **self-contained dispatch
brief** — objective, exact files, approach, and a **completion contract**
(falsifiable proof + a `verify:` command). The dispatched subagent does the
literal TDD per `superpowers:test-driven-development`.

**Rules for every task:**
- **Code tasks:** TDD — write the failing test first, then minimal code.
- **Non-code tasks** (contract docs, agent `.md`, the enforcement matrix,
  shell-hook edits, config): NO red→green phase — the `verify:` command is
  the completion contract directly.
- One atomic commit per task (or sub-step), conventional-commit style.
- The task is DONE only when its `verify:` command passes — that is the
  completion contract, not "the code looks done."
- A subagent that cannot meet the contract returns BLOCKED with the failed
  criterion — it does not mark the task complete.
- Worktree dispatch does not run `npm install` — every Node subagent must
  `cd mcp-server && npm install` first if it needs deps.

**Wave table (the execution contract — collision-checked):**

| Wave | Tasks | Mode | Depends on |
|------|-------|------|------------|
| A — P0a foundation | T1 → T2 → T3 → T4 → T5 | SEQUENTIAL | — |
| B — P0b migrations | (T6, T7, T9, T10) ∥ ; T8 ; T12 → T11 ; T13 ; then T14 | PARALLEL group, ordered subchains | A |
| C — P1.1 enforcement | T15 → T16 → T17 → T18 | SEQUENTIAL (shared files) | A |
| D — P1.2 telemetry | T19 → T20 | SEQUENTIAL | C (T15) + T6 |
| E — P2 moats & depth | (T21, T22, T24, T28) ∥ ; T23 ; T25 → T26 ; T27 (after T24) ; T29 ; T30 (after T24+T26) | PARALLEL | A; overlaps C/D |
| F — P3 proof & ship | T31 → T32 → T33 → T34 | SEQUENTIAL | C, D, E |

**Collision rule:** never dispatch two tasks in parallel that Modify the
same file. Wave C is fully sequential because T15/T17 share `state-sdk.js`
and T15/T18 share `verification-gate.js`. In Wave B, `T12 → T11` is ordered
(T11 needs T12's CLI). T14 runs after all other Wave B tasks return.

---

## Recon corrections to brief / roadmap (reconciled — same commit)

1. **No `bin/` directory.** The CLI face is the **`state` colon-namespace**:
   `ijfw state:<verb>` (IJFW's existing `namespace:command` dispatch in
   `mcp-server/src/dispatch/colon-syntax.js`), NOT a `bin/ijfw-state`.
2. **3 of 4 G7-core agents already exist** — `claude/agents/ijfw-doc-verifier.md`
   (90 ln), `ijfw-integration-checker.md` (100 ln), `ijfw-nyquist-auditor.md`
   (118 ln). Only `ijfw-code-fixer` is new. G7-core = build 1 + wire 4.
3. **Temporal memory partially exists** — `mcp-server/src/memory/temporal.js`
   + `staleness.js` + migration `004-bitemporal.js`. W5/T23 is gap-fill,
   not greenfield.

---

## Wave A — P0a: the state-SDK foundation (SEQUENTIAL)

### T1 — Freeze the state-SDK verb contract  *(non-code task)*
**Files:** Create `.planning/v150-gap-closure/STATE-SDK-CONTRACT.md`;
Create `mcp-server/test-state-sdk-contract.js` (the contract validator)
**Objective:** Produce the frozen, *literal* contract every downstream task
binds to — verbs AND the four cross-cutting models. This is the single
keystone: if T1 is vague, T2-T20 re-litigate it and the swarm churns.
**Approach:**
- For EACH verb, a block in this EXACT template:
  ```
  ### verb: <name>
  - Signature: query('<name>', { ... })
  - Payload: <fields + types>
  - Returns: <shape>
  - Day-1: <create | refuse | no-op> when the target file is absent
  - Locks: <ordered subset of the canonical lock list>
  ```
- Verb set (≥17): `workflow.get`, `workflow.set-phase`, `wave.get`,
  `wave.advance`, `wave.record-task`, `phase.plan-check`, `phase.complete`,
  `subagent.dispatch`, `subagent.checkpoint`, `subagent.post-done`,
  `event.emit`, `telemetry.record`, `roster.synthesize`, `roster.record`,
  `extension.set-active`, `decision.add`, `blocker.add`, `blocker.resolve`,
  `state.replay`, `state.validate`.
- The four cross-cutting models, each written LITERALLY (not prose):
  1. **Lock hierarchy** — the canonical acquire-order as an ordered list
     naming every physical state file (e.g. `workflow.json` →
     `wave-*/STATE.md` → `*.jsonl` → `~/.ijfw/state/active-extension.json`).
  2. **Intent/commit record** — the literal JSON shape, e.g.
     `{verb, verbId, phase:'begin'|'commit', ts, dedupKey?}`.
  3. **Event record** — the literal JSON shape, e.g.
     `{seq, verb, subagentId, ts, payloadDigest}` + the log rotation
     policy (ceiling in bytes/lines).
  4. **Gate failure rule** — verdict-fail → verb refuses; execution-fail
     (gate threw) → advisory + loud log, verb proceeds; MCP-unavailable →
     documented bypass.
- State the CLI face explicitly: `ijfw state:<verb>` colon-namespace.
**Completion contract:** `verify:` `node --test mcp-server/test-state-sdk-contract.js` — the validator (written in this task) asserts: every verb in the required set has a block with all 5 sub-fields non-empty; all 4 cross-cutting models present and non-empty; the lock list is a concrete ordered file list.
**Model:** capable.

### T2 — state-sdk.js verb core + dispatcher
**Files:** Create `mcp-server/src/orchestrator/state-sdk.js`; Test
`mcp-server/test-state-sdk.js`
**Objective:** The `query(verb, payload)` dispatcher + verb registry.
**Approach:** Registry maps verb → handler per the T1 contract; unknown
verb throws (no silent fallback). Every verb write uses tmp-write + atomic
rename (reuse `mcp-server/src/lib/atomic-io.js`). Day-1 semantics per the
contract. Physical files unchanged.
**Completion contract:** `verify:` `node --test mcp-server/test-state-sdk.js` — dispatch, unknown-verb rejection, atomic write, a happy-path verb round-trip.
**Model:** capable. **Depends on:** T1.

### T3 — Lock hierarchy + acquire-order
**Files:** Modify `mcp-server/src/orchestrator/state-sdk.js`,
`mcp-server/src/fs-lock.js`; Test `mcp-server/test-state-sdk-locking.js`
**Objective:** One lock model; multi-file verbs cannot deadlock.
**Approach:** Implement the T1 canonical acquire-order; a verb touching N
files acquires in that order, releases reverse. Heartbeat-refreshed locks
for long verbs (replace the fixed 30s stale window). Never hold a lock
across a subprocess spawn.
**Completion contract:** `verify:` `node --test mcp-server/test-state-sdk-locking.js` — a concurrent multi-lock test proves no deadlock and no double-write.
**Model:** capable. **Depends on:** T2.

### T4 — Idempotency: intent/commit markers + append dedup
**Files:** Modify `mcp-server/src/orchestrator/state-sdk.js`; Test
`mcp-server/test-state-sdk-idempotency.js`
**Objective:** Every verb is replay-safe.
**Approach:** Implement the T1 intent/commit record; each verb writes
`begin` then `commit`. Append ops carry the T1 dedup key. Replaying a
committed verb is a no-op; a partial (begin, no commit) rolls back.
**Completion contract:** `verify:` `node --test mcp-server/test-state-sdk-idempotency.js` — replay no-op; interrupted verb rolls back; double append deduped.
**Model:** capable. **Depends on:** T3.

### T5 — Observability: event emit + capped rotated log
**Files:** Modify `mcp-server/src/orchestrator/state-sdk.js`; Create
`mcp-server/src/orchestrator/state-events.js`; Test
`mcp-server/test-state-events.js`
**Objective:** Every verb emits an event without slowing the write.
**Approach:** After lock release, fire-and-forget append to a per-subagent
event log (T1 event record shape). Log ceiling + rotation via
`mcp-server/src/lib/jsonl-rotation.js`. A `pollEvents(since)` reader —
explicit-interval polling, never `fs.watch`.
**Completion contract:** `verify:` `node --test mcp-server/test-state-events.js` — event per verb; emit off the critical section; log rotates at ceiling; `pollEvents` returns events since a cursor.
**Model:** standard. **Depends on:** T4. **Wave A exit:** T1-T5 green.

---

## Wave B — P0b: writer migrations + faces (depends on Wave A)

> T6, T7, T9, T10 are parallel (distinct files). T8 parallel-safe. T12 → T11
> ordered. T13 parallel-safe. T14 runs last.

### T6 — Migrate dispatch-planner.js to the SDK
**Files:** Modify `mcp-server/src/dispatch-planner.js`; Test
`mcp-server/test-dispatch-planner.js`
**Objective:** All state writes in dispatch-planner route through verbs.
**Approach:** Replace direct `writeFile`/JSON writes with `query(verb,…)`.
Add a spy regression test that throws if raw `writeFile` is hit.
**Completion contract:** `verify:` `node --test mcp-server/test-dispatch-planner.js`
**Model:** standard. **Depends on:** Wave A.

### T7 — Migrate wave-state.js to the SDK
**Files:** Modify `mcp-server/src/orchestrator/wave-state.js`; Test
`mcp-server/test-orchestrator-wave-state.js`
**Objective:** Wave state writes route through verbs.
**Approach:** Route `wave.*` writes via the SDK; keep tmp+rename. Spy test
for raw-write bypass.
**Completion contract:** `verify:` `node --test mcp-server/test-orchestrator-wave-state.js`
**Model:** standard. **Depends on:** Wave A.

### T8 — Migrate agents-md-blackboard.js + port merge-block-aware.sh to JS
**Files:** Modify `mcp-server/src/orchestrator/agents-md-blackboard.js`;
Create `mcp-server/src/orchestrator/merge-block-aware.js`; Test
`mcp-server/test-agents-md-blackboard.js`
**Objective:** Blackboard writes route through verbs; no subprocess in the
lock path.
**Approach:** Port `claude/skills/ijfw-agents-md/scripts/merge-block-aware.sh`
to in-process JS (`merge-block-aware.js`); route blackboard writes via the
SDK; never hold a lock across a spawn.
**Completion contract:** `verify:` `node --test mcp-server/test-agents-md-blackboard.js` — block-aware merge parity with the old shell script + SDK routing.
**Model:** capable. **Depends on:** Wave A.

### T9 — Migrate subagent-telemetry.js to the SDK
**Files:** Modify `mcp-server/src/orchestrator/subagent-telemetry.js`; Test
`mcp-server/test-orchestrator-subagent-telemetry.js`
**Objective:** Checkpoint/summary/violation writes route through verbs;
append ops get dedup keys.
**Approach:** `recordCheckpoint`/`appendSummary`/`recordViolation` →
`subagent.checkpoint`/`event.emit` verbs; append ops carry a T1 dedup key.
Spy test for bypass.
**Completion contract:** `verify:` `node --test mcp-server/test-orchestrator-subagent-telemetry.js`
**Model:** standard. **Depends on:** Wave A.

### T10 — Migrate active-extension-writer.js (homedir) to the SDK
**Files:** Modify `mcp-server/src/active-extension-writer.js`; Create
`mcp-server/test-active-extension-writer.js`
**Objective:** The homedir `~/.ijfw/state/` write routes through the SDK.
**Approach:** Route via `extension.set-active`; the SDK handles the
homedir-vs-project path. Spy test for bypass.
**Completion contract:** `verify:` `node --test mcp-server/test-active-extension-writer.js`
**Model:** standard. **Depends on:** Wave A.

### T12 — `ijfw state:<verb>` CLI colon-namespace
**Files:** Modify `mcp-server/src/dispatch/colon-syntax.js`,
`mcp-server/src/cli-run.js`, `scripts/e2e-smoke.sh`; Test
`mcp-server/test-cli-command-parity.js`
**Objective:** External tooling reaches the SDK via the CLI.
**Approach:** Register `state` as a colon-namespace in
`dispatch/colon-syntax.js` — `ijfw state:<verb>` routes to
`query(verb, JSON)`; output JSON. Add an e2e-smoke gate that runs
`ijfw state:workflow.get` and asserts valid JSON.
**Completion contract:** `verify:` `node --test mcp-server/test-cli-command-parity.js` + the new e2e-smoke gate passes.
**Model:** capable. **Depends on:** Wave A.

### T11 — Migrate shell-hook state writes to `ijfw state:`
**Files:** Modify `claude/hooks/scripts/compute-nudge.sh`,
`claude/hooks/scripts/pre-tool-use-extension-check.sh` (+ codex/gemini
copies); Test `mcp-server/test-compute-nudge.js`
**Objective:** No bash `>` redirect writes IJFW state directly.
**Approach:** Replace direct state writes in the hooks with
`ijfw state:<verb>` calls. Hooks stay fail-open (exit 0 on error).
**Completion contract:** `verify:` `node --test mcp-server/test-compute-nudge.js` + a grep proving no `>` state redirects remain in the hooks.
**Model:** standard. **Depends on:** T12.

### T13 — `ijfw_state` MCP tool, absorbing `ijfw_subagent_post_done`
**Files:** Modify `mcp-server/src/server.js`,
`mcp-server/src/orchestrator/post-done-runner.js`,
`mcp-server/test-tool-cap.js`, `CLAUDE.md`; Test
`mcp-server/test-state-mcp-tool.js`
**Objective:** Add `ijfw_state`, remove `ijfw_subagent_post_done` — cap
stays 12/12, zero stale references.
**Approach:** Register `ijfw_state` (single tool, `verb` param). Re-point
`post-done-runner.js` behind the `subagent.post-done` verb. Remove the
`ijfw_subagent_post_done` tool registration (`server.js` `case`). Update
`test-tool-cap.js` + the CLAUDE.md MCP-tool paragraph + lock-in #47.
**Grep-sweep** `claude/`, `docs/`, `mcp-server/test-*` for
`ijfw_subagent_post_done` and update every stale reference.
**Completion contract:** `verify:` `node --test mcp-server/test-tool-cap.js mcp-server/test-state-mcp-tool.js` — cap 12/12 with `ijfw_state` present, `ijfw_subagent_post_done` absent — plus `grep -rn ijfw_subagent_post_done claude docs mcp-server/test-*` returns nothing.
**Model:** capable. **Depends on:** Wave A.

### T14 — SDK grep-gate + per-writer regression sweep
**Files:** Create `mcp-server/test-state-sdk-grepgate.js`
**Objective:** Prove zero state writes bypass the SDK.
**Approach:** Grep-gate scans JS **and `.sh`** files **and homedir paths**
for direct state writes outside the SDK; fails on any hit. Confirm each
T6-T11 spy regression test exists.
**Completion contract:** `verify:` `node --test mcp-server/test-state-sdk-grepgate.js` + full `node --test` sweep green.
**Model:** standard. **Depends on:** T6-T13.

---

## Wave C — P1.1: the enforcement layer (SEQUENTIAL — shared files)

### T15 — G3: gates as verb preconditions + fail-mode split
**Files:** Modify `mcp-server/src/orchestrator/state-sdk.js`,
`mcp-server/src/orchestrator/verification-gate.js`; Test
`mcp-server/test-verification-gate-strict.js`
**Objective:** `phase.complete` refuses on a red gate — structurally.
**Approach:** `phase.complete` runs `enforceVerificationGate` as a
precondition. Per the T1 gate-failure rule: verdict-fail → REFUSE;
execution-fail (gate threw / malformed plan / bug) → advisory + loud log,
verb proceeds; MCP-unavailable → documented bypass.
**Completion contract:** `verify:` `node --test mcp-server/test-verification-gate-strict.js` — proves refuse-on-red AND degrade-on-exception (a thrown gate does not freeze state).
**Model:** capable. **Depends on:** Wave A.

### T16 — G3: per-platform enforcement matrix + accuracy check
**Files:** Create `docs/ENFORCEMENT-MATRIX.md`; Test
`mcp-server/test-enforcement-matrix.js`
**Objective:** Name the enforcement ceiling, per platform, verifiably.
**Approach:** Matrix states, per platform, structural (state routes
through SDK/MCP) vs best-effort (LLM can write files directly). Also
enumerate the W3 boundary set (for T18). The test asserts every platform
row maps to a real, exercised hook/MCP path.
**Completion contract:** `verify:` `node --test mcp-server/test-enforcement-matrix.js`
**Model:** standard. **Depends on:** T15.

### T17 — W1: plan-check hard-BLOCK on HIGH
**Files:** Modify `mcp-server/src/orchestrator/plan-checker.js`,
`mcp-server/src/orchestrator/state-sdk.js`; Test
`mcp-server/test-plan-checker.js`
**Objective:** `phase.plan-check` blocks execute on a HIGH finding,
pre-dispatch.
**Approach:** `validatePlan` becomes the `phase.plan-check` precondition;
a HIGH finding makes the verb refuse — dispatch cannot proceed.
**Completion contract:** `verify:` `node --test mcp-server/test-plan-checker.js` — a seeded HIGH-finding plan blocks; a clean plan passes.
**Model:** standard. **Depends on:** T16.

### T18 — W3: verification at every enumerated boundary + Iron-Law discipline
**Files:** Modify `mcp-server/src/orchestrator/verification-gate.js`,
`claude/skills/ijfw-verify/SKILL.md`; Test
`mcp-server/test-verification-gate.js`
**Objective:** The gate fires at every enumerated boundary, not just
post-done.
**Approach:** For each boundary in the T16 matrix's boundary set (mid-wave,
non-subagent, post-done), the gate fires. Add Iron-Law discipline to the
verify skill — our own wording ("no completion claim without fresh
verification evidence"), not a verbatim copy.
**Completion contract:** `verify:` `node --test mcp-server/test-verification-gate.js` — a test per enumerated boundary.
**Model:** capable. **Depends on:** T17.

---

## Wave D — P1.2: live subagent telemetry (SEQUENTIAL)

### T19 — G1: subagent event stream + dispatch verb
**Files:** Modify `mcp-server/src/orchestrator/subagent-telemetry.js`,
`mcp-server/src/dispatch-planner.js`, `mcp-server/src/orchestrator/state-sdk.js`;
Test `mcp-server/test-subagent-event-stream.js`
**Objective:** The parent sees subagent progress live.
**Approach:** `subagent.dispatch` verb builds the deterministic dispatch
brief (env-var passthrough + SDK contract) — deterministic on Claude,
best-effort prompt-template elsewhere (recorded in the T16 matrix). The
parent polls the per-subagent event log via `pollEvents`.
**Completion contract:** `verify:` `node --test mcp-server/test-subagent-event-stream.js` — a dispatched subagent's verbs appear in the parent's poll.
**Model:** capable. **Depends on:** T15, **T6** (dispatch-planner must be SDK-migrated first).

### T20 — G1: truncation recovery + measured rate
**Files:** Modify `mcp-server/src/orchestrator/state-sdk.js`,
`mcp-server/src/recovery/` (recovery module); Create
`mcp-server/test-truncation-recovery.js` + a fixture corpus
`mcp-server/fixtures/truncation-corpus/`
**Objective:** Truncation recovers from the last committed verb; the rate
is measured against a reproducible corpus.
**Approach:** `state.replay` replays to the last commit marker; partials
roll back; appends do not double-apply. Build a fixed truncation-simulation
corpus (a set of recorded subagent runs with injected truncation points)
so the measured rate is reproducible. Emit a truncation-rate metric.
**Completion contract:** `verify:` `node --test mcp-server/test-truncation-recovery.js` — simulated truncation recovers; **measured rate over the fixed corpus ≤ 31%** (halves the 62% baseline).
**Model:** capable. **Depends on:** T19.

---

## Wave E — P2: moats & depth (PARALLEL off Wave A; overlaps C/D)

### T21 — W4: Trident convergence telemetry
**Files:** Modify `mcp-server/src/cross-orchestrator.js`; Test
`mcp-server/test-cross-orchestrator.js`
**Objective:** Publish measured convergence telemetry.
**Approach:** Instrument `runPhaseEConverge` (`cross-orchestrator.js`) via
the `telemetry.record` verb — cycles-to-converge, false-positive rate,
cost. Emit `.ijfw/telemetry/convergence.json`.
**Completion contract:** `verify:` `node --test mcp-server/test-cross-orchestrator.js` — a real converge run emits the artifact with all three metrics.
**Model:** capable. **Depends on:** Wave A.

### T22 — W5: memory benchmark harness + published numbers
**Files:** Create `mcp-server/src/memory/benchmark.js`,
`mcp-server/test-memory-benchmark.js`
**Objective:** IJFW memory has published, falsifiable benchmark numbers.
**Approach:** Build a benchmark harness over the 3-tier memory; produce a
results artifact comparable to mem0/Zep/Graphiti's published axes.
**Completion contract:** `verify:` `node --test mcp-server/test-memory-benchmark.js` — harness runs, emits a numbers artifact.
**Model:** capable. **Depends on:** Wave A.

### T23 — W5: temporal / staleness gap-fill
**Files:** Modify `mcp-server/src/memory/temporal.js`,
`mcp-server/src/memory/staleness.js`; Test
`mcp-server/test-memory-temporal.js`
**Objective:** Close the gap in the EXISTING temporal layer — decay on
retrieval.
**Approach:** FIRST audit `temporal.js` (386 ln), `staleness.js` (237 ln),
migration `004-bitemporal.js` — they already do validity windows +
staleness detection. The missing piece is **decay-on-retrieval**. Add only
that. Write a test that FAILS against current HEAD (proving the gap is
real) then passes.
**Completion contract:** `verify:` `node --test mcp-server/test-memory-temporal.js` — a stale fact is decayed at retrieval time; the test demonstrably fails on pre-task HEAD.
**Model:** capable. **Depends on:** T22.

### T24 — G7-core: build `ijfw-code-fixer` + wire 4 agents into the generator
**Files:** Create `claude/agents/ijfw-code-fixer.md`; Modify
`mcp-server/src/team/generator.js`, `mcp-server/src/team/schemas.js`; Test
`mcp-server/test-team-generator.js`
**Objective:** The 4 G7-core agents are resolvable from the team generator.
**Approach:** Author `ijfw-code-fixer.md` (the G4 fixer agent). `generator.js`
currently renders agents from `role` bundles — add an explicit
**software-core agent set** (`ijfw-doc-verifier`, `ijfw-integration-checker`,
`ijfw-nyquist-auditor`, `ijfw-code-fixer`) that a software-domain project
roster always includes; the generator references the static
`claude/agents/*.md` files by id. The wiring contract: `generator.js`
output for a software project lists all 4 agent ids, and each id resolves
to an existing `claude/agents/<id>.md` file.
**Completion contract:** `verify:` `node --test mcp-server/test-team-generator.js` — for a software project the generator output contains all 4 agent ids AND each `claude/agents/<id>.md` exists on disk.
**Model:** capable. **Depends on:** Wave A.

### T25 — G7-gen: domain-aware team generator
**Files:** Modify `mcp-server/src/team/generator.js`,
`mcp-server/src/team/schemas.js`; Test `mcp-server/test-team-generator.js`
**Objective:** The generator synthesizes rosters by project domain.
**Approach:** Read the project brief/domain; route to a domain-template
spec; software → software roster, book/campaign → domain specialists.
Roster writes go through the `roster.*` verbs.
**Completion contract:** `verify:` `node --test mcp-server/test-team-generator.js` — software vs ≥2 non-software domains yield provably different rosters.
**Model:** capable. **Depends on:** T24.

### T26 — G7-gen: domain-template specs (≥3 domains) + schema validation
**Files:** Create `mcp-server/src/team/domain-templates/*.json` (software,
book, campaign at minimum); Test `mcp-server/test-domain-templates.js`
**Objective:** Each shipped domain template is schema-valid.
**Approach:** Author ≥3 domain-template specs; a schema-validation test
covers every shipped template.
**Completion contract:** `verify:` `node --test mcp-server/test-domain-templates.js`
**Model:** standard. **Depends on:** T25.

### T27 — G4: cross-AI consensus code-fixer loop
**Files:** Create `mcp-server/src/recovery/code-fixer.js`; Test
`mcp-server/test-code-fixer.js`
**Objective:** review → fix → Trident-verify → atomic commit.
**Approach:** 3-tier verification (re-read / per-language syntax check /
fallback); each finding fixed in an isolated worktree, **Trident-verified**
before an atomic per-finding commit; logic bugs flagged for human review;
recovery-sentinel cleanup (reuse `mcp-server/src/lib/worktree-recovery.js`).
**Completion contract:** `verify:` `node --test mcp-server/test-code-fixer.js` — seeded bug → fixed → Trident-verified → committed, end-to-end; plus a unit test for the 3-tier matrix.
**Model:** capable. **Depends on:** T24 (needs `ijfw-code-fixer`).

### T28 — G6: codex Stop e2e gate
**Files:** Modify `scripts/e2e-smoke.sh`
**Objective:** The codex-Stop status-card e2e gate goes green.
**Approach:** The status card stays opt-in (deliberate — codex renders Stop
stdout as a visible warning). In `scripts/e2e-smoke.sh`, locate the gate
asserting the codex Stop status card (current failing line: "Codex Stop did
NOT emit status card"); update it to export `IJFW_CODEX_HOOK_NOTICES=1`
before the assertion, testing the opt-in path.
**Completion contract:** `verify:` `bash scripts/e2e-smoke.sh 2>&1 | grep -A1 'Codex Stop'` shows PASS.
**Model:** standard. **Depends on:** Wave A.

### T29 — W2: Trident-powered debug + field-validation campaign
**Files:** Modify the `ijfw-debug` stack modules under
`mcp-server/src/orchestrator/` (locate via recon — debug-session manager +
debugger); Create `.ijfw/receipts/debug-campaign-v150.md`; Test
`mcp-server/test-debug-trident.js`
**Objective:** The debug loop uses cross-lens competing hypotheses; field-
validated.
**Approach:** When a hypothesis stalls, dispatch codex + gemini to generate
competing hypotheses cross-lens. Run a real multi-cycle debug campaign;
commit the receipt.
**Completion contract:** `verify:` `node --test mcp-server/test-debug-trident.js` + the committed receipt shows multi-lens hypotheses used.
**Model:** capable. **Depends on:** Wave A.

### T30 — Agent cross-platform deploy
**Files:** Modify `installer/scripts/build.js` (and/or the installer
manifest — locate via recon), `scripts/e2e-smoke.sh`; Test
`mcp-server/test-cross-platform-smoke.js`
**Objective:** New agents reach their target platforms; the team engine is
universal.
**Approach:** Deploy agent definitions into platform packages that support
an agent/subagent construct; the team engine (MCP-server-side) is the
universal layer for the rest. Update the installer manifest. Add an
e2e-smoke gate that greps the built platform packages for the new agent
files.
**Completion contract:** `verify:` `node --test mcp-server/test-cross-platform-smoke.js` + the new e2e-smoke agent-deploy gate passes.
**Model:** standard. **Depends on:** T24, T26.

---

## Wave F — P3: proof & ship (SEQUENTIAL; no feature work)

### T31 — Falsifiable-proof walk
**Objective:** Every brief proof-table row is green at its threshold.
**Approach:** Run every `verify:` command in this plan + the brief proof
table; any red = not done, return BLOCKED.
**Completion contract:** `verify:` full `node --test` sweep + `npm test` + `bash scripts/e2e-smoke.sh` all green; the G1 truncation-rate ≤ 31%.
**Model:** standard. **Depends on:** Waves C, D, E.

### T32 — Trident milestone cross-audit
**Objective:** The whole milestone diff passes cross-audit.
**Approach:** `ijfw cross-audit` over the milestone diff (`--chunk` for
size); adjudicate; close all HIGH/MED/LOW.
**Completion contract:** `verify:` cross-audit synthesis shows 0 open HIGH/MED.
**Model:** capable. **Depends on:** T31.

### T33 — Ship-gate close-out
**Objective:** The repo is ship-ready.
**Approach:** e2e-smoke green; assert `claude/skills/ijfw-core/SKILL.md`
≤ 55 lines; audit **all** lock-in entries + the CLAUDE.md convention/cap
text + CHANGELOG `[1.5.0]` for stale "v1.5.1"/"next milestone" refs and
reconcile to v1.5.0; retag `v1.5.0` at final HEAD.
**Completion contract:** `verify:` `bash scripts/e2e-smoke.sh` green + `test $(grep -c '' claude/skills/ijfw-core/SKILL.md) -le 55` + `grep -rn 'v1.5.1\|next milestone' CHANGELOG.md` returns nothing stale.
**Model:** standard. **Depends on:** T32.

### T34 — Phase F (OPERATOR-GATED)
**Objective:** Ship v1.5.0.
**Approach:** On explicit operator "yes, push": `git push gitlab main` +
tag; CI OIDC npm publish. Do NOT proceed without authorization.
**Completion contract:** `verify:` `npm view @ijfw/install version` returns `1.5.0`.
**Model:** standard. **Depends on:** T33 + operator authorization.

---

## Self-review

- **Spec coverage:** every register item maps to tasks — G1→T19/T20,
  G2→T1-T14, G3→T15/T16, G4→T27, G5→(out; T3 lock test covers the
  foundation), G6→T28, G7→T24/T25/T26/T30, W1→T17, W2→T29, W3→T18,
  W4→T21, W5→T22/T23. Every brief proof-table row has an owning task; the
  CLI + agent-deploy e2e-smoke gates are owned by T12 and T30.
- **No placeholders:** every task has exact files, an objective, an
  approach, and a falsifiable `verify:` command.
- **Type consistency:** all tasks bind to the T1 frozen verb contract;
  verb names are consistent T2-T20.
- **Collision integrity:** no two parallel tasks Modify the same file —
  Wave C serialized; Wave B `T12→T11` ordered; T19 depends on T6.
- **Dependency integrity:** Wave A is the sole hard prerequisite; B/C/E run
  off the frozen contract; D follows C(T15)+T6; F follows C/D/E.
