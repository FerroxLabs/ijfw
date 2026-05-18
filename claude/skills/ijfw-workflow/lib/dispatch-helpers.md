# Wave Dispatch Contract

Reference for orchestrators and implementer prompts. Covers isolation wiring,
branch naming, the 4-value status protocol, and post-DONE handoff.

---

## Dispatch order

1. Read `.ijfw/memory/plan.md`.
2. Parse with `parsePlan()` from `mcp-server/src/dispatch-planner.js` →
   `[{ wave, sub, files, mode: 'shared'|'worktree' }]`.
3. For each sub-wave in the current wave, dispatch:

```js
import { parsePlan, buildManifest } from '../mcp-server/src/dispatch-planner.js';

const subwaves = parsePlan(planMarkdown);
const manifest = buildManifest(subwaves);

for (const entry of manifest.filter(e => e.wave === currentWave)) {
  Agent({
    prompt: buildImplementerPrompt(entry),
    isolation: entry.mode === 'worktree' ? 'worktree' : undefined,
  });
}
```

Back-compat: plans without `### Wave` headers fall through — treat as single
shared-tree mode (v1.4.3 behavior).

---

## Branch naming

Every implementer agent commits to a branch named:

```
wave/<wave-id>/<sub-id>
```

Examples: `wave/W10-A1/dispatch`, `wave/W10-A2/review`, `wave/W12-B3/mcp`.

---

## Worktree npm install caveat

Agents dispatched with `isolation:'worktree'` start in a fresh worktree where
`node_modules` may not exist. Brief every implementer prompt with:

```
cd mcp-server && npm install --no-audit --no-fund
```

Run this before any `node --test` invocation.

---

## 4-value status contract

Every implementer prompt **must** require the agent to end its final message
with exactly these lines (orchestrator parses them):

```
Status: DONE
Branch: wave/<wave-id>/<sub-id>
Commit: <full SHA>
Tests: <N> pass / <M> fail
```

Valid `Status:` values:

| Value | Meaning |
|---|---|
| `DONE` | Work complete, commit landed, tests pass. |
| `DONE_WITH_CONCERNS` | Work complete but reviewer should note `Concerns:` field. |
| `NEEDS_CONTEXT` | Cannot proceed; `Missing:` field names what's needed. |
| `BLOCKED` | Hard blocker; `Reason:` + `Tried:` fields required. |

Additional optional fields:
- `Concerns: <text>` — required with `DONE_WITH_CONCERNS`
- `Reason: <text>` — required with `BLOCKED`
- `Tried: <text>` — required with `BLOCKED`
- `Missing: <text>` — required with `NEEDS_CONTEXT`; also returned by orchestrator on stale-commit detection

---

## Post-DONE flow

After receiving an implementer report, parse and route via `status-protocol.js`:

```js
import { parseAgentReport, handleStatus } from '../mcp-server/src/orchestrator/status-protocol.js';

const parsed  = parseAgentReport(agentReport);           // throws ProtocolViolation if malformed
const action  = handleStatus(parsed, dispatchTimestamp, { projectRoot });

switch (action.action) {
  case 'proceed_to_review':
    // hand off to W10-A2 review.js with action.commit_sha
    break;
  case 'proceed_with_flag':
    // proceed to review, surface action.concerns to user
    break;
  case 'redispatch_with_context':
    // re-prompt agent, append action.missing to context
    break;
  case 'redispatch_needs_context':
    // agent reported DONE but commit predates dispatch; re-prompt with missing:'commit-before-report'
    break;
  case 'escalate_to_user':
    // surface action.reason + action.tried; halt wave
    break;
}
```

`dispatchTimestamp` is `Date.now() / 1000` (Unix seconds) captured at the
moment the implementer agent was dispatched.

---

## Implementer prompt template snippet

Paste verbatim at the end of every implementer prompt:

```
End your final message with EXACTLY these lines (orchestrator parses this):

Status: DONE
Branch: wave/<wave-id>/<sub-id>
Commit: <full SHA>
Tests: <N> pass / <M> fail

Alternative statuses: DONE_WITH_CONCERNS + Concerns:; NEEDS_CONTEXT + Missing:;
BLOCKED + Reason: + Tried:. No other status strings are valid.
```

---

## When you're in over your head

**Bad work is worse than no work. You will not be penalized for escalating.**

If you encounter any of these, STOP and report `Status: BLOCKED` with the reason:

- The task as written is ambiguous (multiple reasonable interpretations exist)
- The spec contradicts code or assumes infrastructure that doesn't exist
- You'd have to invent significant new abstractions to complete it
- You hit a tool/permission limit that prevents real progress
- 3 fix attempts on the same issue have failed (per the deviation rule in W12-A/S07)
- You realise the task is bigger than scoped and should be split

Reporting BLOCKED is a legitimate, encouraged outcome — not a failure. The orchestrator handles BLOCKED by either splitting the task, adding context, or escalating to the human. Each is cheaper than half-done work that has to be unwound.

DO NOT:
- Force-fit a solution you don't believe in just to avoid reporting BLOCKED
- Mark DONE with hidden caveats hoping the reviewer won't notice
- Silently truncate (do NOT just stop) — always emit a status line

---

## Continuous execution

Do NOT ask "should I continue?" between tasks in the same brief. The orchestrator dispatched you with a complete task spec; execute the entire spec.

Stop ONLY when:
1. You complete the spec → report Status: DONE
2. You hit a blocker per "When you're in over your head" → report Status: BLOCKED
3. You need context the brief didn't provide → report Status: NEEDS_CONTEXT
4. You completed with caveats worth flagging → report Status: DONE_WITH_CONCERNS

Anything else (mid-task pauses, "let me check with you", "I think the next step is...") is friction that wastes turns. Execute or escalate.

<!-- IJFW-S09-SELFCHECK-START -->
<!-- (W12-A/S09 ships the self-check protocol as a separate prompt at claude/skills/ijfw-workflow/prompts/post-done-self-check.md; this marker reserves an integration point if we later want it inline.) -->
<!-- IJFW-S09-SELFCHECK-END -->
