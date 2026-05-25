# IJFW Brain — M1 → M2/B/C Interface Contract

Locked at v1.5.2. This document specifies the contract Plans B (dashboard memory panel) and C (Wayland portal PR) consume from Plan A's runtime. Any breaking change to a shape listed here requires a new milestone version + a contract amendment.

## 1. MCP Surface

One new MCP tool added in v1.5.2:

### `ijfw_brain`

Combined verb-based tool. Input shape:

```json
{ "verb": "<verb>", "args": { ... } }
```

#### Verbs

| Verb | Args | Returns |
|------|------|---------|
| `think` | `{ query: string }` | `{ ok, answer, citations: [{kind, id}], citationsResolved: bool, unresolved: [], gaps: [] }` |
| `links` | `{ of: string }` | `{ ok, of, incoming: [{memory_id, count}], outgoing: [{target, count}], incomingCount }` |
| `wiki.get` | `{ slug: string }` | `{ ok, slug, path, type, markdown }` |
| `wiki.compile` | `{ subject, type? }` | `{ ok, pagePath, factsCount, historyRows }` or `{ ok: false, error, unresolved? }` |
| `wiki.promote` | `{ slug: string }` | `{ ok, slug, type, src, dst }` |
| `wiki.export` | `{ slug, outFile }` | `{ ok, outFile, bytes, linkedPagesIncluded }` |
| `wiki.shareReadme` | `{}` | `{ ok, outFile, bytes }` |
| `conflict.resolve` | `{ subject, predicate, winnerId, supersede?: bool=true }` | `{ ok, resolved, winnerId, supersededIds }` |

Cap impact: 13 → 14 (one new combined tool; verbs do not count toward the cap).

## 2. On-Disk Layout

Layout version is tracked by `<repoRoot>/.ijfw/.layout-version`:
- `1` (or missing) — legacy hidden layout (`.ijfw/memory/`, `.ijfw/sessions/`)
- `2` — visible layer (`ijfw/memory/`, `ijfw/sessions/`, `ijfw/dump/`, `ijfw/wiki/`)

```
<repoRoot>/
├── .ijfw/                 ← HIDDEN (gitignored): tool internals
│   ├── .layout-version    ← sentinel
│   ├── .migrate.lock      ← exclusive file lock during migration
│   ├── index/memory.db    ← FTS5 / facts index db
│   ├── state/             ← runtime state
│   ├── metrics/           ← brain-spend.jsonl, telemetry
│   ├── receipts/          ← dream-cycle receipts
│   └── facts.jsonl        ← write-ahead facts log
└── ijfw/                  ← VISIBLE (user's git choice): content
    ├── memory/            ← knowledge.md, handoff.md, journal.md
    ├── sessions/          ← per-session logs
    ├── dump/
    │   ├── inbox/         ← drop files here
    │   └── processed/     ← committed after ingest + <name>.manifest.json
    └── wiki/              ← LLM-curated, Obsidian-readable
        ├── concepts/, entities/, decisions/, milestones/
        ├── index.md, log.md
```

## 3. File Formats

### Manifest (`ijfw/dump/processed/<name>.manifest.json`)

```json
{
  "cycleId": "cycle-<epoch-ms>",
  "ts": "<iso8601>",
  "sizeBytes": <int>,
  "kind": "markdown" | "text" | "transcript" | "pdf",
  "factsInserted": <int>,
  "touchedSubjects": ["<subject>", ...]
}
```

Atomic write contract: written as `<name>.manifest.json.tmp` then renamed. `isProcessed(processedDir, fileName)` returns true iff the final manifest exists.

### Wiki Page Sentinels

Wiki pages contain operator-owned NOTES regions outside the AUTO sentinels. The compiler must preserve everything outside the sentinels verbatim.

```markdown
# <subject>

<!-- ijfw:auto:begin section="current-state" -->
- predicate: **object** [fact:N] [mem:N]
...
<!-- ijfw:auto:end section="current-state" -->

## Operator notes (NOTES region — preserved verbatim)
hand-written text stays untouched.

<!-- ijfw:auto:begin section="history" -->
- 2024-01-15: predicate = **object** [fact:N] [mem:N]
...
_Older: 55 events between 2023-01-01 and 2023-12-31._
<!-- ijfw:auto:end section="history" -->

<!-- ijfw:auto:begin section="backlinks" -->
- [[target]] (3 links)
<!-- ijfw:auto:end section="backlinks" -->

<!-- ijfw:auto:begin section="sources" -->
- `/notes/a.md` (markdown) — 4 mentions
<!-- ijfw:auto:end section="sources" -->
```

### Citation Token Format

- `[mem:N]` — references `memory_entries.id = N`
- `[fact:N]` — references `facts.id = N`

The compiler rejects a page if any cite is unresolved (Trident F-B1).

### Wikilink Format

