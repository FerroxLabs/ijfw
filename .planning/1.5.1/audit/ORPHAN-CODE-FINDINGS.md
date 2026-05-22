# v1.5.1 Audit: Orphan code + stale markers

Auditor: orphan-code subagent. Scope: `mcp-server/src/`, `installer/src/`,
`claude/`, `codex/`. Baseline: HEAD of `main` at audit time (post-v1.5.0 ship).
Class problem motivating audit: `search.js` migration-005 dual-registry (caught
INT.7 hotfix). This audit looks for the NEXT instance of the same pattern.

## Summary

- **8 production modules ship with ZERO production callers** -- imported only
  by their own test file. These are the next migration-005-class regressions.
  Three of them are explicitly named in the v1.5.0 CHANGELOG as shipped
  features: T20 (truncation recovery, "falsifiable proof published"), T29
  (debug-trident "every gate's failure mode covered"), and audit-MED-design-#12
  (uispec-intake "Production wire-up for the 7 design libs").
- **`lib/ui-review-runner.js` docstring lists 6 design libs as "Production
  wire-up"; the file actually only imports 5.** `uispec-intake` is in the
  prose, missing from the import block. Exact same dual-source-of-truth
  pattern that produced the search.js bug.
- **`bin/ijfw-memorize` self-documents as a half-feature**: "current build
  emits a TODO marker instead of calling an LLM" -- it's shipped as a
  production binary but the LLM-synthesis code path is a stub.
- **`npm test` only runs `test.js`** (a single smoke test). CI (.gitlab-ci.yml)
  runs `node --test test-*.js` so the 208 other test files DO run there, but
  local `npm test` developers see only the smoke. Not a tests-not-run bug, but
  a developer-experience footgun -- a contributor running `npm test` locally
  has no idea ~200 test files exist.
- **Two stale `TODO(W2b/t11)` + `TODO(v1.5.0-major S01)` references** are
  shipped against milestones that have already shipped.

## HIGH severity (shipped but never called -- migration-005-class)

### H1. `mcp-server/src/recovery/truncation.js` -- T20 truncation recovery

- **What CHANGELOG claims**: "T20 G1 truncation recovery + measured rate ≤31%
  (down from 62% baseline at v1.5.0-foundation). Falsifiable proof published."
- **What ships**: 386-line module exporting truncation detection + recovery
  helpers, plus a passing test (`test-truncation-recovery.js`).
