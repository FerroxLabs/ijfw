# TRIDENT r22 — v1.5.0 Memory Moat Amendment Cross-Audit

**Date:** 2026-05-21
**Diff anchor:** `3d8536c..HEAD` (HEAD = `071c9e4`)
**Patch size:** 51,511 bytes / 1,310 lines / 18 files
**Scope:** memory-moat amendment to v1.5.0 (M1-M5 + M-INT.1-7)

---

## 0. Methodology

**Intended:** 3-lens cross-audit (codex + gemini + claude/opus) via `ijfw cross audit
.planning/v150-gap-closure/r22-diff.patch --chunk`.

**Actual:** Single-lens claude/opus self-audit. Documented T32 failure pattern:

- **codex lens** — HTTP 404 from OpenAI backend on every chunk (confirmed T32 SYNTHESIS,
  no infra fix shipped since v1.5.0 ship).
- **gemini lens** — API timeout on diffs >30KB (documented memory entry
  `gemini-trident-timeout-pattern`, deferred to v1.5.1 H1.6).
- **claude/opus lens** — performed below. Read 100% of the diff, structural lens
  sweeps via grep against the live tree.

Per handoff §F.2 fallback protocol: "If codex 404 or gemini timeout (the T32 pattern),
fall back to opus self-audit — document honestly." That is what follows.

Honesty caveat: a single-lens audit cannot catch the same class of fault that an
independent lens would. The findings below are the result of structural sweeps for
known fault classes (migration registries, schema-altering ALTER TABLE, fire-and-
forget races, cap-asserts, double-loaded modules). Any subtle code-quality issue
not surfaced by a structural sweep is by definition outside this audit's window.

---

## 1. Audit lenses applied

| Lens | Question | Result |
|---|---|---|
| L1 | Any OTHER file hardcodes the memory migration list? | Clean — only `search.js`, fixed in INT.7 |
| L2 | Any other `highestMigrationVersion` / `MEMORY_MIGRATIONS` duplicate? | Clean — only `search.js` |
| L3 | Any "12" tool-cap straggler that should be "13"? | 4 stale comments — LOW |
| L4 | Any legacy `.dream-state.json` reader unaware of `-v2.json` collision? | Intentional dual-path per handoff §3.3; one stale docstring — LOW |
| L5 | Migrations 006/007/008 idempotent on re-run? | Clean — `IF NOT EXISTS` / `PRAGMA table_info` guards present |
| L6 | autoLink env-gate order — does the off-path skip DB work? | Clean (INT.2 commit `13ddc99`) |
| L7 | state-SDK telemetry sink — payload contract matches state-SDK output? | Clean (INT.3 verified by test-skill-telemetry) |
| L8 | bi-temporal MCP verb — surfaces the underlying temporal API? | Clean (test-memory-facts-mcp 3/3 green) |

---

## 2. Findings

### HIGH — 1 finding (closed before audit fired)

#### r22-H1 — `search.js` migration registry omits 006/007/008

**File:** `mcp-server/src/memory/search.js:57-70` (pre-fix)
**Status:** **CLOSED** by commit `071c9e4` (INT.7) before this audit synthesis was written.
**Severity if shipped:** HIGH — silent search degradation on every v1.5.0 db.

**Cause:** `search.js` maintains its own `MEMORY_MIGRATIONS` registry separate from
the one `migration-runner.js` discovers. The plan added migrations 006/007/008 to
the directory but did not add the corresponding `await import('./migrations/00X-…')`
lines to `loadMemoryMigrationsSync()`. When `openDb` (from `fts5.js`) brings any db
to user_version=8, `searchMemory` saw `current=8 > target=5` and hit the "newer
schema — refuse rather than downgrade" branch, closing the db and falling back to
linear file search — silently.

**Surfaces caught:**
- `test-d1-tier-semantic.js` — D1 tier_semantic filter (`expected >=3 hits, got 1`)
- `test-memory-fts5.js` — GA-B2 `include_stale` (default-exclusion guard never ran)

Both tests pass at baseline `3d8536c`, regressed at HEAD pre-fix, restored at HEAD
post-fix. test-search-hybrid + test-memory-search + test-search-bm25 + the two
repaired files = 101/101 + 1 skip at post-fix HEAD.

**Root cause class — DUAL MIGRATION REGISTRIES.** `fts5.js` discovers migrations
from disk via `migration-runner.js`. `search.js` hardcodes a literal list. The
registries drift independently. Audit lens L2 confirmed this is the only such
duplication in the tree. Full consolidation belongs in v1.5.1 — `search.js` should
also use `migration-runner.js`'s discovery path so the next migration is auto-
picked-up.

### MED — 0 findings

(None surfaced by the structural sweeps. A second-lens audit would tighten this
claim but is unavailable per §0.)

### LOW — 4 findings (defer to v1.5.1)

#### r22-L1 — Stale "12" MCP cap references in comments

