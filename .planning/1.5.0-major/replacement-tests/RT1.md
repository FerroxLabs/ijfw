# Replacement Test RT1 — GSD-Style Software Build with IJFW Only

**Scenario:** A user asks: *"Build a CLI tool that takes a CSV of email addresses, validates them, deduplicates, and exports clean JSON. I want it shipped to npm."* Walk this end-to-end through the 11-step GSD-equivalent lifecycle (discover → spec → discuss → plan → execute → review → verify → ship → milestone-summary → extract-learnings → complete-milestone) using ONLY IJFW skills, agents, and commands shipped in the current worktree. Verify each step's existence, trigger fidelity, output contract, hand-off to the next step, and domain-agnosticism.

**Verdict:** PARTIAL
**HIGH findings:** 3   **MEDIUM:** 4   **LOW:** 4

## Per-step coverage matrix

| GSD step | IJFW skill/agent | Exists? | Trigger fidelity | Output contract | Hand-off | Multi-domain | Verdict |
|---|---|---|---|---|---|---|---|
| discover | `claude/skills/ijfw-new-project/SKILL.md` (since 1.5.0, 126 lines) | YES | Strong — natural-language + slash | Strong — `.ijfw/memory/brief.md` + `.planning/<milestone>/MILESTONE.md` + `project_meta` memory key | Strong — explicit `Next:` line points to `ijfw-plan` for software, domain-aware for others | YES — 6 domains enumerated, anti-software-assumption clause | **FLAG** (software.brief.md template MISSING) |
| spec | `claude/skills/ijfw-spec-phase/SKILL.md` (since 1.5.0, 153 lines) | YES | Strong — "spec this", "scope this", "lock requirements", slash | Strong — `.planning/<MS>/<phase>/SPEC.md` with falsifiable acceptance criteria | Strong — dispatches `ijfw-discuss-phase` then `/ijfw-plan-phase` | YES — software/book/campaign/research examples in body | **PASS** |
| discuss | `claude/agents/ijfw-discuss-phase.md` (since 1.5.0, 214 lines) | YES | Strong — natural-language + slash, dispatched-by-skill flow | Strong — `.planning/<MS>/<phase>/CONTEXT.md` with D-XX decisions + checkpoint resume | Strong — returns control to spec-phase | YES — explicit per-domain gray-area table | **PASS** |
| plan | `claude/commands/ijfw-plan.md` (slash command, 40 lines) | YES (as slash command, not skill) | Medium — slash works; natural-language routes through `ijfw-workflow` | Medium — writes `.ijfw/memory/plan.md` fallback `.planning/**/PLAN.md`; not a skill, so contract is documented in command body not enforced by a SKILL.md | Medium — references PLAN AUDIT gate then execute, but no agent or skill file enforces hand-off | YES (workflow body is domain-agnostic) | **FLAG** (no `ijfw-plan` skill file — only a slash command + `ijfw-plan-check` skill) |
| execute | `claude/commands/ijfw-execute.md` + `claude/agents/ijfw-executor.md` (since 1.5.0, 144 lines) | YES | Strong — slash + "start building", "execute the plan", "build it" | Strong — executor agent emits 4-value Status block with `Attempts:` cap; ledger at `.ijfw/state/execute-issues.json` | Strong — ends at PHASE AUDIT gate; `/ijfw-execute resolve` sub-command | YES (workflow-wrapped) | **PASS** |
| review | `claude/skills/ijfw-review/SKILL.md` (NO `since:`, 42 lines) | YES | Medium — "review", "code review", "PR review", slash | Weak — emits one-liner findings + `gate-result` JSON; no review report artifact path; no PR comment integration | Weak — no explicit hand-off to verify or ship; relies on user judgment | Software-centric ("null handling", "test coverage") — NOT domain-agnostic | **FLAG** (no `since:`, software-only, no artifact path) |
| verify | `claude/skills/ijfw-verify/SKILL.md` (NO `since:`, 138 lines) + `claude/agents/ijfw-nyquist-auditor.md` (since 1.4.4) | YES | Strong — fires on "done", "tests pass", "shipped", "no regressions", "ready to merge" etc. | Strong — Iron Law gate + ledger check + nyquist coverage matrix to `.planning/<phase>/NYQUIST.md`; runtime-enforced via `ijfw_subagent_post_done` | Strong — gate must pass before ship; ledger blocks ship | YES at the Iron Law level (works for any claim); nyquist auditor is test-focused so software-leaning | **PASS** (LOW: missing `since:`) |
| ship | `claude/commands/ijfw-ship.md` (slash command, 62 lines) | YES (as slash command, not skill) | Strong — slash + "ship it", "deploy", "go live", "wrap this up" | Strong — SHIP GATE re-reads original brief + ledger gate + confidence declaration + explicit push-word requirement | Medium — references end-of-workflow but no automated hand-off to milestone-summary | Mostly software ("changelog", "npm publish", "deployment") — domain-agnostic claims weak | **FLAG** (no `ijfw-ship` skill file; ship checklist is software-shaped) |
| milestone-summary | `claude/skills/ijfw-milestone-summary/SKILL.md` (since 1.5.0, 122 lines) | YES | Strong — natural-language ("milestone summary", "what shipped in v<X>") + slash | Strong — `.planning/<MS>/SUMMARY.md` with 6 fixed sections + stats footer + overwrite guard | Strong — explicitly callable solo OR dispatched by `ijfw-complete-milestone` (C04) | YES — explicit per-domain "what shipped" rewording (software/book/campaign/podcast/research) | **PASS** |
| extract-learnings | `claude/agents/ijfw-extract-learnings.md` (since 1.5.0, 215 lines) | YES | Medium — agent, no direct slash; dispatched by `ijfw-complete-milestone`; natural-language trigger relies on user knowing the agent name | Strong — `.planning/<MS>/<phase>/LEARNINGS.md` with frontmatter counts + 5 categories + memory feedback bar | Strong — writes back to memory as `type: feedback`; called by C04 | YES — "domain-agnostic" stated explicitly; works for chapter / campaign / sprint | **PASS** (MEDIUM: no slash command) |
| complete-milestone | `claude/skills/ijfw-complete-milestone/SKILL.md` (since 1.5.0, 97 lines) | YES | Strong — natural-language ("milestone complete", "wrap milestone", "ship milestone") + slash | Strong — moves `.planning/<MS>/` → `.planning/_archive/<MS>/`, collapses ROADMAP entry, writes memory, optionally tags | Strong — dispatches `ijfw-extract-learnings` then `ijfw-milestone-summary` then commits | YES — explicit "phases in a book milestone (chapters), a campaign milestone (channels), or a design-system milestone (tiers) all use the same archive path" | **PASS** |

