# LongMemEval-S benchmark fixture

**Purpose:** baseline retrieval-quality measurement for the IJFW memory
layer (V2-M8 / D-PILLAR-SPEC §9). The benchmark provides 500 long-history
chat questions with ground-truth `answer_session_ids` per question. We
treat each haystack session as a candidate "memory file" and run the
IJFW memory-search code over it; the per-question hit lets us compute
Recall@5, Recall@10, and MRR.

**Source:** [Wu et al., ICLR 2025 — LongMemEval](https://arxiv.org/pdf/2410.10813.pdf).
Cleaned 2025-09 release. Hosted at
[huggingface.co/datasets/xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).

## Files

This directory holds the dataset JSON. **The data file itself is gitignored**
(per `.gitignore` — it is ~265 MB) so checkouts stay light. The harness at
`mcp-server/test/longmemeval-baseline.js` IS committed.

| File | Size | Tracked? |
|---|---|---|
| `longmemeval_s_cleaned.json` | ~265 MB | gitignored |
| `README.md` | ~1 KB | committed |

## Download

```sh
mkdir -p mcp-server/test/fixtures/longmemeval-s
curl -L \
  -o mcp-server/test/fixtures/longmemeval-s/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

## Run baseline

```sh
node mcp-server/test/longmemeval-baseline.js
```

Outputs JSON envelope + a one-line summary. Append the numbers as a row
to `.planning/1.3.0/D-PILLAR-SPEC.md` §9 to lock the pre-D-pillar bar.
D1+D2 must beat Recall@10 by ≥10% (or equivalent precision tradeoff) to
pass the D-pillar value gate.

## Cite

```
@article{wu2024longmemeval,
  title={LongMemEval: Benchmarking Chat Assistants on Long-Term
         Interactive Memory},
  author={Di Wu and Hongwei Wang and Wenhao Yu and Yuwei Zhang and
          Kai-Wei Chang and Dong Yu},
  journal={ICLR},
  year={2025}
}
```
