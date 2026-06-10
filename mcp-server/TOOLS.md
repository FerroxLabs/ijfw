# IJFW MCP Tool Manifest

**Cap:** ≤14 tools. Combine before raise. (Active: 13/14 as of v1.5.5.)
**Last updated:** 2026-05-27 (v1.5.5 — V155-017 retired `ijfw_update_apply`).

This file is the **source of truth** for the IJFW MCP server's tool surface. CLAUDE.md links here. `scripts/check-mcp.sh` is a launch health probe (initialize + ping handshake); `scripts/check-mcp-count.sh` reconciles the count claim below against `mcp-server/src/server.js`'s TOOLS array length, counting both inline `name: 'ijfw_*'` entries AND `UPPER_SNAKE_TOOL` named-import references. CI invokes both on every release.

## Active tools (13/14)

| Slot | Name | Since | Verbs / shape | Description | Retirement blocker |
|------|------|-------|---------------|-------------|--------------------|
| 1  | `ijfw_memory_prelude`         | v1.3.0 | — (single shape)           | Per-session memory prelude: knowledge / team / journal / handoff projection. | Core API; downstream callers depend on the exact shape. |
| 2  | `ijfw_memory_recall`          | v1.3.0 | — (single shape)           | Recall stored entries with FTS5 + BM25 ranking + recency decay. | Distinct semantic from search; recall = "give me what's relevant," search = "find by query." |
| 3  | `ijfw_memory_search`          | v1.3.0 | `format` optional          | FTS5 keyword search; v1.5.2 added `format:'structured'` for B/C consumers. | Combined-tool target for verbs in v1.6+ if surface grows. |
| 4  | `ijfw_memory_store`           | v1.3.0 | — (single shape)           | Persist a memory entry; M1/M2 indexing runs write-time. | Write path; combining with prelude/recall would break the read/write separation. |
| 5  | `ijfw_prompt_check`           | v1.4.0 | — (single shape)           | Pre-prompt redaction + dedup gate for Codex/Cursor/Windsurf/Copilot/Gemini (no native pre-prompt hook there). | Cannot retire without degrading non-Claude platforms. |
| 6  | `ijfw_update_check`           | v1.4.1 | — (single shape)           | Air-gapped first half of the update flow: check available + emit one-time token. CLI `ijfw update` is the supported apply path. | Air-gapped two-step trust model documented in README. |
| ~~7~~ | ~~`ijfw_update_apply`~~     | ~~v1.4.1~~ | retired (V155-017, v1.5.5) | Retired — see CLI flow in cross-orchestrator-cli.js. | n/a |
| 8  | `ijfw_cross_project_search`   | v1.4.1 | — (single shape)           | Cross-project BM25 search over registry'd projects. | Scope semantics differ from `ijfw_memory_search` (registry-bounded vs project-local). |
| 9  | `ijfw_metrics`                | v1.4.4 | — (single shape)           | Session-level cost + skill telemetry summary for the dashboard. | Read-only meta tool; separation from memory verbs is intentional. |
| 10 | `ijfw_run`                    | v1.4.4 | — (single shape)           | Single-shot command runner: spec → executor → report. | Wraps a different lifecycle (single-task) than the workflow tools. |
| 11 | `ijfw_state`                  | v1.5.0 | `workflow.*` / `wave.*` / `phase.*` / `subagent.*` / `event.emit` / `telemetry.record` / `roster.*` / `extension.set-active` / `decision.add` / `blocker.*` / `state.replay` / `state.validate` + `subagent.post-done` | The single MCP face for the state-SDK verb facade. 20 frozen verbs from STATE-SDK-CONTRACT §7. Absorbed the retired `ijfw_subagent_post_done` tool. | Verb expansion is the documented growth path. |
| 12 | `ijfw_cross_audit_converge`   | v1.5.0 | — (single shape)           | Trident-as-a-service: multi-lens (codex + gemini) consensus convergence loop. Lock-in #47. | Distinct from search/recall: this is a quality-gate verb, not retrieval. |
| 13 | `ijfw_memory_facts`           | v1.5.0 | `getValidAt` / `getHistory` / `getAllFactsWithWindows` | Bi-temporal read path. Cannot fold into `ijfw_memory_search` without breaking the deterministic `(subject, predicate, valid_at)` contract that makes temporal queries replayable. | Replayability contract. |
| 14 | `ijfw_brain`                  | v1.5.2 | `think` / `links` / `wiki.get` / `wiki.compile` / `wiki.promote` / `wiki.export` / `wiki.shareReadme` / `conflict.resolve` / `profile.get` / `profile.brief` / `profile.forget` / `profile.audit` | Combined brain query + wiki + conflict-resolve + cross-system profile-bus serving + profile right-to-be-forgotten/audit. Would have been 4 standalone tools (T24-27 of Plan A) but the combined-tool pattern kept the raise to +1. v1.6.0 P4 folded the profile-bus read path (`profile.get` / `profile.brief`) in as two verbs; the P4 serving-security audit (M2) added `profile.forget` (right-to-be-forgotten — purges a matching inference AND its egress-ledger entries under the global lock, ReDoS-guarded pattern) and `profile.audit` (lists every inference with provenance) — NO new top-level tool, so the count stays 13/13. **Retirement/rationale note (profile.* verbs):** the serve path is ZERO-LLM by construction and read-only; `profile.forget`/`profile.audit` are likewise zero-LLM (they route through `profile/audit.js` → `store.js`/`egress.js`/`lock.js`, none of which reach the LLM tier). They are NOT candidates for standalone tools because (a) folding into `ijfw_brain` keeps the cap honest, and (b) the P4.5 import-graph moat guard statically forbids the serve modules (`profile/serve.js`, `profile/render-brief.js`) from reaching the LLM tier (`tiered-llm.js` / `derive-dialectic.js` / `derive.js`) — keeping it inside the brain facade does not weaken that guard since the guard walks the serve entrypoints, not the tool boundary. | Verb expansion is the documented growth path. |

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
| v1.5.5  | 13  | V155-017: retired `ijfw_update_apply` (deprecation since v1.5.0). CLI `ijfw update` flow is the supported apply path. Cap unchanged at 14 — frees a slot for v1.6.0 growth. |
| v1.6.0  | 13  | P4: cross-system profile bus serving folded into `ijfw_brain` as `profile.get` + `profile.brief` verbs (combine-before-raise — NO new tool, count stays 13/13). ZERO-LLM serve path, sensitivity-gated + redaction/kill-switch enforced, egress-ledgered; moat enforced by the P4.5 import-graph guard. |
| v1.6.0  | 13  | P4 serving-security audit: + `profile.forget` (right-to-be-forgotten: purge inference + its egress entries under the global lock, ReDoS-guarded pattern) and `profile.audit` (list inferences with provenance) verbs on `ijfw_brain`. Also: egress append hardened against symlink-TOCTOU (O_NOFOLLOW); `IJFW_PROFILE_DIR`/`_STATE_DIR` overrides validated (homedir-rooted or test-context only); med/high fields now require a per-host share-hosts allowlist; passive resource read forced low-only. NO new tool — count stays 13/13. |