**Step coverage:** 11/11 steps exist in some form. 7/11 are skill or agent files with `since:` frontmatter. 4/11 (plan, execute, ship, review) either rely on slash commands without a paired SKILL.md or lack `since:` frontmatter, which is a contract gap.

## Findings

### HIGH — blocks the all-in-one claim

- **H1: `software.brief.md` template is MISSING from the `ijfw-new-project` template directory.**
  **Evidence:** `claude/skills/ijfw-new-project/SKILL.md:42` lists `claude/skills/ijfw-new-project/templates/software.brief.md` as the software-domain template; `ls claude/skills/ijfw-new-project/templates/` returns `book.brief.md campaign.brief.md design-system.brief.md landing-page.brief.md launch.brief.md` — **no `software.brief.md`**.
  **Impact:** The scenario's domain is software. The most-requested IJFW domain runs the documented fallback path (minimal skeleton) instead of the templated one. Every other domain has a curated brief; software does not. This is the exact opposite of "smarter not cheaper".
  **Fix:** Author `claude/skills/ijfw-new-project/templates/software.brief.md` with fields: goal, users, success criteria, non-goals, first move, distribution target (e.g. npm, internal, web). Shipping the other 5 templates without this one is a half-ship under the "no half-shipping" principle.

- **H2: `ijfw-review` is software-only and lacks `since:` frontmatter; there is no domain-agnostic review surface.**
  **Evidence:** `claude/skills/ijfw-review/SKILL.md:1-19` — no `since:` field; trigger checklist is "null handling, error paths, security boundaries, test coverage"; output contract is one-liner findings, no artifact path written, no PR comment integration. The matrix row for GSD's `/gsd-code-review` (which writes a CODE-REVIEW.md per-phase artifact) has no equivalent file in IJFW.
  **Impact:** A book or campaign milestone has no "review" step. The replacement claim breaks in the first non-software domain — IJFW reverts to "the user reviews their own work" while GSD ships a structured artifact.
  **Fix:** Either (a) extend `ijfw-review` to detect `project_meta.domain` and load a domain-appropriate review checklist (prose / message / design system), OR (b) add `ijfw-code-review` as a domain-agnostic review skill that writes `.planning/<MS>/<phase>/REVIEW.md`, leaving `ijfw-review` as the lightweight inline reviewer. Add `since:` either way.

