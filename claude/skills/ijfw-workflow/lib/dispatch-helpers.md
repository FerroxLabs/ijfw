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
