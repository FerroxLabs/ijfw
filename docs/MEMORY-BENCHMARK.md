# Memory Benchmark

IJFW ships a benchmark harness for its 3-tier memory store. It measures the
same axes the published memory benchmarks (mem0, Zep, Graphiti) report —
retrieval quality and latency — so IJFW numbers can be diffed across builds
and cited honestly.

The harness lives at `mcp-server/src/memory/benchmark.js` (IJFW v1.5.0 T22).

## Running it

```bash
ijfw metrics --benchmark
```

Flags:

| Flag          | Effect                                                              |
|---------------|---------------------------------------------------------------------|
| `--benchmark` | Runs the memory benchmark instead of the deprecated metrics redirect |
| `--json`      | Emits the full result object as JSON (also implied when not a TTY)   |
| `--no-write`  | Skips writing the JSON artifact to disk                              |

By default a JSON artifact is written to
`<project>/.ijfw/benchmarks/memory-<unix_ms>.json`. Each run is timestamped,
so artifacts accumulate and can be compared over time.

The benchmark is self-contained: it builds its own seeded corpus, ingests it
into a fresh SQLite FTS5 index, runs the query set, and tears the temp store
down. It adds zero new dependencies and does not touch your real project
memory.

The harness is also callable in-process:

```js
import { runBenchmark } from './memory/benchmark.js';
const results = await runBenchmark({ write: false });
```

## The 3-tier model

| Tier | Backing store                              | Exercised here       |
|------|--------------------------------------------|----------------------|
| Hot  | Markdown files (`.ijfw/memory/*.md`)       | Sampled (provenance) |
| Warm | SQLite FTS5 index (`.ijfw/index/memory.db`)| Yes — primary tier   |
| Cold | pgvector / embedded vectors                | Reserved axis only   |

The cold tier needs an embedding model, which the zero-dep harness does not
bind. Its axis slot is reserved so future runs can drop in numbers without
changing the artifact schema.

## The axes

### Retrieval quality

**recall@k** — fraction of queries whose gold (correct) document appears in
the top-k results. The harness reports `recall@1`, `recall@3`, and
`recall@5`. Higher is better; `1.0` means every query found its answer
within the top k. The default seeded corpus is hand-curated so a correct
porter-stemmed FTS5 search hits `recall@5 == 1.0` — a regression in the
tokenizer, synonym expansion, or result ordering shows up immediately as a
recall drop.

**MRR (Mean Reciprocal Rank)** — averages `1/rank` of the first correct
result across all queries. A result at rank 1 contributes `1.0`; rank 2
contributes `0.5`; rank 5 contributes `0.2`. MRR rewards putting the right
answer *first*, not just somewhere in the top k. Read it alongside recall:
high recall + low MRR means the answer is found but ranked poorly.

**NDCG@10 (Normalized Discounted Cumulative Gain)** — a graded ranking
metric that discounts correct results logarithmically by position and
normalizes against the ideal ordering, capped at the top 10 results. NDCG@10
of `1.0` is a perfect ranking; lower values mean correct results are pushed
down the list. Like MRR it is rank-sensitive, but it accounts for *every*
relevant result in the window, not only the first.

> Note: the artifact's `recall` block is the load-bearing quality number for
> the warm tier today. MRR and NDCG@10 are the rank-quality lenses to read
> the same result set through — recall answers "did we find it?", MRR and
> NDCG@10 answer "did we rank it well?".

### Latency

All latency axes report **p50 / p95 / p99** percentiles (plus mean / min /
max), never just the mean. Percentiles are reported because tail latency is
what users feel and because absolute numbers vary by machine — only the
*shape* of the distribution is portable across hardware.

**p95 latency** is the headline number: 95% of operations complete at or
below it. It is the honest "how fast is it, really" figure because it
ignores the lucky-fast median while not being dominated by a single
cold-cache outlier the way max would be.

- `ingest.latency_ms` — per-insert latency into the warm tier.
- `query_warm_fts5.latency_ms` — per-search latency against the FTS5 index.
- `query_hot_linear.latency_ms` — sampled hot-tier (linear regex) latency,
  reported for provenance. On a corpus larger than ~50 rows the hot tier
  *should* be slower than warm; if it is not, the warm tier is broken.

### Throughput and storage

- `ingest.throughput_rps` — rows inserted per second (single writer).
- `storage.bytes_per_memory` — on-disk database size divided by row count.
- `storage.rows_indexed` / `storage.db_bytes` — raw inputs to the above.

### Sanity axes

- `staleness_filter` — proves the warm-tier staleness filter still gates:
  a stale row is hidden by default and surfaced with `include_stale: true`.
- `query_cold_vector` — reserved `{ available: false }` schema slot.

## Interpreting results

1. **Start with recall.** `recall@5` below `1.0` on the default corpus is a
   regression — the search path stopped finding answers it used to find.
2. **Then check rank quality.** If recall is high but MRR / NDCG@10 are low,
   results are found but mis-ranked; investigate scoring and ordering.
3. **Read p95, not mean, for latency.** Compare p95 across builds on the
   *same* machine. A p95 regression is a real slowdown; a mean regression
   alone may just be one cold-cache sample.
4. **Watch p99 vs p95 spread.** A wide gap means inconsistent tail behavior
   — usually a page-cache or prepared-statement priming issue.
5. **Track `bytes_per_memory` over time.** Sudden growth points at index
   bloat or a schema change that is not paying for itself.
6. **Cross-machine comparisons are invalid for absolute latency.** Compare
   recall / MRR / NDCG@10 across machines freely; compare latency only
   build-over-build on identical hardware.

## Artifact schema

```jsonc
{
  "schema_version": 1,          // BENCHMARK_SCHEMA_VERSION — bump on shape change
  "ijfw_version": "1.5.x",
  "ts_iso": "2026-…",
  "duration_ms": 58.4,
  "corpus": { "docs": 30, "queries": 30, "query_runs": 3, "total_query_samples": 90 },
  "axes": {
    "ingest":           { "throughput_rps": …, "latency_ms": { "p50": …, "p95": …, "p99": … } },
    "query_warm_fts5":  { "latency_ms": { "p50": …, "p95": …, "p99": … }, "recall": { "recall@1": …, "recall@3": …, "recall@5": … } },
    "query_hot_linear": { "samples": …, "latency_ms": { "p50": …, "p95": … } },
    "query_cold_vector":{ "available": false, "reason": "…" },
    "storage":          { "db_bytes": …, "rows_indexed": …, "bytes_per_memory": … },
    "staleness_filter": { "default_excludes_stale": true, "stale_visible_with_flag": true }
  },
  "artifact_path": "…/.ijfw/benchmarks/memory-<unix_ms>.json"
}
```

The `schema_version` field is `BENCHMARK_SCHEMA_VERSION` in `benchmark.js`;
bump it whenever the artifact shape changes so downstream diff tooling can
detect incompatible runs.
