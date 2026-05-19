# POST-BRAINSTORM WORKFLOW

After LOCK, the brief drives every downstream phase. Same discipline, same memory hooks, same positive framing.

## PLAN (after LOCK)

- Memory hook: recall past similar plans.
- Assistant drafts `.ijfw/memory/plan.md` (max 15 tasks for Quick, 30 for Deep).
- Each task: what / how-to-verify / file paths.
- User reviews. One-word commit: `approve` / `trim` / `expand`.

**Design auto-fire** -- if plan mentions UI, dashboard, component, page, layout, CSS, styles, content layout, brand system, document design, diagram, presentation, marketing surface, or another visual artifact:
- Deep mode: dispatch `ijfw-design` automatically before writing tasks. Log observation via `bash scripts/design-pass.sh`.
- Quick mode: offer `I'll run a design pass first. Say "show me" to open it, or "skip" to continue.` Wait for the user's next turn before starting visual companion work.
- Use `ijfw design init` when no `DESIGN.md` exists or the existing contract is stale.
- Use `ijfw design plan` before implementation tasks so the plan has durable visual scope, constraints, and success criteria.
- Use `ijfw design audit` or `ijfw design critique` at LOCK or before EXECUTE when visual quality, accessibility, brand fit, hierarchy, or audience fit carries risk.
- Use `ijfw design polish`, `ijfw design normalize`, `ijfw design bolder`, or `ijfw design quieter` during refinement, depending on whether the artifact needs quality pass, drift correction, stronger expression, or restraint.
- Use `ijfw design handoff` before VERIFY/SHIP when visual decisions need to survive context loss or platform handoff.
- Live companion commands (`ijfw design start/open/status/stop/push/clear`) are transient preview. `DESIGN.md` plus the durable design commands are the design memory.
- On completion: write `.ijfw/design-pass.json` sentinel for preflight gate.

**Plan audit** -- run `ijfw plan-check` or follow inline checklist, not silent:
- Every task has a verify step.
- No unstated assumptions.
- Scope matches brief (nothing new).
- Destructive ops flagged.
- User confirms before EXECUTE.

## EXECUTE

<!-- IJFW-A1-DISPATCH-START -->
### Wave Dispatch

Wave dispatch resolves each sub-wave's isolation mode via `dispatch-planner.js`.
Full contract: `claude/skills/ijfw-workflow/lib/dispatch-helpers.md`.

**Dispatch steps (inside Execute, before agent launch):**
1. Parse `.ijfw/memory/plan.md` with `parsePlan()` + `buildManifest()`.
2. For each sub-wave: `mode === 'worktree'` → `Agent({ isolation: 'worktree' })`, else no isolation flag.
3. Branch naming: `wave/<wave-id>/<sub-id>` (e.g. `wave/W10-A1/dispatch`).
4. Worktree agents: brief them to run `cd mcp-server && npm install --no-audit --no-fund` first.

**Every implementer prompt must end with this exact block (orchestrator parses it):**
```
Status: DONE
Branch: wave/<wave-id>/<sub-id>
Commit: <full SHA>
Tests: <N> pass / <M> fail
```

**handleStatus action table** (from `orchestrator/status-protocol.js`):

| Status reported | handleStatus action | Next step |
|---|---|---|
| `DONE` | `proceed_to_review` | Hand commit_sha to W10-A2 review |
| `DONE` (stale commit) | `redispatch_needs_context` | Re-prompt with `missing: commit-before-report` |
| `DONE_WITH_CONCERNS` | `proceed_with_flag` | Proceed to review; surface `Concerns:` to user |
| `NEEDS_CONTEXT` | `redispatch_with_context` | Re-prompt agent; append `Missing:` field to context |
| `BLOCKED` | `escalate_to_user` | Surface `Reason:` + `Tried:` to user; halt wave |

Alternative status strings (append below the standard block as needed):
`DONE_WITH_CONCERNS` + `Concerns:`; `NEEDS_CONTEXT` + `Missing:`; `BLOCKED` + `Reason:` + `Tried:`.
No other status strings are valid.

**Deviation rules + 3-attempt cap (v1.5.0-major S07):** dispatched implementer subagents follow `claude/agents/ijfw-executor.md`'s deviation taxonomy (Rules 1-3 auto-fix bugs / missing critical things / blockers; Rule 4 STOPs on architectural change) + a per-issue 3-attempt fix cap. The orchestrator-LLM should brief implementers using ijfw-executor's PROCESS + DEVIATION RULES sections. After-DONE, an `Attempts: N` line in the Status block is parsed by `ijfw_subagent_post_done` MCP tool — N≥3 routes to `escalate_to_user` with `reason: '3-attempt-cap-hit'` regardless of reported status. The field is opt-in: reports without an `Attempts:` line default to 0 and behave exactly as before.
<!-- IJFW-A1-DISPATCH-END -->

**Phase banner** -- emit at every phase transition (Brainstorm, Plan, Execute, Verify, Ship):
```
IJFW > BRAINSTORM (Quick mode, step 2 of 5)
IJFW > PLAN (Deep mode, module 3 of 6)
IJFW > EXECUTE (Wave 2 of 4)
```