- **H3: No `ijfw-plan` and no `ijfw-ship` SKILL.md files — both are slash commands only.**
  **Evidence:** `claude/skills/` directory contains `ijfw-plan-check` (a check, not the planner) and no `ijfw-ship`. `find` confirms `claude/commands/ijfw-plan.md` and `claude/commands/ijfw-ship.md` exist but no paired SKILL.md.
  **Impact:** Slash commands route into `ijfw-workflow` at a phase, but a slash command is not auto-invoked by description-match — it requires the user to type it. Natural-language "let's plan the CSV CLI" or "ship it" goes through `ijfw-workflow` (correct), but standalone "plan-phase" semantics (PLAN.md contract, output artifact, ledger writes) are diffused across the workflow body rather than concentrated in a dedicated planner skill the way `ijfw-spec-phase` concentrates spec contract. This makes the "GSD has a phase per skill" parity claim weaker than it looks in the table — the asymmetry between `ijfw-spec-phase` (skill) and `ijfw-plan` (slash) is a real gap.
  **Fix:** Either promote `ijfw-plan` and `ijfw-ship` to SKILL.md files with their own contracts and `since:`, OR document explicitly in the README that the workflow skill owns plan + ship and the slash commands are entry-point sugar. Pick a story and ship it.

### MEDIUM — friction in the user's path

- **M1: `ijfw-verify` SKILL.md missing `since:` frontmatter.**
  **Evidence:** `claude/skills/ijfw-verify/SKILL.md:1-4` — no `since:` field. v1.5.0 contract enforcement (S07) requires every skill carry `since:` for compatibility tracking.
  **Impact:** Loaders that filter skills by `since:` will miss the gate that imports the Iron Law — a load-bearing skill.
  **Fix:** Add `since: '1.5.0'` to frontmatter.

- **M2: `ijfw-extract-learnings` has no slash command and no description hook for natural-language invocation outside the C04 dispatch.**
  **Evidence:** `claude/agents/ijfw-extract-learnings.md:1-7` — agent only. No slash entry under `claude/commands/`. Trigger surface is "Use after a phase or milestone completes…" — agentic dispatch only.
  **Impact:** A user who completes a phase mid-milestone (the common case) cannot say "/extract-learnings" — they must remember the agent name or rely on `ijfw-complete-milestone` (which only fires at milestone end). Mid-milestone learnings are stranded until the milestone closes.
  **Fix:** Add `claude/commands/extract-learnings.md` slash entry that dispatches the agent with the active phase resolved from `.ijfw/state/active-phase`.

- **M3: `ijfw-ship` and `ijfw-review` use software vocabulary in checklists.**
  **Evidence:** `claude/commands/ijfw-ship.md:8-14` (changelog / deployment / monitoring / rollback / npm); `ijfw-review` SKILL body lists null handling, error paths, test coverage.
  **Impact:** Domain-agnostic claim partially false. A book milestone "shipping" should mean "publish manuscript", not "deployment monitoring".
  **Fix:** Branch checklist by `project_meta.domain` read at runtime (the pattern `ijfw-new-project` already sets up via the project_meta key).

