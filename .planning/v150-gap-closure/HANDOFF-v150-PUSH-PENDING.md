# IJFW v1.5.0 — PUSH-PENDING HANDOFF

**Created:** 2026-05-20
**State:** SHIP-READY, NOT PUSHED. T34 is the only outstanding task and it is operator-gated.
**Operator intent for the next session:** verify IJFW's memory layer against Claude mem-agent memory + other field implementations before pushing. Any adjustments land in this same v1.5.0 release (the tag and branch are local-only — they move freely until push).

---

## 0. State pin (must match at start of next session)

| Thing | Value |
|---|---|
| Repo | `/Users/seandonahoe/dev/ijfw` |
| Current branch (after merge) | `main` |
| `main` HEAD | `3d8536c` (merge commit `Merge branch 'v1.5.0-gap-closure' — IJFW v1.5.0 gap-closure milestone`) |
| Old feature branch (kept for safety) | `v1.5.0-gap-closure` at same commit history; can be deleted any time |
| Tag `v1.5.0` | `3d8536c` (force-moved from the provisional `282bad8`) |
| `gitlab/main` | unchanged from pre-milestone (`main` is **297 commits ahead** of `gitlab/main`, NOT PUSHED) |
| Working tree | only `AGENTS.md` + `mcp-server/CLAUDE.md` pre-existing unstaged drift (DO NOT stage these) |
| npm published `@ijfw/install` | still `1.4.4` (T34 publishes `1.5.0`) |

**Verify on resume:** `git log --oneline -3` should show the merge commit. `git rev-parse v1.5.0` should print `3d8536c…`. `git status --short` should show ONLY the two drift files.

---

## 1. Milestone summary — what shipped (33 of 34 tasks)

**32 swarm tasks + 1 proof-walk + 1 cross-audit synthesis**, plus 7 plan/docs commits — ~40 atomic commits.

| Wave | Tasks | Outcome |
|---|---|---|
| A — foundation | T1–T5 | state-SDK: frozen verb contract (20 verbs, 4 cross-cutting models), dispatcher + handlers, canonical lock hierarchy + heartbeat, WAL idempotency (intent+commit + snapshot rollback + canonical-JSON digest + replay), per-subagent rotated event log + `pollEvents`. Multiple real defects caught and fixed during reviews (T3 heartbeat-after-stale-recovery; T4 append-rollback data-loss; T10 extension-shape security-boundary crash; T14 grep-gate proves zero bypass). |
| B — migrations | T6–T14 | 7 writers + shell hooks routed through SDK; `ijfw state:<verb>` CLI namespace; `ijfw_state` MCP tool (cap stays 12/12 — replaces `ijfw_subagent_post_done`); grep-gate proves the rule. |
| C — enforcement | T15–T18 | 4 W3 boundaries (`phase.complete`, `phase.plan-check`, `subagent.post-done`, `wave.advance` hard-gate) all structurally enforce verdict-fail → REFUSE; per-platform matrix at `docs/ENFORCEMENT-MATRIX.md` (8 structural + 1 best-effort + Universal n/a); Iron-Law discipline in `claude/skills/ijfw-verify/SKILL.md`. |
| D — telemetry | T19–T20 | Live subagent event stream + truncation recovery; measured rate **0%** vs 31% ceiling (vs 62% baseline). Reproducible 25-fixture corpus at `mcp-server/fixtures/truncation-corpus/`. |
| E — moats | T21–T30 | **Trident convergence telemetry** (cycles / false-positive rate / cost USD); **memory benchmark + temporal decay-on-retrieval**; **G7 generative team engine** + 4 G7-core agents + 7 domain specialists + 6 domain templates; **G4 cross-AI consensus code-fixer** (3-tier verify + Trident-verify + atomic per-finding commit); **W2 Trident-powered debug** with cross-lens hypothesis merge; **G6 codex Stop e2e gate** green via opt-in env. |
| F — ship | T31–T33 | Proof-walk: **511/511** test sweep + 103/103 npm + e2e-smoke green (modulo 2 pre-existing acceptable failures). T32 Trident milestone synthesis: 0 HIGH / 0 MED / 4 LOW (deferred). T33 merge to main + retag. |

