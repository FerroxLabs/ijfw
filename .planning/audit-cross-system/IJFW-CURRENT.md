# IJFW v1.5.0 — Current State Audit (R3 baseline)

**Author:** R3 researcher in 3-agent swarm. Baseline for R4 synthesis.
**Repo state at audit:** branch `worktree-agent-aa036601918551f0a` from `c45cb2c release(1.5.0): bump version`.
**Date:** 2026-05-18.
**Test posture (per recent commits):** 1428/1428 tests; Trident r14 PASS (2/3 productive auditors, codex unblocked via S7, 0 findings).

> **Load-bearing mandate:** distinguish WIRED (code calls code at runtime) from ASPIRATIONAL (documented in markdown / has unit tests but no runtime call-site). Where the spec says one thing and the code says another, this report sides with the code.

---

## TL;DR

**3 strongest dimensions (where the code is honest about what it does):**
1. **Cross-AI audit (Phase E / Trident)** — `runPhaseEAuto` in `cross-orchestrator.js` is fully wired: roster → reachability probe → fan-out with per-auditor `timeoutMs` (S7) → INCONCLUSIVE on zero productive. Tested in production: r14 PASS with 2/3 productive.
2. **Subagent dispatch contract** — the 4-value status protocol (`status-protocol.js`) is fully specified, has a freshness+branch-tuple commit verifier (S3), and is documented end-to-end in `dispatch-helpers.md`. Implementer prompts include a verbatim "end your message with" template.
3. **Specialist roster** — 13 named specialists with frontmatter + role docs in `claude/agents/ijfw-*.md`. They exist as files (markdown agents), invocable via Claude Code's Agent tool.

**4 weakest dimensions (where spec ≠ runtime):**
1. **Subagent dispatch is human-orchestrated** — `parseAgentReport` / `handleStatus` are imported only by tests + markdown. No `cross-orchestrator.js`, `extension.js`, or runtime loop calls them. The Claude session running ijfw-workflow is expected to read the report and route by eye.
2. **Subagent recovery (S1) — worktree blindness** — implementer in `isolation:'worktree'` writes checkpoints to **its own worktree** (`<worktree>/.ijfw/wave-<id>/...`), not the parent. After worktree cleanup, parent never sees the checkpoint. `listOrphanedSubagents(waveId, projectRoot)` reads `<projectRoot>/.ijfw/wave-<waveId>/`, so the parent gets empty results unless the subagent wrote outside its sandbox.
3. **Two-stage code review is documented but not auto-fired** — `reviewTask` in `review.js` is imported only by `mcp-server/test-orchestrator-review.js`. No orchestrator runtime calls it post-DONE. The skill says "the orchestrator runs … reviewTask"; the orchestrator is the LLM session, not the JS module.
4. **Verification gate is record-only** — `checkVerificationGate` lives as a pure function. No call-site in `mcp-server/src/` invokes it on agent messages; it ships as a library the LLM session is supposed to call. Even when called, it only appends to JSONL.

**Top single gap (load-bearing for v1.6.0 planning):**
> **The worktree → parent checkpoint visibility gap.** S1 shipped a checkpoint contract and CLI, but in the canonical `isolation:'worktree'` dispatch mode, the checkpoint file lands at `<worktree>/.ijfw/wave-<id>/subagent-<sub>.checkpoint.json`. The orchestrator after worktree cleanup looks at `<parent>/.ijfw/wave-<id>/` and finds nothing. The 62% truncation rate that S1 was sized against is **not closed for worktree dispatch** — only for non-isolation dispatches that share the parent's filesystem.

---

## Dimension 1 — Subagent dispatch

### Wired
- `claude/skills/ijfw-workflow/SKILL.md` (lines 240-273) embeds the dispatch contract directly inside the workflow skill, between explicit `IJFW-A1-DISPATCH-START/END` markers.
- `claude/skills/ijfw-workflow/lib/dispatch-helpers.md` is the full contract document.
- `mcp-server/src/dispatch-planner.js::parsePlan` + `buildManifest` parse plan.md into `[{wave, sub, files, mode: 'shared'|'worktree'}]`.
- `mcp-server/src/orchestrator/status-protocol.js`:
  - `STATUS_VALUES = ['DONE','DONE_WITH_CONCERNS','NEEDS_CONTEXT','BLOCKED']` (4-value contract).
  - `parseAgentReport(reportText)` — extracts `Status:`, `Commit:`, `Branch:`, `Tests:`, `Concerns:`, `Reason:`, `Missing:`, `Tried:`. Throws `ProtocolViolation` if `Status:` missing or invalid.
  - `handleStatus(parsed, dispatchTimestamp, ctx)` — routes to one of `proceed_to_review`, `proceed_with_flag`, `redispatch_with_context`, `redispatch_needs_context`, `escalate_to_user`.
  - `verifyFreshCommit(sha, branch, ts, ctx)` — v1.5.0 S3 closes the r13-M-N2 bypass: requires commit ≥ dispatchTimestamp-1s AND commit reachable from dispatched branch (`git branch --contains <sha> --list <branch>`).