- **What is missing**: NO production caller. `orchestrator/runtime-loop.js`
  only mentions truncation in a comment ("Decide what to do when a subagent
  report indicates truncation."). `state-sdk.js` only references it in a
  comment ("T20 layers truncation-recovery orchestration on top."). The agent
  prompts in `claude/agents/ijfw-ralph-loop-runner.md` and `ijfw-executor.md`
  describe truncation recovery in prose, but no JS imports the module.
- **Why this is migration-005-class**: The CHANGELOG publishes a "measured
  rate ≤31%" claim. That measurement can only be produced by code that
  actually runs in production. With zero callers, the metric is either (a)
  measured against the test fixtures (not real subagent traffic), or (b) a
  vaporware number. Trident r22 would flag this as a HIGH.
- **Recommended fix (v1.5.1)**: Either wire `recoverTruncation` /
  `writeRateArtifact` into `runtime-loop.js` (the obvious caller given the
  comment) or downgrade the CHANGELOG claim from "shipped" to "module
  present, integration deferred."

### H2. `mcp-server/src/orchestrator/debug-trident.js` -- T29 Trident-powered debug

- **What CHANGELOG claims**: "T29 W2 Trident-powered debug + field-validation
  campaign -- every gate's failure mode covered by a Trident dissent test."
- **What ships**: 21.8 KB module + test-debug-trident.js.
- **What is missing**: NO production caller anywhere in the tree. Not in
  state-sdk, not in runtime-loop, not in cross-orchestrator, not in any agent
  hook. The CHANGELOG language ("every gate's failure mode covered by a
  Trident dissent test") implies a runtime mechanism; reality is the module
  is only exercised by its own unit test.
- **Recommended fix (v1.5.1)**: Wire `runDebugTrident` into the gate-failure
  branch of `verification-gate.js` or `runtime-loop.js`, or document it as a
  CLI-only utility (then add a `bin/` entry point so the claim is honest).

### H3. `mcp-server/src/lib/uispec-intake.js` -- audit-MED-design-#12

- **What `ui-review-runner.js:3` claims**: `"Production wire-up for the 7
  design libs (uispec-intake, uispec-drift, a11y-contract, lighthouse-pillar,
  playwright-baseline, sketches-gc)"`.
- **What `ui-review-runner.js` actually imports (lines 28-40)**:
  `uispec-drift`, `a11y-contract`, `lighthouse-pillar`, `playwright-baseline`,
  `sketches-gc`. Five libs, not six. **`uispec-intake` is named in the
  docstring but not in the import block.**
- **What is missing**: NO production caller. Imported only by
  `test-design-med-batch.js`.
- **Why this is migration-005-class**: This is the *literal* same pattern --
  a "registry" (here, the docstring listing wired libs) is out of sync with
  the actual wiring (the import block). Search.js had MEMORY_MIGRATIONS
  hardcoded out of sync with `migration-runner.js`'s disk-discovery; here
  the prose-doc inventory is out of sync with the static import list. Any
  future feature that calls `runUiReview` expecting `--from-image` /
  `--from-figma` parsing will get nothing.
- **Recommended fix (v1.5.1)**: Add `import { ... } from './uispec-intake.js'`
  to ui-review-runner.js AND invoke it at the appropriate boundary (likely
  in the spec-load path before `parseUISpec` is called).

### H4. `mcp-server/src/gate-result-formatter.js`

- **What ships**: 95-line module exporting `appendGateResult`,
  `gateResultBlockOnly`, `gateResultTemplate`. Test file:
  `test-gate-result.js`.
- **What is missing**: NO callers anywhere. `gate-result.js` (the sibling
  module) IS used (by `extension-installer.js` and `trident/dispatch.js`),
  but the formatter is not. The formatter's purpose (rendering the fenced
  gate-result block for inclusion in subagent reports) is a known IJFW
  protocol surface, so the orphan-status is a wiring miss, not a dead
  feature.
- **Recommended fix (v1.5.1)**: Either wire `appendGateResult` into the
  post-done envelope path in `state-sdk.js` / `subagent-telemetry.js`, or
  delete the module and fold the (used) `formatGateResult` helper into
  `gate-result.js` directly.

### H5. `mcp-server/src/lib/worktree-guards.js` -- v1.5.0-major S08

- **What docstring claims**: "v1.5.0-major S08: incident-driven worktree
  safety guards."
- **What ships**: 118-line module + 187-line test (10 tests).
- **What is missing**: NO production caller. The worktree CLI
  (`dispatch/worktree-cli.js`) does not import it. `orchestrator/
  worktree-provision.js` does not import it. The "incident-driven" framing
  implies a runtime guard that fires on dispatch; reality is the guards
  exist only as a callable surface that nothing calls.
- **Recommended fix (v1.5.1)**: Wire into `worktree-provision.js` at the
  branch-create / worktree-add boundary.

### H6. `mcp-server/src/observability/evaluator-checkpoint-contract.js` -- v1.5.0 N4.obs M3

- **What ships**: Module with checkpoint-contract evaluator helpers + test
  `test-checkpoint-contract-evaluator.js`.
- **What is missing**: NO production caller. The checkpoint-contract.md spec
  lives in `orchestrator/checkpoint-contract.md`, but no JS imports the
  evaluator.
- **Recommended fix (v1.5.1)**: Wire into `subagent-telemetry.js` or
  `verification-gate.js` at the checkpoint-emit path; or downgrade the N4.obs
  CHANGELOG entry.

### H7. `mcp-server/src/extension-registry-ws.js` -- v1.4.3/B17 (stub shipped to v1.5.0)

- **What docstring claims**: "WebSocket revocation client (stub). Dormant by
  default. Imported via `await import(...)` ONLY when
  `process.env.IJFW_REGISTRY_WS_URL` is set at startup."
- **What is missing**: There is no `await import('./extension-registry-ws.js')`
  anywhere in the tree. Grep across all of `mcp-server/src/` returns zero
  hits. The "dynamic-import-on-env-flag" mechanism that the docstring
  promises does not exist.
- **Why this isn't a "stub is fine" case**: The docstring sets the user
  expectation that setting `IJFW_REGISTRY_WS_URL` activates revocation push.
  Setting that env var today is a no-op -- the loader never fires.
- **Recommended fix (v1.5.1)**: Add the dynamic-import gate to `server.js`
  startup OR delete the module and document the WS path as v1.6+.

### H8. `mcp-server/src/memory/benchmark.js` -- exported but unused

- **What ships**: 22.3 KB module with `runBenchmark`, `percentile`,
  `loadDefaultCorpus`, `buildSyntheticCorpus`. Test:
  `test-memory-benchmark.js`.
- **What is missing**: NO production caller (`cross-dispatcher.js` references
  the WORD "benchmarks" in unrelated prompt copy, but does not import the
  module).
- **Note**: The longmemeval-baseline grader (`test/longmemeval-baseline.js`)
  may have been the intended caller -- worth confirming with maintainer.
- **Recommended fix (v1.5.1)**: Either wire to the grader / bin entry, or
  flag as a development-only tool and exclude from the published `files:`
  array.

## MED severity (stale markers, dead code, orphan tests)

### M1. Stale TODO referencing already-shipped milestones

- `mcp-server/src/dispatch/extension.js:21` --
  `TODO(v1.5.0-major S01 -- IJFW_PARENT_PROJECT_ROOT env passthrough)`.
  v1.5.0-major shipped; this TODO either was closed (and the marker not
  removed) or it slipped. Inspect the surrounding code to verify the
  passthrough is in place.
- `mcp-server/src/override-resolver.js:68` --
  `TODO(W2b/t11): replace this with an exported helper from ...`. W2b/t11
  was part of an earlier milestone; either close or re-target.
- `mcp-server/src/cross-orchestrator-cli.js:699` --
  `TODO post-merge: perAuditorTimeoutSec, minResponses, quiet are added by
  Item 2 agent`. References a merge that has presumably happened; verify
  and remove or re-target.

### M2. `mcp-server/src/update-apply.js:81` -- DEPRECATED notice with a removal deadline

- Literal string: `'[DEPRECATED v1.5.0; removal in v1.6.0] Stage an IJFW
  update behind out-of-band terminal '`.
- v1.5.0 has shipped; this is now a v1.6.0-removal item. Verify the
  deprecation timeline holds, document in v1.5.1 release notes that the
  removal is approaching, and plan the actual removal for v1.6.0.

### M3. `bin/ijfw-memorize` -- LLM-synthesis stub shipped as production binary

- Self-documents: "Deterministic by default: feedback/signals promote 1:1.
  LLM-based synthesis activates only when IJFW_AUTOMEM_MODEL is set
  (documented as a wiring point; current build emits a TODO marker instead
  of calling an LLM)."
- This is honest, but it's a production binary in `package.json` `bin`. A
  user who sets `IJFW_AUTOMEM_MODEL` expecting LLM synthesis will get a
  TODO marker in their `knowledge.md`. Either:
  - implement the LLM-call branch in v1.5.1, OR
  - hard-fail with "IJFW_AUTOMEM_MODEL not supported yet" when the env var
    is set, instead of silently writing a TODO into the user's memory file.

### M4. Dual migration-registry pattern is repaired but not consolidated

The CHANGELOG INT.7 hotfix notes: "Class problem (dual migration registries);
full consolidation onto `migration-runner.js`'s discovery flagged for v1.5.1."

`memory/search.js` lines 58-65 still hardcode `await import('./migrations/00X-*.js')`
for v1-v8 (the just-fixed version). `memory/migration-runner.js` uses
`readdirSync` for the same directory. Adding migration 009 in v1.5.1
without touching search.js will re-trigger the original bug. **The
v1.5.1 milestone should prioritize this consolidation -- it is the root
cause that produced the bug.**

### M5. `cross-orchestrator-cli.js` -- only reached via `bin/ijfw` bash launcher

This is fine (the bash entry point IS a real caller), but worth noting that
my static-import grep would flag it as an orphan. Future automation in this
audit space needs to treat bin shell scripts as call sites.

### M6. `bin/ijfw-memorize` writes a "TODO marker" into the user's memory

Re-statement of M3 in operational terms: today, if a user enables auto-memorize
(per the consent flow) AND has `IJFW_AUTOMEM_MODEL` set, a literal `TODO`
string gets appended to their `knowledge.md`. Audit this path -- it may
already be guarded, but if not, it's an end-user-visible mess.

## LOW severity (cosmetic markers, low-impact TODO cleanup)

- `mcp-server/src/compute/extract.js:30` -- `"ADR-XXX" placeholder shouldn't
  match`. Doc comment referencing a placeholder convention. Harmless.
- `mcp-server/src/orchestrator/plan-checker.js:35-36` -- regexes for
  matching `FIXME` / `XXX` tokens in plan files. These are PRODUCTION
  matchers (not stale markers themselves); leaving them as-is is correct.
- Pillar comments in `lib/ui-review-runner.js` referencing peer tools
  ("chrome-devtools-mcp's lighthouse_audit / axe runner") are descriptive,
  not stale.
- `mcp-server/src/hardware-signer.js:17` -- "(not yet implemented in v1.4.3)
  is a..." referencing libfido2 backend. v1.5.0 shipped; this comment is
  now stale and should clarify whether libfido2 is intentional v1.6+ work
  or a v1.5.1 task.
- `mcp-server/src/hardware-signer.js:469` -- "this is a placeholder" for
  the mock-agent PEM re-import path. Test-only path; fine.

## Tests not running

**There are no tests on disk that the CI runner glob misses.** CI runs
`node --test test-*.js` from `mcp-server/`, which matches all 209
`test-*.js` files at depth 1. All test files DO run in CI.

**However**: local `npm test` (= `node test.js`) runs ONLY the single
smoke-test file. A contributor running `npm test` locally sees ~100
assertions pass and assumes that's the suite. The actual test count is
1500+ across 209 files, all gated by CI rather than local script.

**Recommended fix (v1.5.1)**: Update `package.json` `scripts.test` to mirror
the CI invocation (e.g., `node --test --test-force-exit test-*.js`),
making the smoke a separate `npm run smoke` target. Risk: full test run is
slow / heavy, so consider a `npm run test:smoke` (fast) + `npm test` (full)
split. The current split inverts the convention (test = smoke; full suite
= CI only).

**Skip patterns**: All `{ skip: ... }` calls found are legitimate
platform-conditional skips (Windows/POSIX, bash-vs-python availability).
No `it.only` / `test.only` leakage. No `xtest` / `xit` patterns.

## Half-features (stub returns / not-implemented throws)

- `bin/ijfw-memorize` -- LLM synthesis path emits a TODO marker. See M3.
- `mcp-server/src/extension-registry-ws.js` -- self-described "stub",
  dynamic-import gate that nothing fires. See H7.
- `mcp-server/src/hardware-signer.js:17` -- libfido2 backend "(not yet
  implemented in v1.4.3)". v1.5.0 shipped without it; status unclear.
