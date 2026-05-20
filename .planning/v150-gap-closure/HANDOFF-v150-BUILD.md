# IJFW v1.5.0 Gap-Closure — BUILD SESSION HANDOFF

**Created:** 2026-05-20
**For:** the next session — an **EXECUTE** session. The brainstorm and
planning are done. The next session builds.

---

## 0. STATE PIN

**Repo:** `/Users/seandonahoe/dev/ijfw` · **Branch:** `main`
**HEAD:** `2ba371b` · **Tag:** `v1.5.0` → `282bad8` (provisional, LOCAL
ONLY — moves as gap-closure lands, final only when v1.5.0 ships).
**Tests:** green at last sweep (`node --test` 2013/2012/0-fail/1-skip;
`npm test` 103/103).
**Nothing is pushed.** v1.5.0 ships only after the build plan is fully
executed and every falsifiable proof is green. Phase F (push + npm
publish) is operator-gated.

---

## 1. WHAT THIS PLANNING ARC PRODUCED

Four locked, cross-audited artifacts in `.planning/v150-gap-closure/` +
`.ijfw/memory/`:

1. **`.ijfw/memory/brief.md`** — the locked v1.5.0 gap-closure brief:
   the state-SDK spine, 5 flagship capabilities (3 structural moats + 2
   first-mover leads), the 8-dimension ship scorecard, the 12-row
   falsifiable-proof contract.
2. **`ROADMAP-v150-GAP-CLOSURE.md`** — the phase breakdown (P0a→P3).
3. **`BUILD-PLAN-v150-GAP-CLOSURE.md`** — **the execution artifact.** 34
   tasks (T1-T34) in 6 waves, each a self-contained dispatch brief with a
   falsifiable completion contract (`verify:` command).
4. **Cross-audit records** — `CROSS-AUDIT-ADJUDICATION.md` (brief+roadmap,
   3-lens) and `PLAN-CROSS-AUDIT-ADJUDICATION.md` (build plan, 3-lens).
   Every finding folded in.

The brainstorm resolved all architecture forks; two cross-audits hardened
the plan. The build plan is dispatch-ready.

---

## 2. THE NEXT SESSION'S JOB — execute the build plan

**Resume protocol:**
```
This session EXECUTES the v1.5.0 gap-closure build plan.
Read .planning/v150-gap-closure/BUILD-PLAN-v150-GAP-CLOSURE.md first —
top to bottom. Then read .ijfw/memory/brief.md for the proof contract.

Use superpowers:subagent-driven-development. Dispatch the waves per the
plan's Wave Table: A → (B ∥ C ∥ E) → D → F. Within a wave, dispatch
parallel tasks as multiple Agent calls in ONE message; never run two
tasks in parallel that Modify the same file (the plan is collision-checked
— honor it). Two-stage review (spec compliance, then code quality) after
each task. A task is DONE only when its verify: command passes.

This is still v1.5.0, one tag. Phase F (T34) is operator-gated — STOP and
await explicit "yes, push". Do not push or publish without it.
```

**Wave order (the plan's execution contract):**
- **Wave A** (P0a, T1-T5) — SEQUENTIAL. T1 freezes the verb contract; it
  is the keystone — do not let it be vague.
- **Wave B** (P0b, T6-T14), **Wave C** (P1.1, T15-T18), **Wave E** (P2,
  T21-T30) — all run off Wave A's frozen contract; may overlap. Wave C is
  internally sequential (shared files).
- **Wave D** (P1.2, T19-T20) — after Wave C's T15 + Wave B's T6.
- **Wave F** (P3, T31-T34) — after C+D+E. T34 = Phase F, operator-gated.

---

## 3. CARRY-FORWARD CONSTRAINTS

- **No-half-shipping.** Every falsifiable-proof row (brief proof table)
  green at its threshold before ship. A red proof = not done.
- **Worktree dispatch does not run `npm install`** — brief every Node
  subagent to `cd mcp-server && npm install` first.
- **MCP cap stays 12/12** — T13 absorbs `ijfw_subagent_post_done` into
  `ijfw_state`; do not add a 13th tool.
- **Anti-patterns** (brief §anti-patterns): no 33-agent clone, worktree
  isolation stays, Node 18 floor, zero new prod deps, core skill ≤55 lines.
- **Pre-existing unstaged drift:** `AGENTS.md` + `mcp-server/CLAUDE.md`
  carry session-state mods unrelated to this milestone — safe to leave.
- `.planning/` is gitignored — force-add audit artifacts with `git add -f`.

---

## 4. FIRST ACTIONS FOR THE NEXT SESSION

1. Read `BUILD-PLAN-v150-GAP-CLOSURE.md` fully.
2. Invoke `superpowers:subagent-driven-development`.
3. Create a worktree if the skill calls for one
   (`superpowers:using-git-worktrees`).
4. Dispatch Wave A, starting with T1. Do not parallelize Wave A.
5. After Wave A's frozen contract lands, fan out B/C/E.
