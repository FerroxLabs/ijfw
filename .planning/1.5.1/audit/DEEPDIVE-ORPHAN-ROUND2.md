# v1.5.1 Deep-Dive Round 2 — orphan code + wiring (current HEAD)

Auditor: independent deep-dive subagent. HEAD: `8d4aa92` on `v1.5.1-staging`.
Scope: fresh orphan/wiring sweep of `mcp-server/src/`, post the 29-commit W2
swing. Baseline reference: `.planning/1.5.1/audit/ORPHAN-CODE-FINDINGS.md`
(the original audit that found 8 orphans).

## Summary

**The W2 swing is mostly real — 6 of 8 wirings are genuine, reachable runtime
paths. But two of the eight (truncation, worktree-guards) were wired into a
HOST MODULE THAT IS ITSELF AN ORPHAN.** `orchestrator/runtime-loop.js` has
ZERO production importers — it is imported only by 5 test files. The original
audit missed this because it scanned the 8 *leaf* modules and never asked
whether the *host* it recommended (`runtime-loop.js`) was itself reachable.
W2.B + W2.E (commit `b74f295`) dutifully wired `truncation.js` (T20) and
`worktree-guards.js` (S08) into `runtime-loop.js` — but nothing calls
`runLoop`, `handleTruncation`, `recoverAndRouteTruncation`,
`measureAndPersistTruncationRate`, or `dispatchSubagentGuarded`. **The
CHANGELOG's "T20 measured-rate claim now has a caller" is still false** — the
caller is itself dead code. This is the next migration-005: a fix that moved
the orphan one level up the import graph instead of into a live path.

Second new HIGH the original audit missed: `recovery/code-fixer.js` — the T27
"G4 cross-AI consensus code-fixer loop", a v1.5.0 CHANGELOG-claimed feature
with 14 exports including `fixFindings`/`fixFinding` — has NO production
caller. Imported only by `test-code-fixer.js`. It was never in the original
8-orphan list at all.

Third: `dashboard-charts.js` is a hard orphan (3 exports, zero refs anywhere
but its own test; the live dashboard uses a different `scripts/dashboard/`
renderer).

The codex-doctor test failure is environmental BUT exposes a real LOW bug: a
misleading status message. The `cmdUpdateConfirm` "known failure" no longer
reproduces — test-1.1.6.js is 55/55 green.

## HIGH — genuine orphans / dead wirings / shipped half-features

### H1. `orchestrator/runtime-loop.js` — orphan HOST; W2.B + W2.E wired live code into it

- `runtime-loop.js` is imported by **zero** non-test files. The only matches
  in `termination.js` and `post-done-runner.js` are *comment text*
  ("`runtime-loop.js` wrappers", "verified by runtime-loop.js"), not imports.
  Verified: `grep "import.*runtime" termination.js post-done-runner.js` = 0.
- Importers (all tests): `test-cross-ai-resume.js`,
  `test-orchestrator-runtime-loop.js`, `test-termination.js`,
  `test-repo-map-wire.js`.
- No MCP tool / `ijfw_state` verb / bin script routes to any runtime-loop
  export. Confirmed: `server.js` and `state-sdk.js` never reference
  `runLoop`, `handleTruncation`, `recoverAndRouteTruncation`,
  `measureAndPersistTruncationRate`, `dispatchSubagentGuarded`,
  `reviewSubagentReport`.
- **Consequence for W2.B (truncation.js / T20):** commit `b74f295` says
  "CHANGELOG measured-rate claim now has a caller." It does not. `truncation`'s
  `detectTruncation` / `writeRateArtifact` are now called by
  `handleTruncation` / `measureAndPersistTruncationRate` — both of which have
  no caller. The orphan moved up one level; the claim is still vaporware.
- **Consequence for W2.E (worktree-guards.js / S08):** the guards are run as
  preconditions inside `dispatchSubagentGuarded` (runtime-loop.js:610). That
  function is never called. The "incident-driven worktree safety guards"
  fire on no real dispatch path.
- This is a pre-existing v1.5.0 orphan (`runtime-loop.js` landed at `8e68f28`,
  "recovered from..." — it has never had a production caller). The original
  audit recommended runtime-loop.js as the wiring target for H1 and H5
  *without checking the host*.
