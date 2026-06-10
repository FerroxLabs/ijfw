# Benchmarks & method

How we measure IJFW's memory layer against the field: the harness, the honest re-run, the numbers, and where IJFW does *not* win. Linked from the **Proof** section of the [README](../README.md).

## Standing limitation (read this first)

Ferrox Labs **authored this benchmark and competes in it.** That is a real conflict of interest, and we state it up front. These results are **directional, not peer-reviewed.** One leg (LoCoMo) is distributed hash-only and is not publicly reproducible from this repo: it is a replication leg, not a verification leg. The primary axis is *memory-as-retrieval-substrate*, not end-to-end products. Read everything below through that lens, and reproduce the license-clean cells yourself before relying on them.

## Why our numbers are *lower* than the field's headlines

The published memory benchmarks routinely report **80–92% on LoCoMo.** When we traced those scores back through the public eval source (Mem0's and MemMachine's own harnesses, corroborated against Zep's and a third-party audit), the gap turned out to be a **grading artifact**, not a capability difference. Three things inflate it:

1. **A single lenient LLM judge** that accepts near-misses and paraphrase as correct.
2. **Deleted hard categories:** the adversarial bucket (LoCoMo cat-5) is dropped from the denominator entirely in several published runs.
3. **Spoon-fed hints:** the question prompt leaks the session or fact the answer lives in.

Our re-run removes all three. So our honest numbers are *lower than the field's loud ones*, and **that is the point.** A benchmark you can game upward is not measuring memory; it is measuring how forgiving the grader is. We would rather show a defensible 0.61 than an ungrounded 0.91.

## Method

- **License-clean harness, MIT data.** The headline TEST cells run on HotpotQA and longmemeval (both publicly licensed) through one uniform `BenchAdapter` contract, so every system (ours and competitors') is ingested and queried identically. LoCoMo is run on the same harness but reported separately as the non-commercial replication leg.
- **Pinned model IDs.** Every cell records the exact model strings (answer, embed, and judge), so a result is reproducible against a known frontier snapshot rather than a moving "latest". Embeddings: `text-embedding-3-small` across all subjects.
- **Three-model judge panel.** Grading is not one model's opinion. Each answer is scored by a panel (`anthropic:claude-opus-4-8`, `google:gemini-3.1-pro-preview`, `openai:gpt-5.5`) against non-circular gold. The single-lenient-judge failure mode above is the specific thing this defends against.
- **DEV / TEST split (overfit firewall).** Levers are tuned on DEV; every headline number below is the held-out **TEST** split. We never report a tuned-on number as a result.
- **Paired McNemar + Holm correction.** Head-to-head claims use the paired McNemar test on per-item agreement, Holm-corrected across the whole family of 16 comparisons. **A "win" requires Holm-corrected p < 0.05 *and* gains > losses on TEST. Everything else is reported as a tie.** We do not promote a raw-p near-miss to a win.
- **Bootstrap CIs, never bare points.** Every mean below carries a 95% bootstrap confidence interval.
- **No silent gaps.** Cells that did not finish (DNF) or failed validity are excluded from every mean *and listed* in the coverage table, never quietly dropped.

## Results

### Memory beats no-memory (the load-bearing claim)

On longmemeval (MIT, n=138, panel-graded), IJFW reaches **0.6087** [0.529, 0.696]. The closed-book ceiling (the same model answering with *no* retrieved memory) sits at **0.058** [0.022, 0.101]. That is roughly **+55 points** from the memory layer alone, and the McNemar verdict (IJFW vs closed-book, n=346 on HotpotQA, 121 wins to 31, Holm p < 0.0001) is a decisive win. This is the claim the whole product rests on, and it is the one that holds most cleanly.

### Head-to-head vs the memory layer

**longmemeval (MIT, n=138, TEST, accuracy):**

| System | Accuracy | 95% CI |
|---|---|---|
| mem0 | 0.6159 | [0.536, 0.696] |
| **IJFW** | **0.6087** | [0.529, 0.696] |
| letta | 0.5507 | [0.471, 0.638] |
| zep | 0.2609 | [0.188, 0.341] |
| _closed-book ceiling_ | _0.0580_ | _[0.022, 0.101]_ |

Paired McNemar (Holm-corrected): **IJFW vs mem0 = tie. IJFW vs letta = tie. IJFW beats zep** (52 wins to 4, Holm p < 0.0001). We state the ties as ties: at this n, IJFW and mem0 are statistically indistinguishable on longmemeval, and so are IJFW and letta. We are *not* claiming to beat mem0 here.

**HotpotQA (MIT, n=349, TEST, accuracy):**

| System | Accuracy | 95% CI |
|---|---|---|
| _pure-llm (ceiling control)_ | _0.8448_ | _[0.805, 0.882]_ |
| mem0 | 0.6590 | [0.607, 0.708] |
| letta | 0.6504 | [0.602, 0.699] |
| **IJFW** | **0.6132** | [0.562, 0.662] |
| closed-book | 0.3497 | [0.298, 0.399] |

Paired McNemar (Holm-corrected): **IJFW vs letta = tie** (18 wins to 31, Holm p = 0.43). **IJFW vs mem0 = tie** (21 wins to 37, Holm p = 0.29). IJFW decisively beats closed-book. On HotpotQA the point estimates put mem0 and letta a few points above IJFW, but the difference does not clear the significance bar, so the honest verdict is a three-way tie among IJFW, letta, and mem0, all comfortably above closed-book.

### Temporal recall: where IJFW separates

On the LoCoMo **temporal** split, the gap is not subtle:

| System | Temporal accuracy |
|---|---|
| **IJFW** | **0.676** |
| mem0 | 0.000 |
| letta | 0.000 |
| zep | 0.000 |

All three competitors score **zero** on time-ordered recall; IJFW's read-time temporal injection lever carries it to 0.676. This is the one dimension where IJFW is not tied: it is categorically ahead. **Caveat:** the temporal lever was validated partly against a *synthetic* contamination-free control (DevMembench), and LoCoMo itself is the hash-only replication leg, so treat this as a strong directional finding, not a settled third-party result.

## Where IJFW does NOT win

We are not cherry-picking, so here is the unflattering side of the same data:

- **pure-llm beats IJFW on HotpotQA (0.8448 vs 0.6132), and it is a real Holm-significant win.** pure-llm stuffs the *entire* document into context with no retrieval at all. It is an **upper-ceiling control, not a deployable memory system** (it does not scale to long histories and it is not what you run in production), but on a short-context QA task where the whole haystack fits, full-context reading beats any retrieval layer, including ours. We show it precisely because it bounds how much headroom retrieval is leaving on the table.
- **IJFW is tied, not ahead, on the two MIT accuracy headlines.** Tie with mem0 and letta on longmemeval; tie with mem0 and letta on HotpotQA. The memory-layer field is genuinely competitive on plain QA; IJFW's edge is temporal recall and the cost frontier (below), not raw single-shot accuracy.
- **DNF, disclosed:** pure-llm **did not finish** longmemeval (22.46% of its queries errored, long-context degradation, over our 2% validity threshold), so it is excluded from the longmemeval table above rather than scored on partial data.
- **Temporal is synth-bound** and **LoCoMo is hash-only**, as flagged above.

## Cost frontier (the other half of the story)

Accuracy is a tie on plain QA; ingest cost is not. The difference is **architectural, not tunable**: IJFW indexes into FTS5 (near-free), while per-record-LLM-extraction systems pay an LLM call per stored record:

| System | Dataset | Ingest wall (measured identically) |
|---|---|---|
| **IJFW** | longmemeval | **61 s** |
| letta | longmemeval | 1,071 s (~18 min) |
| mem0 | longmemeval | 18,634 s (~5.2 hr) |
| zep | longmemeval | 41,588 s (~11.6 hr) |

Ingest **wall-clock** is measured the same way for every subject; competitor ingest **dollar** cost is reported as `n/a` (their Python sidecars do not expose provider token usage, and we refuse to synthesize a competitor's cost number). Read the comparison off the symmetric wall-clock column.

## Reproducibility

The full QA-accuracy harness (LoCoMo, HotpotQA, longmemeval, plus the competitor adapters and the judge panel) is research tooling and lives in IJFW's **separate, internal lab-study repository**, not in the shipped product. Every result cell there carries a full provenance block: git SHA, dataset content hash, engine and config signatures, the pinned judge panel, seed (`42`), and the exact one-line command that regenerates it. The MIT-licensed cells (HotpotQA, longmemeval) are reproducible from that repo. The non-commercial LoCoMo cells require the licensed dataset; only derived metrics plus a content hash are reported, so a result can be *checked* but not silently swapped, and the dataset text itself is never redistributed.

The product ships its own self-contained **retrieval-quality** harness (recall@k / MRR / NDCG@10 / p95 latency on the warm FTS5 tier), documented in [docs/MEMORY-BENCHMARK.md](MEMORY-BENCHMARK.md) and run with `ijfw metrics --benchmark`.

---

*The QA-accuracy result set, competitor adapters, and per-cell provenance live in IJFW's separate, internal lab-study repository; the product ships only the retrieval-quality harness (`ijfw metrics --benchmark`). Back to the [README](../README.md).*
