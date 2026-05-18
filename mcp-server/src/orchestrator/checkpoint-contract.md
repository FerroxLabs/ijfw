# Subagent Checkpoint Contract — v1.5.0 S1

**Status:** Frozen. Wave 11-A1 wire-up.

## Why this exists

Across IJFW v1.4.4 Wave 10 + v1.5.0 research dispatch, **8 of 13 subagents (62%) truncated mid-flow** at the Claude Code harness cap (~20 tool uses or ~60s wall, whichever first). Truncation manifested as silent stop without a Status: report — orchestrator had to read partial worktree state and finish by hand. The checkpoint contract closes this gap by giving the orchestrator a structured record of "what the agent was doing when it died" so it can resume from the last known good state instead of redispatching from scratch.

## The CLI

```bash
ijfw checkpoint <waveId> <subId> <jsonPayload>
```

- `<waveId>` and `<subId>` MUST match `[A-Za-z0-9_-]{1,64}` (no path traversal).
- `<jsonPayload>` is a JSON object string. Wrapping fields (`schema_version`, `wave_id`, `sub_id`, `ts`) are added by the CLI; do not include them yourself.
- The CLI atomically writes via `withFsLock` to `.ijfw/wave-<waveId>/subagent-<subId>.checkpoint.json`. Concurrent calls from the same subId serialise.

## What to put in the payload

Recommended fields (free-form — the schema accepts arbitrary keys, but these are what the orchestrator looks for on resume):

| Field | Type | Purpose |
|---|---|---|
| `tool_use_count` | integer | How many tool calls the agent has made. Helps the orchestrator estimate cap proximity. |
| `last_action` | string ≤200 chars | Human-readable description of what the agent just finished. |
| `files_created` | string[] | Paths the agent has created so far (relative to project root). |
| `files_modified` | string[] | Paths the agent has modified so far. |
| `commits_made` | string[] | SHA list of commits the agent has landed. |
| `next_step` | string ≤200 chars | What the agent intends to do next. **The orchestrator's resume protocol picks up here.** |
| `blockers` | string (optional) | Set only if the agent paused due to ambiguity or environment issue. Triggers `NEEDS_CONTEXT` handling. |

## Cadence

**Checkpoint every substantive tool use OR every 30 seconds, whichever first.** Do not checkpoint after pure read-only tool calls — that just burns your tool budget. Examples of "substantive":

- After a Write that produced a non-trivial file.
- After an Edit that changed code semantics.
- After a Bash that ran tests, built artifacts, or made commits.
- After a substantive piece of analysis you don't want to repeat.

Examples of "not substantive" (skip the checkpoint):

- Read of a small file you already had context for.
- Glob/Grep that returned nothing surprising.

## Size cap

Serialised payload (after the CLI adds wrapping fields) must be ≤ **4 KB**. The CLI rejects larger payloads with a clear error. Keep `last_action` and `next_step` under 200 chars each; trim file lists if they grow past ~20 entries.

## How orchestrator detects + resumes truncation

1. After the agent returns, the orchestrator inspects its message for a `Status: <VALUE>` line per the v1.4.4 status protocol.
2. If no Status line, the orchestrator treats the agent as truncated.
3. It calls `listOrphanedSubagents(waveId, projectRoot)` to find subagents with a checkpoint file but no completion marker in STATE.md.
4. For each orphan, it calls `readLastCheckpoint(waveId, subId, projectRoot)`.
5. It re-dispatches the subagent with a prepended context block:

   ```
   PRIOR CHECKPOINT (from your last truncated run):
   - Tool uses: <tool_use_count>
   - Last action: <last_action>
   - Files created: <files_created>
   - Files modified: <files_modified>
   - Commits made: <commits_made>
   - Intended next step: <next_step>
   - Blockers (if any): <blockers>

   RESUME FROM `next_step`. Do NOT restart from scratch. Re-verify your prior commits are intact, then continue.
   ```

6. The resumed agent verifies its prior commits + continues. The orchestrator confirms by checking that the next commit touches files in the checkpoint's modified list (or the agent must explain divergence in the commit message).

## Backward compatibility

Subagents that don't call `ijfw checkpoint` still work — they just have the same truncation-recovery cost as v1.4.4 (orchestrator-side hand-finishing). The contract is opt-in for the implementer; opt-in for the orchestrator's resume protocol.

## Real-world evidence