- Branch naming convention `wave/<wave-id>/<sub-id>` is documented and the spec-reviewer prompt assumes it.

### Aspirational / partial
- **No production call-site for `parseAgentReport` or `handleStatus`.** `grep -rn` shows:
  - `mcp-server/src/orchestrator/status-protocol.js` (defines them)
  - `claude/skills/ijfw-workflow/lib/dispatch-helpers.md` (documents them in JS-flavored markdown)
  - `mcp-server/src/server.js::handleStatus` is an UNRELATED function (workflow-status command handler, no `parsed` arg).
  - No `cross-orchestrator.js`, `wave-cli.js`, or `extension.js` import or invoke `parseAgentReport`.
- The "orchestrator" referenced in SKILL.md line 260 ("from `orchestrator/status-protocol.js`") is the **Claude session running the workflow skill** — a human-language orchestrator that's expected to copy-paste the regex behavior. Not an automated runtime loop.
- The freshness+branch-tuple check is genuine, but only fires if the LLM session remembers to call `handleStatus` (or implement it inline) when reading a subagent's report.

### Truthful gap
> The 4-value contract is **declared and tested in isolation, but execution depends on the LLM session enforcing it by eye.** A drift-prone implementer can submit `Status: COMPLETE` instead of `Status: DONE` and the workflow only catches it if the orchestrator-session remembers to validate against `STATUS_VALUES`. There is no daemon, no tool-call interception, no pre-handoff gate.

---

## Dimension 2 — Subagent recovery (S1)

### Wired
- `mcp-server/src/orchestrator/subagent-telemetry.js`:
  - `recordCheckpoint(waveId, subId, checkpoint, projectRoot)` — atomic write via `withFsLock` to `<projectRoot>/.ijfw/wave-<waveId>/subagent-<subId>.checkpoint.json`. Enforces `WAVE_ID_PATTERN` / `SUB_ID_PATTERN` (path-traversal hardening) and `MAX_CHECKPOINT_SIZE = 4 KB`.
  - `readLastCheckpoint(waveId, subId, projectRoot)` — returns parsed JSON or `null` (ENOENT).
  - `listOrphanedSubagents(waveId, projectRoot)` — `readdir` the wave dir, regex-match `subagent-<subId>.checkpoint.json`, defence-in-depth subId pattern check.
- `mcp-server/src/dispatch/checkpoint-cli.js` — provides `ijfw checkpoint <waveId> <subId> <jsonPayload>` via the dispatch handlers contract.
- **Wire-up confirmed:** `mcp-server/src/dispatch/extension.js:616` imports `./checkpoint-cli.js` and merges its handlers into the dispatch surface, so `ijfw checkpoint ...` works at the CLI.
- `mcp-server/src/orchestrator/checkpoint-contract.md` — frozen, 94-line documented contract.
- Documented agent (`claude/agents/ijfw-ralph-loop-runner.md` lines 27-31) prescribes the orphan-detection protocol.
- Test: `mcp-server/test-orchestrator-subagent-telemetry.js`.

### Aspirational / partial — the worktree → parent gap
**This is the biggest single spec-vs-wired gap in v1.5.0.**

The orchestrator-side resume protocol assumes `<projectRoot>/.ijfw/wave-<waveId>/...` is readable from the orchestrator's vantage. But:

