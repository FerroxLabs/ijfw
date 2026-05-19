# Wave-W4.2 — Trident r20 Adjudication

**Generated:** 2026-05-19
**Audit run:** Trident r20 (against cumulative diff `e0f1c4e..7189ef8`, 136 KB,
chunked into 3 × ~58 KB)
**Lenses fired:** codex + gemini (claude was caller, recused per
diversity strategy)
**Verbose mode:** ✅ wire-W4.a renderer fix surfaced real finding text per
finding (r19 had emitted `(no detail)` for every finding -- root cause
was the chunker normalizer + CLI renderer only checking `finding`/
`message`/`text` keys; auditors emit `description`/`issue`/`detail` etc.)

## Result

| Severity | Count | Disposition |
|---|---:|---|
| Consensus HIGH (≥2 lens) | 0 | -- |
| Single-lens HIGH | 1 | FIXED |
| MEDIUM | 6 | 5 FIXED + 1 false-positive |
| LOW | 0 | -- |

Ship gate: **PASS** — 0 consensus HIGH, ≤2 single-lens HIGH (exactly 1,
fixed in this commit), no LOW pile-up.

## Per-finding adjudication

### HIGH #1 — `gradeColor` swallows scan errors → false-PASS

**File:** `mcp-server/src/lib/ui-review-runner.js:170`
**Auditor text:** `gradeColor` passes the `scopes` array into
`scanCodeForTailwind`, then swallows any thrown error and treats drift
as empty.
**Disposition:** REAL. Confirmed by reading the code: the `catch { drift = []; }`
silently emptied drift on any scan failure, so the color pillar would
PASS even though the scan never ran.
**Fix:** capture the error message, log to stderr, surface as a FLAG
finding inside the pillar verdict. Color pillar now ALWAYS reflects
real coverage; a true PASS means the scan completed and found no drift.

### MED #1 — `--json` flag unparsed

**File:** `mcp-server/src/cross-orchestrator-cli.js:410`
**Auditor text:** `cmdUiReview` supports `parsed.json`, and the help
comment documents `--json`, but `parseArgsInner` never parses `--json`.
**Disposition:** **FALSE POSITIVE.** `--json` is handled by the OUTER
`parseArgs` function at lines 211-218, which strips it before delegating
to `parseArgsInner` and sets `out.json = json`. The flag works. No fix.

### MED #2 — `peakConcurrent` witness scope

**File:** `mcp-server/src/lib/ui-review-runner.js:394`
**Auditor text:** the `peakConcurrent` witness increments before the
actual synchronous grader work, so `parallel.parallelism` can report
true even though all grader bodies execute serially on the event loop.
**Disposition:** Real but UNDERSTOOD. The witness proves Promise.all
DISPATCH concurrency (all 7 wrappers enter same tick), not BODY overlap
on sync work (sync code serializes by definition). The lib design keeps
graders cheap + sync so the runner stays fast; async graders would
naturally exhibit body interleaving.
**Fix:** tightened the runner's inline comment block to make the
semantic guarantee explicit ("Promise.all dispatch is concurrent" — not
"sync bodies overlap"). No behavior change; docs only.

### MED #3 — lazy cache DB skipped on embedder presence

**File:** `mcp-server/src/server.js:855`
**Auditor text:** the lazy cache DB is skipped whenever `opts.embedder`
is present, even if the caller did not supply `opts.db`.
**Disposition:** REAL. The original guard `if (!rerankOpts.db && opts.embedder !== undefined)`
was meant as a test seam but lost the cache for any production caller
passing a custom embedder.
**Fix:** lazy-open whenever `!opts.db AND opts.db !== null`. Tests that
need to disable the cache pass `opts.db = null` explicitly.

### MED #4 — migration 005 doesn't replace old schema

**File:** `mcp-server/src/memory/migrations/005-vector-cache.js:31`
**Auditor text:** Migration 005 uses CREATE TABLE IF NOT EXISTS after
changing the schema from `memory_id` to `cache_key`, so an environment
that already applied the earlier v5 migration keeps the incompatible
old table.
**Disposition:** REAL — for developer machines that built from source
between the schema-change commit and the W1.C commit. Migration 005
was net-new in v1.5.0 (never shipped to npm), so production users are
unaffected.
**Fix:** `DROP TABLE IF EXISTS memory_entry_vectors` before `CREATE`.
No-op on a fresh db; on a stale dev db, the old PK structure is
replaced. Since 005 was unshipped there are no production rows to
preserve.

### MED #5 — color-pillar test accepts PASS for hostile case

**File:** `mcp-server/test-ui-review-runner.js:196`
**Auditor text:** the unauthorized-color test claims the color pillar
must FLAG or BLOCK, but the assertion explicitly accepts PASS.
**Disposition:** REAL. The assertion `['FLAG', 'BLOCK', 'PASS']` made
the test useless — a regression where the scanner missed pink-500 would
still pass.
**Fix:** tightened to `['FLAG', 'BLOCK']` only, and added a
`findings.length > 0` assertion so the hostile token MUST be observed.

### MED #6 — "byte-identical" test doesn't compare both briefs

**File:** `mcp-server/test-repo-map-wire.js:184`
**Auditor text:** the byte-identical opt-out test does not compare
against `handleTruncation` output and only checks the brief prefix
plus `repoMapApplied`.
**Disposition:** REAL. The test name promised byte-equivalence; the
body only spot-checked the prefix.
**Fix:** the test now actually calls `handleTruncation(args)` AND
`handleTruncationWithRepoMap({...args, env: {}})` with the same inputs
and asserts `asyncDecision.brief === syncDecision.brief`. Real byte
compare.

## Ship-gate verdict

- Consensus HIGH (>=2 lens): **0** ✅
- Single-lens HIGH adjudicated and FIXED: **1** ✅
- MED adjudicated: 6 (5 fixed in-commit, 1 documented false-positive) ✅
- Wire-W4.a value: every r20 finding came with verbose detail. The
  field-name-fallback widening was the right call.

Phase F push is unblocked **on the audit axis**. Operator authorization
gate remains.