| Dispatch | Cap hit at | Outcome |
|---|---|---|
| v1.4.4 W10-A2 | 19 tool uses / 3:00 | Orchestrator finished in-place |
| v1.4.4 W10-A3 | 28 / 3:30 | Orchestrator finished in-place |
| v1.4.4 W10-B2 | 10 / 0:42 | Orchestrator finished in-place |
| v1.5.0 R1 (research) | 25 / 43s | Lost work — no commit |
| v1.5.0 R2-first | 33 / 587s | Lost work — empty branch |
| v1.5.0 R4-first | 55 / 167s | Lost work — partial file recovered |
| v1.5.0 R1-redo | 19 / 58s | Lost work — even with anti-truncation prompt |
| v1.5.0 R4-redo | 17 / 49s | Lost work — even with anti-truncation prompt |
| v1.5.0 W11-A0 | 14 / 69s | Files written but commit failed |
| v1.5.0 W11-A1 | 14 / 80s | First commit landed, last two lost |

**8 of 13 dispatches = 62% truncation rate.** v1.5.0 S1 is the load-bearing fix for this class of failure.

## Worktree isolation drain protocol — v1.5.0-major S01

The v1.5.0 S1 checkpoint contract above assumes the subagent's `projectRoot` matches the orchestrator's `projectRoot`. That assumption **does not hold** for canonical dispatch in `isolation: 'worktree'` mode: the Claude Code harness spawns the subagent with `cwd` set to a disposable worktree (e.g. `.claude/worktrees/agent-<id>/`), so `process.cwd()` resolves to the worktree — not the parent project. Checkpoints written under the worktree's `.ijfw/` directory vanish the moment `git worktree remove` runs, taking truncation forensics with them.

**This was R3's #1 honest finding for v1.5.0:** without the fix below, S1 is shelfware in the canonical dispatch mode where it matters most.

### How the fix works

Two complementary mechanisms:

1. **Env-var passthrough (primary).** When the orchestrator/dispatcher spawns a worktree subagent, it MUST set:

   ```
   IJFW_PARENT_PROJECT_ROOT=<absolute path to the parent projectRoot>
   ```

   `orchestrator/subagent-telemetry.js` (`recordCheckpoint`, `readLastCheckpoint`, `listOrphanedSubagents`) and `dispatch/checkpoint-cli.js` consult this env var first and fall back to the passed `projectRoot` when absent. Net effect: a worktree subagent's `ijfw checkpoint` write lands in the **parent** project's `.ijfw/wave-<id>/` directory automatically — visible to the orchestrator before and after worktree cleanup, no drain step required.

   The `ijfw checkpoint` CLI also logs the resolved root to stderr (`ijfw checkpoint: writing to <root>/.ijfw/wave-<id>/`) so operators can see at a glance whether the env var was honored.

2. **Belt-and-suspenders drain (fallback).** When the dispatcher cannot set env vars (older Claude Code harness builds, manual `claude` invocation inside a worktree, third-party orchestrators), the subagent's checkpoint still lands in the worktree's `.ijfw/`. To prevent loss, the orchestrator MUST run the drain CLI **BEFORE** `git worktree remove`:

   ```
   ijfw worktree-drain <waveId> <worktreePath>
   ```

   This copies every `<worktreePath>/.ijfw/wave-<waveId>/subagent-*.checkpoint.json` into the parent's `.ijfw/wave-<waveId>/`. Idempotent (safe to re-run). Returns `{ok:true, drained: N}` (or `{ok:true, drained: 0}` if the worktree has no checkpoints).

### Orchestrator scanning across active worktrees

`listOrphanedSubagents(waveId, projectRoot, additionalRoots)` accepts an optional `additionalRoots: string[]` argument — pass the list of active worktree paths (typically from `git worktree list --porcelain`) so the orchestrator sees in-flight checkpoints from worktree subagents that have NOT yet drained. Returned subId list is deduplicated across all scanned roots.

### Backward compatibility

- **Subagents without the env var set** continue to write to the passed `projectRoot` (which for legacy non-worktree dispatch is already correct).
- **Subagents in a worktree without the env var set** write to the worktree's own `.ijfw/` — the orchestrator's `ijfw worktree-drain` pre-cleanup step recovers them.
- **`listOrphanedSubagents` called without `additionalRoots`** preserves v1.5.0-S1 behavior (single-root scan).

### Why both mechanisms

Env passthrough is the right primary because it makes checkpoints visible **continuously**, not just at cleanup time (matters for live `wave-status` queries and mid-flight resume). The drain step exists because env passthrough requires harness cooperation that may not exist in every dispatch path; the drain ensures checkpoints survive even when the env var doesn't propagate.

### Wiring status

- `subagent-telemetry.js`, `checkpoint-cli.js`, `wave-cli.js` (`worktree-drain`) — wired in v1.5.0 W12-A0 S01.
- Dispatcher env passthrough — **TODO marker** in `dispatch/extension.js`; depends on Claude Code harness exposing an env-passthrough hook on `Agent({ isolation: 'worktree' })` spawn. Until that lands, orchestrators MUST rely on the drain step.
