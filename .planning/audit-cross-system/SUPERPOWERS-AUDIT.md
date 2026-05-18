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

### Evidence-before-assertion enforcement

The `verification-before-completion` skill is **the most disciplined skill in the entire library**. It defines a single "Iron Law":

> ```
> NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
> ```
> If you haven't run the verification command in this message, you cannot claim it passes.

The skill provides a 5-step **Gate Function**:

1. IDENTIFY — what command proves this claim?
2. RUN — execute FULL command (fresh, complete)
3. READ — full output, check exit code, count failures
4. VERIFY — does output confirm the claim?
5. ONLY THEN — make the claim

Plus a verbatim "Common Failures" table mapping claims → required evidence:

| Claim | Requires |
|-------|----------|
| Tests pass | Test command output: 0 failures |
| Linter clean | Linter output: 0 errors |
| Build succeeds | Build command: exit 0 |
| Bug fixed | Test original symptom: passes |
| Regression test works | Red-green cycle verified |
| Agent completed | VCS diff shows changes |
| Requirements met | Line-by-line checklist |

The skill explicitly forbids: "should work now", "I'm confident", "linter passed" (linter ≠ compiler), "agent said success" (verify independently).

### TDD loop they impose

`test-driven-development` is encoded as RED → Verify RED → GREEN → Verify GREEN → REFACTOR.

**The MANDATORY Verify-RED step** is the load-bearing innovation:

> Verify RED — Watch It Fail
> MANDATORY. Never skip.
> Test passes? You're testing existing behavior. Fix test.
> Test errors? Fix error, re-run until it fails correctly.

This catches "test was always going to pass" bugs.

**The anti-mock-cheating gate** is encoded in test examples:

> ❌ BAD: `expect(mock).toHaveBeenCalledTimes(3)` (tests mock not code)
> ✅ GOOD: `expect(result).toBe('success'); expect(attempts).toBe(3)` (tests real behavior)

And the iron law: **"NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"** — with "Write code before the test? Delete it. Start over." as the hard rule.

### IJFW gap (vs. v1.4.4 N5 verification-gate.js)

- [ ] **Adopt the verbatim "Iron Law"** in `ijfw-verify` skill — currently softer
- [ ] **Adopt the Common Failures table** mapping (claim → evidence) — concrete + scannable
- [ ] **Add "Rationalization Prevention" table** — 8 excuses + reality counters; missing from IJFW
- [ ] **Adopt the "Spirit over letter" framing** for verification — Superpowers' anti-loophole pattern
- [x] IJFW v1.4.4 N5 verification-gate.js already exists — gap is **prompt-level discipline**, not gate logic
- [ ] **TDD skill missing from IJFW** — Superpowers has explicit RED-GREEN-REFACTOR; IJFW assumes TDD but doesn't enforce. Consider importing `test-driven-development` skill verbatim under attribution

## Plan-writing + executing protocols

### Plan structure they require

`writing-plans` mandates a strict document header + per-task structure:

```markdown
# [Feature Name] Implementation Plan
> For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development...

**Goal:** [One sentence]
**Architecture:** [2-3 sentences]
**Tech Stack:** [Key technologies]
---
```

Then per-task:

```markdown
### Task N: [Component Name]
**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

- [ ] **Step 1: Write the failing test**  [code block]
- [ ] **Step 2: Run test to verify it fails**  [command + expected output]
- [ ] **Step 3: Write minimal implementation**  [code block]
- [ ] **Step 4: Run test to verify it passes**  [command + expected output]
- [ ] **Step 5: Commit**  [git command]
```

**Task granularity:** 2-5 minutes per step. Steps use checkbox syntax (`- [ ]`) for TodoWrite tracking.

**Plan path:** `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` (user preference overrides).

### Task breakdown rules

The "No Placeholders" section is the **anti-laziness contract**:

> Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
> - "TBD", "TODO", "implement later", "fill in details"
> - "Add appropriate error handling" / "add validation" / "handle edge cases"
> - "Write tests for the above" (without actual test code)
> - "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)

**This is the killer line:** "the engineer may be reading tasks out of order" — explicitly designed for subagent dispatch where each subagent sees only its own task text.

