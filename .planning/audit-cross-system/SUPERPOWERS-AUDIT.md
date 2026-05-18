# SUPERPOWERS Audit (v5.1.0)

**Auditor:** R1 (parallel swarm researcher)
**Date:** 2026-05-18
**Source:** `/Users/seandonahoe/.claude/plugins/cache/superpowers-marketplace/superpowers/5.1.0/`
**Plugin version:** 5.1.0
**Author:** Jesse Vincent (obra) — MIT License
**Manifest:** `superpowers` — "Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques"

---

## TL;DR

### Top 5 patterns IJFW should ADAPT
1. **Two-stage review = SPEC + QUALITY (separate reviewer subagents).** Superpowers dispatches a *spec-compliance reviewer* BEFORE the *code-quality reviewer*. The spec reviewer explicitly distrusts the implementer report and re-reads code. IJFW v1.4.4 has a "two-stage review" but blurs spec + quality into one pass — adopting Superpowers' strict ordering (spec PASS gates quality) would harden the gate.
2. **Self-review built into implementer prompt (Completeness / Quality / Discipline / Testing).** Implementer must run a 4-axis self-audit before reporting. This is cheap context-free quality gain. IJFW implementer prompts (per memory: 3/6 subagent truncations) don't enforce self-review — adding it could reduce reviewer rework.
3. **Model selection guidance baked into dispatch skill.** Superpowers tells dispatcher to pick cheap/standard/most-capable per task complexity. IJFW v1.4.4 dispatches uniformly — explicit model tiering would cut cost.
4. **"Continuous execution" rule (no check-ins between tasks).** Hard rule: dispatcher does NOT ask "should I continue?" between tasks. Only stops on BLOCKED / ambiguity / done. IJFW workflow should adopt this verbatim — it eliminates the chattiness pattern.
5. **"Never trust the implementer report" framing for reviewers.** Spec reviewer prompt explicitly says: "implementer finished suspiciously quickly. Their report may be incomplete, inaccurate, or optimistic." This adversarial reviewer mindset is missing from IJFW review prompts.

### Top 3 patterns IJFW should IGNORE
1. **Single-tree subagent dispatch (no worktree per agent).** Superpowers' `subagent-driven-development` runs ALL subagents in the controller's tree and forbids parallel implementers ("conflicts"). IJFW already has worktree isolation via dispatch, which is strictly better — DO NOT regress to single-tree.
2. **Graphviz `dot` decision trees inside SKILL.md.** Cute but unparseable for non-Claude consumers. IJFW's 55-line plain-prose cap is leaner.
3. **MIT-licensed reusable subagent prompts as separate files.** Superpowers ships `implementer-prompt.md` + `spec-reviewer-prompt.md` + `code-quality-reviewer-prompt.md` as separate files. IJFW's inline-template approach (dispatch fills variables at runtime via `team`/dispatch wiring) is more flexible — don't fragment.

### Pattern that surprised me most
**The "Never" red-flags list at the bottom of every workflow skill.** Each skill ends with a hard-fail list ("Never start implementation on main/master without explicit user consent", "Never skip reviews", "Never accept 'close enough'"). It treats anti-patterns as a contract violation, not a guideline. IJFW should adopt this format in core workflow skills — currently we soft-recommend.

---

## Skill inventory (14 skills)

| Skill | 1-line purpose | IJFW action |
|-------|----------------|-------------|
| `brainstorming` | Explores user intent, requirements, design before any creative work | ADAPT — compare to ijfw-workflow Q-pattern |
| `dispatching-parallel-agents` | One agent per independent problem domain, concurrent | ADAPT — IJFW's wave-CLI already does this; harden prompt structure |
| `executing-plans` | Load plan, execute tasks one-by-one in separate session | IGNORE — IJFW has stronger workflow/wave model |
| `finishing-a-development-branch` | Decide merge/PR/cleanup after work complete | ADAPT — compare to ijfw-ship D6 |
| `receiving-code-review` | Verify before implementing, no performative agreement | ADAPT — high-signal anti-sycophancy rules |
| `requesting-code-review` | Dispatch reviewer subagent with git SHA range | ADAPT — verdict shape + git-range pattern |
| `subagent-driven-development` | Fresh subagent per task + 2-stage review (spec → quality) | **ADAPT — top priority** |
| `systematic-debugging` | Before-fix discipline: reproduce, hypothesize, verify | ADAPT — compare to ijfw-debug |
| `test-driven-development` | RED → GREEN → REFACTOR with anti-mock-cheating gate | ADAPT — strict TDD framing |
| `using-git-worktrees` | Native isolation tools or worktree fallback | ALREADY HAVE — IJFW v1.5.0 S2 closes this |
| `using-superpowers` | Meta-skill: how to find/use skills, requires Skill tool first | IGNORE — IJFW has its own routing layer |
| `verification-before-completion` | Evidence before assertions; run commands before claiming "done" | **ADOPT — top priority for v1.5.1** |
| `writing-plans` | Spec → multi-step plan with bite-sized tasks + verifications | ADAPT — compare to ijfw-plan |
| `writing-skills` | Create/edit/verify skills against quality checklist | ADAPT — compare to IJFW skill-creator |

