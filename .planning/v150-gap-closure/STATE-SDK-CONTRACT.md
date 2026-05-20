# IJFW v1.5.0 — STATE-SDK VERB CONTRACT (FROZEN)

**Task:** T1 — Freeze the state-SDK verb contract
**Status:** FROZEN — 2026-05-20. Downstream tasks T2–T20 bind to this verbatim.
**Supersedes:** nothing — this is the first state-SDK contract.
**Source of truth:** `.ijfw/memory/brief.md` "## The architecture spine — the
state-SDK" (G2 / G3 / G1). This document encodes that brief literally; it does
not invent divergent semantics.

---

## 0. What this is

The state-SDK is **one `query(verb, payload)` core** — a **verb facade over the
EXISTING physical state files**. The physical files (`workflow.json`,
`STATE.md`, `*.checkpoint.json`, `*.jsonl`, `AGENTS.md`,
`active-extension.json`) **stay exactly where they are**. The SDK is the single
*mutation surface* over them, not a new storage format and not a single file.

The core is exposed **three ways** (all routing into the same `query()`):

1. **JS module** — `import { query } from './orchestrator/state-sdk.js'` for
   in-process writers (`dispatch-planner.js`, `wave-state.js`,
   `subagent-telemetry.js`, `agents-md-blackboard.js`,
   `active-extension-writer.js`).
2. **CLI face** — `ijfw state:<verb>` — a **colon-namespace** registered in
   `mcp-server/src/dispatch/colon-syntax.js` (`state` joins the
   `RUN_NAMESPACES` set). There is **NO `bin/` directory** — the CLI face is a
   colon-namespace on the existing `ijfw` CLI. Payload is passed as a JSON
   string argument; output is JSON on stdout.
3. **MCP tool** — `ijfw_state` (single tool, `verb` + `payload` params),
   reachable from all 13 platforms. `ijfw_state` is created by *absorbing*
   `ijfw_subagent_post_done` (post-done IS a state transition → the
   `subagent.post-done` verb). MCP tool count stays **12/12**.

### CLI face — explicit form

```
ijfw state:<verb> '<json-payload>'
```

Examples (every verb in this contract is reachable this way):

```
ijfw state:workflow.get '{}'
ijfw state:workflow.set-phase '{"phase":"build"}'
ijfw state:wave.advance '{"waveId":"W12-A","status":"complete"}'
ijfw state:decision.add '{"text":"...","dedupKey":"d-001"}'
ijfw state:state.validate '{}'
```

The colon-namespace token is `state`; the verb is the colon-`command`. The
verb's own dotted name (`workflow.get`) is the command string passed through to
`query()`.

### Verb-name → call mapping

- JS: `query('workflow.get', { ... })`
- CLI: `ijfw state:workflow.get '{ ... }'`
- MCP: `ijfw_state` with `{ verb: 'workflow.get', payload: { ... } }`

All three normalise to the same `query(verb, payload, ctx)` invocation. `ctx`
carries `{ projectRoot, subagentId?, homeDir? }` — supplied by the JS caller
directly, derived from `cwd` + env for the CLI/MCP faces.

---

## 1. Canonical physical state files

Every verb operates over one or more of these REAL files (confirmed by recon
of `mcp-server/src/`). The SDK does not introduce new files; it is a facade.