- **M4: Hand-off chain between phases is implicit, not enforced.**
  **Evidence:** Each skill ends with `Next:` text but no skill rejects invocation if the prior artifact is missing (except `ijfw-execute` which has the ledger gate). `ijfw-spec-phase` does not block if `brief.md` is absent — it falls back. `ijfw-milestone-summary` does not require LEARNINGS.md.
  **Impact:** A user can skip steps unintentionally; the all-in-one claim depends on the chain being walked in order, but nothing enforces order beyond the workflow skill.
  **Fix:** Either tighten the dispatch (skill A refuses to run unless skill A-1's artifact exists) or add a `--no-prereq` escape hatch with a visible warning. Right now the chain is convention, not contract.

### LOW — polish

- **L1: Matrix-cell visibility — no `Status:` block returned by `ijfw-new-project`, `ijfw-spec-phase`, `ijfw-milestone-summary`, or `ijfw-complete-milestone`.**
  Only the agent files (`ijfw-executor`, `ijfw-extract-learnings`) emit the v1.5.0-major Status block. Skill-emitted "output format" sections are bespoke per skill. Standardizing on the 4-value Status block across skills too would make orchestration uniform.

- **L2: `ijfw-discuss-phase` agent file references `AskUserQuestion` extensively but no fallback is documented for runtimes without it (Codex / Gemini).**
  Multi-platform claim weakens on AskUserQuestion-less hosts.

- **L3: ROADMAP.md entry for the scenario's milestone is not auto-created — `ijfw-new-project` only stubs `MILESTONE.md` placeholder.**
  Downstream skills (`ijfw-spec-phase` Step 2.3) read `.planning/<MS>/ROADMAP.md` but it isn't seeded. Empty-read fallback works but a populated stub would surface what's planned.

- **L4: `extract-learnings` memory key collision rule (append `-2`, `-3`) is unbounded.**
  After 10+ runs the memory store gets noisy keys. A retention policy (or merge-into-one-entry) would help.

## What IJFW does BETTER than GSD (in this scenario)

- **Iron Law verification gate.** `ijfw-verify` imports Superpowers' Iron Law and wires it to a runtime gate (`ijfw_subagent_post_done` → `verification-gate.js`). GSD has `/gsd-validate-phase` but no same-message-evidence runtime enforcement that downgrades DONE to DONE_WITH_CONCERNS automatically.
- **Memory feedback loop.** `ijfw-extract-learnings` writes high-signal entries back to memory as `type: feedback` so the next phase can recall prior decisions. GSD's `/gsd-extract-learnings` writes a markdown but lacks the memory tool integration.
- **Domain-aware bootstrap.** `ijfw-new-project` treats book/campaign/landing-page/design-system/launch as first-class peers from line 1; GSD's `/gsd-new-project` assumes software.
- **3-attempt fix cap in `ijfw-executor`.** Converts subagent truncation from behavior problem to budget problem — codified as Status `Attempts:` field. GSD has no equivalent cap; subagents can loop indefinitely.
- **Auto-picker Quick vs Deep mode.** Workflow skill picks mode from prompt signals; GSD requires the user to choose the phase command explicitly.
- **Ledger gate at execute AND ship.** Unresolved issues in `.ijfw/state/execute-issues.json` block both — bidirectional safety net. GSD relies on PR review to catch deferred items.

## Summary

- IJFW currently covers **11/11** of the GSD-equivalent steps in some form, but **4** (plan, ship, review, extract-learnings-trigger) have contract or surface-area gaps that weaken the "drop-in replacement" claim.
- **Top 3 fixes that would make this REPLACES-GSD:**
  1. Author `software.brief.md` template (H1) — 15 min.
  2. Add `since:` to `ijfw-verify` and `ijfw-review` (M1) and resolve the review-domain-agnosticism question (H2) — either domain-branch `ijfw-review` or add `ijfw-code-review` skill — 1-2 h.
  3. Promote `ijfw-plan` and `ijfw-ship` to SKILL.md form (H3) OR document the workflow-owns-them story in README — 1-2 h.
- **Estimated effort to close all HIGH findings: 1-4h.** All three are scoped, mechanical, and have clear patterns in the existing codebase to follow.
- **Verdict rationale:** PARTIAL, not DOES-NOT-REPLACE — the bones are all there, the memory/verify integration genuinely surpasses GSD in specific axes, and the domain-agnostic intent is structurally honored in 8/11 steps. But the matrix's 3 HIGH findings each break the all-in-one claim in a way a first-time user would hit on day 1. With the H1-H3 fixes shipped, this becomes REPLACES-GSD with caveats; today, it's a strong partial.