- **Fix (v1.5.1):** EITHER route the post-done / verification-gate path
  through `runtime-loop.js` for real (the orchestrator dispatch path that
  actually runs in production is `subagent-telemetry.dispatchSubagent` +
  `post-done-runner.runSelfCheck` via the `ijfw_state` verb — that is where
  truncation recovery and worktree guards must hook), OR move the
  truncation/worktree-guard calls directly into `subagent-telemetry.js` /
  `post-done-runner.js` (which ARE reachable), OR downgrade the T20 + S08
  CHANGELOG claims to "module present, integration deferred." Do NOT leave
  three layers of orphan stacked.

### H2. `recovery/code-fixer.js` — T27 "G4 cross-AI consensus code-fixer loop" — orphan, MISSED by round 1

- v1.5.0 CHANGELOG-claimed feature (commit `309a6ed`, "feat(v1.5.0 T27): G4
  cross-AI consensus code-fixer loop"). 14 exports incl. `fixFinding`,
  `fixFindings`, `triage`, `verifyTier1/2/3`, `runTridentVerify`,
  `atomicCommit`.
- Imported only by `test-code-fixer.js`. No production caller anywhere.
- The repo-wide hits for "code-fixer" in `team/schemas.js`, `team/generator.js`
  are the **agent-name string** `'ijfw-code-fixer'` (a roster entry), NOT the
  JS module. The `ijfw-code-fixer.md` agent prompt is prose. Neither invokes
  `recovery/code-fixer.js`.
- This was NOT in the original 8-orphan list — a genuine round-1 miss.
- **Fix (v1.5.1):** Wire `fixFindings` into the recovery path (the obvious
  caller is `post-done-runner.js` or a `recovery`-stage in the orchestrator
  after a gate FAIL), expose it as a `bin/` entry, OR downgrade the T27
  CHANGELOG claim. A "consensus code-fixer loop" that nothing can invoke is
  the same dishonesty class as H1.

### H3. `dashboard-charts.js` — hard orphan, MISSED by round 1

- 3 exports: `lineChart`, `barChart`, `progressBar`. Landed v1.4.3 (`f23d286`,
  "B19 aggregator + chart helpers").
- Zero references anywhere except `test-dashboard-charts.js` and stale
  `.planning/` docs. The shipped dashboard (`scripts/dashboard/`) renders
  charts via its own `render.js` — `dashboard-charts.js` (the mcp-server copy)
  is dead.
- Not in the original 8-orphan list.
- **Fix (v1.5.1):** Delete `dashboard-charts.js` + `test-dashboard-charts.js`,
  OR confirm whether `scripts/dashboard/` was meant to import it and wire it.
  Low blast radius (browser-canvas helpers), but it's dead weight in the
  published `files:` array.

## MED — dead exports, weak wirings

### M1. W2.C debug-trident wiring is real but DEFAULT-OFF (gated behind injected dispatcher)

`post-done-runner.js:250` — `runDebugCampaign` only fires when
`typeof debugTridentDispatch === 'function'`, i.e. only when a caller
explicitly injects `debugTridentDispatch`. The function IS reachable (the
host `post-done-runner.runSelfCheck` is wired into `state-sdk.js`), and the
default-off design is defensible (annotation-only, cost-bounded). But verify
that ANY production caller of `runSelfCheck` actually passes
`debugTridentDispatch` — if none does, T29's "every gate's failure mode
covered by a Trident dissent" is reachable-but-never-exercised. Grep
`debugTridentDispatch` across `server.js` / `state-sdk.js` to confirm the
injection happens on a real path. Classify as MED until confirmed.

### M2. `codexDoctor` MCP-config check — message contradicts verdict (real bug, surfaced via test)

`cross-orchestrator-cli.js:3012` (`codexDoctor`):
- `ok: existsSync(configPath) && readFileSync(configPath).includes('ijfw-memory')`
- `message: existsSync(configPath) ? 'ijfw-memory configured' : 'missing config.toml'`

When `~/.codex/config.toml` EXISTS but lacks the `ijfw-memory` string, the
check renders `[ !! ] MCP config -- ijfw-memory configured` — a failure mark
with a success message. The `message` must be derived from the same condition
as `ok` (e.g. `... ? (content.includes('ijfw-memory') ? 'ijfw-memory
configured' : 'config.toml present but ijfw-memory not registered') : ...`).
A user running `ijfw codex doctor` with a non-IJFW codex config sees a
self-contradicting line. Fix is 2 lines.

### M3. Stale TODOs from round 1 M1 — partially addressed

- `dispatch/extension.js:21` — `TODO(v1.5.0-major S01 — IJFW_PARENT_PROJECT_ROOT
  passthrough)`: STILL present. Re-read: it is a genuine forward-looking
  comment documenting a real harness-dependency that does not exist yet
  (the Task-tool worktree env hook). Acceptable as a documented deferral —
  downgrade to LOW, but re-target the marker off "v1.5.0-major".
- `override-resolver.js:68` — `TODO(W2b/t11)`: STILL present. Documents a real
  deferred consolidation (canonical platform-list getter in
  `installer/src/install-helpers.js`). Acceptable; re-target the marker.
- `cross-orchestrator-cli.js:709` — `TODO post-merge: ... added by Item 2
  agent`: STILL present. The referenced merge has happened; this is a true
  stale marker — remove it.

## LOW — cosmetic

- `bin/ijfw-memorize` LLM-synthesis stub (round-1 M3/M6) is **FIXED**: line 13
  now explicitly states "It never writes literal TODO text into user memory" —
  the `IJFW_AUTOMEM_MODEL` path queues for batch processing
  (`pending: true`) rather than writing a TODO marker. Resolved.
- M4 dual-migration-registry (round-1, the actual root cause of the search.js
  bug) is **FIXED**: `memory/search.js:34,63` now does
  `import { loadMigrations } from './migration-runner.js'` +
  `await loadMigrations()` — single source of truth via `readdirSync`. The
  hardcoded `migrations/00X` import block is gone. Verified.
- `hardware-signer.js:17` / `:469` — libfido2 "not yet implemented" + mock-PEM
  "placeholder" comments still present; test-path / future-work, harmless.
- All other TODO/FIXME hits in `src/` are SQL `placeholders` variables or
  `plan-checker.js` production matchers — not stale markers.

## W2 wiring verification (the 8)

| Orphan | Host claimed | Verdict |
|---|---|---|
| `uispec-intake` → `lib/ui-review-runner.js` | ui-review-runner | **REAL** — `fromImage`/`fromFigma` imported (L43) AND called (L427-431) behind `fromImagePath`/`fromFigmaUrl`; `runUiReview` reachable via `cross-orchestrator-cli.js:2560` (bin path). |
| `recovery/truncation.js` → `runtime-loop.js` | runtime-loop | **DEAD IMPORT (host orphan)** — `detectTruncation`/`writeRateArtifact` are called, but only by `handleTruncation`/`measureAndPersistTruncationRate`, which have no caller. See H1. |
| `lib/worktree-guards.js` → `runtime-loop.js` | runtime-loop | **DEAD IMPORT (host orphan)** — guards run inside `dispatchSubagentGuarded`, which is never called. See H1. |
| `orchestrator/debug-trident.js` → `post-done-runner.js` | post-done-runner | **REAL but gated** — `runDebugCampaign` called (L262); host reachable via `state-sdk.js`. Fires only when `debugTridentDispatch` injected (default off). See M1. |
| `gate-result-formatter.js` → `server.js` | server.js | **REAL** — `appendGateResult` dynamically imported + invoked inside the `ijfw_cross_audit_converge` MCP tool handler (server.js:1988). Reachable. |
| `observability/evaluator-checkpoint-contract.js` → `subagent-telemetry.js` | subagent-telemetry | **REAL** — `evaluateCheckpointContract` called (L136) on every checkpoint carrying a `report`; host reachable via `wave-cli.js` + `checkpoint-cli.js`. |
| `extension-registry-ws.js` → `server.js` | server.js | **REAL** — `initWsClient` dynamically imported at module top-level (server.js:2197) behind `IJFW_REGISTRY_WS_URL`/`_WS_SOURCE` env gate. The dynamic-import gate the round-1 docstring promised now exists. |
| `memory/benchmark.js` → `ijfw metrics` | cross-orchestrator-cli | **REAL** — `runBenchmark` imported (L66) + called in `cmdMetricsBenchmark` (L589), dispatched by `name === 'metrics' && args.includes('--benchmark')` (L279); reachable via `bin/ijfw`. |

**Score: 6 REAL, 2 DEAD (both into the same orphan host `runtime-loop.js`).**

## Pre-existing test failures verdict

### `cmdUpdateConfirm` (test-1.1.6.js) — NO LONGER FAILS

Ran `node --test test-1.1.6*.js` at current HEAD: **55/55 pass, 0 fail**,
including the two `cmdUpdateConfirm` cases. Either the W2 swing or an earlier
commit fixed it, or it was always environmental (npm-network flake). Not a
masked bug — green now. **Verdict: resolved / not reproducible.**

### `codex doctor` (test-codex-bundle.js) — ENVIRONMENTAL, but masks a real LOW bug

Ran `node --test test-codex-bundle.js`: 25/26 pass, 1 fail —
`codex: doctor works from a non-IJFW project directory`. Root cause:
`codexDoctor` resolves `configPath` via `findFirstExisting($HOME/.codex/
config.toml, ...)`. On this dev machine `~/.codex/config.toml` EXISTS (a real
personal Codex config) and contains **zero** `ijfw-memory` references
(verified: `grep -c ijfw-memory ~/.codex/config.toml` = 0). So the MCP-config
check returns `ok:false, required:true` → `[ !! ]` → `process.exit(1)` → the
test's `execFileSync` throws. **Verdict: environmental** — the test is
HOME-state-sensitive; CI with a clean `$HOME` would pass. It is NOT a
regression from v1.5.1 (prior memory note confirms baseline at `cee76c5`).
**BUT** it surfaced a genuine LOW bug (M2): the `message` field prints
"ijfw-memory configured" even when the file lacks `ijfw-memory`. Fix M2 and
the test becomes both honest and HOME-independent if the message-vs-verdict
contradiction is removed (the test could then assert on a non-contradictory
line). Recommend: fix M2; optionally make the test set `HOME` to a temp dir
so it stops being machine-dependent.

## Other verified-clean findings

- All 5 design libs + `uispec-intake` correctly imported by
  `ui-review-runner.js` (round-1 H3 docstring/import drift is FIXED — the
  import block now matches the prose).
- The dream subsystem (`runner.mjs`, `cooldown.js`, `stage-runner.js`,
  `staleness-wiring.js`, `state-file.js`, `tier-promotion.js`) reads as
  "test-only" to a static-JS-import grep, but is genuinely wired:
  `claude/hooks/scripts/session-end.sh` → `dream-trigger.sh` → spawns
  `dream/runner.mjs` → dynamically imports the rest. Reachable. NOT orphans.
- `intent-router.js`, `feedback-detector.js` — wired via
  `claude/hooks/scripts/pre-prompt.sh` (`await import` of the resolved
  module). Reachable.
- `observability/cost-anomaly.js` — wired via `scripts/dashboard/server.js`
  (`detectCostAnomaly` imported + served at `/api/cost-anomaly`). Reachable.
- `lib/status-card.js` — wired via `codex/.codex/hooks/session-end.sh`.
  Reachable.
- `dashboard-server.js`, `cross-orchestrator-cli.js`, `server.js` — bin/MCP
  entry points (`bin/ijfw-dashboard`, `bin/ijfw`, MCP stdio). Not orphans.
- Migration modules (`compute/migrations/*`, `memory/migrations/*`) — loaded
  by `readdirSync` in their respective `migration-runner.js`. Expected
  dynamic-discovery pattern; not orphans.
- Spot-checked 12 exported functions (`probeLenses`, `rotateJsonlIfNeeded`,
  `findNearDuplicate`, `mergeFile`, `expandQuery`, `buildRecallCounts`,
  `readWaveState`, `buildRepoMap`, `getValidAt`, `topKSuccessfulSkills`,
  `ensureTraceId`, `getCached`) — all have genuine production callers.
  Caveat: `buildRepoMap` + `ensureTraceId` are called by `runtime-loop.js`
  among others — `ensureTraceId` also has a live caller via `receipts.js`;
  `buildRepoMap` should be re-checked once H1 is resolved.
- All new-since-v1.5.0 modules (`llm-call`, `a11y-contract`, `auto-linker`,
  `query-dataview`, `team/modify`, `state-events`, `skill-telemetry-sink`,
  `tmp-suffix`, `termination`, `command-registry`) — verified production
  importers exist. `command-registry.js` imported by `cross-orchestrator-cli.js`
  + `installer/src/ijfw.js`.

## Recommended v1.5.1 priorities

1. **H1 — runtime-loop.js orphan host.** This is the next migration-005. The
   W2.B/E swing wired live code into dead code. Either route the real
   orchestrator path through runtime-loop, or move truncation + worktree-guard
   calls into the reachable `subagent-telemetry.js`/`post-done-runner.js`, or
   admit-and-defer the T20/S08 claims. Do NOT ship with three orphan layers.
2. **H2 — recovery/code-fixer.js.** T27 CHANGELOG claim with no caller. Wire,
   add a bin entry, or downgrade.
3. **H3 — dashboard-charts.js.** Delete or wire.
4. **M2 — codexDoctor message bug.** 2-line fix; also de-flakes the codex test.
5. **M1 — confirm debug-trident injection** happens on a real path.
6. **M3 — remove the one true stale TODO** (`cross-orchestrator-cli.js:709`);
   re-target the other two markers off shipped milestone names.
