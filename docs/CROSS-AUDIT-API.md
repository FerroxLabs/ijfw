# Cross-Audit API — Trident-as-a-Service

**MCP tool:** `ijfw_cross_audit_converge`
**Status:** Stable (v1.5.0-major)
**Lock-in:** #47 — multi-lens consensus convergence IS the canonical Phase E.

---

## What is Trident-as-a-Service

Trident is IJFW's three-lens code review: dispatch the same diff at codex
(technical), gemini (strategic), and claude (UX/synthesis) simultaneously,
then merge their verdicts into a single consensus answer. Any project that
talks MCP can now invoke this on any commit range and get back a structured
verdict (`PASS` / `CONDITIONAL` / `FAIL` / `consensus_failed`) without
running IJFW's CLI orchestrator directly.

Multi-lens consensus is the default. Single-shot Phase E (one parallel
fan-out, no re-run) is the fallback mode — request it explicitly by
passing `maxIterations: 1`.

---

## MCP tool signature

### Input

```jsonc
{
  "commitRange":   "HEAD~1..HEAD",        // required: any valid git rev range
  "maxIterations": 3,                     // optional: 1 = single-shot, default 3
  "lenses":        ["codex","gemini","claude"]  // optional, default = those three
}
```

### Output

```jsonc
{
  "verdict":    "PASS",                   // PASS | CONDITIONAL | FAIL | consensus_failed | UNREACHABLE
  "iterations": 1,                        // how many rounds the loop ran
  "findings":   [                         // merged, each tagged with _lens
    { "severity": "high", "text": "...", "_lens": "codex" }
  ],
  "divergence": [                         // only present when verdict === consensus_failed
    { "lens": "codex", "verdict": "FAIL", "majority": "PASS" }
  ],
  "stalled":    true,                     // only present when stall-breaker fired
  "perIteration": [                       // diagnostic trace, every round
    { "iteration": 1, "lensResults": [...], "divergent": true }
  ]
}
```

---

## Convergence loop semantics

Per iteration:

1. Dispatch all configured lenses **in parallel**.
2. Each lens returns `{verdict, findings}` (or `UNREACHABLE` if its CLI/API
   is offline).
3. **Stop if reachable lenses agree on the verdict.** Findings can still
   differ — convergence is verdict-level, not finding-level.
4. **Stop if findings are byte-identical to the previous iteration** —
   re-running won't change anything (`stalled: true`).
5. **Stop if iteration count hits `maxIterations`** — `consensus_failed`
   plus the disagreement axes are surfaced to the caller.
6. Otherwise build a `CYCLE_SUMMARY` (prior verdicts + lens-vs-majority
   axes) and inject it into the next round's lens brief, then loop.

The divergence detector compares verdicts across **reachable** lenses
only — an `UNREACHABLE` lens never triggers a divergence cycle on its
own. If only one lens is reachable, the loop returns that lens's verdict
in one iteration (degraded posture; the caller can decide whether to
trust it).

---

## Example invocations

### 1. Clean commit (expected `PASS`)

```jsonc
// Request
{ "commitRange": "HEAD~1..HEAD" }

// Response (single round, all three lenses agree)
{
  "verdict": "PASS",
  "iterations": 1,
  "findings": [],
  "perIteration": [
    { "iteration": 1, "divergent": false, "lensResults": [
      { "lens": "codex",  "verdict": "PASS", "findings": [] },
      { "lens": "gemini", "verdict": "PASS", "findings": [] },
      { "lens": "claude", "verdict": "PASS", "findings": [] }
    ]}
  ]
}
```

### 2. Divergent commit that converges by round 2

```jsonc
// Request — codex catches something in round 1, others miss it, but
// after re-reading with the CYCLE_SUMMARY they update.
{ "commitRange": "main..feature/auth-refactor" }

// Response
{
  "verdict": "PASS",
  "iterations": 2,
  "findings": [],
  "perIteration": [
    { "iteration": 1, "divergent": true,  "lensResults": [...] },
    { "iteration": 2, "divergent": false, "lensResults": [...] }
  ]
}
```

### 3. Persistent divergence (`consensus_failed`)

```jsonc
// Request — lenses cannot agree even after 3 rounds.
{ "commitRange": "main..feature/contested" }

// Response — caller is told who disagreed and on what.
{
  "verdict": "consensus_failed",
  "iterations": 3,
  "findings": [ /* every finding from every lens, tagged with _lens */ ],
  "divergence": [
    { "lens": "codex",  "verdict": "FAIL", "majority": "PASS" }
  ]
}
```

### 4. Stalled (no new information)

```jsonc
// Findings byte-identical to round 1 in round 2 → halt early.
{ "commitRange": "HEAD~5..HEAD" }

{
  "verdict": "consensus_failed",
  "iterations": 2,
  "stalled": true,
  "divergence": [ { "lens": "codex", "verdict": "FAIL", "majority": "PASS" } ],
  "findings": [...]
}
```

---

## Failure modes

| Verdict             | Meaning                                                                  | Caller action                                            |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `PASS`              | All reachable lenses agree the commit range is clean.                    | Ship it.                                                 |
| `CONDITIONAL`       | All reachable lenses agree there are non-blocking findings.              | Read the findings; address or accept-and-ship.           |
| `FAIL`              | All reachable lenses agree on a blocking issue.                          | Fix the highlighted finding(s) and re-run.               |
| `consensus_failed`  | Lenses disagreed and the loop hit `maxIterations` (or stalled).          | Read `divergence` + `perIteration`; human decides.       |
| `UNREACHABLE`       | Zero lenses produced a verdict (every CLI absent and no API fallback).   | Install at least one lens CLI or configure `*_API_KEY`.  |

`stalled: true` is a flag, not a verdict — the underlying verdict is
still set (typically `consensus_failed`). It signals that re-running with
a higher `maxIterations` would burn tokens without changing the outcome.

A single-lens `UNREACHABLE` does NOT fail the run on its own — the
remaining reachable lenses continue to vote. If you want to enforce
"all three lenses must respond," check `divergence` for any
`UNREACHABLE` entries before trusting `PASS`.

---

## Comparison to single-shot Phase E

| Aspect                | Single-shot (`maxIterations: 1`)        | Convergence (default `maxIterations: 3`)        |
| --------------------- | --------------------------------------- | ----------------------------------------------- |
| Latency               | 1 lens round-trip                       | 1–3 lens round-trips                            |
| Token cost            | ~1x                                     | 1x–3x (early termination is the common case)    |
| Catches false-flag    | No — first-round divergence is final    | Yes — lens that mis-reads gets a second chance  |
| Surfaces real disputes| No — divergence silently merged         | Yes — `consensus_failed` + axes returned        |
| When to use           | Cheap pre-flight, CI smoke              | Pre-merge gates, release blockers, audits       |

**Default to convergence.** Use single-shot only when you've already
audited the commit and just need a token-cheap signal, or when the
caller is itself a loop (don't nest convergence loops).