1. The canonical dispatch mode for code-heavy work is `Agent({ isolation: 'worktree' })` (per `dispatch-helpers.md` and the v1.5.0 lock-in #22+#32).
2. A worktree subagent's `process.cwd()` is `<worktree>` (e.g. `/Users/.../ijfw/.claude/worktrees/agent-xxx/`).
3. `ijfw checkpoint` resolves `projectRoot` via `(ctx && ctx.projectRoot) || process.cwd()` — for a CLI invocation inside the worktree, this is the worktree, not the parent.
4. Checkpoint file lands at `<worktree>/.ijfw/wave-<id>/subagent-<sub>.checkpoint.json`.
5. After the wave completes, the orchestrator (running in parent) calls `listOrphanedSubagents(waveId, parentProjectRoot)` → reads `<parent>/.ijfw/wave-<id>/` → **empty**.
6. If the worktree was cleaned up (`ijfw swarm worktree cleanup <task-id>`), the checkpoint is gone forever.

The contract document (`checkpoint-contract.md` lines 52-72) describes the orchestrator resume protocol in detail, but does not address worktree isolation. The 62% truncation rate that S1 was sized to close is **partially closed**:
- Closed for non-isolation (shared-tree) dispatch.
- Open for `isolation:'worktree'` dispatch.

Combined with Dimension 1's "handleStatus has no runtime caller" gap, **the full subagent-recovery loop is not end-to-end wired in any documented dispatch mode**: the orchestrator-LLM has to (a) parse reports by eye, (b) reach into worktree filesystems before cleanup to discover checkpoints, (c) re-dispatch with the documented prepended context block.

### Truthful gap
> v1.5.0 S1 is real code with real tests. But the production deployment surface — orchestrator notices truncation → finds checkpoint → resumes from `next_step` — has **zero runtime call-sites** and a structural blindness to worktree-isolated subagents that the spec never resolved. v1.6.0 candidate: either (a) checkpoint to parent via env-var passthrough on worktree dispatch, (b) drain checkpoints during integrate before cleanup, or (c) auto-push checkpoint commits to wave branch.

---

## Dimension 3 — Code review pipeline (two-stage)

### Wired
- `mcp-server/src/orchestrator/review.js`:
  - `REVIEW_MAX_ITERATIONS = 3` constant exported.
  - `shouldReReview(prevVerdict, iteration)` — `prevVerdict !== 'PASS' && iteration < REVIEW_MAX_ITERATIONS`.
  - `reviewTask({ taskId, taskSpec, commitSha, branch, projectConventions, dispatch })`:
    - Stage 1: `dispatch('spec-compliance', {...})` → if FAIL, returns `{ ok: false, stage: 'spec', findings }` — short-circuit.
    - Stage 2 (only after spec PASS): `dispatch('code-quality', {...})` → returns `{ ok: verdict === 'PASS', stage: 'quality', findings }`.
  - `dispatch` is INJECTED by caller (test-friendly; no live Agent tool import).
- Reviewer prompts are first-class artifacts:
  - `claude/skills/ijfw-workflow/prompts/spec-reviewer.md` — Stage 1 reviewer, `Verdict: PASS|FAIL`, `Finding: <text>` contract.
  - `claude/skills/ijfw-workflow/prompts/quality-reviewer.md` — Stage 2 reviewer, 4 dimensions (correctness/security/conventions/tests), severity-tagged findings `[HIGH]/[MED]/[LOW]`.
- Both reviewer prompts mandate they are SEPARATE from the implementer (no self-review) and use `isolation: 'none'` (read-only on the implementer's branch).
- SKILL.md lines 326-328 document the post-DONE flow inline.

### Aspirational / partial
- **`reviewTask` has no production call-site.** `grep -rn "reviewTask"` shows:
  - `mcp-server/src/orchestrator/review.js` (definition).
  - No imports from any other `mcp-server/src/` file.
- The skill says "after the implementer subagent reports `Status: DONE`, the orchestrator runs … reviewTask" — but the actual orchestrator (Claude session running ijfw-workflow) has to (a) recognize DONE, (b) construct a `dispatch` callback that fires the reviewer agents (likely via Claude Code's `Agent` tool with the prompt set to `prompts/spec-reviewer.md` content), (c) call `reviewTask` from within tool calls. This is documented but not automated.
- No mention of `REVIEW_MAX_ITERATIONS` escalation handling on the LLM-session side beyond the prose paragraph in SKILL.md.

### Truthful gap
> Two-stage review is a **library + prompt pair**, not a runtime loop. The Claude session is expected to be the orchestrator that wires it together. This is comparable to the dispatch-status gap: the contract is faithful, but the trigger lives in the LLM's discipline, not in a daemon.

---

## Dimension 4 — Plan → execute workflow

### Wired
- `claude/skills/ijfw-workflow/SKILL.md` (519 lines) is the canonical document. Phase lifecycle: **BRAINSTORM → PLAN → EXECUTE → VERIFY → SHIP → MEASURE** ("Donahoe Loop", line 16).
- Two modes:
  - **Quick** (5 moves: FRAME / WHY / SHAPE / STRESS / LOCK), 3-5 min, written to `.ijfw/memory/brief.md`.
  - **Deep** (6 modules: FRAME / RECON / HMW / DIVERGE / CONVERGE / LOCK + 3 optional: External Brief / Anti-Scope / Trident Critique), 20-45 min.
- Auto-picker (lines 34-53) routes by deterministic signals (word count, vague verbs, project-dir state).
- PLAN section (lines 213-237):
  - `.ijfw/memory/plan.md` (max 15 Quick / 30 Deep tasks).
  - Design auto-fire if plan mentions UI/dashboard/visual artifact → dispatch `ijfw-design`.
  - Plan-check via `ijfw plan-check` or inline checklist (verify step / no unstated assumptions / scope matches brief / destructive ops flagged).
- EXECUTE section (lines 239-339):
  - Wave dispatch per A1-DISPATCH block (Dimension 1).
  - Phase banner + team announcement narration.
  - Swarm preparation: `ijfw swarm plan|prepare|tasks|status|start|complete|block|prompt`.
  - Conservative worktree support (code-heavy tasks only) — `ijfw swarm worktree create|list|integrate|cleanup`.
  - Blackboard claims for non-code artifacts (writing, design, research, business).
  - Post-DONE two-stage review (per Dimension 3 contract) + advisory verification gate (per Dimension 5).
- VERIFY section (lines 356-361): audit against brief (not plan); functional + UX + security + quality checklists; optional Trident cross-audit.
- Phase E cross-audit auto-fires between VERIFY and SHIP (per Dimension 8).
- SHIP section (lines 408-419): atomic commit, optional Trident final critique, tag/release/changelog only on public ship, memory write of decision+pattern+learning.

### Aspirational / partial
- **Where does discuss/spec happen?** IJFW collapses GSD's `gsd-discuss-phase` + `gsd-spec-phase` + `gsd-plan-phase` into the BRAINSTORM phase (Quick 5 moves or Deep 6 modules). There is **no separate spec gate** — the LOCK action at end of brainstorm IS the spec, written to `brief.md` (Quick) or `brief.md` with metrics+risks appended (Deep CONVERGE).
- This is intentional ("Brainstorm Discipline" invariants, line 69-80) — the user should never see "Phase N complete, ready to build" without seeing intermediate findings.
- Plan-vs-spec distinction is implicit: `plan.md` is the task breakdown; `brief.md` is the spec; VERIFY audits against brief (line 358 explicit: "Audit the result against the **brief**, not the plan").

### Truthful gap
> IJFW has **no SPEC.md analog** to GSD's gsd-spec-phase. Whether this is a strength (less ceremony) or weakness (ambiguity scoring missing) depends on the project. The brief carries the spec role, but the brainstorm-to-brief route is conversation-driven rather than ambiguity-scored. Big-stakes phases may lose the rigor GSD's separate spec gate forces.

---

## Dimension 5 — Verification gate

### Wired
- `mcp-server/src/orchestrator/verification-gate.js`:
  - `checkVerificationGate(message, toolCallsInMessage)` — scans message for `COMPLETION_PATTERNS`:
    - `/\b(?:DONE|completed|shipped|PASS)\b/`
    - `/✅/`
    - `/\b(?:all tests pass|build succeeded|deployed|ready to ship)\b/i`
  - If a completion claim is found WITHOUT a matching `Bash` tool call running `npm test|node --test|cargo test|pytest|preflight|ijfw preflight|build`, returns `{ ok: false, violation, claim }`.
  - r13-M-01/04 false-positive cleanup: dropped bare `complete` (matched "not yet complete"), lowercase `done` (matched "to be done in v1.5"), lowercase `pass` (matched "pass the context"). The pattern set now favors precision over recall.
- `recordViolation(violation, projectRoot)` — appends JSONL entry to `.ijfw/memory/verification-violations.jsonl`. Silently swallows write errors (never blocks).

### Aspirational / partial
- **No production call-site.** No `mcp-server/src/` file imports `checkVerificationGate` or `recordViolation` outside tests.
- The function takes `toolCallsInMessage` — there is no infrastructure that captures tool calls inside an agent message and passes them to the gate. This is a library waiting for a host.
- Skill (line 330) is explicit: "The gate is ADVISORY — it never blocks; it teaches over time." But "teaches" requires the violations file to be populated, which requires the gate to actually fire, which requires a caller.

### Truthful gap
> The verification gate is **a pure function awaiting a runtime**. Even if it fired, it would only log to JSONL for memory-feedback pattern detection — never block. Its honest status: a v1.4.4 design landed as code, not wired into any execution path. The "memory-feedback system v1.4.1 B10" it references is the pattern detector; both halves need to operate together to deliver the teaching loop.

---

## Dimension 6 — Debug loop

### Wired
- `claude/skills/ijfw-debug/SKILL.md` — 52-line skill. Six-step protocol:
  1. **Reproduce** — one-line failure description.
  2. **Check recent changes** — memory recall on symptom; offer revert if regression correlates.
  3. **Isolate** — narrow to smallest reproducing case.
  4. **Hypothesize** — ranked H1/H2/H3 with evidence per hypothesis.
  5. **Fix + Verify** — minimal change, no adjacent fixes, tests after every fix, `ijfw_memory_store` capture.
  6. **Two-strikes session reset** — if two attempts both fail, stop, summarize, ask user to start a fresh session with a sharpened prompt.
- Output format mandated: `SYMPTOM / ROOT CAUSE / FIX / VERIFIED / FOLLOW-UPS`.

### Aspirational / partial
- **No multi-cycle checkpoint protocol for debugging.** GSD has `gsd-debug-session-manager` (per the orienting prompt) — a persistent state machine across debug cycles. IJFW's two-strikes rule is a session-reset heuristic, not a state machine.
- No `.ijfw/debug-state.json` analogue. The skill assumes the LLM session holds the hypothesis tree in context; on context reset, the tree is lost (the two-strikes summary in memory is the only durable artifact).
- No integration with the subagent checkpoint contract (Dimension 2) — debug runs are not modeled as subagents with telemetry.

### Truthful gap
> Debug is a **single-skill, single-session protocol** in IJFW. GSD's debug-session-manager pattern (persistent state across context resets) is absent. The two-strikes reset is a discipline, not a persistence layer. For long debug sessions that span context windows, IJFW relies on memory writes after each cycle — workable but lossy.

---

## Dimension 7 — Specialist roster (13 total)

`ls claude/agents/ijfw-*.md` returns 13 files. Group by purpose:

| Agent | Role | Group | Since |
|---|---|---|---|
| `ijfw-accessibility-eng.md` | a11y review of UI work | Audit / verify | v1.4.4 |
| `ijfw-dep-audit.md` | dependency audit (CVEs, license, drift) | Audit / verify | v1.4.4 |
| `ijfw-doc-verifier.md` | docs vs. code drift detector | Audit / verify | v1.4.4 W10-A3 |
| `ijfw-doc-writer.md` | doc-writing specialist | Coverage / docs | v1.4.4 |
| `ijfw-e2e-runner.md` | end-to-end smoke runner | Audit / verify | v1.5.0 W11-D1 (regex relaxed in 8540f5d) |
| `ijfw-integration-checker.md` | cross-module integration smell detector | Audit / verify | v1.4.4 W10-A3 |
| `ijfw-llm-budget-watcher.md` | token / cost telemetry | Coverage | v1.4.4 |
| `ijfw-nyquist-auditor.md` | sample-rate / verification coverage | Audit / verify | v1.4.4 W10-A3 |
| `ijfw-pattern-mapper.md` | codebase pattern mapper | Planning / coverage | v1.4.4 W10-A3 |
| `ijfw-plan-checker.md` | pre-execute plan audit | Planning | v1.4.4 |
| `ijfw-ralph-loop-runner.md` | ralph-loop runner (per-wave repeat protocol) | Ship / execute | v1.4.4 |
| `ijfw-release-eng.md` | release engineering / ship gate | Ship | v1.4.4 |
| `ijfw-security-auditor.md` | security review specialist | Audit / verify | v1.4.4 W10-A3 |

### Coverage gaps vs. GSD analogues (flagged honestly)
- **No `ijfw-codebase-mapper`** equivalent to GSD's `gsd-codebase-mapper` / `gsd-map-codebase` skill. `ijfw-pattern-mapper` is the closest, but its remit is "patterns in the codebase," not the comprehensive "produce .planning/codebase/ documents" workflow.
- **No `ijfw-spec-reviewer-agent`** — the spec/quality reviewers live as PROMPTS (`prompts/spec-reviewer.md`, `prompts/quality-reviewer.md`) inside the workflow skill, not as standalone agent files. This is a design choice (single-purpose prompts vs. full agent surface), but it means the reviewer is invoked by passing prompt text rather than `Agent({ subagent_type: 'ijfw-spec-reviewer' })`.
- **No `ijfw-discuss-phase` / `ijfw-spec-phase`** analogues — both live inside the ijfw-workflow skill (per Dimension 4). No separate gate agents.
- **No `ijfw-debug-session-manager`** (per Dimension 6).
- **No `ijfw-ui-review`** — `ijfw-accessibility-eng` covers a11y but not full 6-pillar visual audit GSD's `gsd-ui-review` does.
- **No `ijfw-extract-learnings`** equivalent — IJFW relies on memory writes during phases, not a post-phase extraction agent.

### Truthful gap
> The 13-agent roster covers audit/verify/ship/coverage strongly but **leaves codebase intelligence, ambiguity scoring, and structured post-phase learning extraction to either the workflow skill's inline prose or to the LLM session's discipline**. For projects already deep in IJFW idioms, this is enough; for cross-platform projects or onboarding contexts, the GSD-style dedicated agents would catch things the IJFW prose may miss.

---

## Dimension 8 — Cross-AI audit (Trident / Phase E)

### Wired
- `mcp-server/src/cross-orchestrator.js::runPhaseEAuto` (line 457):
  - Loads `.ijfw/swarm.json` for `auditors: string[]` (roster IDs).
  - Falls back to `['codex', 'gemini', 'claude']` when absent.
  - Each ID probed via `audit-roster.isReachable()`:
    - CLI present → use CLI.
    - CLI missing + `apiFallback.authEnv` set → use API fallback.
    - Neither → **skip with NOTE** (never fails the run).
  - Fans out via `fanOut(tasks, 3)` with per-auditor `timeoutForPick(pick, resolvedTimeoutSec)` — v1.5.0 S7 introduced `pick.timeoutMs` (e.g., codex review at 8 minutes vs. the 2-minute default for exec mode).
  - Classifies results: `ok | timeout | failed | aborted | fallback-used`. Only `ok` and `fallback-used` count toward verdict (`counted: true`).
- v1.5.0 S7 verdict logic (lines 510-516):
  - `productive = results.filter(r => r.counted)`.
  - If `productive.length === 0` → verdict = **`INCONCLUSIVE`** (not PASS).
  - Otherwise → `classifyVerdict(items)` returns `PASS|CONDITIONAL|FAIL`.
- Output: writes synthesis to `.planning/<phase>/CROSS-AUDIT-r<N>.md`, auto-incremented N.
- Verdict routing per SKILL.md (lines 396-401):
  - `PASS` → proceed to SHIP immediately.
  - `CONDITIONAL` → surface findings; user says `ship` or `fix <X>`.
  - `FAIL` (HIGH+ finding) → loop back to fix-wave; re-enter EXECUTE.
- User overrides: `skip cross-audit`, `force cross-audit`.

### Audit roster (`mcp-server/src/audit-roster.js`)
- 9 entries: codex, gemini, qwen, deepseek, kimi, opencode, aider, copilot, claude.
- Each has: `id, family, model, name, invoke, note, detect(env), apiFallback`.
- Several have `reviewInvoke` (codex specifically — separate path for git-ref targets because `codex review` and `codex exec` have different requirements; `mcp_servers.ijfw-memory.enabled=false` is load-bearing to prevent self-cycle hang).
- Self-detection: `detect(env)` heuristics from session env vars; falls back to filename-based detection.
- `pickAuditors({ strategy: 'diversity' })`: targets `['openai', 'google']` families, backfills from oss if family unreachable.

### v1.5.0 F5 audit-rotation schema (reserved)
- `ROTATION_SCHEMA_VERSION = 1`, `defaultRotationPolicy = 'manual'`.
- Shape declared in code comments: `{ schema, policy, window_days, min_picks_per_auditor, last_rotated }`.
- **No runtime consumer** — explicitly deferred to v1.6.0 once telemetry exists to inform policy (cost-weighted / win-rate / round-robin).

### Aspirational / partial
- **Phase E is single-round per phase.** No convergence loop ("re-audit after fix" auto-trigger). The `FAIL → loop back to fix-wave → re-enter EXECUTE` requires the user/orchestrator to re-fire Phase E manually after the fix wave. The CHANGELOG notes "Trident r14 PASS" implying r1-r14 iterations happened during v1.5.0 dev — but iteration is LLM-orchestrated, not auto-converged.
- Auditor-rotation policy is declared as a contract but not active.
- "Trident" branding implies 3 lenses; in practice 2/3 productive (codex unblocked via S7) was acceptable for the v1.5.0 release gate (per `b03f98f` commit message).

### Truthful gap
> Phase E is the **most genuinely wired** dimension of IJFW — actual code, actual telemetry, actual INCONCLUSIVE-on-zero-productive logic, actually fired during v1.5.0 ship (r14 PASS). But "iterative convergence" (re-audit after fix until no HIGH remains) is not automated — it lives in the orchestrator-LLM's discipline of re-firing `runCrossOp({ mode: 'phase-e-auto' })` after each fix wave.

---

## v1.5.0 features — partial vs. full table

| Feature | Spec (skill / docs) | Wired (runtime code) | Gap |
|---|---|---|---|
| **S1 subagent checkpoint contract** | Frozen contract, CLI, atomic FS-lock writes | `recordCheckpoint` + CLI handler wired into `extension.js` | **Worktree → parent visibility** — checkpoints write to subagent's worktree; orchestrator looks at parent's `.ijfw/wave-<id>/`. Empty results in canonical isolation mode. |
| **S3 freshness + branch-tuple commit check** | `verifyFreshCommit` with branch-contains guard | Function defined in `status-protocol.js`; tested | **No call-site** — fires only if orchestrator-LLM calls `handleStatus`. |
| **S4 AGENTS.md blackboard population** | `agents-md-blackboard.js` (per recent commits) | Module exists, tests pass (per `6 tests for BLACKBOARD population` commit) | Lazy-loaded to avoid top-level await breaking `node:test` (per `38d63f0`) — implies infrastructure friction with the host. |
| **S5 checkpointWave rollup** | Aggregates wave-level checkpoint state | Tests rolled up per `bc2267d` | **Resume logic still LLM-orchestrated.** |
| **S7 per-auditor timeoutMs** | `pick.timeoutMs` honored by `timeoutForPick` | Fully wired in `runPhaseEAuto` | None — this one is genuinely complete and load-bearing for codex review (8min vs 2min). |
| **S7 INCONCLUSIVE verdict** | `productive.length === 0` → INCONCLUSIVE | Fully wired in `runPhaseEAuto` line 516 | None. |
| **4-value status protocol (W10-A1 / v1.4.4 N2)** | `parseAgentReport` + `handleStatus` + freshness check | Defined + tested | **No call-site** — orchestrator-LLM must enforce by eye. |
| **Two-stage review (W10-A2 / v1.4.4 N3)** | `reviewTask` with injectable `dispatch` | Function defined + tested | **No call-site** — orchestrator-LLM must invoke. |
| **Verification gate (W10-A2 / v1.4.4 N5)** | `checkVerificationGate` + `recordViolation` | Functions defined + tested | **No call-site, no host capturing per-message tool calls.** Advisory by design, but advisory-of-nothing without a runtime. |
| **F5 audit-rotation schema** | `ROTATION_SCHEMA_VERSION = 1, policy = 'manual'` | Constants exported | **No runtime consumer** — deferred to v1.6.0. |
| **F6 checkpointWave helpers** | Per commit `0606294 merge(v1.5.0 W11-B1)` | Tests roll up | Same gap as S5 — telemetry exists, orchestrator does not call it. |
| **Phase E cross-audit auto-fire** | `runCrossOp({ mode: 'phase-e-auto' })` | Fully wired | Not iterative; orchestrator-LLM must re-fire after fix waves. |
| **Wave dispatch (isolation:'worktree')** | Per dispatch-helpers.md | `parsePlan` + `buildManifest` exist; mode propagated | Agent dispatch is via Claude Code `Agent({ isolation: 'worktree' })` — the JS code doesn't dispatch the agent, the LLM session does. |
| **Memory feedback v1.4.1 B10 + verification-violations.jsonl** | Pattern detector reads JSONL | Detector exists per docs | JSONL never populated because gate has no caller (see above). |

---

## Specialist roster summary (13)

| Name | Role | Group | Notes |
|---|---|---|---|
| ijfw-accessibility-eng | a11y reviewer | Audit | UI-focused |
| ijfw-dep-audit | dependency audit | Audit | CVEs, license drift |
| ijfw-doc-verifier | docs vs code drift | Audit | v1.4.4 W10-A3 |
| ijfw-doc-writer | docs author | Coverage | Single-purpose |
| ijfw-e2e-runner | smoke runner | Audit | regex relaxed in v1.5.0 W11-D1 |
| ijfw-integration-checker | cross-module integration | Audit | v1.4.4 W10-A3 |
| ijfw-llm-budget-watcher | token/cost telemetry | Coverage | session-end consumer |
| ijfw-nyquist-auditor | sample-rate verification | Audit | v1.4.4 W10-A3 |
| ijfw-pattern-mapper | codebase pattern map | Planning | v1.4.4 W10-A3 |
| ijfw-plan-checker | pre-execute plan audit | Planning | runs `ijfw plan-check` discipline |
| ijfw-ralph-loop-runner | per-wave repeat protocol | Ship/execute | knows orphan-detection (per its SKILL) |
| ijfw-release-eng | release engineering | Ship | ship-gate single pass |
| ijfw-security-auditor | security review | Audit | v1.4.4 W10-A3 |

Missing analogues vs. GSD: codebase-mapper, spec-phase, discuss-phase, debug-session-manager, ui-review (6-pillar), extract-learnings, milestone-summary.

---

## Where IJFW is empirically strong

1. **Cross-AI audit (Phase E)** — genuine end-to-end wiring; INCONCLUSIVE-on-zero-productive logic; per-auditor timeoutMs; diversity-strategy roster picker; 9-entry roster including OSS lineages (qwen, deepseek, kimi); recent r14 PASS proof.
2. **Brainstorm discipline (Quick/Deep + auto-picker)** — the workflow skill (`ijfw-workflow/SKILL.md`) is the most narratively complete artifact in the codebase. Auto-picker, memory hooks every FRAME step, one-question-at-a-time invariants, positive-framing replacement table. The DX investment is visible.
3. **Specialist + reviewer prompt architecture** — 13 named specialists + 2 reviewer prompts give the orchestrator-LLM a strong vocabulary. Even where the runtime wiring is thin, the prompt material is high-quality (spec-reviewer.md `Verdict:` contract, quality-reviewer.md severity-tagged findings, 4-dimension correctness/security/conventions/tests review).

## Where IJFW is empirically weak

1. **Orchestrator-as-LLM-session pattern** — most v1.4.4 N-series and v1.5.0 S-series features are JS modules with tests but no production caller in the JS codebase. They depend on a Claude session running ijfw-workflow to read the skill, import the function (mentally), and call it. Drift-prone.
2. **Worktree isolation breaks checkpoint visibility** — the load-bearing v1.5.0 fix (S1, sized to close 62% truncation rate) silently doesn't help in the canonical dispatch mode. v1.6.0 must address this.
3. **No spec/discuss gate separate from brainstorm** — `brief.md` carries spec role but with conversation rigor, not ambiguity scoring. High-stakes phases lose the formal gate GSD's spec-phase enforces.
4. **Verification gate is record-only with no recorder** — the advisory pattern only teaches if violations are recorded, which only happens if the gate fires, which depends on a host that doesn't exist.

---

## Methodology notes

- Source: fresh worktree at `worktree-agent-aa036601918551f0a`, branched from `c45cb2c` (v1.5.0 ship).
- "Wired" = `grep -rn "<symbol>" mcp-server/src/ claude/` returns a non-test JS call-site that is not the definition.
- "Aspirational" = symbol exists in source + tests + markdown but has no non-test runtime caller.
- The audit does not claim the aspirational features are useless — many are precisely the right design for an LLM-orchestrated workflow. It claims that **the gap between "this is documented" and "the host will catch your mistake" matters for cross-system comparison**.
- The 13-specialist count matches the v1.5.0 ship state (5 v1.4.4 + 8 v1.5.0 per the orienting prompt; physical file count is 13).
