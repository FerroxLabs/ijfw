# IJFW Memory Query Grammar (v1)

Dataview-grade declarative query for `ijfw_memory_search` (via `dv:` prefix)
and the `memory:search` CLI. Sits alongside the existing NL / FTS5 hybrid
mode — the FTS5 path is unchanged.

This is the surface IJFW v1.5.0 ships in the "deeper than Obsidian-compat"
direction. Nobody else in the agent-memory category ships structured queries
over their store. Backed by the `memory_links`, `memory_tags`, `memory_meta`
tables (migration 006) populated at write-time by the Obsidian parser
(`obsidian-parser.js`).

## Syntax (v1)

```
tag = #path[/subpath]*           Prefix-matches descendants.
                                 #project/r17 also matches #project/r17/audit.
linked_to = "target"             Matches memories whose body has [[target]].
created_after = <unix-secs>      memory_entries.created_at > N
created_before = <unix-secs>     memory_entries.created_at < N
```

- Multiple clauses join with `and` (case-insensitive). Whitespace-tolerant.
- Targets are normalised to lowercase + dash-collapsed at write time
  (`[[Memory Field Comparison]]` → `memory-field-comparison`). Queries
  should use the normalised form.
- Tag paths are stored without the leading `#` and without trailing `/`.
  Query forms accept either `#project/r17` or `project/r17`.
- Unrecognised clauses are silently skipped. Inspect `parsed.filters` for
  `__unrecognised` entries if debugging.

## Examples

```
tag = #project/r17/audit
linked_to = "v150-brief"
tag = #ship and created_after = 1700000000
created_after = 1700050000 and created_before = 1700200000
```

## Invocation

**MCP — `ijfw_memory_search`:**

```
ijfw_memory_search({ "query": "dv: tag = #project/r17" })
```

The `dv:` prefix routes to the declarative executor; everything else stays
on the FTS5 hybrid path.

**CLI — colon-dispatch:**

```
ijfw memory:search "dv: tag = #ship and created_after = 1700000000"
```

## What you get back

```json
{
  "mode": "dataview",
  "parsed": { "tag": "...", "filters": [...] },
  "rows": [
    { "id": <integer>, "body": "...", "source": "...", "created_at": <unix-secs> }
  ]
}
```

(`mode` is always `"dataview"` when the executor runs.)

## Grammar status

v1 is intentionally minimal. The grammar is designed for additive growth
without breaking existing clients. Future extensions tracked under v1.6+:

- `OR` clauses (currently AND-only)
- `decayed_confidence > N` (joins facts table — surfaces M5 bi-temporal data)
- `state = "active"` (post Hermes-style lifecycle: active / stale / archived)
- `ORDER BY <field> [ASC|DESC]` overrides (currently always `created_at DESC`)
- Inline-meta filters: `meta.author = "Sean"` (joins memory_meta)
- `linked_from = "target"` reverse direction (backlinks query)

## Implementation pointers

- Parser: `mcp-server/src/memory/query-dataview.js` → `parseDataviewQuery`
- Executor: same module → `runDataviewQuery(db, parsed)`
- Indexer (writes `memory_links` / `memory_tags` / `memory_meta` at store
  time): `mcp-server/src/memory/obsidian-parser.js` → `indexObsidianRelations`
- Schema: `mcp-server/src/memory/migrations/006-obsidian-graph.js`
- Tests: `mcp-server/test-query-dataview.js` (10 tests; full grammar + JOIN
  surface)
