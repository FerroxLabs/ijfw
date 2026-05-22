---
name: ijfw-memory-audit
description: "Audit and clean project memory files. Trigger: 'memory audit', 'clean memory', 'memory health', /memory-audit"
---

## Execution

1. Call `ijfw_metrics` to get counts and last-update timestamps for all tiers.

2. Scan `.ijfw/memory/` for all `.md` files. For each, note:
   - File name, size (lines), last modified date.
   - Days since last referenced (use file mtime as proxy).

3. Categorize entries:

```
ACTIVE  -- referenced within 30 days
STALE   -- not referenced in 30-90 days
ARCHIVE -- not referenced in 90+ days, or flagged as superseded
```

4. Report:

```
MEMORY HEALTH REPORT
  Total entries: <N>  |  Total size: ~<X> lines
  Active: <N>  |  Stale: <N>  |  Archive candidates: <N>

STALE ENTRIES (>30 days unreferenced)
  - <filename>: <one-line summary>  [last seen: <date>]

ARCHIVE CANDIDATES (>90 days or superseded)
  - <filename>: <one-line summary>  [last seen: <date>]

RECOMMENDATION
  Archive <N> entries to .ijfw/memory/archive/. No data is deleted.
```

5. **Pruning question:** for each entry flagged STALE or ARCHIVE, ask "Would removing this rule cause the agent to make a mistake?" If no, archive. If yes, keep and tighten. Memory that doesn't change behavior is bloat that crowds out memory that does.

6. Ask before acting:
   > `Archive <N> stale entries? (y/n -- files move to .ijfw/memory/archive/, not deleted)`

6. On confirmation, move flagged files. Store audit result:
   > `ijfw_memory_store: memory audit on <date> -- archived <N> entries`