### Self-Review for plans

After writing, the planner runs a 3-axis self-review:

1. **Spec coverage** — can you point to a task for each spec requirement?
2. **Placeholder scan** — search for red-flag patterns from "No Placeholders"
3. **Type consistency** — does `clearLayers()` in Task 3 match `clearFullLayers()` in Task 7?

### IJFW gap (vs. ijfw-plan / ijfw-ultraplan-phase)

- [ ] **Mandatory document header** — IJFW plans should ALL start with the same 4-line header (Goal / Architecture / Tech Stack / Required sub-skill)
- [ ] **"Tasks may be read out of order" framing** — verbatim adoption recommended; this justifies the "repeat the code" rule and matches IJFW's parallel-wave dispatch reality
- [ ] **3-axis plan self-review** — IJFW currently relies on cross-audit; adding inline planner self-review cuts review rounds
- [ ] **Bite-sized step contract (2-5 min per step)** — IJFW phases are larger; consider explicit step granularity in plan template

## Systematic debugging

### Their loop

`systematic-debugging` defines a 4-Phase Iron Law:

> ```
> NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
> ```

| Phase | Activities | Success criteria |
|-------|-----------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence at boundaries | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare against references, identify differences | Identified differences |
| **3. Hypothesis** | Form ONE theory, test minimally (one variable), verify | Confirmed or new hypothesis |
| **4. Implementation** | Create failing test, single fix, verify, **escalate at 3+ failures** | Bug resolved |

**Killer innovation: the 3-fix architecture-question rule.**

> If 3+ fixes failed: STOP and question the architecture. Pattern: each fix reveals new shared state/coupling in different place. Fixes require "massive refactoring". Each fix creates new symptoms elsewhere. → This is NOT a failed hypothesis — this is a wrong architecture.

**Multi-component evidence gathering** (verbatim pattern):

```
For EACH component boundary:
  - Log what data enters component
  - Log what data exits component
  - Verify environment/config propagation
  - Check state at each layer
Run once to gather evidence showing WHERE it breaks
THEN analyze evidence to identify failing component
THEN investigate that specific component
```

Plus partner-signals decoder ("Is that not happening?", "Will it show us...?", "Stop guessing", "Ultrathink this", "We're stuck?") — each interpreted as STOP→Phase 1.

### IJFW gap (vs. ijfw-debug skill)

- [ ] **Adopt the 4-phase Iron Law** in `ijfw-debug` — currently lacks the gating discipline
- [ ] **Adopt the 3-fix architecture rule** — concrete escalation trigger, missing from IJFW
- [ ] **Adopt multi-component evidence-gathering template** — verbatim is fine
- [ ] **Adopt partner-signals decoder** — translates frustration into procedural action
- [ ] **Supporting techniques** — Superpowers has separate files for `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md` (each as standalone reference). IJFW could similarly modularize debugging tactics

## Brainstorming protocol

### Their elicitation pattern

`brainstorming` enforces a **HARD-GATE**:

> Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.

**9-step checklist (each becomes a TodoWrite item):**

1. Explore project context (files, docs, recent commits)
2. Offer Visual Companion (own message, no other content) — if visual questions ahead
3. Ask clarifying questions — **one at a time**
4. Propose 2-3 approaches with trade-offs + recommendation
5. Present design in sections, get approval after each
6. Write design doc to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and commit
7. Spec self-review (placeholder / consistency / scope / ambiguity)
8. User reviews written spec
9. Transition to implementation (invoke writing-plans skill)

**Anti-pattern called out explicitly:**

> "This Is Too Simple To Need A Design" — Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work.

