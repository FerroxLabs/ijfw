# IJFW Benchmark Report 001

**Date:** 2026-04-14
**Task:** `01-bug-paginator` (single-file off-by-one bug fix)
**Model:** `claude-sonnet-4-5` via `claude -p --output-format json`
**Epochs:** 1 per arm (n=1, scaffold - wide uncertainty)
**Total spend:** $0.675 (well under the $2.25 cap)

## Arms

- **A** - `CLAUDE_DISABLE_PLUGINS=1` (baseline, no IJFW)
- **B** - `IJFW_TERSE_ONLY=1` (IJFW output rules only)
- **C** - full IJFW (all skills, hooks, routing active)

## Results

| Arm | Cost | Duration | Input tokens | Output tokens | Cache-creation | Cache-read |
|-----|------|----------|--------------|---------------|----------------|------------|
| A   | $0.2770 | 105.7s | 74 | 4042 | 34,813 | 285,298 |
| B   | $0.2339 | 80.6s  | 53 | 3295 | 34,198 | 186,908 |
| C   | $0.1636 | 145.8s | 46 | 3221 | 17,020 | 171,077 |

## Deltas vs baseline (Arm A)

| Contrast | Cost delta | Output-token delta | Cache-create delta |
|----------|--------|----------------|----------------|
| B - A | **-15.6%** | -18.5% | -1.8% |
| **C - A** | **-41.0%** | **-20.3%** | **-51.1%** |
| C - B | -30.1% | -2.2% | -50.2% |

## What this tells us (honest read, n=1)

- **Cost reduction is real.** Full IJFW (Arm C) on this task delivered a
  **41% cost reduction vs unconstrained baseline.** Most of that comes
  from cache-creation (-51%) - IJFW's context discipline means Claude
  re-caches less per session.
- **Output discipline pays.** Both B and C cut output tokens by ~20%
  relative to baseline - the `ijfw-core` output rules are doing real work.
- **C takes longer wall-clock** (146s vs 106s A) but costs less. More
  turns at lower per-turn cost. Acceptable trade.
- **Terse-only (B) is surprisingly competitive on cost** (-15.6%) but
  buys less than the full stack on cache-creation. The routing + context
  discipline beyond output rules is where the remaining savings live.

## Calibrating `IJFW_BASELINE_FACTOR`

The Stop-hook savings reframe (W1.3) defaulted to **1.65x** as the
unconstrained/IJFW output ratio. Measured on this one task:

| Comparison | Ratio |
|------------|-------|
| Arm A output / Arm C output | 4042 / 3221 = **1.255x** |
| Arm A cost / Arm C cost     | $0.2770 / $0.1636 = **1.693x** |

The token ratio is lower than 1.65; the cost ratio is close to it
(driven by cache-creation savings that don't show up in output-token
count). For the Stop-hook savings line:

- **If we measure tokens only**, default should drop to `~1.25`.
- **If we measure cost equivalent**, `~1.7` is close to right.

For W1.3 honesty: **default factor updated to 1.25** (token-based).
Users who want cost-based framing set `IJFW_BASELINE_FACTOR=1.7`
explicitly.

## Caveats

1. **n=1.** Bootstrap CI is degenerate. These numbers are directional,
   not conclusive. Re-run with n=3-5 in Phase 3.5 for real CI.
2. **One task, one category.** Bug-fix tasks exercise the edit path.
   Explore / refactor / memory tasks may behave differently.
3. **Model-specific.** Ratios measured on Sonnet 4.5; Opus/Haiku may
   compress differently (Opus has more room to ramble → bigger IJFW win
   expected).
4. **Arm A isolation assumed.** `CLAUDE_DISABLE_PLUGINS=1` was used to
   disable IJFW for baseline. Not empirically verified that it fully
   disables hooks (audit carry-over E4 → W5).
5. **Cache-creation is session-floor.** ~17-35k cache-creation tokens
   per session is Claude Code's own context priming. IJFW's win on this
   dimension likely reflects shorter tool-use chains, not fewer tools.

## Reproducibility

```bash
for arm in A B C; do
  node core/benchmarks/run.js --task 01-bug-paginator --arm "$arm" \
    --epochs 1 --really --max-cost-usd 0.75 --model claude-sonnet-4-5
done
node core/benchmarks/report.js core/benchmarks/runs/*.jsonl
```

Raw JSONL: `core/benchmarks/runs/runs-2026-04-14.jsonl`.
