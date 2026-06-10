# How memory works

IJFW gives your AI coding tools a shared, local-first memory: decisions, project state, and observations persist as plain markdown on your machine, are indexed for fast ranked recall, and are reachable from every MCP-connected agent on your stack. Nothing leaves your disk.

This page explains the mechanism. For the headline pillar see the [README](../README.md); for retrieval-quality and competitor numbers see [Benchmarks & method](benchmarks.md); they are not duplicated here.

## What gets remembered

Memory lives under `.ijfw/memory/` in your project, as readable markdown you can open, edit, diff, or delete:

- **Decisions**: curated, durable entries in `knowledge.md` ("Postgres, not Mongo, we need the temporal queries", and the *why*). Each carries a type, a one-line summary, a stored timestamp, and tags.
- **Project state**: the rolling timeline in `project-journal.md` (append-only) and the latest `handoff.md` so a new session resumes where the last one stopped.
- **Observations**: lighter-weight signals captured as you work: patterns that recur, conventions, things learned. Most start life in the journal and only graduate to `knowledge.md` once they have proven themselves (see the dream cycle below).

A separate **team tier** under `.ijfw/team/` is git-committed, so your project's conventions ride along with the repo: a new contributor's first session inherits them. Cross-project preferences promoted from many projects live in `~/.ijfw/memory/global/`.

Everything here is markdown first. The indexes below are derived caches built *from* that markdown; if an index is ever deleted it is rebuilt from the source files on the next read.

## Storage tiers

Memory is layered so that the common case is instant and the expensive case is optional. All three tiers are local.

| Tier | Backing store | Status |
|------|---------------|--------|
| **Hot** | Plain markdown (`.ijfw/memory/*.md`) | Always on. Instant reads. Git-friendly. The source of truth. |
| **Warm** | SQLite FTS5 index (`.ijfw/index/memory.db`) | Always on. Ranked keyword retrieval. Scales to ~10,000 entries before an inverted-index cache would pay off. |
| **Cold** | Semantic vectors via `@xenova/transformers` | Off by default. Opt-in (`IJFW_VECTORS=on`). Adds dense-similarity rerank when an embedder is present. |

The warm tier is auto-built: the first search against a fresh database indexes the markdown files, and schema migrations run forward automatically (a newer-than-expected schema is refused rather than downgraded, and recall falls back to a linear scan). The cold tier binds an embedding model only when you turn it on; with vectors off, the embedder is never loaded.

## Retrieval

Recall is keyword-ranked first, optionally vector-reranked, and recency-aware.

**Lexical (BM25 / FTS5).** The warm tier ranks with Okapi BM25 (`k1=1.2`, `b=0.75`) over an FTS5 index. Natural-language queries are tokenized, stop-words dropped, and the salient terms OR-ed together so a phrase like "what did we decide about auth" doesn't starve under FTS5's implicit-AND. Quoted `"exact phrases"` are matched as phrases. If a rewritten query errors, recall retries the raw query, so a bad rewrite can never return *fewer* results than the plain search would.

**Dense rerank (optional, cold tier).** With `IJFW_VECTORS=on` and an embedder available, the BM25 top-K is reranked by cosine similarity between the query embedding and each result snippet, blended with the BM25 score (default weights ~0.6 lexical / 0.4 vector). Embeddings are cached in SQLite keyed on `sha256(snippet) + model_id`, so a repeated query over a stable corpus serves from cache with zero re-embed cost. Any embedding failure falls back to BM25 with a single stderr warning; vectors are an enhancement, never a dependency. With vectors off (the default) this step is a pure no-op.

**Recency awareness.** Results are decayed by age so "what did we decide *last*" surfaces the latest decision rather than a random old one. The recall path uses a ~90-day half-life for project memory; the bi-temporal fact layer applies a shorter exponential decay (30-day half-life for project facts, 1-day for session-scoped facts) to confidence on retrieval. Decay re-weights ranking; it does not delete anything.

> **One honest distinction.** Reciprocal Rank Fusion (RRF) of multiple rankers and multi-hop graph traversal are implemented in the benchmark adapters (`mcp-server/src/memory/bench-adapters/`), where they are measured against LoCoMo, HotpotQA and similar sets (see [benchmarks.md](benchmarks.md)). The production read path your editor calls through (`searchMemory`) is BM25/FTS5 + the optional weighted vector rerank + recency decay described above. We document what each path actually does rather than blur them together.

## Time-aware recall and cross-session indexing

