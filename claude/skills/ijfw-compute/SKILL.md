---
name: ijfw-compute
description: "Compute over read. Run sandboxed scripts to process data instead of dumping it into context. Trigger: 'compute', 'process this data', 'analyze logs', or PreToolUse nudge."
context: fork
model: sonnet
---

Compute over read. When data is large or repetitive, run a sandboxed script
and surface only the result. The four trees below decide which lever to pull.

## Compute tree -- run a sandboxed script

Use when the input is bigger than the answer: log files, CSV/JSON dumps,
file-tree walks, repeated string transforms, aggregate stats, deduping.
Call `ijfw_run compute:python "<script>"` for pandas / numpy / stdlib parsing.
Call `ijfw_run compute:js "<script>"` for JSON shape-checks, regex sweeps,
quick numeric work. Sandbox is allowlist filesystem (cwd + project root) +
best-effort OS-level network deny; opt-in with `IJFW_COMPUTE_NET=1` if the
script needs egress. Default timeout 30s, hard cap 300s via
`IJFW_COMPUTE_TIMEOUT_MS`. Output cap 100MB; overflow lands in the on-disk log.

Example: a 40MB nginx log. Instead of reading 200k lines into context, run
`ijfw_run compute:python "import collections,sys;c=collections.Counter();[c.update([l.split()[8]]) for l in open('access.log')];print(c.most_common(10))"`
and surface the top-10 status-code summary.

## Read tree -- skip compute, just read

Use when the file is small (<2k lines), the task is a code edit or config
tweak, or the agent needs to reason about structure rather than aggregate
content. Direct Read is cheaper than spinning a subprocess; compute has
fixed startup overhead.

Example: editing a single function in `mcp-server/src/server.js`. Read the
file, edit it, move on. No compute call needed.

## Index tree -- write findings to FTS5 for later search

Use after a compute or research step produces a finding worth recalling
across sessions. Call `ijfw_run index:source <kind> <body>` to write into
the per-project FTS5 db at `<project>/.ijfw/index/compute.db`. Schema is
`raw` table (source_kind, source, session_id, project_root, body, ts).
Per-write `PRAGMA quick_check` guards integrity.

Citation provenance (C9.6): pass `--source=<pointer>` before the body to
attach an origin (file path / observation kind / skill name). Search hits
surface this pointer + the session_id so users can trace where each row
came from. Omitted -> source stays NULL.

Example: after analyzing the nginx log, index the verdict:
`ijfw_run index:source compute_output --source=logs/access.log "Top error 502 from upstream X 2026-05-08; 4.1% of requests"`.
Next session can search for it via the search tree below.

## Search tree -- query the existing index

Use before computing again. If a previous session already answered a similar
question, recall it instead of recomputing. Call
`ijfw_memory_search compute:query "<query>"` for top-k FTS5 hits scoped to
the current project. Each hit returns body + source_kind + source +
session_id + ts; the agent decides whether the cached finding is still
fresh and can cite the source pointer.

Stemmed BM25 (C9.4): the FTS5 tokenizer is `porter unicode61`. Morphological
variants collapse: "authenticate" / "authenticating" / "authentication"
share a stem; "configure" / "configured" / "configuring" share a stem.

Synonym expansion (C9.5): default-on. Bare tokens expand against ~80 coding-
domain pairs (db <-> database, auth <-> authentication, perf <-> performance,
etc.). The result envelope reports `synonym_matches: { token: [expansions] }`
so callers see what fired. Disable per-process via `IJFW_SYNONYM_EXPAND=0`.

Session filter (C9.6): append `--session=<id>` to a query to scope hits to
a single session. The envelope echoes the filter as `session_filter`.

Example: user asks "what was the top nginx error last week?" Run
`ijfw_memory_search compute:query "nginx error rate"` first; if a recent
indexed finding lands, surface it directly. If empty or stale, fall back to
the compute tree on fresh log data.

## Rules

- Default to compute when input >> output. Default to read when input <= output.
- Always index actionable findings; don't index raw dumps.
- Always search before computing on a recurring question.
- Subprocess runs are sandboxed -- treat untrusted script bodies as
  untrusted; never disable the sandbox to make a script work.
- One compute-nudge per session via the PreToolUse hook; further nudges
  are suppressed.