---

## Subagent dispatch pattern (deep-dive)

### How dispatcher briefs subagents

Superpowers uses **3 separate prompt template files** in `skills/subagent-driven-development/`:
- `implementer-prompt.md`
- `spec-reviewer-prompt.md`
- `code-quality-reviewer-prompt.md`

The implementer-prompt structure (verbatim sections):

1. **Task Description** — "FULL TEXT of task from plan - paste it here, don't make subagent read file"
2. **Context** — "Scene-setting: where this fits, dependencies, architectural context"
3. **Before You Begin** — explicit invitation to ask questions before working
4. **Your Job** — 6-step contract (implement, test, verify, commit, self-review, report)
5. **Code Organization** — file-responsibility rules + "if file growing beyond plan intent, stop and report DONE_WITH_CONCERNS"
6. **When You're in Over Your Head** — explicit escalation invitation ("Bad work is worse than no work")
7. **Self-Review** — 4-axis checklist (Completeness, Quality, Discipline, Testing)
8. **Report Format** — 4-value status + structured fields

**Critical line for IJFW:** "You will not be penalized for escalating." This is explicit psychological safety baked into the prompt.

### Worktree isolation

`subagent-driven-development` requires `superpowers:using-git-worktrees` as a sub-skill but does NOT dispatch one worktree per subagent — implementer + reviewers all run in the controller's tree. Parallel implementer dispatch is explicitly forbidden:

> "Never... Dispatch multiple implementation subagents in parallel (conflicts)"

This is WEAKER than IJFW v1.4.4 wave-dispatch with `isolation: "worktree"`. IJFW should NOT regress.

### Status protocol (vs. IJFW v1.4.4 4-value)

**Match.** Superpowers uses the exact same 4-value status: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`.

Handling (from `subagent-driven-development/SKILL.md` lines 104-120):

| Status | Controller action |
|--------|-------------------|
| DONE | Proceed to spec compliance review |
| DONE_WITH_CONCERNS | Read concerns, address if correctness/scope, else note and proceed |
| NEEDS_CONTEXT | Provide missing context + re-dispatch |
| BLOCKED | Assess: (1) more context, (2) more capable model, (3) break into smaller pieces, (4) escalate to human |

**IJFW gap:** IJFW v1.4.4 has the 4 values but the controller-side handling matrix is less prescriptive. Specifically:
- IJFW doesn't explicitly say "re-dispatch with more capable model" for BLOCKED
- IJFW doesn't say "break into smaller pieces"
- "Never ignore an escalation or force the same model to retry without changes" — this hard rule is missing from IJFW

### Truncation handling

**ZERO truncation handling in Superpowers.** No mention of token caps, no commit-as-you-go pattern, no skeleton-first strategy.

This is **IJFW's competitive advantage**. v1.4.4 memory notes 3/6 truncations + the 62% truncation rate referenced in this very dispatch prompt. Superpowers has no answer for this — Anthropic's `Task` tool issue must not affect them as much (different usage pattern: shorter focused tasks, not 600-line audits).

### Recovery pattern

From the `BLOCKED` handling matrix (lines 114-120):

1. Context problem → provide more context, re-dispatch with **same** model
2. Reasoning problem → re-dispatch with **more capable** model
3. Task too large → break into smaller pieces
4. Plan wrong → escalate to human

Plus: "Never ignore an escalation or force the same model to retry without changes."

**IJFW gap:** The model-escalation ladder is explicit in Superpowers. IJFW dispatch wiring (v1.4.4 N1) currently uses a fixed model per dispatch — no escalation ladder. **Recommendation:** add a `--escalate-model` flag to `ijfw_run` for BLOCKED retries.

### IJFW gap summary
- [ ] **Add self-review section** to IJFW implementer prompts (4-axis checklist)
- [ ] **Add "continuous execution" rule** to ijfw-workflow execute phase
- [ ] **Add model escalation ladder** for BLOCKED status
- [ ] **Add "Never ignore escalation"** hard rule to dispatch protocol
- [ ] **Adopt "Bad work is worse than no work"** framing in implementer prompt
- [x] 4-value status — ALREADY DONE in v1.4.4

---

## Code review pipeline (deep-dive)

### Stage structure

Superpowers uses a **strict 2-stage review with ordering gate**:

```
implementer DONE → spec-compliance reviewer
                       ↓ ✅ PASS
                   code-quality reviewer
                       ↓ ✅ APPROVED
                   mark task complete
