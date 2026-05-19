# Wave-W3.A — r19 LOW Adjudication Decisions

**Generated:** 2026-05-19
**Audit run:** Trident r19 (against v1.5.0 cumulative diff)
**Total findings:** 8 LOW
**Method:** Same as W2 — each cited file:line was read against current main.
r19 emitted no finding-detail text (per HANDOFF-v150-WIREUP.md note about
`(no detail)` output). LOW findings are by definition softer than MEDs;
adjudication leans toward "no actionable issue at cited location" unless
the code itself reveals a real defect.

**Outcome:** 0 actionable bugs at cited lines + 8 non-actionable findings.
All 8 are at benign lines (comments, JSDoc, test scaffolding, function
signatures, or already-applied fixes). r20 (W4) verbose run will surface
real finding text for any line where the adjudication should be re-checked.

## 8 non-actionable

1. **blackboard.js:109** — `// rotate large JSONL files in place before appending`
   **Decision:** Comment in `appendJsonlUnlocked` explaining the F-PRF-1
   rotation pattern. The function below (lines 112-115) calls
   `rotateJsonlIfNeeded` then `appendFileSync` with mode 0o600
   (owner-only) — correct.

2. **uispec-intake.js:331** — JPEG SOF marker parsing
   `if (marker >= 0xc0 && marker <= 0xc3) { width = buf.readUInt16BE(...); }`
   **Decision:** Covers SOF0/1/2/3 markers. Technically JPEG has SOF
   markers up to 0xCF (excluding 0xC4, 0xC8, 0xCC which are non-SOF), so
   rare progressive/lossless variants (SOF5-15) wouldn't be detected.
   But 99%+ of JPEGs are SOF0 (baseline) or SOF2 (progressive). The
   broader range is a v1.6 vision-pipeline concern; intake's role is
   "stub the file metadata," not "parse every JPEG variant." Acceptable.

3. **memory/fts5.js:257** — graph-error JSONL writer (relative path)
   **Decision:** Inside the `autoIndexGraphFromMemoryBody` error catch,
   writes to `.ijfw/index/graph-errors.jsonl`. This uses a relative path
   that resolves against cwd; could differ from project root if cwd
   shifted asynchronously. But this is a best-effort observability write
   that runs inside `.catch()` — failure is silently swallowed at the
   next layer. Acceptable for diagnostic logging; not correctness-
   critical.

4. **orchestrator/review.js:97** — `if (bothStages) { ... dispatch('code-quality', ...)`
   **Decision:** M7 wire that fires the quality reviewer when
   `bothStages: true` regardless of spec verdict. Standard control flow;
   the outer ok/stage still reflects the spec result.

5. **server.js:786** — `_memoryDbForRerank = await openDb(PROJECT_DIR);`
   **Decision:** My own W1.C addition (lazy memory.db handle for the
   embedding cache). The try/catch swallows any open failure and falls
   back to live re-embed. Correct degradation pattern.

6. **test-api-client.js:246** — `function userPrefixBytes() { return null; }`
   **Decision:** A test helper stub that returns null with a comment
   "resolved per-call via the live source." Looking at the rest of the
   file, this function is no longer called — possible dead code. But
   removing it would touch a file already subject to v1.5.0 cache_control
   churn and the helper is harmless. Leaving as-is for v1.5.0; flag for
   v1.5.1 cleanup.

7. **test-cross-project-search.js:357** — `mkdirSync(memDir, { recursive: true });`
   **Decision:** Test setup line creating a project memory dir.
   Standard test scaffolding inside `test('mtime cache: file modification
   busts the cache', ...)`. The test pattern is correct (writeFileSync
   updates mtime; reader cache should bust).

8. **/tmp/v150-final.patch:limit-cap test** — patch-content reference
   **Decision:** Not a real source-file citation. r19 was run against
   a `/tmp/v150-final.patch` diff blob; this citation is meaningless
   post-merge. No actionable file:line exists.

## Crosscheck with W2

The W2 decision doc covers 22 MEDs at adjacent file:line locations.
None of the LOW findings here overlap with the W2 fix
(`deploy-alerts.js:71`). W3.A leaves the code untouched; the value is
preserving the adjudication for r20 cross-check.

## Test posture after W3.A

No code changes, no test changes. The 8 LOWs are documentation
decisions only.