Obsidian-style `[[target]]` or `[[target|display]]`. Target is the slug (lowercased, non-alphanum → `-`).

## 4. IPC / Transport

MCP transport: **stdio JSON-RPC 2.0**, one message per line. Either spawn the IJFW MCP server fresh (`node mcp-server/index.mjs`) or attach to an already-running instance via the user's CLI configuration.

Tool call shape (standard MCP):
```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "ijfw_brain", "arguments": { "verb": "wiki.get", "args": { "slug": "sean" } } } }
```

## 5. File Watching (M2 Wayland portal sync)

Recommended:
- Library: `chokidar@^4.0.1` (already added in Plan A Task 1)
- Watch globs: `<repoRoot>/ijfw/**/*.md`
- Debounce: 250ms (collapse bursts of saves)
- Ignored: `<repoRoot>/.ijfw/**` (internal state — never watch)

## 6. Deep Link URI Scheme (M2)

Wayland portal registers `ijfw://` URIs:

| URI | Action |
|-----|--------|
| `ijfw://memory/<slug>` | open the wiki page for slug |
| `ijfw://search?q=<query>` | open search with query pre-filled |
| `ijfw://dump/inbox` | open dump inbox view |
| `ijfw://project/<projectName>` | switch to the project's brain |

## 7. Discovery Protocol

Two sources, registry wins on duplicate:

1. Registry: `~/.ijfw/registry.md` lines of form `- [name](/abs/path)` — operator-curated.
2. Filesystem scan (opt-in): walk caller-supplied dev roots (max-depth 3 by default). Skip `node_modules` + dotdirs. Stop descending once an `ijfw/` or `.ijfw/` marker hits.

`discoverProjects({homeDir, scanRoots, maxDepth})` returns `[{name, path, kind: 'v2'|'legacy', fromRegistry: bool}]`.

## 8. Cost Telemetry

Path: `<repoRoot>/.ijfw/metrics/brain-spend.jsonl`
Line shape:
```json
{ "day": "YYYY-MM-DD", "cycleId": "cycle-...", "usd": 0.0123, "ts": <epoch-ms> }
```
Append-only. Consumers MUST tolerate missing file as zero spend.

Budget envelopes (env-controlled):
- `IJFW_DREAM_BUDGET_USD` — per-cycle cap (default $0.50)
- `IJFW_DREAM_BUDGET_DAY_USD` — per-day cap (default $5.00)
- Separate from the legacy `IJFW_AUTOLINK_BUDGET_USD` (A-Mem auto-linker)
- `IJFW_BRAIN_LOCAL_URL` — Ollama-compatible local endpoint to try first

## 9. Tiered LLM Routing

`callTiered(tier, prompt, opts)` from `mcp-server/src/brain/tiered-llm.js`:

| Tier | Default model | Env override |
|------|---------------|--------------|
| `extract` | `claude-haiku-4-5-20251001` | `IJFW_BRAIN_EXTRACT_MODEL` |
| `synth` | `claude-sonnet-4-6` | `IJFW_BRAIN_SYNTH_MODEL` |

Default per-tier max_tokens: extract=512, synth=1500. Local-first when `IJFW_BRAIN_LOCAL_URL` is set; falls back to Anthropic on any local error.

## 10. Context Injection (env-gated)

Set `IJFW_BRAIN_INJECT=auto` (or `always`) to have `handlePrelude` append the top-N most-recently-touched wiki pages to the prelude. Default `never` = zero behavior change.

## 11. Layout Migration Behavior

Migration 010 (filesystem-only, NOT a SQL migration):
- Acquires `withLayoutLock` (5s timeout default)
- Freshness gate: refuses if any `*.md` mtime under `.ijfw/memory/` or `.ijfw/sessions/` is younger than 30s
- Copy-not-move (`.ijfw/{memory,sessions}/*` → `ijfw/{memory,sessions}/*`) — legacy paths preserved for one-version backward-compat
- Scaffolds 6 dirs: `ijfw/dump/{inbox,processed}` + `ijfw/wiki/{concepts,entities,decisions,milestones}`
- Sentinel flip to 2 is the LAST mutation
- Idempotent: re-running at v2 is a no-op (no lock acquired)

## 12. What's NOT in the contract

The following are M1 implementation details that B/C must NOT depend on:
- Internal table schemas in `memory.db` (facts, memory_entries, memory_links) — go through MCP verbs only
- The shape of `.ijfw/state/*` — runtime-internal
- Dream-cycle stage names beyond `wiki-compile`
- Specific tiered-LLM provider IDs

## 13. Versioning

This contract is locked at IJFW v1.5.2. A breaking change requires:
- New milestone version bump (v1.6.x for additive, v2.0.x for breaking)
- Updated CONTRACT.md with the new version number and a CHANGELOG entry
- A grace period in M1 for back-compat shims where feasible