| Key | Physical path | Format | Written today by |
|-----|---------------|--------|------------------|
| `workflow.json`     | `<projectRoot>/.ijfw/state/workflow.json`                       | JSON object        | workflow skill (shell `>` today; migrates via T11) |
| `waves.json`        | `<projectRoot>/.ijfw/state/waves.json`                          | JSON object        | wave tracking |
| `wave-STATE`        | `<projectRoot>/.ijfw/wave-<waveId>/STATE.md`                    | YAML frontmatter + md body | `wave-state.js` (T7) |
| `wave-checkpoint`   | `<projectRoot>/.ijfw/wave-<waveId>/subagent-<subId>.checkpoint.json` | JSON object   | `subagent-telemetry.js` (T9) |
| `decisions.jsonl`   | `<projectRoot>/.ijfw/blackboard/decisions.jsonl`                | JSONL (append)     | blackboard / decision log |
| `event-log`         | `<projectRoot>/.ijfw/wave-<waveId>/events-<subId>.jsonl`        | JSONL (append, rotated) | NEW — `state-events.js` (T5) |
| `AGENTS.md`         | `<projectRoot>/AGENTS.md` (BLACKBOARD marker block only)        | markdown block     | `agents-md-blackboard.js` (T8) |
| `telemetry-convergence` | `<projectRoot>/.ijfw/telemetry/convergence.json`            | JSON object        | NEW — `cross-orchestrator.js` (T21) |
| `roster`            | `<projectRoot>/.ijfw/team/workflow.json` + `charter.json`       | JSON object        | `team/generator.js` (T24/T25) |
| `active-extension`  | `~/.ijfw/state/active-extension.json` (HOMEDIR — not project)   | JSON object        | `active-extension-writer.js` (T10) |
| `intent-journal`    | `<projectRoot>/.ijfw/state/intent-journal.jsonl`                | JSONL (append)     | NEW — the SDK itself (intent/commit markers) |

**Lock files** are the dotfile sibling of each target (e.g.
`.ijfw/state/.workflow.json.lock`, `.ijfw/wave-<id>/.STATE.md.lock`,
`.ijfw/state/AGENTS.md.lock`). Locks are acquired via
`withFsLock(lockPath, fn, opts)` from `mcp-server/src/fs-lock.js`.

---

## 2. Reused libraries (the SDK does not reimplement these)

| Library | Exported surface the SDK calls | Use |
|---------|--------------------------------|-----|
| `mcp-server/src/lib/atomic-io.js`      | `writeAtomic(targetPath, data, opts)` · `readSafe(targetPath, validator)` | Every verb write = tmp-write + atomic rename via `writeAtomic`. Reads via `readSafe`. |
| `mcp-server/src/fs-lock.js`            | `withFsLock(lockPath, fn, opts)` · `FsLockBusyError` · `FsLockStaleError` | Lock acquisition. `opts` carries the heartbeat-refresh window. |
| `mcp-server/src/lib/jsonl-rotation.js` | `appendJsonlWithRotation(path, line, options)` · `rotateJsonlIfNeeded(path, options)` · `DEFAULT_ROTATE_SIZE` (4 MiB) | Append-style verbs + the event log + intent journal; rotation. |

Heartbeat note: T3 replaces the fixed 30s stale window with a
heartbeat-refreshed lock — `withFsLock` is called with a `heartbeatMs` option;
long-running verbs refresh the lock mtime on an interval so a concurrent caller
never wrongly reclaims a live lock.

---

## 3. CROSS-CUTTING MODEL 1 — Lock hierarchy (canonical acquire-order)

A verb that touches N files **acquires locks in this exact order** and
**releases in reverse order**. The order is coarse-to-fine and deterministic, so
two verbs touching an overlapping file set can never deadlock (no lock-ordering
cycle is possible). A verb acquires only the *subset* of this list it actually
writes — but always in this relative order.

**Canonical acquire-order (ordered list of physical files):**

1. `.ijfw/state/intent-journal.jsonl` — the write-ahead intent journal (always first; every mutating verb writes a `begin` record here before any target lock)
2. `.ijfw/state/workflow.json` — workflow phase state
3. `.ijfw/state/waves.json` — wave index
4. `.ijfw/wave-<waveId>/STATE.md` — per-wave state (ordered by `waveId` ascending when a verb touches multiple waves)
5. `.ijfw/wave-<waveId>/subagent-<subId>.checkpoint.json` — per-subagent checkpoint (ordered by `subId` ascending when multiple)
6. `.ijfw/team/workflow.json` — generated roster
7. `.ijfw/blackboard/decisions.jsonl` — decision/blocker append log
8. `AGENTS.md` — blackboard rollup block
9. `.ijfw/telemetry/convergence.json` — Trident convergence telemetry
10. `.ijfw/wave-<waveId>/events-<subId>.jsonl` — per-subagent event log
11. `~/.ijfw/state/active-extension.json` — homedir extension state (always last; a different filesystem root, acquired after all project-scope locks)