**Final tag state at HEAD `3d8536c`:**
- 511 / 511 across 29 state-SDK + feature suites
- 103 / 103 npm test
- e2e-smoke: T28 PASS, T30 PASS (3 sub-gates), 60+ gates green, only 2 pre-existing FAILs (`scope leak` — environmental; `ijfw --version mismatch` — resolves at publish)
- `claude/skills/ijfw-core/SKILL.md` = **54** lines (≤55 cap)
- CHANGELOG.md `[1.5.0]` has new "Gap-closure milestone" subsection; 3 stale v1.5.1 forward-refs reconciled; 9 legitimate v1.5.1 refs preserved (historical / real artifact name / explicit-defer items)

---

## 2. Why you're stopping here (operator's actual ask)

Before pushing, you want to **research Claude mem-agent memory on GitHub and other field implementations**, then re-verify IJFW's memory layer is at-or-above the field — and update if it's not.

**Anything you change after this point lands in v1.5.0** (the tag and branch are local-only, no remote has seen them). The proof-walk + Trident audit + ship-gate close-out can be re-run cheaply if you modify memory code.

---

## 3. Memory layer — surface area to verify

### 3.1 What v1.5.0 ships in the memory layer

**Existing (pre-milestone):**
- 3-tier storage: **hot markdown** (`.ijfw/memory/*.md` + `MEMORY.md` index per project / per cross-project), **warm SQLite FTS5** (`.ijfw/memory.db`), **optional cold vectors** (embedding cache + migration `005`).
- MCP surface: `ijfw_memory_prelude`, `ijfw_memory_recall`, `ijfw_memory_search`, `ijfw_memory_store`, `ijfw_cross_project_search`.
- Search: hybrid (FTS5 + vector + recency boost).

**New in v1.5.0 (relevant to your research):**
- **T22 — Memory benchmark harness** (commit `3a0bb95`):
  - `mcp-server/src/memory/benchmark.js`
  - `mcp-server/test-memory-benchmark.js`
  - Axes measured: recall@k, latency p50/p95, storage cost, insertion throughput.
  - Test: 6/6 pass with a 50-memory canned corpus.
  - **Your research question:** does our axis set + threshold values match what mem0 / Zep / Graphiti / Claude mem-agent publish? Are they measured on comparable corpora?
- **T23 — Temporal decay-on-retrieval** (commit `d8d152a`):
  - `mcp-server/src/memory/temporal.js` (added `DECAY_HALFLIFE_DAYS = 30`, `DECAY_HALFLIFE_SESSION_DAYS = 1`, `applyDecayToFacts()`)
  - `mcp-server/src/memory/staleness.js` (pre-existing; T23 extends)
  - `mcp-server/test-memory-temporal.js` — 13 tests.
  - Decay rule: exponential `Math.exp(-ageDays / halflife)`; emits `staleness_days` + `decayed_confidence` per row; non-mutating (shallow-copy).
  - **Your research question:** is exponential decay the right model? mem-agent literature may use TTL, sliding window, or learned decay. Are the halflives (30d project / 1d session) defensible vs the field?

### 3.2 Specific claims to challenge

The brief (`/Users/seandonahoe/dev/ijfw/.ijfw/memory/brief.md`) commits IJFW to:
- **W5 ELEVATED:** "published benchmarks + temporal/staleness layer."
- **Lead #5 in the flagship-capabilities list** (alongside Trident telemetry — "first-mover lead" status).
- "Mem0/Zep/Graphiti publish memory benchmarks; IJFW must match the genre with measurable numbers across comparable axes."