- `mcp-server/src/hardware-signer.js:469` -- mock-agent PEM "placeholder".
  Confirmed test-path only; not a half-feature in production.

No `throw new Error('not implemented')` patterns found in src/. The
half-features above are all "silently returns / writes TODO" style, which
is harder to detect than explicit throws.

## Recommended v1.5.1 priorities (in order)

1. **Wire or remove H1 (truncation), H2 (debug-trident), H3 (uispec-intake)**
   -- these have CHANGELOG claims that don't match runtime reality. Pick
   ONE strategy per module (wire or admit-and-defer).
2. **Consolidate the dual migration registry (M4)** -- root cause of the
   search.js bug. Make `search.js` import from `migration-runner.js`'s
   discovery output rather than maintaining its own list. This is the
   single highest-leverage v1.5.1 task.
3. **Fix the `npm test` developer-experience footgun** -- have local
   `npm test` run the same suite CI runs.
4. **Audit `bin/ijfw-memorize` LLM-synthesis path (M3/H?)** -- a production
   binary writing literal `TODO` into a user's memory file is unacceptable
   UX. Either implement or hard-error.
5. **Sweep stale TODOs and the v1.6.0-removal DEPRECATED notice (M1, M2)**
   -- 30-minute hygiene pass.
6. **H4-H8 (gate-result-formatter, worktree-guards,
   evaluator-checkpoint-contract, extension-registry-ws, memory/benchmark)**
   -- decide wire-or-delete for each.
