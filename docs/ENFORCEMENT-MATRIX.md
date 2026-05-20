# IJFW v1.5.0 — Per-Platform Enforcement Matrix

**Task:** T16 — G3: per-platform enforcement matrix + accuracy check
**Status:** LOCKED — 2026-05-20. Downstream tasks T17, T18 bind to this.
**Source of truth:** `.planning/v150-gap-closure/STATE-SDK-CONTRACT.md` §4/§6/§7
and `.ijfw/memory/brief.md` §G3.

---

## 1. Enforcement model — definitions

**Structural enforcement** — state advances only through the `ijfw_state` MCP tool
(`mcp-server/src/server.js:1078`) or the `ijfw state:<verb>` CLI colon-namespace
(`mcp-server/src/dispatch/colon-syntax.js`). Both funnel through the same
`query(verb, payload, ctx)` core (`mcp-server/src/orchestrator/state-sdk.js`).
Gate-driven verbs (`phase.complete`, `phase.plan-check`, `subagent.post-done`,
`wave.advance` with hard gate) run their precondition check BEFORE the lock is
acquired; a verdict-fail returns `{ ok:false, refused:true }` and mutates nothing.
The verb literally cannot advance state with a red gate — refusal is by construction.

**Best-effort enforcement** — the platform's LLM can write state files directly
(e.g. `writeFile` on `workflow.json`, `AGENTS.md`) without passing through the
SDK. Gate logic is not structurally on the critical path. Enforcement relies on
prompt discipline and IJFW skill instructions, not on an interposed code layer.

**Second-tier hook** — some structural-enforcement platforms also have a
platform-native pre-tool-use hook script that fires BEFORE any MCP tool call.
This adds a defence-in-depth layer (e.g. extension permission check, destructive
command warning) but does NOT change the structural/best-effort classification —
that is determined solely by whether the SDK/MCP gate is on the critical path.

---

## 2. Per-platform enforcement matrix

| Platform | Enforcement type | Mechanism (file path / verb) | Notes |
|---|---|---|---|
| **Claude Code** | Structural + hook | `mcp-server/src/server.js` (`ijfw_state` tool, `gatePermissionAndQuota`) · `mcp-server/src/orchestrator/state-sdk.js` (`VERBS` registry, gate preconditions) · `claude/hooks/scripts/pre-tool-use.sh` (destructive-command scan) · `claude/hooks/scripts/pre-tool-use-extension-check.sh` (extension permission check) · `claude/hooks/scripts/session-end.sh` (Stop hook — session metrics) | Hook lifecycle: PreToolUse + Stop. MCP gate is structural; hooks add a second tier. Gate-driven verbs (`phase.complete`, `phase.plan-check`, `subagent.post-done`) enforce via `verification-gate.js`, `plan-checker.js`, `post-done-runner.js` inside `state-sdk.js`. |
| **Codex CLI** | Structural + hook | `mcp-server/src/server.js` (`ijfw_state` tool) · `mcp-server/src/orchestrator/state-sdk.js` · `codex/.codex/hooks/scripts/pre-tool-use-extension-check.sh` (extension permission check) | Hook lifecycle: PreToolUse only (no Stop hook in Codex). MCP gate is structural; extension-check hook fires in parallel. |
| **Hermes CLI** | Structural + hook | `mcp-server/src/server.js` (`ijfw_state` tool) · `mcp-server/src/orchestrator/state-sdk.js` · `hermes/plugins/ijfw/hooks/pre_tool_use_extension_check.py` (Python extension permission check) | Hook lifecycle: PreToolUse Python plugin. MCP gate is structural; hook adds second tier. |
| **Wayland CLI** | Structural + hook | `mcp-server/src/server.js` (`ijfw_state` tool) · `mcp-server/src/orchestrator/state-sdk.js` · `wayland/plugins/ijfw/hooks/pre_tool_use_extension_check.py` (Python extension permission check) | Hook lifecycle: PreToolUse Python plugin. MCP gate is structural; hook adds second tier. |
| **Gemini CLI** | Structural (MCP only) | `mcp-server/src/server.js` (`ijfw_state` tool, `gatePermissionAndQuota` via `runtime-mediator.js`) · `mcp-server/src/orchestrator/state-sdk.js` · `gemini/.gemini/settings.json` (MCP server registration) | No native pre-tool hook lifecycle. `runtime-mediator.js` is the single tier-2 enforcement point (per module comment §"Cross-platform enforcement boundary"). Gate is structural at the MCP layer. |
| **Cursor** | Structural (MCP only) | `mcp-server/src/server.js` (`ijfw_state` tool, `runtime-mediator.js`) · `mcp-server/src/orchestrator/state-sdk.js` · `cursor/.cursor/mcp.json` (MCP server registration) | No native pre-tool hook lifecycle. `runtime-mediator.js` is the sole enforcement path. Gate is structural at the MCP layer. |
| **Windsurf** | Structural (MCP only) | `mcp-server/src/server.js` (`ijfw_state` tool, `runtime-mediator.js`) · `mcp-server/src/orchestrator/state-sdk.js` · `windsurf/mcp_config.json` (MCP server registration) | No native pre-tool hook lifecycle. `runtime-mediator.js` is the sole enforcement path. Gate is structural at the MCP layer. |
| **Copilot (VS Code)** | Structural (MCP only) | `mcp-server/src/server.js` (`ijfw_state` tool, `runtime-mediator.js`) · `mcp-server/src/orchestrator/state-sdk.js` · `copilot/.vscode/mcp.json` (MCP server registration) | No native pre-tool hook lifecycle. MCP tool is the enforcement path. `copilot/copilot-instructions.md` carries prompt-level rules as a complement, not a replacement. |
| **Universal** | Best-effort | `universal/ijfw-rules.md` (15-line paste-anywhere rules) | No MCP registration; no hook lifecycle. The rules file is pasted into any agent's system prompt. The LLM can write state files directly — SDK is not on the critical path. Ceiling is prompt discipline only. |