If your research shows the field has moved past simple decay-on-retrieval (e.g. Claude mem-agent uses entity-relationship graphs, mem0 added structured-fact extraction, Zep added knowledge-graph reasoning), IJFW needs to either:
- (a) demonstrate parity on the axes it claims (recall + staleness),
- (b) add the missing capability before claiming Lead #5, or
- (c) drop the "first-mover lead" claim and reframe honestly.

The brief is amendable — `git add -f` the contract. Lock-in #54 in CLAUDE.md governs the cap on the memory tier; that doesn't move unless you say so.

---

## 4. Research targets — what to look at

These are the obvious field references for memory-layer parity. Your research will likely find more.

| Project | What to look for | Where |
|---|---|---|
| **Claude mem-agent** | The agent's memory API, decay/recall semantics, evaluation harness, axes published | github.com (you'll search) — anthropic / claude-mem-agent / claude-cookbook variants |
| **mem0** | Recall@k benchmarks, fact-extraction pipeline, dedup strategy | mem0ai/mem0 on GitHub; their published benchmarks |
| **Zep** | Knowledge-graph memory + temporal facts; their benchmark page | getzep/zep, getzep/graphiti |
| **Graphiti** | Knowledge-graph + temporal; bitemporal model | getzep/graphiti |
| **MemGPT / Letta** | Hierarchical memory; OS-paging metaphor | letta-ai/letta (formerly MemGPT) |
| **LangGraph memory** | Long-term memory store; vector + key-value blend | langchain-ai/langgraph |
| **OpenAI memory** | Recall heuristics (semantic + last-mention) | API docs |
| **Cursor / Cody / Continue** | IDE-side memory patterns | each project's repo |

### Key axes to compare (build a side-by-side)

- **Recall@k** on a standard corpus (LoCoMo / LongMemEval / similar).
- **Staleness handling:** filter / decay / re-rank / surface confidence?
- **Update semantics:** overwrite / append / merge / fact-resolution?
- **Cross-session vs cross-project scope** — how does each handle scope?
- **Cost model:** memory cost per fact / per query (tokens, ms, MB).
- **Verbosity floor:** does prelude bloat the context window?
- **Adversarial:** prompt-injection resistance on retrieved memories.

---

## 5. The path forward — what to do after research

```
[NEXT SESSION]
  1. Research the field (the table above + your own discoveries).
  2. Build a comparison artifact at .planning/v150-gap-closure/MEMORY-FIELD-COMPARISON.md
     — IJFW's current numbers vs each field implementation.
  3. Decide:
     (a) IJFW is at-or-above the field on its claimed axes → no code changes; only
         update the brief's framing / CHANGELOG to be more honest if needed.
     (b) IJFW has a gap → fix it. Options ranked by scope:
           • Tune halflife defaults / decay formula (T23 module — small).
           • Add a missing axis to the benchmark harness (T22 — medium).
           • Add a missing capability (e.g. entity-relationship facts) — large; may
             escalate to a v1.5.0 amendment with another /gsd-plan + Wave-E-prime.

  4. If (b): land the fix as one or more atomic commits, then:
       - Re-run T31 proof-walk:
           cd /Users/seandonahoe/dev/ijfw/mcp-server &&
           node --test test-*.js && npm test &&
           cd .. && bash scripts/e2e-smoke.sh
         All 511 + 103 + e2e gates stay green (modulo the 2 pre-existing).
       - Re-run T32 cross-audit IF codex/gemini backends are healthy this time
         (T32 was opus-self-audit only because codex 404 + gemini timeout).
       - Update CHANGELOG's [1.5.0] subsection if material.
       - Force-move v1.5.0 tag to the new main HEAD.

  5. Phase F (T34) — push + publish (still operator-gated, see §6).
```

---

## 6. T34 — the final gated step (verbatim)

When you say "yes, push" in the next session:

