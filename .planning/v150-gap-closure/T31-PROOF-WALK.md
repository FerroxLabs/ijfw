# T31 — Falsifiable-Proof Walk Results

**Date:** 2026-05-20
**Branch:** `v1.5.0-gap-closure`
**HEAD at sweep:** `da22c78` (T30 — agent cross-platform deploy + 7 domain specialists)

## Verdict: ✅ **ALL GREEN — READY FOR T32**

Every brief proof-table row green at its defined threshold. Pre-existing failures (not introduced by this milestone) documented separately and accepted.

---

## Sweep results

### Full state-SDK + feature test sweep (29 suites, single `node --test` invocation)
- **511 / 511 pass, 0 fail, 0 cancelled, 0 skipped, ~23.85s**

### `npm test` (mcp-server custom runner)
- **103 / 103 pass, 0 fail**

### `bash scripts/e2e-smoke.sh`
- T30 gate: 3/3 PASS (`all 11 expected agent files`, `domain-template ids resolve`, `test-agent-cross-platform-deploy green`)
- G6 codex Stop gate: PASS (`Codex Stop emits systemMessage receipt (IJFW_CODEX_HOOK_NOTICES=1 opt-in)`)
- Pre-existing acceptable failures (NOT regressions, NOT T31 blockers):
  - `scope leak: /Users/seandonahoe/.claude/settings.json changed during scratch install` — environmental (real HOME's Claude settings touched by scratch installer; not a v1.5.0 bug, predates milestone)
  - `ijfw --version mismatch: expected 1.5.0, got: @ijfw/install@1.4.4` — Phase F territory (v1.5.0 not yet published to npm; pre-T34)

---

## Proof contract per row

| Row | Required proof | Status | Evidence |
|---|---|---|---|
| **G2** state-SDK | Grep-gate covers JS + `.sh` + homedir; each writer regression test; concurrent multi-lock + deadlock test; CLI + MCP exercised in e2e-smoke | ✅ GREEN | `test-state-sdk-grepgate.js` 9/9; `test-state-sdk-locking.js` 15/15; `test-cli-command-parity.js` 11/11; `test-state-mcp-tool.js` 6/6; spy tests across all 6 migrated writers (T6-T11) |
| **G3** enforcement | `phase.complete` REFUSES on red verdict; gate exception → advisory; matrix doc exists; every platform row maps to real path | ✅ GREEN | `test-verification-gate-strict.js` 15/15 (refuse + degrade + bypass per verb); `docs/ENFORCEMENT-MATRIX.md` exists; `test-enforcement-matrix.js` 7/7 |
| **G1** subagent stream + truncation | Per-subagent event log live; truncation recovered to last commit; partial rolls back; append no double-apply; **rate ≤ 31%** | ✅ GREEN | `test-subagent-event-stream.js` 13/13; `test-truncation-recovery.js` 9/9; **measured rate = 0.0 ≤ 0.31** (vs 0.62 baseline); artifact at `.ijfw/telemetry/truncation-rate.json` |
| **G4** code-fixer | Seeded bug → review → fix → Trident-verify → atomic commit; 3-tier verify unit test | ✅ GREEN | `test-code-fixer.js` 38/38 (logic-bug heuristic + triage + tier-1/2/3 + Trident + atomic commit + recovery-sentinel + 8 e2e scenarios) |
| **G5** lock awareness (multi-machine out) | G2 lock test passes; multi-machine explicitly out, no claim | ✅ GREEN | `test-state-sdk-locking.js` 15/15 (incl. cross-root locks); G5 deferred per brief, no contradictory claims |
| **G6** codex Stop e2e | e2e gate green with `IJFW_CODEX_HOOK_NOTICES=1` | ✅ GREEN | e2e-smoke `[PASS] 1.1.6: Codex Stop emits systemMessage receipt (IJFW_CODEX_HOOK_NOTICES=1 opt-in)` |
| **G7** generative roster | Software vs ≥2 non-software differ; every template schema-valid; each G7-core has test; agents deploy to platform packages | ✅ GREEN | `test-team-generator.js` 37/37 (software vs book vs content vs design — all pairwise differ); `test-domain-templates.js` 21/21 (6 templates schema-valid); 4 G7-core + 7 specialists exist; `test-agent-cross-platform-deploy.js` 20/20 |
| **W1** plan-check hard-BLOCK | plan-check BLOCKS execute on seeded HIGH finding | ✅ GREEN | `test-plan-checker.js` 17/17 (HIGH-tier refuse + downstream dispatch NOT writing workflow.json + intent-journal) |
| **W2** Trident-powered debug | multi-cycle debug campaign; cross-lens hypotheses used | ✅ GREEN | `test-debug-trident.js` 15/15; cross-lens hypothesis merge tested |
| **W3** verification at every boundary | Boundary set enumerated; test per boundary; Iron-Law in verify skill | ✅ GREEN | `test-verification-gate.js` 35/35 (4 W3 boundaries: phase.complete, phase.plan-check, subagent.post-done, wave.advance-hard); Iron-Law section in `claude/skills/ijfw-verify/SKILL.md` |
| **W4** Trident telemetry | Convergence-telemetry artifact with cycles/false-positive/cost | ✅ GREEN | `test-cross-orchestrator.js` 5/5 (T21 tests); artifact at `mcp-server/.ijfw/telemetry/convergence.json` (27KB) with `cyclesToConverge`, `falsePositiveRate`, `costUsd` fields |
| **W5** memory benchmark + temporal | Published benchmark numbers + temporal/staleness test | ✅ GREEN | `test-memory-benchmark.js` 6/6; `test-memory-temporal.js` 13/13 (decay-on-retrieval with halflife thresholds 30d project / 1d session) |

---

## Open follow-ups (NOT T31 blockers; T33 territory)

1. **CHANGELOG.md has 9 hits for `v1.5.1 / next milestone / TBD`** — T33 reconciles to v1.5.0 single-version vocabulary.
2. **`ijfw-core/SKILL.md` is at 54 lines** (cap is 55) — passes but only 1 line of headroom. Note for future skill edits.
3. **T7 follow-ups (open, not blocking):**
   - `wave.advance` has no `body` field in its payload; wave-state.js bridges via a follow-up raw write.
   - `wave.advance` declares `waves.json` as a lock target but never writes it.
4. **Pre-existing test failures unrelated to this milestone:** `scope leak` (environmental) + `ijfw --version mismatch` (Phase F territory).

---

## Next: T32

`ijfw cross-audit` over `main..v1.5.0-gap-closure` diff (with `--chunk` for Gemini timeout per memory note). Adjudicate all HIGH/MED/LOW.