**Tally:** 8 structural platforms (4 with second-tier hook, 4 MCP-only) · 1 best-effort platform.

---

## 3. W3 boundary set — verification gate firing points

W3 (verification scope) requires that the gate fires at every **enumerated
boundary**. The boundaries are the state-advancing verbs that carry a gate
precondition (contract §4, §6):

| Boundary verb | Gate function | Gate kind | Fires on | Structural on… |
|---|---|---|---|---|
| `phase.complete` | `enforceVerificationGate` (`mcp-server/src/orchestrator/verification-gate.js`) | Verdict-fail → REFUSE; execution-fail → advisory | Phase completion — the primary post-phase gate | All 8 structural platforms |
| `phase.plan-check` | `validatePlan` (`mcp-server/src/orchestrator/plan-checker.js`) | HIGH finding → verdict-fail → REFUSE (W1 hard-BLOCK); execution-fail → advisory | Pre-execute plan validation | All 8 structural platforms |
| `subagent.post-done` | `runSelfCheck` / `runPostDone` (`mcp-server/src/orchestrator/post-done-runner.js`) | Failed self-check → verdict-fail → REFUSE; execution-fail → advisory | Subagent completion report | All 8 structural platforms |
| `wave.advance` (hard gate) | Checkpoint-completeness check (inline in `state-sdk.js`) | Advisory by default; verdict-fail only when wave declares a hard gate | Mid-wave progress gate | All 8 structural platforms |

**Per-platform W3 structural vs best-effort:**
- Structural (all four boundaries enforced): Claude Code, Codex, Hermes, Wayland, Gemini, Cursor, Windsurf, Copilot
- Best-effort (boundaries exist in rules text, not in code path): Universal

**Non-subagent boundary note:** `phase.complete` and `phase.plan-check` are
non-subagent boundaries (fired by the orchestrator/parent, not by a subagent
task). `subagent.post-done` is the post-done boundary. `wave.advance` with a
hard gate is the mid-wave boundary. These three categories cover the brief's
enumerated set: mid-wave, non-subagent, post-done.

---

## 4. Residual ceiling — honest disclosure

The **structural enforcement ceiling** is Universal. On that platform:

- The LLM receives the IJFW rules file (`universal/ijfw-rules.md`) as injected
  context but has no MCP server, no hook lifecycle, and no `ijfw_state` tool in
  scope.
- A model executing on Universal CAN write `workflow.json`, `AGENTS.md`, or any
  other state file directly using its file-write tools, bypassing the SDK
  entirely.
- Gate preconditions (`enforceVerificationGate`, `validatePlan`, `runSelfCheck`)
  are NOT on the critical path — they are referenced in the rules text only.
- This is the documented ceiling: **one platform (Universal) is best-effort**.
  It is disclosed, not hidden.

**For all 8 structural platforms**, the ceiling is the `IJFW_STATE_GATE_BYPASS=1`
env escape hatch (contract §4, MCP-unavailable case). When set, gate-driven verbs
proceed without running the precondition and record an advisory event. This is an
intentional design choice — enforcement is a floor, never a single point of failure.
The bypass is an operational escape hatch, not a product-level gap.

---

## 5. Mechanism file index (for test-enforcement-matrix.js)

The test parses this section to validate that every listed file path exists on
disk and every listed verb exists in the `VERBS` registry. Lines beginning with
`PATH:` are file paths (relative to repo root). Lines beginning with `VERB:` are
verb names.

```
PATH: mcp-server/src/server.js
PATH: mcp-server/src/orchestrator/state-sdk.js
PATH: mcp-server/src/orchestrator/verification-gate.js
PATH: mcp-server/src/orchestrator/plan-checker.js
PATH: mcp-server/src/orchestrator/post-done-runner.js
PATH: mcp-server/src/runtime-mediator.js
PATH: mcp-server/src/dispatch/colon-syntax.js
PATH: claude/hooks/scripts/pre-tool-use.sh
PATH: claude/hooks/scripts/pre-tool-use-extension-check.sh
PATH: claude/hooks/scripts/session-end.sh
PATH: codex/.codex/hooks/scripts/pre-tool-use-extension-check.sh
PATH: hermes/plugins/ijfw/hooks/pre_tool_use_extension_check.py
PATH: wayland/plugins/ijfw/hooks/pre_tool_use_extension_check.py
PATH: gemini/.gemini/settings.json
PATH: cursor/.cursor/mcp.json
PATH: windsurf/mcp_config.json
PATH: copilot/.vscode/mcp.json
PATH: universal/ijfw-rules.md
VERB: phase.complete
VERB: phase.plan-check
VERB: subagent.post-done
VERB: wave.advance
VERB: workflow.get
VERB: workflow.set-phase
VERB: wave.get
VERB: wave.record-task
VERB: subagent.dispatch
VERB: subagent.checkpoint
VERB: event.emit
VERB: telemetry.record
VERB: roster.synthesize
VERB: roster.record
VERB: extension.set-active
VERB: decision.add
VERB: blocker.add
VERB: blocker.resolve
VERB: state.replay
VERB: state.validate
```