```

**Hard rule (lines 249-250):** "Start code quality review before spec compliance is ✅ (wrong order)" — listed as a Never.

After ALL tasks complete: a **final** code-reviewer subagent runs on the entire implementation before `finishing-a-development-branch`.

### Reviewer prompt structure

**Spec reviewer** (`spec-reviewer-prompt.md`):

The killer feature is the **adversarial framing**:

> ## CRITICAL: Do Not Trust the Report
>
> The implementer finished suspiciously quickly. Their report may be incomplete, inaccurate, or optimistic. You MUST verify everything independently.

Then explicit DO / DO NOT lists:
- DO NOT: take their word, trust completeness claims, accept their interpretation
- DO: read actual code, compare line-by-line, check missing pieces, look for extras

Three failure modes the reviewer must check:
1. **Missing requirements** (skipped or claimed-not-implemented)
2. **Extra/unneeded work** (over-engineering, nice-to-haves)
3. **Misunderstandings** (wrong problem solved)

**Code-quality reviewer** (`code-quality-reviewer-prompt.md`):

Defers to the `requesting-code-review/code-reviewer.md` template. Adds extra checks:
- Single-responsibility per file
- Decomposed units (testable independently)
- File-structure matches plan
- "Don't flag pre-existing file sizes — focus on what this change contributed"

### Verdict shape

**Spec reviewer:** binary — `✅ Spec compliant` or `❌ Issues found: [file:line list]`

**Code reviewer** (`code-reviewer.md`): structured 5-section output:

```
### Strengths
### Issues
#### Critical (Must Fix)   — bugs, security, data loss, broken functionality
#### Important (Should Fix) — architecture, missing features, error handling, test gaps
#### Minor (Nice to Have)   — style, optimization, docs polish
### Recommendations
### Assessment
**Ready to merge?** [Yes | No | With fixes]
**Reasoning:** [1-2 sentence technical assessment]
```

For each issue: file:line, what's wrong, why it matters, how to fix.

### Iteration semantics

**No explicit iteration cap.** Loop is: reviewer finds issues → implementer fixes → re-review → repeat until approved. The escalation path is "if subagent fails task, dispatch fix subagent with specific instructions" — implicit cap is "as many rounds as it takes."

**Compare to IJFW v1.4.4 N3 review.js:** IJFW has explicit iteration tracking + presumably some max-rounds gate. Superpowers leaves this to the human-in-loop on the controller side.

### Integration with worktrees / git

Reviewer prompt mandates git SHA range:
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
git diff --stat {BASE_SHA}..{HEAD_SHA}
git diff {BASE_SHA}..{HEAD_SHA}
```

The reviewer reads the diff (not the file tree) — this is a precise, bounded scope. **IJFW should adopt this** — currently `ijfw cross-audit` reads broader context.

### IJFW gap summary (vs. v1.4.4 N3 review.js)
- [ ] **Strict spec→quality ordering** (spec PASS gates quality) — Superpowers has it, IJFW blurs the two
- [ ] **Adversarial reviewer framing** ("don't trust the report") — verbatim addition recommended
- [ ] **Binary spec verdict** + structured quality verdict (3-tier severity) — adopt
- [ ] **Git-SHA range scoping** in reviewer prompt — adopt for cross-audit
- [ ] **Final reviewer pass** after all tasks complete — does IJFW have this between Execute and Ship? Confirm
- [ ] **No iteration cap** (Superpowers' weakness) — IJFW's cap is BETTER, keep it

---

## Verification + TDD (deep-dive)

(To be filled in next commit pass.)

## Plan-writing + executing protocols

(To be filled in next commit pass.)

## Systematic debugging

(To be filled in next commit pass.)

## Brainstorming protocol

(To be filled in next commit pass.)

## Skill structure conventions

(To be filled in next commit pass.)

## Hooks + scripts inventory

(To be filled in next commit pass.)

## Top recommendations for IJFW v1.5.1+

(To be filled in next commit pass.)
