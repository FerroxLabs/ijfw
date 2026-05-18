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