**Team announcement** -- at plan→execute transition, emit before dispatching agents:
```
Assembling team: [Opus] Architect, 2x [Sonnet] Builders, [Haiku] Scout
Dispatching Wave 1...
```

**Swarm preparation (Deep mode or 2+ parallel agents):**
- Before using swarm commands, run `ijfw recover status` to surface any existing checkpoint and `ijfw blackboard init` when the project has no blackboard yet.
- If no team exists, run `ijfw team init` first. Use `--archetype <type>` when the project type is known.
- In Codex-heavy projects, run `ijfw codex doctor` after team setup to confirm plugin metadata, hooks, MCP config, skills, AGENTS.md memory, and custom-agent surfaces are ready.
- Run `ijfw codex sync-agents` when `.codex/agents/*.toml` needs to be regenerated from the current Team Assembly charter.
- Run `ijfw swarm plan` to explain artifact owners, parallel/review/blocked waves, and verification.
- Run `ijfw swarm prepare` before dispatch, or `ijfw swarm prepare --reviews` when review tasks should be queued immediately. This writes `.ijfw/blackboard/tasks.json`.
- Run `ijfw swarm tasks` to list prepared task IDs. Tasks may represent code, design, research, writing, business artifacts, or other project work.
- Run `ijfw swarm status` and surface ready/blocked counts before assigning agents.
- Dispatch only tasks marked `ready`. For each dispatched task, run `ijfw swarm start <task-id>` before work begins.
- Generate a scoped dispatch brief before spawning a worker: `ijfw swarm prompt <task-id>`, or `ijfw swarm prompt <task-id> --codex` when the worker is a Codex subagent. Paste the generated prompt into the worker so artifact scope, allowed paths, dependencies, blackboard commands, verification, and non-revert rules travel with the task.
- Codex runtime caveat: some tool-backed Codex sessions expose only a generic `spawn_agent` interface, without direct named custom-agent invocation. IJFW still generates `.codex/agents/*.toml`; when named agents are not callable, paste the `ijfw swarm prompt <task-id> --codex` output into the built-in worker or explorer agent.
- On completion, run `ijfw swarm complete <task-id>`. If a task is blocked, run `ijfw swarm block <task-id> --message <why>` and escalate the blocker through claims, scope adjustment, or user decision.
- At each transition, create a durable safety point with `ijfw memory checkpoint <label>`. Use labels like `after-team-init`, `after-swarm-prepare`, `after-wave-1`, `before-worktree-integrate`, and `before-ship`.
- If context is lost, run `ijfw recover status` first, then `ijfw recover latest` for the last checkpoint body.

- **Conservative worktree support (code-heavy tasks only by default):**
  - Worktrees are optional execution isolation, not the coordination model. Use blackboard claims for writing, design, research, business, strategy, and other non-code artifacts.
  - Create a task worktree only after `ijfw swarm start <task-id>` has succeeded: `ijfw swarm worktree create <task-id>`.
  - Inspect active task worktrees with `ijfw swarm worktree list` before assigning or integrating parallel code work.
  - Before integration, run task verification in the worktree and create `ijfw memory checkpoint before-worktree-integrate`.
  - Integrate one completed task at a time with `ijfw swarm worktree integrate <task-id>`, then run wave-level verification in the main worktree.
  - Clean up only successful, verified integrations with `ijfw swarm worktree cleanup <task-id>`.
  - Preserve failed or blocked worktrees for inspection. Do not clean them up automatically.
  - Never auto-resolve merge conflicts. On any conflict, stop, record `ijfw swarm block <task-id> --message <why>`, and escalate to the user or lead agent.

- Dispatch per workflow manifest and blackboard task records.
- Use blackboard claims before parallel artifact edits: `ijfw blackboard claim --artifact <id> --owner <agent> --paths <globs>`.
- When the platform has a native task tracker, create one visible task per prepared blackboard task and keep it synchronized with `start` / `complete` / `block`.
- Mid-step pings for operations > 30s: `<agent> in progress (~<estimate>).`
- After each task: task micro-audit (6 points).
- Post-wave: update blackboard tasks/findings/blockers. Integrate worktrees only when worktrees were used. Conflicts halt + escalate without auto-resolution.
- **No auto-advance to VERIFY.** User confirms all tasks done.

**Task micro-audit** -- one line per task:
- Criteria met, scope clean, tests pass, no new assumptions.

<!-- IJFW-A2-REVIEW-START -->
**Post-DONE pipeline (v1.5.0-major S02 — MANDATORY MCP tool call, NOT advisory text):**

After every subagent finishes (any `Status:` value), the orchestrator MUST call the `ijfw_subagent_post_done` MCP tool with `reportText` + `dispatchTimestamp` (Unix seconds at dispatch) + `branch`. The tool returns `{routeDecision, postDone}`. Act on `routeDecision.action`:

- `proceed_to_review` → tool already ran two-stage review + verification-gate scan. Inspect `postDone.verdict`. If approved, mark task complete in blackboard. If findings, re-dispatch implementer (max `REVIEW_MAX_ITERATIONS = 3`).
- `redispatch_needs_context` → re-dispatch with `routeDecision.missing` as added context.
- `redispatch_with_context` → re-dispatch with `routeDecision.missing` as the NEEDS_CONTEXT field.
- `escalate_to_user` → surface to human with `routeDecision.reason` + `routeDecision.tried`.
- `proceed_with_flag` → mark complete; note `routeDecision.concerns` in wave SUMMARY.

This is wired runtime contract, NOT honor-system markdown. Behind the tool: `runtime-loop.js::reviewSubagentReport` + `post-done-runner.js::runPostDone`. Combined into one MCP tool to stay under the ≤10-tool cap. The two-stage review (spec-reviewer.md then quality-reviewer.md) + verification-gate scan are now invoked automatically; skipping the tool call silently no-ops these v1.4.4 N3 + N5 features.

Reviewer subagents are SEPARATE from the implementer (no self-review). Both use `isolation: 'none'` (read-only on the implementer's branch).
<!-- IJFW-A2-REVIEW-END -->

<!-- IJFW-A3-SPECIALISTS-START -->
<!-- Wave 10 v1.4.4 W10-A3: specialist roster awareness — 5 new ijfw-* agents (doc-verifier, pattern-mapper, security-auditor, integration-checker, nyquist-auditor). Reserved for any workflow-side hook the agent owner judges necessary; primary edits land in ijfw-agents-md SKILL.md + claude/agents/*. Insert here only if needed. -->
<!-- IJFW-A3-SPECIALISTS-END -->

**Phase audit** -- at wave/milestone boundaries:
- Brief still accurate? Speed respectful? Security invisible? Memory updated?

### LIVE VISUAL COMPANION (UI/design projects, opt-in)

For visual software work -- HTML, app UI, dashboards, interfaces, landing
pages, components, design systems -- offer a live preview before SHAPE:
`This is visual. Want me to open a live preview while we brainstorm?`

`yes` runs `ijfw design start`, writes/pushes real HTML mockups with
`ijfw design push <file.html> [more.html ...]`, and keeps `http://localhost:<port>/design`
open while options evolve. Use this for brainstorm variants, design choices,
and implementation review. Durable visual identity still belongs in `DESIGN.md`;
the live companion is the fast feedback loop.

For architecture-only visuals, use Mermaid in `.ijfw/visual/<phase>.md`.
Skip visual companion for non-visual work where the brief and plan carry enough
structure.

## VERIFY

- Audit the result against the **brief**, not the plan. (Tasks can pass while brief goals miss.)
- Functional + UX + Security + Quality checklists.
- Optional Trident cross-audit on the diff: `ijfw cross audit <diff>`.
- User confirms: `verified` / `gap: <X>` / `ship it`.

<!-- IJFW-B1-PHASE-E-START -->
## Cross-Audit Phase (Phase E — auto-fired after VERIFY, before SHIP)

After VERIFY completes and the user confirms, the orchestrator **automatically**
fires a Trident cross-audit before any ship action.

### How it fires

```js
const result = await runCrossOp({
  mode: 'phase-e-auto',
  target: '<current-phase>',   // e.g. 'v1.4.4' or wave label
  projectDir,
});
// result: { verdict: 'PASS'|'CONDITIONAL'|'FAIL', findings: [...], outputPath }
```

### Auditor selection

1. Reads `.ijfw/swarm.json` for `auditors: string[]` (roster IDs).
2. Falls back to `['codex', 'gemini', 'claude']` when the field is absent.
3. Each ID is probed via `audit-roster.isReachable()`:
   - CLI present → use CLI.
   - CLI missing + `apiFallback` key set in env → use API fallback.
   - CLI missing + no `apiFallback` → **skip with NOTE** (never fails the run).

### Output

Writes synthesis to `.planning/<phase>/CROSS-AUDIT-r<N>.md` where N is
auto-incremented from existing files in that directory.

### Verdict routing

| Verdict | Action |
|---|---|
| `PASS` | Proceed to SHIP immediately. |
| `CONDITIONAL` | Surface findings to user; user says `ship` or `fix <X>`. |
| `FAIL` (HIGH+ finding) | Loop back to fix-wave; re-enter EXECUTE with findings as brief addendum. |

### User overrides

- `skip cross-audit` at VERIFY — bypasses Phase E (recorded in memory).
- `force cross-audit` at any step — fires Phase E immediately.
<!-- IJFW-B1-PHASE-E-END -->

## SHIP

- Atomic commit with the brief's one-liner as the title, only after explicit user approval to commit.
- Optional Trident final critique: `ijfw cross critique HEAD~1..HEAD` (background).
- Before any tag, release, deploy, or publish action, read AGENTS.md/CLAUDE.md memory for release cautions and require explicit user approval.
- Tag / release notes / CHANGELOG entry only when this is a public ship and the release gate is clear.
- Memory write: decision + pattern + learning.
- Announcement copy -- user owns the channels, IJFW provides talking points.

**Ship gate** -- single pass:
- Diff matches brief. Tests green. Changelog updated. Memory stored. Trident receipt logged.
