# IJFW MCP Tool Manifest

**Cap:** ≤14 tools. Combine before raise.
**Last updated:** 2026-05-25 (v1.5.2).

This file is the **source of truth** for the IJFW MCP server's tool surface. CLAUDE.md links here. Lint check (`scripts/check-mcp.sh`) reconciles this manifest against `mcp-server/src/server.js` TOOLS array length on every release.

## Active tools (14/14)

| Slot | Name | Since | Verbs / shape | Description | Retirement blocker |
|------|------|-------|---------------|-------------|--------------------|
| 1  | `ijfw_memory_prelude`         | v1.3.0 | — (single shape)           | Per-session memory prelude: knowledge / team / journal / handoff projection. | Core API; downstream callers depend on the exact shape. |
| 2  | `ijfw_memory_recall`          | v1.3.0 | — (single shape)           | Recall stored entries with FTS5 + BM25 ranking + recency decay. | Distinct semantic from search; recall = "give me what's relevant," search = "find by query." |
| 3  | `ijfw_memory_search`          | v1.3.0 | `format` optional          | FTS5 keyword search; v1.5.2 added `format:'structured'` for B/C consumers. | Combined-tool target for verbs in v1.6+ if surface grows. |
| 4  | `ijfw_memory_store`           | v1.3.0 | — (single shape)           | Persist a memory entry; M1/M2 indexing runs write-time. | Write path; combining with prelude/recall would break the read/write separation. |
| 5  | `ijfw_prompt_check`           | v1.4.0 | — (single shape)           | Pre-prompt redaction + dedup gate for Codex/Cursor/Windsurf/Copilot/Gemini (no native pre-prompt hook there). | Cannot retire without degrading non-Claude platforms. |
| 6  | `ijfw_update_check`           | v1.4.1 | — (single shape)           | Air-gapped first half of the update flow: check available + emit one-time token. | Air-gapped two-step trust model documented in README. |
| 7  | `ijfw_update_apply`           | v1.4.1 | — (single shape)           | Air-gapped second half: verify token + apply update. | Two-step token flow can't compress to one call without losing the prompt-injection defense. |
| 8  | `ijfw_cross_project_search`   | v1.4.1 | — (single shape)           | Cross-project BM25 search over registry'd projects. | Scope semantics differ from `ijfw_memory_search` (registry-bounded vs project-local). |
| 9  | `ijfw_metrics`                | v1.4.4 | — (single shape)           | Session-level cost + skill telemetry summary for the dashboard. | Read-only meta tool; separation from memory verbs is intentional. |
| 10 | `ijfw_run`                    | v1.4.4 | — (single shape)           | Single-shot command runner: spec → executor → report. | Wraps a different lifecycle (single-task) than the workflow tools. |
| 11 | `ijfw_state`                  | v1.5.0 | `workflow.*` / `wave.*` / `phase.*` / `subagent.*` / `event.emit` / `telemetry.record` / `roster.*` / `extension.set-active` / `decision.add` / `blocker.*` / `state.replay` / `state.validate` + `subagent.post-done` | The single MCP face for the state-SDK verb facade. 20 frozen verbs from STATE-SDK-CONTRACT §7. Absorbed the retired `ijfw_subagent_post_done` tool. | Verb expansion is the documented growth path. |
| 12 | `ijfw_cross_audit_converge`   | v1.5.0 | — (single shape)           | Trident-as-a-service: multi-lens (codex + gemini) consensus convergence loop. Lock-in #47. | Distinct from search/recall: this is a quality-gate verb, not retrieval. |
| 13 | `ijfw_memory_facts`           | v1.5.0 | `getValidAt` / `getHistory` / `getAllFactsWithWindows` | Bi-temporal read path. Cannot fold into `ijfw_memory_search` without breaking the deterministic `(subject, predicate, valid_at)` contract that makes temporal queries replayable. | Replayability contract. |
| 14 | `ijfw_brain`                  | v1.5.2 | `think` / `links` / `wiki.get` / `wiki.compile` / `wiki.promote` / `wiki.export` / `wiki.shareReadme` / `conflict.resolve` | Combined brain query + wiki + conflict-resolve. Would have been 4 standalone tools (T24-27 of Plan A) but the combined-tool pattern kept the raise to +1. | Verb expansion is the documented growth path. |

## Cap policy

- **≤14 tools** as of v1.5.2.
- **Combine before raise.** Default to extending an existing combined tool (`ijfw_state`, `ijfw_brain`) with a new verb. Raise the cap only when a verb genuinely breaks user-facing semantics of an existing tool.
- **Retirement review.** Every new tool proposal must include a retirement-review note for each existing tool: can this functionality fold into an existing tool's verbs? Document the blocker if no.
- **Combined-tool pattern.** Single tool with `verb` or `action` parameter. Examples: `ijfw_state` (the original pattern), `ijfw_memory_facts` (bi-temporal read), `ijfw_brain` (v1.5.2 combined Plan A). Pattern is preferred over individual tool additions because it minimizes the registration footprint per capability.

## How the cap is enforced

- **At build time:** `scripts/check-mcp.sh` counts the TOOLS array length in `mcp-server/src/server.js` and asserts it ≤14.
- **At PR review time:** any PR that adds a new tool must (a) increment the table above, (b) document the retirement-review note, (c) update the cap if needed, and (d) update CLAUDE.md's one-line pointer.
- **At runtime:** the MCP server registers exactly the tools listed in the source TOOLS array. No dynamic registration paths exist.

## History

| Version | Cap | Change |
|---------|-----|--------|
| v1.3.0  | 4   | Initial memory verbs (prelude/recall/search/store). |
| v1.4.0  | 5   | + `ijfw_prompt_check`. |
| v1.4.1  | 8   | + `ijfw_update_check` / `_apply` + `ijfw_cross_project_search`. |
| v1.4.4  | 10  | + `ijfw_metrics` + `ijfw_run`. |
| v1.5.0  | 12  | Major raise: + `ijfw_state` (absorbed retired `ijfw_subagent_post_done`) + `ijfw_cross_audit_converge`. |
| v1.5.0  | 13  | Memory-moat amendment: + `ijfw_memory_facts`. |
| v1.5.2  | 14  | Brain milestone: + `ijfw_brain` (combined; would have been 4 standalone). |
