# Wave-W5 — Trident r21 Cross-Audit Adjudication

**Generated:** 2026-05-20
**Audit run:** Trident r21 (against cumulative diff `e0f1c4e..HEAD`, 164.5 KB,
chunked into 4 × ~58 KB)
**Lenses fired:** codex + gemini (claude was caller, recused per diversity strategy)
**Trigger:** post-compact cross-audit of the entire v1.5.0 wire-up before Phase F.
**Raw output:** `W5-R21-RAW-OUTPUT.log`

## Result

| Severity | Count | Disposition |
|---|---:|---|
| Consensus HIGH (≥2 lens) | 0 | -- |
| Single-lens HIGH | 1 | FIXED |
| MEDIUM | 4 | 3 FIXED + 1 false-positive |
| LOW | 1 | FIXED |

Ship gate: **PASS** — 0 consensus HIGH, exactly 1 single-lens HIGH (fixed in
this commit), no LOW pile-up. 5 of 6 findings actionable + fixed; 1 false
positive documented.

## Per-finding adjudication

### HIGH #1 — `gradeInteraction` returns PASS unconditionally despite a finding

**File:** `mcp-server/src/lib/ui-review-runner.js` (gradeInteraction, ~L283-292)
**Auditor text:** gradeInteraction records a Playwright baseline diff finding
but still returns verdict PASS unconditionally.
**Disposition:** REAL. Same false-PASS class as r20-HIGH-1 (gradeColor). When
`compareToBaseline` reports `pass === false`, the grader pushes a `med`
finding into `findings[]` but the return statement hard-coded
`verdict: VERDICT_PASS`. The interaction pillar would read PASS even with a
recorded baseline regression in hand.
**Fix:** derive the verdict from findings, mirroring the existing (and tested)
`gradeSecurity` pattern — `high` finding → BLOCK, any finding → FLAG, else
PASS. A true PASS now means zero findings.
**Regression test:** `test-ui-review-runner.js` — new test
`wire-W1.D (r21-HIGH): interaction pillar does not false-PASS on a playwright
baseline diff`. Plants a baseline PNG, drives `runUiReview` with a differing
candidate `png` through the hash-fallback path, asserts the interaction pillar
verdict is FLAG (not PASS) and carries the baseline-diff finding.

### MED #1 — keepalive active flag sampled after cancel

**File:** `mcp-server/src/cross-orchestrator.js` (`_finalize`, ~L1303)
**Auditor text:** the keepalive active flag is sampled after
`_keepalive.cancel()`, so `keepaliveActive` will report false even when the
heartbeat was actually wired and running.
**Disposition:** REAL. `_finalize` called `_keepalive.cancel()` and then read
`_keepalive.isActive()`. `isActive()` returns false once cancelled, so the
`keepaliveWired` receipt/return field could under-report a heartbeat that ran
the whole wave.
**Fix:** sample `isActive()` into `_keepaliveActive` BEFORE the `cancel()`
call. One-line reorder, no behavior change beyond accurate observability.

### MED #2 — `gradeSecurity` evaluator calls not failure-isolated

**File:** `mcp-server/src/lib/ui-review-runner.js` (gradeSecurity, ~L299-327)
**Auditor text:** gradeSecurity calls `evaluateA11y` and `evaluateLighthouse`
on optional peer inputs without isolating evaluator failures.
**Disposition:** REAL. Both evaluator calls were unguarded. The 7 graders run
under `Promise.all`; a throw out of any grader rejects the whole review.
`gradeInteraction` already wraps its peer-tool call (`compareToBaseline`) in
try/catch — gradeSecurity was inconsistent. Today's evaluators are defensively
coded, so this is defense-in-depth, but a malformed peer input (or a future
evaluator change) would crash the entire UI review.
**Fix:** wrap each evaluator call in try/catch; a failure surfaces as a `med`
finding (`a11y evaluation failed: …` / `lighthouse evaluation failed: …`)
instead of escaping the grader.

### MED #3 — rerank hard-codes default modelId instead of `embedder.modelId`

**File:** `mcp-server/src/search-hybrid.js`
**Auditor text:** the rerank path hard-codes the default modelId to
`IJFW_VECTORS_MODEL` or `Xenova/all-MiniLM-L6-v2` instead of using the
supplied `embedder.modelId` when a custom embedder is passed.
**Disposition:** **FALSE POSITIVE.** `search-hybrid.js` L95 reads
`const modelId = opts.modelId || embedder.modelId || null;` — it explicitly
prefers a custom embedder's `.modelId`. The `IJFW_VECTORS_MODEL ||
DEFAULT_MODEL` resolution the auditor cites lives in `vectors.js::getEmbedder()`
(L115) and is the *default embedder's own* model — used only when no custom
embedder is injected. When a custom embedder IS passed, the cache key uses
that embedder's modelId; if the custom embedder omits `.modelId`, `modelId`
falls to `null` and the cache simply disengages (safe degradation, no
mis-keyed vectors). `opts.modelId` precedence is an intentional caller
override documented in the W1.C comment block. No fix.

### MED #4 — keepalive test has thin scheduling slack

**File:** `mcp-server/test-runtime-converge.js` (W1.B keepalive tests)
**Auditor text:** the keepalive test uses a 1200ms mock delay with a 1000ms
interval, which leaves only ~200ms of scheduling slack for the tick assertion.
**Disposition:** REAL. The test's own comment promised "a wave that takes
~2.5s" but the mock dispatch used `setTimeout(..., 1200)`. With a 1000ms
keepalive interval that left a ~200ms window for the single guaranteed tick —
flaky under CI load. `IJFW_CACHE_KEEPALIVE_MS` has a documented `[1000,
300000]` floor, so lowering the interval is not an option; the wave must be
longer.
**Fix:** raise the mock dispatch delay to 2500ms in both W1.B keepalive tests
(matching the test's own documented intent). 1000ms interval over a 2500ms
wave → ~2 guaranteed ticks with comfortable margin. Adds ~2.6s wall time to
the suite — accepted in exchange for non-flakiness.

### LOW #1 — tick counter only increments on the default onTick path

**File:** `mcp-server/src/cross-orchestrator.js` (~L1271-1279)
**Auditor text:** `_keepaliveTicks` only increments for the default onTick
path, so runs with a custom `keepaliveOnTick` report zero ticks even if
heartbeats fired.
**Disposition:** REAL. The `onTick` handler was a ternary —
`keepaliveOnTick` *replaced* the counter increment when a custom callback was
supplied. `keepaliveTicks` / `keepalive_ticks` then reported 0 for any
production caller that passed `keepaliveOnTick`, masking a live heartbeat.
**Fix:** the onTick handler now always increments `_keepaliveTicks` first,
then invokes any custom `keepaliveOnTick` (guarded by try/catch so a caller
callback can never crash the wave). Counter + custom callback run together.
**Test update:** the test `wire-W1.B: caller-supplied keepaliveOnTick
overrides default counter` encoded the buggy behavior (`assert.equal(
r.keepaliveTicks, 0)`). Renamed to `…runs alongside the tick counter` and
re-asserted: `keepaliveTicks >= 1` AND `keepaliveTicks === customCalls`
(counter and custom callback increment in lockstep).

## Ship-gate verdict

- Consensus HIGH (≥2 lens): **0** ✅
- Single-lens HIGH adjudicated and FIXED: **1** ✅
- MED: 4 (3 fixed in-commit, 1 documented false-positive) ✅
- LOW: 1 (fixed in-commit) ✅
- Full regression sweep green (see commit message for the count).

Phase F push is unblocked **on the audit axis**. Operator authorization gate
remains — no push until explicit "yes, push".