**Files & lines:**
- `mcp-server/src/update-apply.js:10` — `MCP-tool slot (see CLAUDE.md "MCP server: ≤12 tools" cap)`
- `mcp-server/src/server.js:1091` — `keeping the MCP cap at 12/12`
- `mcp-server/src/orchestrator/plan-checker.js:5` — `cap is full at 12/12`
- `mcp-server/test-tool-cap.js:13` — docstring `result.tools.length === 12`

**Behavior:** Cap is correctly raised to 13 (verified — `EXPECTED_COUNT = 13` at
test-tool-cap.js:59; test.js line 105 comment says "fixes the cap at 13"). The
above 4 instances are stale comments only.

**Disposition:** Sweep in v1.5.1 cleanup. Behavioral risk = zero.

#### r22-L2 — `runner.mjs` file-level docstring describes the OLD 4h cooldown

**File:** `mcp-server/src/dream/runner.mjs:12`
**Stale text:** `1. Cooldown check (4h via .ijfw/.dream-state.json) -- skip on hit.`

**Reality after M4.4:** The 4h cooldown was replaced by a 30-min idle gate via
`state-file-v2.json` + per-stage isolation. The legacy `cooldown.markCompleted()`
is preserved as the final stage of the new pipeline (intentional, per handoff §3.3),
but the leading docstring claims "4h" is the primary gate. Confusing.

**Disposition:** Doc-only refresh in v1.5.1.

#### r22-L3 — autoLink debug stderr line is verbose in test harness when API key set

**File:** `mcp-server/src/memory/fts5.js:265` (the `.catch(...)` line that emits
`[fts5] autoLink failed:`)

**Behavior:** When `ANTHROPIC_API_KEY` is set in the environment and a test calls
`closeDb(db)` synchronously after `indexEntry()`, the fire-and-forget autoLink
chain may race the close and write `[fts5] autoLink failed: The database connection
is not open` to stderr. This is captured (per `// best-effort`) so does not affect
test outcomes, but it's noise that masks real signals during sweeps.

The INT.2 env-gate-at-top change short-circuits when `IJFW_AUTOLINK_OFF=1` or no
API key — so the noise only appears when callers explicitly opt in to live LLM
calls. All memory-moat test files set `IJFW_AUTOLINK_OFF=1` at module top. Other
tests inheriting an env API key will see the noise.

**Disposition:** Acceptable. v1.5.1 could add a "swallow if-and-only-if db.close()
was the cause" predicate, but the current behavior is honest and contained.

#### r22-L4 — Trident r22 ran single-lens (codex 404, gemini timeout per T32)

**Cause:** No infra fix shipped between T32 and r22. codex auth path 404s on every
chunk; gemini API times out on diffs >30KB. This is documented in
`gemini-trident-timeout-pattern` memory and T32 SYNTHESIS.md.

**Disposition:** v1.5.1 H1.6 / H1.7 — codex retry policy + gemini per-chunk hard
timeout escalation. Tracking-only for v1.5.0 ship; r22 covers the diff via
structural sweeps + claude/opus reading 100% of the patch.

---

## 3. Verdict

**Memory-moat amendment is SHIPPABLE.** No HIGH findings remain open after INT.7.
4 LOW findings (3 doc-drift + 1 single-lens caveat) deferred to v1.5.1.

Test surface at HEAD `071c9e4`:
- `npm test`: 104/104 ✓
- 12 new memory-moat test files: 59/59 ✓
- search-impacted regression set (5 files): 100/100 + 1 skip ✓
- node:test full sweep on test-*.js: green modulo 4 pre-existing baseline fails
  (publishConfig, checkpoint, drainCheckpoints x2) + 2 import-time hangs documented
  in handoff §3
- `bash scripts/e2e-smoke.sh`: green modulo the 2 documented pre-existing fails
  (scope leak / version mismatch)

---

## 4. Closed/Deferred summary

| ID | Class | Status | Owner |
|---|---|---|---|
| r22-H1 | search.js dual-registry | CLOSED in commit `071c9e4` (INT.7) | this session |
| r22-L1 | MCP cap "12" comment drift | DEFERRED to v1.5.1 cleanup | v1.5.1 |
| r22-L2 | runner.mjs docstring drift | DEFERRED to v1.5.1 doc-sweep | v1.5.1 |
| r22-L3 | autoLink stderr race noise | DEFERRED to v1.5.1 H1.x | v1.5.1 |
| r22-L4 | single-lens caveat | DEFERRED to v1.5.1 H1.6/H1.7 (trident infra) | v1.5.1 |

---

**Author:** claude/opus (single-lens fallback per documented T32 pattern)
**Honesty:** the single-lens audit is a known degradation vs the 3-lens design.
The structural sweeps applied (L1-L8) cover the same fault classes the lenses
historically catch in this repo, but a second-lens run on v1.5.1 should verify the
deferred items did not hide a peer-detectable HIGH.