```bash
# From repo root, on `main`:
git push gitlab main
git push gitlab v1.5.0     # or `git push gitlab --tags` if you want all tags
                            # (only v1.5.0 was retagged this milestone)

# CI OIDC trusted-publisher should auto-fire on the tag push and publish
# @ijfw/install@1.5.0. If CI doesn't trigger, fallback to manual:
cd installer && npm publish --provenance

# Verify ship:
npm view @ijfw/install version    # expect: 1.5.0
```

**Do not push without explicit "yes, push" or equivalent.** The operator-gate is the protection against the "main is 297 commits ahead of gitlab/main" turning into an irreversible publish.

The pre-existing `ijfw --version mismatch` e2e-smoke failure resolves automatically once `1.5.0` is the installed npm version.

---

## 7. Constraints / lessons that carry forward

1. **AGENTS.md + mcp-server/CLAUDE.md are pre-existing session-state drift.** NEVER stage them. Stage every commit's files explicitly with `git add <path>`.
2. **`.planning/` and `.ijfw/` are gitignored.** Force-add audit artifacts with `git add -f <path>`. Already applied — the milestone's planning docs ARE in git.
3. **`mock.method(fs, ...)` requires `import fs from 'node:fs'`** (default), NOT `import * as fs` (ESM namespace is read-only). Reference: `mcp-server/test-dispatch-planner.js`.
4. **Connection instability at high parallelism:** past sessions lost agents at 5-parallel. Cap parallel batches at 4–5. Salvage pattern works: verify partial work in tree, fix any bug, commit explicit files. Most "lost" agents had completed substantial work; they just didn't commit.
5. **T7 follow-ups (open, intentionally deferred — already noted):**
   - `wave.advance` has no `body` field in payload (wave-state.js bridges via follow-up raw write).
   - `wave.advance` declares `waves.json` as a lock target but never writes it.
   - Either fold into the upcoming memory round (if you touch state-sdk.js anyway) or defer to v1.5.1.
6. **T32 caveat:** the milestone Trident cross-audit only had 1/3 lens (claude opus self-audit) — codex 404 + gemini timeout were external backend issues this session. If you want a real 2/3 or 3/3 lens cross-audit before push, retry T32 when backends are healthy. The synthesis at `.planning/v150-gap-closure/T32-TRIDENT-SYNTHESIS.md` is honest about this.
7. **No `--no-verify`. No force-push to main.** Tag force-move (`git tag -f v1.5.0`) was done locally this milestone for the retag-after-merge; further local retag if you adjust memory and re-ship is fine. Force-push tags to `gitlab` ONLY at T34 with explicit auth.

---

## 8. How to resume (verbatim — paste into the next session)

```
Next session is the v1.5.0 push-prep round. Read:

  1. .planning/v150-gap-closure/HANDOFF-v150-PUSH-PENDING.md  (this doc)
  2. .ijfw/memory/brief.md  (the milestone brief — especially W5 + Lead #5 framing)
  3. CHANGELOG.md [1.5.0] section  (what we claim shipped)

I am researching Claude mem-agent memory + other field implementations
(mem0, Zep, Graphiti, MemGPT/Letta, LangGraph) to verify IJFW's memory
layer is at-or-above the field on its claimed axes.

Build .planning/v150-gap-closure/MEMORY-FIELD-COMPARISON.md side-by-side.
If IJFW has a gap, fix it as one or more atomic commits, then:
  - re-run T31 proof-walk (511+103+e2e all green),
  - optionally re-run T32 Trident cross-audit if codex/gemini backends
    are healthier than last session (they 404/timed-out),
  - update CHANGELOG [1.5.0] if material,
  - force-move v1.5.0 tag to the new main HEAD.

If no gap, only update the brief framing if needed.

DO NOT push to gitlab. DO NOT npm publish. T34 stays gated until I say
"yes, push" explicitly. The pre-existing AGENTS.md + mcp-server/CLAUDE.md
drift NEVER gets staged.
```

---

## 9. Done-when (T34 — for completeness)

T34 completion contract: `npm view @ijfw/install version` returns `1.5.0`. After that runs clean, v1.5.0 is shipped.
