# v1.5.1 Cleanup Synthesis — Round 2 (post-swing cross-check + deep-dive)

**Date:** 2026-05-22. Inputs: CROSSCHECK-29-COMMITS.md, DEEPDIVE-ORPHAN-ROUND2.md, DEEPDIVE-LIES-ROUND2.md + in-session verification.

## Cross-check verdict on the 29-commit swing
**27 VERIFIED / 2 DISCREPANCY.** Test surface 2477 pass / 2 fail / 1 skip. The swing was real — multi-domain fix, command-registry, source-of-truth, Antigravity all hold. But the cross-check was shallow on one point (see C1 below) and the deep-dives found 3 NEW orphans the original audit missed.

## What still needs fixing (the cleanup-of-the-cleanup)

### HIGH

**C1 — `runtime-loop.js` is itself an orphan; W2.B+E wired into dead code.**
- `runtime-loop.js` has 4 test importers, ZERO production importers (verified by grep).
- Its own docstring (line 22): "The MCP tool wrapper in server.js passes projectRoot" — S02 designed it as an MCP tool in server.js, never wired it.
- W2.B+E wired `recovery/truncation.js` (T20) + `lib/worktree-guards.js` (S08) INTO runtime-loop.js — so those orphans now have a "caller" that is itself dead. The W2.B+E commit claim ("T20 measured-rate claim now has a caller") is false.
- FIX: either (a) wire `runtime-loop.js`'s `reviewSubagentReport` into server.js as the MCP tool S02 intended, OR (b) if it's redundant with `post-done-runner.js runPostDone` / the `ijfw_state subagent.post-done` verb, move the truncation + worktree-guards wiring into that live path and retire/merge runtime-loop.js. Must end with truncation.js + worktree-guards.js genuinely reachable.

**C2 — `recovery/code-fixer.js` (T27 "G4 cross-AI consensus code-fixer loop") is orphan.**
- 14 exports, v1.5.0 CHANGELOG-claimed, no production caller. Missed by the original 8-orphan audit.
- FIX: wire it, or honestly mark deferred.

**C3 — `dashboard-charts.js` is a hard orphan** (zero refs outside its own test). Wire or remove.

**C4 — `installer/README.md` + `installer/docs/GUIDE.md` still say "14 platforms", omit Antigravity.**
- These SHIP inside the npm `@ijfw/install` package — the Antigravity commit `3a364cd` only patched the ROOT README/GUIDE.
- FIX: bring both installer-bundled docs to 15 platforms + list Antigravity.

**C5 — `mcp-server/package.json` description says "10 MCP tools"** — actual is 13. Update.

**C6 — `ijfw_memory_status` (dead tool) survives in live/shipped files:**
- `gemini/extensions/ijfw/IJFW.md`, `docs/DESIGN.md`, `docs/announcements/readme-preview.html`, `wayland/plugins/ijfw/_mcp.py`, `hermes/plugins/ijfw/_mcp.py`, `wayland/plugins/ijfw/tests/mock_ctx.py`, `hermes/plugins/ijfw/tests/mock_ctx.py`, `codex/.codex/IJFW.md`, `.codex/skills/ijfw-status/SKILL.md`, `installer/.codex/skills/ijfw-status/SKILL.md`.
- KEEP refs in `CHANGELOG.md` + `installer/CHANGELOG.md` (historical record — legitimate).
- The `_mcp.py` files are LIVE platform MCP registration code — if they register a non-existent tool that's a real bug, not just a doc lie. Investigate.
- W1.B + W2.followup both claimed "zero refs remain" — false. Final sweep needed.

**C7 — `ijfw-preflight` gate count is internally contradictory.**
- `claude/skills/ijfw-preflight/SKILL.md`: frontmatter "12 gates", body lists 13.
- The runner actually runs 11. `codex/skills/ijfw-preflight/SKILL.md` correctly says 11.
- W1.D claimed to align claude vs codex — false.
- FIX: count the runner's real gates, make frontmatter + body + both platform SKILL.md agree on the true number.

### MED

**C8 — "8 platforms" / stale platform counts** still in `CLAUDE.md` (root), `universal/` rules, codex + gemini plugin JSON descriptions, claude command page, UPDATE-FLOW.md. Reconcile all to 15.

**C9 — README undersells Claude skills** — says 22, actual 34 (per platform-capabilities.json).

**C10 — `preflight-stale-count.sh` is a toothless gate** — only greps the literal string "8 platforms"; blind to the actual 13/14/15 drift. Make it actually validate the canonical count.

### LOW

**C11 — codex doctor cosmetic bug** — prints `[ !! ]` (failure mark) paired with "ijfw-memory configured" (success message). Mismatched glyph/text.

## Side-effects already handled
- Cross-check agent's `ijfw off` stripped `ijfw-memory` from `~/.codex/config.toml` — RESTORED via `ijfw install --yes` this session.

## What's CONFIRMED GOOD
- 6 of 8 W2 wirings are genuine reachable runtime paths (uispec-intake, debug-trident, gate-result-formatter, evaluator-checkpoint-contract, extension-registry-ws, memory/benchmark).
- command-registry single-source + 16-assertion parity test is real and passes.
- Multi-domain fix holds end-to-end. Antigravity IDE + CLI both wired.
- search.js dual-registry killed. ijfw-memorize false-positive correctly resolved.
- M4 dual-migration root cause confirmed fixed.
