# IJFW Benchmark Harness (scaffold)

Measures cost/quality deltas between three arms:

- **A**: `CLAUDE_DISABLE_PLUGINS=1` - baseline (no IJFW)
- **B**: `IJFW_TERSE_ONLY=1` - terse output rules only
- **C**: full IJFW

## Run

```bash
# Validate fixture, no API calls:
node core/benchmarks/run.js --task 01-bug-paginator --arm C --epochs 1 --dry-run

# Actual run (costs money):
node core/benchmarks/run.js --task 01-bug-paginator --arm C --epochs 1 --really --max-cost-usd 2

# Report:
node core/benchmarks/report.js core/benchmarks/runs/*.jsonl
```

## Cost cap

`--max-cost-usd N` (default **10**). Runner aborts the moment cumulative `total_cost_usd`
from prior epochs exceeds the cap. Set lower for smoke tests.

## Statistical caveats

- Scaffold uses **n=2 epochs per (arm, task)** - wide bootstrap CIs expected.
- Paired design: same task across all 3 arms.
- 95% CIs via paired bootstrap on per-run deltas. Full suite deferred to Phase 3.5.

## Arm A isolation warning

`CLAUDE_DISABLE_PLUGINS=1` is the intended baseline isolation mechanism. Verify
empirically that it actually disables IJFW hooks + skills before trusting Arm A
numbers as a true baseline. If not, document the caveat in the report.

## Token source of truth

`claude -p --output-format json` final-envelope `total_cost_usd` + `usage` block.

## Fixture layout

```
tasks/NN-name/
├── README.md          # prompt (identical across arms)
├── repo/              # starter code
├── tests/hidden/      # verifier runs these
├── verify.sh          # exit 0 = pass
└── manifest.json      # {category, max_turns, timeout_s, allowed_tools}
```

## Tasks in scaffold

- `01-bug-paginator` - bug-fix (Python off-by-one)
- `07-refactor-dedupe` - refactor (tests must stay green)
- `10-explore-ratelimit` - explore (file-path match)
- `11-memory-store` + `12-memory-recall` - paired memory test