**Rules:**
- The intent journal (#1) is always acquired first and the homedir
  active-extension file (#11) always last. Project-scope files (#2–#10) are
  acquired strictly in the numeric order above.
- When a verb touches multiple files at the *same* numbered tier (e.g. two
  `STATE.md` for two waves), it sub-orders them by the natural ascending sort
  of the discriminator (`waveId`, then `subId`).
- The event-log (#10) lock is **NOT held across the verb's critical section** —
  event emit is fire-and-forget *after* lock release (see Model 4 / brief
  observability model). It appears in the list only so its relative position is
  defined if a future verb ever needs it inline.
- **No lock is held across a subprocess spawn.** `merge-block-aware.sh` is
  ported to in-process JS (T8); any unavoidable spawn pre-renders its payload
  and runs outside the lock.

---

## 4. CROSS-CUTTING MODEL 2 — Intent / commit record

Every **mutating** verb writes a write-ahead **intent record** (`begin`) to
`.ijfw/state/intent-journal.jsonl` *before* touching any target file, and a
**commit marker** (`commit`) *after* the atomic rename(s) succeed. Read-only
verbs (`*.get`, `state.validate`, `state.replay`) write no journal records.

**Literal JSON shape — one line in `intent-journal.jsonl`:**

```json
{
  "verb": "wave.advance",
  "verbId": "v-7f3a2c1e-0000",
  "phase": "begin",
  "ts": "2026-05-20T11:30:00.000Z",
  "dedupKey": "wave.advance:W12-A:complete",
  "targets": [".ijfw/wave-W12-A/STATE.md"],
  "payloadDigest": "sha256-9c1f…"
}
```

Field contract:

- `verb` — string, the verb name.
- `verbId` — string, unique per `query()` invocation (`v-<uuid>-<seq>`). The
  `begin` and `commit` records for one invocation share the same `verbId`.
- `phase` — `'begin' | 'commit'`. Exactly these two literals.
- `ts` — ISO-8601 UTC string.
- `dedupKey` — string, OPTIONAL. Present on append-style verbs (see §6). For
  non-append verbs it MAY be omitted.
- `targets` — string[], the physical files this verb mutates (relative paths).
- `payloadDigest` — string, `sha256-<hex>` of the canonical-JSON payload. Used
  by replay to detect a partial vs a completed write.

**Replay semantics (consumed by `state.replay`, T20):**
- A `verbId` with both a `begin` and a matching `commit` → **already applied →
  skip** (no-op).
- A `verbId` with a `begin` but **no** `commit` → **partial → roll back** the
  target files to their pre-`begin` content (the SDK keeps the pre-write tmp
  snapshot until `commit`), then the verb may be safely re-run.
- Append-style verbs are made replay-safe by `dedupKey`: re-applying an append
  whose `dedupKey` already exists in the target log is a no-op.

---

## 5. CROSS-CUTTING MODEL 3 — Event record + log rotation

Every verb (including read-only verbs) emits **one event** to the per-subagent
event log — **fire-and-forget, AFTER lock release**, off the verb's critical
section, so observability never slows a state write. The parent consumes the
log by **explicit-interval polling** (`pollEvents(since)`) — never `fs.watch`
(unreliable across 13 platforms).

**Event log path:** `.ijfw/wave-<waveId>/events-<subId>.jsonl`
(`<subId>` falls back to `parent` when no subagent context is set).

**Literal JSON shape — one line in `events-<subId>.jsonl`:**

```json
{
  "seq": 42,
  "verb": "subagent.checkpoint",
  "subagentId": "W12-A1",
  "ts": "2026-05-20T11:30:01.250Z",
  "verbId": "v-7f3a2c1e-0000",
  "outcome": "ok",
  "payloadDigest": "sha256-9c1f…"
}
```

Field contract:

- `seq` — integer, monotonically increasing per event log (1-based). The poll
  cursor.
- `verb` — string, the verb that emitted.
- `subagentId` — string, the emitting subagent (`'parent'` for orchestrator).
- `ts` — ISO-8601 UTC string.
- `verbId` — string, correlates the event to its intent/commit records.
- `outcome` — `'ok' | 'refused' | 'advisory' | 'error'`. `refused` = a gate
  verdict-fail blocked the verb (Model 4); `advisory` = a gate execution-fail
  degraded but the verb proceeded; `error` = the verb itself threw.
- `payloadDigest` — string, `sha256-<hex>`; same digest as the intent record.

**Per-event size cap:** 4 KiB. An event line exceeding the cap is truncated to
its envelope fields (`seq`, `verb`, `subagentId`, `ts`, `verbId`, `outcome`)
with `payloadDigest` retained — never dropped silently.

**Log rotation policy (ceiling — literal):**
- **Byte ceiling:** `4 MiB` per event log (`jsonl-rotation.js`
  `DEFAULT_ROTATE_SIZE`).
- **Line ceiling:** `10000` lines per event log.
- On reaching either ceiling, `appendJsonlWithRotation` rotates the current log
  to `events-<subId>.jsonl.1` (single generation; the prior `.1` is
  overwritten) and starts a fresh log. `seq` continues monotonically across
  rotation (it does not reset).

---

## 6. CROSS-CUTTING MODEL 4 — Gate failure rule

Gate functions (`enforceVerificationGate`, `validatePlan`, checkpoint checks)
are **preconditions of state-advancing verbs** (G3 enforcement-by-construction).
The verb's behaviour on gate outcome is exactly three-valued:

| Gate outcome | Definition | Verb behaviour | Event `outcome` |
|--------------|------------|----------------|-----------------|
| **verdict-fail** | The gate ran to completion and returned a red/negative verdict (e.g. verification found a missing artefact; plan-check found a HIGH finding). | **Verb REFUSES.** No state file is mutated. `query()` returns `{ ok:false, refused:true, gate:<name>, reason }`. Correct, intended hard block. | `refused` |
| **execution-fail** | The gate function itself **threw**, OR the plan/input is malformed, OR a gate bug. The gate did not produce a verdict. | **Verb MUST NOT block.** It **degrades to advisory**: writes a **loud log** line (`outcome:'advisory'` event + a `WARN` to stderr) and **proceeds** with the state write. A gate bug must never freeze the workflow. `query()` returns `{ ok:true, advisory:true, gate:<name>, reason }`. | `advisory` |
| **MCP-unavailable** | The verb is invoked but the MCP/gate subsystem is unreachable (offline, server crashed, gate module failed to import). | **Documented bypass.** Enforcement is a floor, never a single point of failure. The verb proceeds, writes the state, and records a loud `advisory` event noting the bypass. The CLI/JS faces also honor an explicit `IJFW_STATE_GATE_BYPASS=1` env escape hatch for the same reason. | `advisory` |

**Which verbs run which gate (precondition map):**

- `phase.complete` → `enforceVerificationGate` (verdict-fail → refuse).
- `phase.plan-check` → `validatePlan` (a HIGH finding is a verdict-fail →
  refuse; this is W1's hard-BLOCK).
- `subagent.post-done` → `runSelfCheck` / `runPostDone` self-check (a failed
  self-check is a verdict-fail → refuse).
- `wave.advance` → checkpoint-completeness check (advisory-only by default;
  becomes verdict-fail only when the wave declares a hard gate).

All other verbs have **no gate precondition** — they apply the lock /
intent-commit / event models but skip the gate step.

---

## 7. THE VERB CONTRACT

Each block is frozen. Downstream tasks implement these signatures verbatim.
`Returns` shapes are the success shape; every mutating verb additionally MAY
return the refused/advisory shapes from Model 4. Every `query()` result also
carries `verbId` (string) and `ok` (boolean).

`Day-1` legend — behaviour when the target physical file is **absent**:
`create` (write the file fresh), `refuse` (return `ok:false`, do not create),
`no-op` (return an empty/default success shape, do not create).

`Locks` — the ordered subset of the §3 canonical list the verb acquires.

---

### verb: workflow.get
- Signature: query('workflow.get', { })
- Payload: `{}` — no fields. (`ctx.projectRoot` supplies the root.)
- Returns: `{ ok:true, workflow: { status, phase, version, milestone, items, waves, updated_at, ... } }` — the full parsed `workflow.json` object.
- Day-1: no-op — returns `{ ok:true, workflow: null }` when `workflow.json` is absent; does not create.
- Locks: `.ijfw/state/workflow.json` (read lock — shared; no intent record, read-only verb).

### verb: workflow.set-phase
- Signature: query('workflow.set-phase', { phase, status?, milestone?, version? })
- Payload: `phase` (string, required) · `status` (string, optional) · `milestone` (string, optional) · `version` (string, optional). Unspecified fields are preserved from the current file.
- Returns: `{ ok:true, workflow: <updated object> }`.
- Day-1: create — writes a fresh `workflow.json` with the given `phase` (+ `status:'in_progress'`, `updated_at` now) when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/state/workflow.json`.

### verb: wave.get
- Signature: query('wave.get', { waveId })
- Payload: `waveId` (string, required, matches `/^[A-Za-z0-9_-]{1,64}$/`).
- Returns: `{ ok:true, wave: { frontmatter, body, raw } | null }` — parsed `STATE.md` for the wave.
- Day-1: no-op — returns `{ ok:true, wave: null }` when `.ijfw/wave-<waveId>/STATE.md` is absent; does not create.
- Locks: `.ijfw/wave-<waveId>/STATE.md` (read lock — shared; read-only verb).

### verb: wave.advance
- Signature: query('wave.advance', { waveId, status, frontmatter? })
- Payload: `waveId` (string, required) · `status` (string, required — e.g. `'in_progress'`, `'complete'`) · `frontmatter` (object, optional — extra flat YAML keys to merge: string/number/boolean/string[]).
- Returns: `{ ok:true, wave: { frontmatter, body, raw } }` — the rewritten `STATE.md`.
- Day-1: create — writes a fresh `STATE.md` (auto-creates `.ijfw/wave-<waveId>/`) with the given `status` when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/state/waves.json` → `.ijfw/wave-<waveId>/STATE.md`.

### verb: wave.record-task
- Signature: query('wave.record-task', { waveId, taskId, status, dedupKey })
- Payload: `waveId` (string, required) · `taskId` (string, required) · `status` (string, required — `'pending'|'in_progress'|'complete'|'blocked'`) · `dedupKey` (string, required — append dedup, see Model 2/§6).
- Returns: `{ ok:true, wave: { frontmatter, body, raw }, deduped: boolean }` — `deduped:true` when the `dedupKey` was already present (no-op).
- Day-1: create — auto-creates `.ijfw/wave-<waveId>/STATE.md` and records the task when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/wave-<waveId>/STATE.md`.

### verb: phase.plan-check
- Signature: query('phase.plan-check', { planPath | planText, phaseId? })
- Payload: `planPath` (string, optional — path to a plan markdown file) OR `planText` (string, optional — inline plan markdown); exactly one required. `phaseId` (string, optional).
- Returns: `{ ok:true, findings: [...], verdict: 'pass' }` on a clean plan. On a HIGH finding: `{ ok:false, refused:true, gate:'plan-check', findings:[...], reason }` (Model 4 verdict-fail — W1 hard-BLOCK).
- Day-1: refuse — `ok:false` with `reason:'plan-not-found'` when `planPath` points at an absent file; no state file created.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/state/workflow.json` (records the plan-check verdict on the workflow object).

### verb: phase.complete
- Signature: query('phase.complete', { phase, evidence? })
- Payload: `phase` (string, required) · `evidence` (object, optional — verification artefacts/commands passed to the gate).
- Returns: `{ ok:true, workflow: <updated> }` on a green gate. On a red verification verdict: `{ ok:false, refused:true, gate:'verification', reason }` (Model 4 verdict-fail). On a gate exception: `{ ok:true, advisory:true, gate:'verification', reason }` (Model 4 execution-fail — proceeds).
- Day-1: create — writes a fresh `workflow.json` marking the phase complete when absent (the gate still runs first).
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/state/workflow.json`.

### verb: subagent.dispatch
- Signature: query('subagent.dispatch', { subagentId, waveId, brief, isolation?, env? })
- Payload: `subagentId` (string, required) · `waveId` (string, required) · `brief` (string, required — the task brief) · `isolation` (`'shared'|'worktree'`, optional, default `'worktree'`) · `env` (object, optional — env-var passthrough).
- Returns: `{ ok:true, dispatchBrief: string, subagentId, mode: 'deterministic'|'prompt-template' }` — `mode` is `deterministic` on Claude (real subagent primitive), `prompt-template` elsewhere (best-effort; recorded in the T16 enforcement matrix). The deterministic dispatch brief bakes in env-var passthrough + the SDK contract.
- Day-1: create — auto-creates `.ijfw/wave-<waveId>/` and registers the subagent in `STATE.md` when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/wave-<waveId>/STATE.md`.

### verb: subagent.checkpoint
- Signature: query('subagent.checkpoint', { waveId, subagentId, checkpoint, dedupKey })
- Payload: `waveId` (string, required) · `subagentId` (string, required) · `checkpoint` (object, required — arbitrary JSON ≤ 4 KiB; `tool_use_count`, `last_action`, etc.) · `dedupKey` (string, required — append dedup).
- Returns: `{ ok:true, path: string, deduped: boolean }` — `path` = the written `subagent-<subId>.checkpoint.json`.
- Day-1: create — auto-creates `.ijfw/wave-<waveId>/` and writes the checkpoint when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/wave-<waveId>/subagent-<subId>.checkpoint.json`.

### verb: subagent.post-done
- Signature: query('subagent.post-done', { subagentId, reportText, projectRoot? })
- Payload: `subagentId` (string, required) · `reportText` (string, required — the subagent's completion report) · `projectRoot` (string, optional — overrides `ctx.projectRoot`).
- Returns: `{ ok:true, selfCheck: { claimedPaths, claimedCommits, verified } }` on a passing self-check. On a failed self-check: `{ ok:false, refused:true, gate:'post-done-self-check', reason }` (Model 4 verdict-fail). Absorbs the retired `ijfw_subagent_post_done` MCP tool — post-done IS a state transition.
- Day-1: no-op — runs the `runSelfCheck` gate against `reportText` and returns the verdict; writes no STATE.md and creates no physical file. The post-done verdict is pure in-memory: the verb's job is gate enforcement, not persistence.
- Locks: none — the verb performs no file mutations; it calls `runSelfCheck` (read-only filesystem probe) and returns the result directly.

### verb: event.emit
- Signature: query('event.emit', { subagentId, waveId, eventType, data, dedupKey })
- Payload: `subagentId` (string, required) · `waveId` (string, required) · `eventType` (string, required) · `data` (object, required — event body ≤ 4 KiB) · `dedupKey` (string, required — append dedup).
- Returns: `{ ok:true, seq: number, deduped: boolean }` — `seq` = the assigned event sequence number.
- Day-1: create — auto-creates `.ijfw/wave-<waveId>/events-<subId>.jsonl` when absent.
- Locks: none held across the critical section — append is fire-and-forget AFTER any caller lock release (Model 3). The append itself uses `appendJsonlWithRotation` (its own internal append lock); no §3 lock is acquired.

### verb: telemetry.record
- Signature: query('telemetry.record', { kind, metrics, dedupKey })
- Payload: `kind` (string, required — e.g. `'convergence'`) · `metrics` (object, required — e.g. `{ cyclesToConverge, falsePositiveRate, costUsd }`) · `dedupKey` (string, required — append dedup).
- Returns: `{ ok:true, telemetry: <updated object>, deduped: boolean }`.
- Day-1: create — writes a fresh `.ijfw/telemetry/convergence.json` (auto-creates `.ijfw/telemetry/`) when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/telemetry/convergence.json`.

### verb: roster.synthesize
- Signature: query('roster.synthesize', { domain, briefPath? })
- Payload: `domain` (string, required — `'software'|'book'|'campaign'|...`) · `briefPath` (string, optional — project brief to read for domain inference).
- Returns: `{ ok:true, roster: { domain, agents: [ { id, role, source } ] } }` — the synthesized roster (NOT yet persisted; `roster.record` persists).
- Day-1: no-op — synthesis reads templates/brief only; returns the computed roster without creating any file. Returns `ok:false` only if the domain template is missing.
- Locks: none — pure synthesis, read-only over domain templates + brief.

### verb: roster.record
- Signature: query('roster.record', { roster, dedupKey })
- Payload: `roster` (object, required — a roster shape from `roster.synthesize`) · `dedupKey` (string, required — append dedup).
- Returns: `{ ok:true, path: string, deduped: boolean }` — `path` = `.ijfw/team/workflow.json`.
- Day-1: create — auto-creates `.ijfw/team/` and writes `workflow.json` + `charter.json` when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/team/workflow.json`.

### verb: extension.set-active
- Signature: query('extension.set-active', { manifest, scope, homeDir? })
- Payload: `manifest` (object, required — `{ name, permissions:{ reads, writes } }`) OR `null` to clear · `scope` (`'project'|'org'|'user'`, required) · `homeDir` (string, optional — overrides `ctx.homeDir`/`os.homedir()`).
- Returns: `{ ok:true, path: string }` — `path` = `~/.ijfw/state/active-extension.json`. With `manifest:null`, clears the file and returns `{ ok:true, cleared:true }`.
- Day-1: create — auto-creates `~/.ijfw/state/` and writes the homedir state file when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `~/.ijfw/state/active-extension.json` (the homedir file is always the LAST lock — §3 #11).

### verb: decision.add
- Signature: query('decision.add', { text, kind?, dedupKey })
- Payload: `text` (string, required — the decision body) · `kind` (string, optional, default `'decision'`) · `dedupKey` (string, required — append dedup).
- Returns: `{ ok:true, deduped: boolean }`.
- Day-1: create — auto-creates `.ijfw/blackboard/` and writes a fresh `decisions.jsonl` when absent.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/blackboard/decisions.jsonl`.

### verb: blocker.add
- Signature: query('blocker.add', { id, text, waveId?, dedupKey })
- Payload: `id` (string, required — stable blocker id) · `text` (string, required) · `waveId` (string, optional — associates the blocker to a wave) · `dedupKey` (string, required — append dedup).
- Returns: `{ ok:true, blockerId: string, deduped: boolean }`.
- Day-1: create — auto-creates `.ijfw/blackboard/decisions.jsonl` (blockers share the decision log, `kind:'blocker'`) when absent; when `waveId` is given, also auto-creates `.ijfw/wave-<waveId>/STATE.md` (status `in_progress`) so the `blockers_open` bump always lands.
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/blackboard/decisions.jsonl` → `.ijfw/wave-<waveId>/STATE.md` (the wave lock is acquired only when `waveId` is given, to bump `blockers_open`). When `waveId` is given the verb DOES write `STATE.md`: it bumps the `blockers_open` set — a `string[]` of open blocker ids (the same flat-YAML array shape `wave-state.js` writes) — by adding `id` (idempotent: a no-op if `id` is already present).

### verb: blocker.resolve
- Signature: query('blocker.resolve', { id, resolution, waveId?, dedupKey })
- Payload: `id` (string, required — the blocker id to resolve) · `resolution` (string, required) · `waveId` (string, optional) · `dedupKey` (string, required — append dedup; the resolution is itself an append).
- Returns: `{ ok:true, blockerId: string, resolved: boolean, deduped: boolean }` — `resolved:false` when no open blocker with `id` exists.
- Day-1: refuse — `ok:false` with `reason:'no-blocker-log'` when `decisions.jsonl` is absent (cannot resolve a blocker that was never recorded).
- Locks: `.ijfw/state/intent-journal.jsonl` → `.ijfw/blackboard/decisions.jsonl` → `.ijfw/wave-<waveId>/STATE.md` (wave lock only when `waveId` is given). When `waveId` is given the verb DOES write `STATE.md`: it decrements the `blockers_open` set by removing `id` from the `string[]` of open blocker ids (a no-op if `id` was not present).

### verb: state.replay
- Signature: query('state.replay', { sinceVerbId? })
- Payload: `sinceVerbId` (string, optional — replay from this `verbId`; default = replay the whole intent journal).
- Returns: `{ ok:true, replayed: [...], skipped: [...], rolledBack: [...] }` — `skipped` = verbs with a `begin`+`commit` pair; `rolledBack` = partials (`begin`, no `commit`) whose targets were restored. Used by T20 truncation recovery: replays to the last commit marker, rolls back partials.
- Day-1: no-op — returns `{ ok:true, replayed:[], skipped:[], rolledBack:[] }` when `.ijfw/state/intent-journal.jsonl` is absent (nothing to replay).
- Locks: `.ijfw/state/intent-journal.jsonl` → plus, transitively, the §3-ordered locks of whichever target files a rolled-back verb touched (acquired in canonical order).

### verb: state.validate
- Signature: query('state.validate', { })
- Payload: `{}` — no fields.
- Returns: `{ ok:true, valid: boolean, issues: [ { file, problem } ] }` — checks every canonical state file for parse integrity, dangling lock files, orphaned `begin`-without-`commit` records, and event-log/seq monotonicity.
- Day-1: no-op — an absent state file is reported as `{ file, problem:'absent' }` informationally, NOT a hard failure; `valid` stays `true` if every *present* file is well-formed. Creates nothing.
- Locks: none — read-only integrity scan; reads under shared read locks, mutates nothing.

---

## 8. Verb summary table (the frozen set)

| Verb | Kind | Day-1 | Gate precondition |
|------|------|-------|-------------------|
| `workflow.get`        | read   | no-op  | — |
| `workflow.set-phase`  | write  | create | — |
| `wave.get`            | read   | no-op  | — |
| `wave.advance`        | write  | create | checkpoint (advisory) |
| `wave.record-task`    | append | create | — |
| `phase.plan-check`    | write  | refuse | `validatePlan` (verdict-fail → refuse) |
| `phase.complete`      | write  | create | `enforceVerificationGate` (verdict-fail → refuse) |
| `subagent.dispatch`   | write  | create | — |
| `subagent.checkpoint` | append | create | — |
| `subagent.post-done`  | read   | no-op  | post-done self-check (verdict-fail → refuse) |
| `event.emit`          | append | create | — |
| `telemetry.record`    | append | create | — |
| `roster.synthesize`   | read   | no-op  | — |
| `roster.record`       | append | create | — |
| `extension.set-active`| write  | create | — |
| `decision.add`        | append | create | — |
| `blocker.add`         | append | create | — |
| `blocker.resolve`     | append | refuse | — |
| `state.replay`        | read   | no-op  | — |
| `state.validate`      | read   | no-op  | — |

20 verbs. Append-style verbs (`wave.record-task`, `subagent.checkpoint`,
`event.emit`, `telemetry.record`, `roster.record`, `decision.add`,
`blocker.add`, `blocker.resolve`) **all carry a `dedupKey`** — appends are not
idempotent by themselves (Model 2).

Unknown verbs throw — `query()` has **no silent fallback** (frozen for T2).
