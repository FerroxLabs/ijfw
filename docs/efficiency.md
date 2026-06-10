# Token economy & observability

How IJFW lowers the cost of every turn, and how the dashboard lets you audit that the savings are real: your numbers, traced to source, never a marketing multiplier.

See also: [../README.md](../README.md).

---

## The token economy

IJFW does not have a single "save tokens" switch. It stacks several independent levers, each one mechanical and individually measurable. On a given turn, up to six of them compound. Nothing here depends on a clever prompt or a benchmark: these are architectural facts about how the system spends context.

| Lever | What it does | Where the number comes from |
|-------|--------------|------------------------------|
| **Prompt cache** | Cached input tokens read at ~10% of normal input pricing, hit aggressively via stable rules-file + `CLAUDE.md` prefixes that don't churn between turns | Anthropic's posted cache-read pricing |
| **Smart routing** | Haiku for reads, Sonnet for code, Opus for architecture. Several-x cheaper per turn across the tiers (Haiku output runs ~5x cheaper than Sonnet) | Anthropic's per-model pricing (Claude Code sub-agent tiers) |
| **Output discipline** | Banned openers, lead-with-answer, no monologues: strips a measured 20–40% off typical output volume | Measured per session; the ledger uses the 30% midpoint |
| **Skill hot-load** | A ~55-line core skill is always resident. The other skills load on trigger and unload when done, instead of sitting in context all day | Architecture fact: one always-on skill by design |
| **Command sandbox** | Large-output commands (builds, test suites, `grep -r`, log tails) route to `ijfw_run`, which streams full output to disk and returns a terse summary instead of flooding context. Git, nav, and quick ops still go through Bash | Mechanical: full output in `~/.ijfw/session-sandbox/`, summary in context |
| **Memory recall** | `ijfw_memory_prelude` replaces the 10–20-tool grep cascade a cold session would otherwise open with. One indexed MCP call instead of N | Mechanical fact: one call vs many |
| **Compression** | `/compress` shrinks handoffs and memory artifacts 40–50% before they're re-loaded next session | Measurable per artifact |

The first three levers (cache, routing, output) are the ones the dollar-saved ledger actually prices, because they map cleanly onto per-token cost. The rest reduce context pressure and round-trips: real savings, but not double-counted into the headline dollar figure.

Each turn ends with a one-line receipt so the savings are an entry, not a claim:

```
[ijfw] This session: ~14.3k tokens saved vs baseline (~$0.087)
[ijfw] Memory: 3 decisions stored, 1 Trident run on record.
[ijfw] Next: ship the auth migration after Trident review.
```

---

## Observability: the dashboard

A live window into every AI session across Claude, Codex, and Gemini.

The pipeline is deliberately simple and inspectable:

1. **PostToolUse → one JSONL line.** Every tool call appends a single line to `~/.ijfw/observations.jsonl`. The capture dispatches to a detached child so it never blocks the hot path.
2. **The server reads the ledger.** `ijfw dashboard start` launches `mcp-server/src/dashboard-server.js`, which binds to `127.0.0.1:37891`, reads `observations.jsonl` plus your cost data, and serves a single-file, zero-dependency HTML page.
3. **The browser stays live.** The session timeline streams over Server-Sent Events (`EventSource('/stream')`), so new tool calls appear as they happen; the cost, savings, and memory tiles are fetched from local JSON endpoints (`/api/cost/*`, `/api/savings/methodology`, `/api/memory`). With JavaScript disabled the page points you at those raw JSON endpoints.

The web page itself:

- Session timeline showing every tool call, file touched, and heuristic classification (bugfix, feature, change, discovery, decision).
- Filter bar narrows rows client-side, no round-trips.
- Platform column color-coded: Claude (blue), Codex (purple), Gemini (green).
- Light and dark themes via `prefers-color-scheme`; reduced-motion respected.
- "Load earlier" button paginates past the default 200-row backfill.
- Port walk: if `37891` is busy, it walks up to `37900`. The actual port is written to `~/.ijfw/dashboard.port`.
- External (non-localhost) requests receive `403`. Bound to `127.0.0.1` only.
- Zero runtime dependencies (`npm ls --production`: 0 entries).

### Running it

```bash
ijfw dashboard start    # bind 127.0.0.1:37891, open browser
ijfw dashboard status   # show port + observation count
ijfw dashboard stop     # graceful shutdown
```

---

## The savings tile: exactly how it's computed

Savings is the sum of three measured, defensible components, computed in `mcp-server/src/cost/savings.js` (`computeSavings`). Each carries explicit confidence metadata, and a number is shown only when it traces to your own data.

**Cache (high confidence, measured).** `cache_read_tokens * input_price * 0.9`. A cached read costs about 10 percent of a fresh input token (Anthropic's posted cache pricing), so each one saves about 90 percent. Counted only from real, measured Claude JSONL turns; the char-estimated Codex and Gemini turns are excluded. This is the load-bearing number, and it is measured from your actual token counts, not modeled.

**Memory (medium confidence).** `unique_first_recalls * 800 tokens * input_price`. The first recall of a given file in a session is credited the context you would otherwise have re-pasted, at a conservative 800-token estimate. Later recalls in the same session are already in the prompt cache, so they are not double-counted.

**Trident (medium confidence).** `unique_HIGH_findings * $5`, capped at 20 per week. Five dollars is a deliberately conservative pre-ship rework estimate; McConnell's *Code Complete* cites $15 to $75 for the same bug caught post-ship. Findings are deduplicated by id so stale or repeated records cannot inflate the figure.

**What is deliberately not here.** There is no "estimated spend without IJFW" multiplier. An earlier version applied a 1.4x baseline multiplier to back-calculate a no-IJFW cost; it had no empirical baseline, so it was removed for honesty. The methodology endpoint (`/api/savings/methodology`) records that removal in plain text. The dashboard would rather show a smaller, defensible number than a larger, invented one.

If a tile has no cost data yet, it says so rather than showing a zero dressed up as a result.

### A note on the dogfood receipt

The README cites one real 30-day window, the author's machine: ~$9.4k actual burn, 97% cache efficiency, 2.71B tokens served from cache. That is **one user's real traffic, not an average or a benchmark**. It demonstrates the dashboard against a heavy real workload; it does not predict your savings. Your own numbers materialize the moment you run `ijfw dashboard start` against your own sessions.

---

## Retention math

The ledger at `~/.ijfw/observations.jsonl` is bounded so it can't grow without limit:

- **Rotation:** when the live file hits **10 MB** it rotates to `observations.jsonl.<timestamp>`.
- **Line cap:** each line is capped at **8 KB**.
- **Archive GC:** the **10 most-recent archives** are kept; older ones are garbage-collected on the next rotation.
- **Worst-case footprint:** ~110 MB (one 10 MB live file + ten 10 MB archives).
- **Override:** `IJFW_LEDGER_ARCHIVES=<N>` changes the kept-archive count; `0` disables GC for unbounded archiving.

The same observation ledger also feeds the session summary written at SessionEnd: files read, files edited, what was learned, what ships next.

---

## Verifying any of this yourself

Every claim on this page is auditable against the code and your own logs:

- Components and constants: `mcp-server/src/cost/savings.js` (`computeSavings`, `getSavingsMethodology`).
- Raw events: `~/.ijfw/observations.jsonl`.
- Live numbers: `ijfw dashboard start`, then `http://localhost:37891` (or `/api/savings/methodology` for the breakdown JSON).

Your numbers, measured and defensible, with the unprovable parts left out. ← back to [../README.md](../README.md).