Memory is bi-temporal: facts are stored with validity windows (`valid_from` / `valid_to`, Graphiti-style), so you can ask what was true *at a point in time*, not just what is true now. The `ijfw_memory_facts` tool exposes this deterministically (`getValidAt`, `getHistory`, `getAllFactsWithWindows`) over a stable `(subject, predicate, valid_at)` contract that makes temporal queries replayable.

Because journal entries are tagged by session, recall can reason across sessions: a pattern is only promoted to durable knowledge once it has been seen in **≥3 entries spanning ≥2 distinct sessions** (the round/cross-session indexing thresholds the dream cycle enforces). The effect is that recall reflects *settled* knowledge, weighted toward the recent, rather than every transient remark.

## The dream / consolidation cycle

Left alone, any memory store turns into a junk drawer. IJFW runs a consolidation pass (the "dream cycle") that keeps memory sharp instead of merely larger. Invoke it with `/consolidate`, by saying "run a dream cycle", or let it auto-fire (the session-end hook flags it roughly every 5 sessions). It does five things:

1. **Promote**: patterns that clear the threshold (≥3 journal references across ≥2 sessions, not already curated) are written into `knowledge.md` as structured entries with their extracted rationale and how-to-apply guidance.
2. **Reconcile contradictions**: when a later statement supersedes an earlier one ("use REST" → later "migrated to GraphQL"), the older entry is marked `superseded` with a date and a reconciliation note. Nothing is deleted; history matters for audit.
3. **Prune stale**: journal entries older than 14 days that never reached the promotion threshold are archived out of the active timeline (the last 30 days are always kept regardless).
4. **Compress**: near-duplicate knowledge entries are merged by structural similarity, keeping the most complete/recent version, holding the curated base to a bounded size.
5. **Cross-project promotion (opt-in)**: a pattern seen across ≥3 different projects, or one you explicitly flag, can be lifted into your global memory so every future project inherits it.

The cycle reports in positive framing only; steps that can't run (a missing journal, say) are skipped silently. The result is a memory that grows *sharper* over time, not heavier.

## Cross-tool sharing

Memory is reachable from every MCP-connected agent (Claude Code, Codex, Gemini, and the other supported platforms) through a small, local MCP server (`mcp-server/`, zero runtime dependencies, ≤14 tools by policy). The same `.ijfw/memory/` directory backs all of them, so a decision recorded while working in one tool is recallable from another. The tools you actually use:

| Tool | What it does |
|------|--------------|
| `ijfw_memory_prelude` | Per-session context projection: knowledge + team + journal + latest handoff. Replaces the 10-to-20-tool grep cascade a session would otherwise start with: one call, indexed answer. |
| `ijfw_memory_recall` | "Give me what's relevant": FTS5 + BM25 ranking with recency decay. |
| `ijfw_memory_search` | "Find this by query": keyword search; supports a `structured` format with provenance. |
| `ijfw_memory_store` | Persist an entry; the warm index updates at write time. |
| `ijfw_memory_facts` | Bi-temporal read path (`getValidAt` / `getHistory` / `getAllFactsWithWindows`). |
| `ijfw_cross_project_search` | BM25 search across other registered projects: find a decision from a different repo months ago. |

(`recall` and `search` are deliberately distinct: recall answers "what's relevant to right now", search answers "find the entry matching this query".)

## How you actually invoke it

You rarely call the tools by hand. In practice:

- **At session start**, the prelude fires automatically and your AI begins already knowing the project's decisions, conventions, and where the last session left off.
- **During work**, ask in natural language, "recall what we decided about the auth migration", "what's our database choice and why", and the agent routes to `ijfw_memory_recall` / `ijfw_memory_search` for you.
- **To save something deliberately**, "remember that we're standardizing on Vitest" stores a durable entry; most observations are captured automatically and promoted by the dream cycle rather than typed in.
- **To tidy up**, run `/consolidate` (or let it auto-fire).

Two utilities make recall auditable: `/memory-why` shows whether a result came from BM25, vectors, or the hybrid blend, and `/memory-audit` lists auto-extracted entries so you can remove any you didn't want (`ijfw memory forget <pattern>`).

## Privacy

All of this is local. Memory is markdown and SQLite on your own disk; the optional vector tier runs an on-device embedding model; the MCP server is a local process. IJFW adds nothing to pay for and sends none of your memory anywhere. You can read every byte, edit it in your editor, commit the parts you want to share with your team, and delete the rest. Nothing is recoverable by anyone but you because nothing ever left.

---

Numbers, the questions IJFW loses on, and head-to-head comparisons live in [Benchmarks & method](benchmarks.md). Back to the overview: [README](../README.md).