**Key principles:**
- One question at a time (don't overwhelm)
- Multiple choice preferred
- YAGNI ruthlessly
- Always propose 2-3 approaches
- Terminal state: invoke `writing-plans` (NO other skill)

### IJFW gap (vs. ijfw-workflow's Q-style)

- [ ] **HARD-GATE pattern** — IJFW workflow softly recommends discuss before plan; Superpowers makes it a contract
- [ ] **One-question-at-a-time rule** — IJFW Q-mode sometimes batches questions; Superpowers forbids
- [ ] **"This is too simple" anti-pattern callout** — explicit rationalization counter; IJFW lacks
- [ ] **9-step TodoWrite checklist** — IJFW workflow has phases but not a per-checklist-item TodoWrite contract
- [ ] **Visual Companion as standalone offer message** — neat UX; consider for IJFW's frontend-heavy projects
- [x] IJFW's multi-mode (Quick/Deep) routing IS BETTER than Superpowers' single-path — keep it
- [x] IJFW's mode-by-task-size IS BETTER than Superpowers' "every project gets full process" — keep it

## Skill structure conventions

### Frontmatter contract

Per `writing-skills`:

```yaml
---
name: skill-name-with-hyphens   # letters, numbers, hyphens only
description: Use when [triggering conditions and symptoms]   # third person
---
```

- Max **1024 characters total** for entire frontmatter
- Two required fields: `name`, `description`
- `description` MUST start with "Use when..."
- `description` MUST describe ONLY triggering conditions — **never summarize workflow**

**Critical insight (verbatim):**

> Testing revealed that when a description summarizes the skill's workflow, Claude may follow the description instead of reading the full skill content. A description saying "code review between tasks" caused Claude to do ONE review, even though the skill's flowchart clearly showed TWO reviews. When the description was changed to just "Use when executing implementation plans with independent tasks" (no workflow summary), Claude correctly read the flowchart and followed the two-stage review process.

**This is gold for IJFW.** Current IJFW skill descriptions (e.g., the `ijfw-workflow` description listed in this very session reminder) DO summarize workflow — this may be causing Claude to skip skill body reads.

### Section conventions

Standard SKILL.md layout:

```markdown
# Skill Name
## Overview (1-2 sentence core principle)
## When to Use (small inline flowchart IF non-obvious + symptom bullets)
## Core Pattern (before/after code)
## Quick Reference (scannable table)
## Implementation (inline OR file link)
## Common Mistakes (anti-patterns)
## Real-World Impact (optional, concrete)
```

**Length targets:**
- getting-started workflows: **<150 words each**
- Frequently-loaded skills: **<200 words total**
- Other skills: **<500 words** (still concise)

Compare to IJFW's `ijfw-core/SKILL.md` **53 lines / 55-line hard cap**. IJFW is MORE disciplined on length but loses on the rationale documentation Superpowers includes (the long-form skills are 600+ lines because they bulletproof against rationalization).

### Skill types

- **Technique** — concrete method with steps (condition-based-waiting)
- **Pattern** — way of thinking (flatten-with-flags)
- **Reference** — API docs, syntax guides

### IJFW gap (vs. ijfw-core 55-line cap)

- [ ] **Audit IJFW skill descriptions for workflow-summarization** — this is the highest-impact CSO fix. Specifically check `ijfw-workflow`, `ijfw-plan`, `ijfw-execute`, `ijfw-debug` descriptions and rewrite as "Use when..." triggers only
- [ ] **Adopt the 1024-char frontmatter limit** as enforcement
- [ ] **Consider per-skill length tiers** — IJFW's blanket 55-line cap works for core but blocks the bulletproofing patterns Superpowers uses for discipline skills (TDD, verification). Consider a tiered cap: core (55), workflow (200), discipline (500), reference (unlimited)
- [x] IJFW's flat 55-line cap IS BETTER for hot-loaded core — keep
- [x] IJFW's plain-prose vs Superpowers' graphviz: IJFW wins for readability

## Hooks + scripts inventory

### `hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup|clear|compact",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd session-start",
        "async": false
      }]
    }]
  }
}
```

**Single hook: SessionStart only.** Fires on `startup | clear | compact`.

### `hooks/session-start` (bash)

What it does:
1. Resolves `PLUGIN_ROOT` from script location
2. Detects legacy `~/.config/superpowers/skills` dir → emits user-facing warning if present
3. Reads full `skills/using-superpowers/SKILL.md` content
4. JSON-escapes via bash parameter substitution (fast, no per-char loop)
5. Wraps in `<EXTREMELY_IMPORTANT>You have superpowers.</EXTREMELY_IMPORTANT>` envelope
6. **Platform-detects output format:**
   - Cursor (`CURSOR_PLUGIN_ROOT`) → `additional_context` (snake_case)
   - Claude Code (`CLAUDE_PLUGIN_ROOT` && !`COPILOT_CLI`) → `hookSpecificOutput.additionalContext` (nested)
   - Copilot CLI / unknown → `additionalContext` (top-level SDK standard)
7. Uses `printf` not heredoc to work around bash 5.3+ heredoc hang (`github.com/obra/superpowers/issues/571`)

**Key pattern:** the hook **force-loads the meta-skill content** into the system prompt on every session. This is how Superpowers ensures the "always check for skills first" rule survives compaction.

### `hooks/run-hook.cmd` (polyglot wrapper)

Polyglot bash/cmd file. On Windows, cmd.exe runs the batch portion which finds Git Bash and dispatches. On Unix, `:` is a no-op and the bash portion runs.

Extensionless filenames (no `.sh`) deliberately — Claude Code's Windows auto-detection prepends `bash` to `.sh` commands and would interfere.

**Bash search order:**
1. `C:\Program Files\Git\bin\bash.exe`
2. `C:\Program Files (x86)\Git\bin\bash.exe`
3. `where bash` (PATH)
4. Silent exit (plugin still works, no session context)

### `scripts/`

Two scripts only:
- `bump-version.sh` — version management
- `sync-to-codex-plugin.sh` — sync to codex plugin

### IJFW gap (hooks surface)

- [ ] **Single-hook discipline** — Superpowers ships ONE hook (SessionStart). IJFW ships many — audit whether they all earn their token cost
- [ ] **Polyglot run-hook.cmd pattern** — clever cross-platform wrapper. Compare to IJFW's Windows handling (per memory: HOME+USERPROFILE gotcha)
- [ ] **`printf` over heredoc** — Superpowers learned this from bash 5.3+ hang bug. Worth grepping IJFW hooks for heredoc usage
- [ ] **Multi-platform additionalContext key detection** — Superpowers handles Cursor/Claude/Copilot variation in one hook. IJFW ships per-platform packages (claude/, codex/, gemini/, etc.) so doesn't have this problem — but the pattern is reusable for a future unified plugin

## Top recommendations for IJFW v1.5.1+

Ranked by impact/cost ratio.

### 1. ADAPT — Strict spec→quality review ordering [HIGH impact / LOW cost]

**Pattern:** Two SEPARATE reviewer subagents, in mandatory order:
1. Spec-compliance reviewer (adversarial framing: "don't trust the report")
2. Code-quality reviewer (only after spec PASS)

**IJFW changes:**
- Update `mcp-server/review.js` (per memory: v1.4.4 N3) to dispatch 2 reviewer types with explicit ordering gate
- Add `spec-reviewer-prompt.md` to `claude/skills/ijfw-review/` (verbatim adapt Superpowers template)
- Update `ijfw-workflow.execute` to call both reviewers per task

**Cost:** ~200 lines code + 2 prompt files. **Impact:** addresses the "blurred review" gap noted in v1.4.4 memory.

### 2. ADAPT — "Continuous execution" rule + 4-axis self-review in implementer prompt [HIGH impact / TRIVIAL cost]

**Pattern:**
- Implementer prompt MUST include 4-axis self-review (Completeness / Quality / Discipline / Testing) before reporting
- Dispatcher does NOT pause between tasks — only stops on BLOCKED / ambiguity / done
- "You will not be penalized for escalating" (psychological-safety framing)

**IJFW changes:**
- Update implementer prompt template (`claude/agents/` or `mcp-server/dispatch.js`) — add 4-axis section + escalation-OK line
- Add to `ijfw-workflow.execute` skill: "Do not check in between tasks. Continuous execution."

**Cost:** ~50 lines prompt edits. **Impact:** could reduce v1.4.4's 3/6 subagent truncation rate by catching issues at implementer self-review.

### 3. DUPLICATE — Adopt verbatim "Iron Law" framing for verification gate [MEDIUM impact / TRIVIAL cost]

**Pattern:** Single hard rule + Common Failures table + Rationalization Prevention table.

**IJFW changes:**
- Rewrite `ijfw-verify` skill (and v1.5.0 N5 verification-gate.js prompt) to lead with Iron Law
- Add the verbatim "Common Failures" table (8 rows)
- Add the "Rationalization Prevention" table (8 excuses → realities)

**Cost:** ~80 lines skill rewrite. **Impact:** Superpowers' framing is provably more bulletproof than soft "you should verify" language.

### 4. ADAPT — Model escalation ladder for BLOCKED status [MEDIUM impact / MEDIUM cost]

**Pattern:** BLOCKED handler escalates:
1. Context problem → re-dispatch same model with more context
2. Reasoning problem → re-dispatch with **more capable** model
3. Task too large → break into smaller pieces
4. Plan wrong → escalate to human

**IJFW changes:**
- Add `--escalate-model` flag to `mcp__ijfw__ijfw_run`
- Add escalation matrix to controller (`mcp-server/dispatch.js`)
- Document model tiers (cheap / standard / capable) — match Superpowers' 3-tier guidance

**Cost:** ~150 lines dispatch + docs. **Impact:** unblocks tasks currently dying as BLOCKED with no retry strategy.

### 5. ADAPT — Description-as-trigger-only CSO discipline [HIGH impact / LOW cost]

**Pattern:** Skill descriptions describe ONLY when to invoke, NEVER summarize workflow. Testing showed workflow-summary descriptions cause Claude to skip skill body.

**IJFW changes:**
- Audit ALL IJFW skill descriptions (`ijfw-*/SKILL.md` files in `claude/skills/`)
- Rewrite any description that includes workflow steps as pure "Use when..." triggers
- High-priority targets (per session reminder, these all summarize workflow): `ijfw-workflow`, `ijfw-execute`, `ijfw-plan`, `ijfw-debug`, `ijfw-ship`, `ijfw-verify`

**Cost:** ~20 lines of frontmatter edits. **Impact:** could be biggest win — IJFW skills may currently be partially skipped because Claude follows the description shortcut.

### 6. ADAPT — Systematic debugging 4-phase Iron Law + 3-fix architecture rule [MEDIUM impact / LOW cost]

**Pattern:** "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST" + at 3+ failed fixes, question architecture not fundamentals.

**IJFW changes:**
- Rewrite `ijfw-debug/SKILL.md` to encode 4 phases
- Add 3-fix architecture-question gate
- Add multi-component evidence-gathering template

**Cost:** ~150 lines skill rewrite. **Impact:** debug skill becomes prescriptive, not just descriptive.

### 7. IGNORE — Don't regress to single-tree subagent dispatch [N/A]

Superpowers forbids parallel implementer subagents because they run in the controller's tree. IJFW v1.4.4 has worktree-per-subagent (per memory: v1.5.0 S2 closes the npm-install-in-worktree gap). **IJFW is strictly better here — do not regress.**

### 8. IGNORE — Don't adopt graphviz `dot` blocks in skills [N/A]

Cute for Claude Code but unparseable for the other 7 platforms IJFW ships to. IJFW's plain-prose convention is correct.

### 9. CONSIDER — Modular debugging supporting files [LOW impact / MEDIUM cost]

Superpowers splits debugging into `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md` as separate technique files referenced from the main skill. Worth considering for IJFW once `ijfw-debug` grows past 200 lines.

---

## Summary table — IJFW v1.5.1 backlog candidates

| # | Recommendation | Impact | Cost | Closes IJFW gap |
|---|----------------|--------|------|------------------|
| 1 | Spec→quality strict review ordering | HIGH | LOW | v1.4.4 review.js blur |
| 2 | Continuous execution + 4-axis self-review | HIGH | TRIVIAL | v1.4.4 truncation rate |
| 3 | Iron Law verification framing | MEDIUM | TRIVIAL | ijfw-verify softness |
| 4 | Model escalation ladder | MEDIUM | MEDIUM | BLOCKED with no retry |
| 5 | CSO description-as-trigger audit | HIGH | LOW | skill body skipping |
| 6 | 4-phase systematic debugging | MEDIUM | LOW | ijfw-debug prescriptiveness |
| 9 | Modular debugging files | LOW | MEDIUM | future-proofing |

---

**End of audit.**

