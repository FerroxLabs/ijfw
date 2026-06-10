# Skills & specialist teams

How IJFW keeps a large library of capabilities available without paying for them in context (a small always-on core, the rest hot-loaded on trigger and unloaded when done) and how it assembles a project-specific team of agents and hands off to the skills you already have. This is the deep-dive behind the README's engine summary. ([back to README](../README.md))

---

## On-demand skill loading

IJFW ships 34 skills (`claude/skills/`). If all of them sat in your context window at once, the savings IJFW exists to deliver would be eaten by the framework itself. They don't.

Only one skill is always resident: `ijfw-core` (54 lines, hard-capped at 55). It is the single source of truth for routing, framing, and the rules every session inherits. Everything else is loaded on demand: the skill body is pulled in when a trigger matches, and unloaded when the work is done. Your context stays lean; the skills are there the moment they're needed and absent the moment they aren't.

The triggers are natural language, not commands you have to memorize. Each skill declares the phrases and intents that fire it. "Plan this feature" opens `ijfw-plan`; "cross-audit this" opens `ijfw-cross-audit`; "set up a team" opens `ijfw-team`. Slash commands (`/ijfw-plan`, `/cross-audit`, `/handoff`) are aliases for the same skills when you'd rather be explicit.

This is deterministic dispatch, not magic. A skill fires when its declared trigger matches; it does not infer intent beyond what it's told to look for. The win is mechanical: a 54-line core instead of a 34-skill resident library, with the rest paged in and out on demand.

---

## The skill library

The 34 skills group by the job they do. Not exhaustive (see `claude/skills/` for the full set) but the shape of it:

**Workflow.** `ijfw-workflow` is the spine (brainstorm → plan → execute → verify → ship); `ijfw-plan`, `ijfw-spec-phase`, `ijfw-verify`, `ijfw-ship`, `ijfw-preflight` are the phases. These are the entry points for project-level work. The workflow engine and its modes are documented in [Workflow & cross-audit](judgment.md).

**Review & critique.** `ijfw-review` (two-stage review), `ijfw-cross-audit` (a second training lineage, codex / gemini / opencode / aider / copilot, reviews the diff), `ijfw-critique` (adversarial multi-angle), `ijfw-receiving-review` (how to take feedback without performative agreement).

**Memory & context.** `ijfw-recall`, `ijfw-memory-audit`, `ijfw-summarize`, `ijfw-compress` (shrinks handoffs and memory artifacts 40–50%), `ijfw-handoff` (session handoff generation and loading), `ijfw-auto-memorize`.

**Team & agents.** `ijfw-team` assembles the project-specific bench (below); `ijfw-agents-md` keeps the canonical `AGENTS.md` in sync.

**Engineering.** `ijfw-tdd`, `ijfw-debug`, `ijfw-commit`, `ijfw-design`, `ijfw-ui-spec`.

**Project lifecycle.** `ijfw-new-project`, `ijfw-new-milestone`, `ijfw-complete-milestone`, `ijfw-milestone-summary`, `ijfw-plan-check`.

**Operations.** `ijfw-dashboard`, `ijfw-metrics`, `ijfw-update`, `ijfw-compute` (the command sandbox).

**Meta.** `ijfw-writing-skills`: the rules for authoring skills, applied to IJFW's own.

---

## Natural-language invocation, context-aware

Invocation is intent plus current context. You describe what you want; IJFW resolves the *where* from what you're looking at.

Say "cross-audit this" and the skill picks up the target from context: the file open in front of you, the diff you just staged, the range you referenced a turn ago. Say "plan this feature" and `ijfw-workflow` opens with the brief already seeded from the conversation so far. You supply the verb; the skill supplies the object from the session state it can see.

This is a convenience layer, not inference about your goals. The skill reads concrete signals (open file, staged diff, last-referenced path) and falls back to asking when the target is ambiguous. It does not guess.

---

## Custom specialist teams, generated per project

A generic agent kit fits no project well. IJFW generates the team that fits the one you're actually running.

`ijfw-team` fires on the first session of a new project (or on request: "set up a team", "who should work on this"). It reads what you're building, detects the domain, and writes a purpose-built bench:

- **Software** → architect, senior dev, security, QA.
- **Fiction** → story architect, world builder, lore keeper.
- **Campaign** → strategist, copywriter, brand lead.
- **Research** → investigator, synthesist, fact-checker.

Team Assembly is project-agnostic by design: it covers software, books, content, design, research, business strategy, education, operations, and mixed projects. Each agent is written against *this* project's stack, conventions, and constraints, not a template. The team is more than a list of roles: `ijfw-team` also writes the operating contracts that let the agents coordinate around artifacts, claims, reviews, and handoffs.

The concrete command is `ijfw team init [--archetype <type>] [--name <team>] [--brief <text>]`. It writes:

- `.ijfw/team/`: the team definition and operating contracts.
- `.ijfw/agents/`: the generated agent files, swappable with `ijfw team swap` / `add` / `remove`.
- Codex agent files, refreshed with `ijfw codex sync-agents` after edits, so the same team is available cross-platform.

Generated agents are dispatched automatically when a task matches their role.

### The permanent specialist bench

Alongside the per-project team, IJFW ships a fixed roster of specialists in `claude/agents/` that any project can draw on. These are not regenerated per project; they're the hard-problem bench. A sample of the 37:

- **Build & fix**: `architect` (Opus, multi-file and architectural work), `builder` (Sonnet, single-file mechanical work), `scout` (Haiku, read-only investigation), `ijfw-code-fixer`, `ijfw-executor`.
- **Review & audit**: `ijfw-security-auditor`, `ijfw-risk-reviewer`, `ijfw-method-reviewer`, `ijfw-nyquist-auditor`, `ijfw-integration-checker`, `ijfw-dep-audit`.
- **Investigate**: `ijfw-debugger`, `ijfw-debug-session-manager`, `ijfw-codebase-mapper`, `ijfw-pattern-mapper`, `ijfw-assumptions-analyzer`, `ijfw-extract-learnings`.
- **Frontend & UX**: `ijfw-ui-auditor`, `ijfw-accessibility-eng`, `ijfw-accessibility-reviewer`, `ijfw-design-critic`.
- **Writing & narrative**: `ijfw-doc-writer`, `ijfw-doc-verifier`, `ijfw-line-editor`, `ijfw-copy-reviewer`, `ijfw-lore-keeper`, `ijfw-narrative-continuity-checker`.
- **Strategy & planning**: `ijfw-strategy-lead`, `ijfw-research-lead`, `ijfw-campaign-strategist`, `ijfw-roadmapper`, `ijfw-plan-checker`, `ijfw-discuss-phase`.
- **Run & release**: `ijfw-e2e-runner`, `ijfw-release-eng`, `ijfw-ralph-loop-runner`, `ijfw-llm-budget-watcher`.

The model each agent runs on is matched to its scope: read-only investigation is safe at any tier (Haiku), single-file mechanical work routes to Sonnet, and multi-file or architectural work routes to Opus. This routing is load-bearing: mis-routing a multi-file task to a cheaper model was a real failure mode, so the dispatch policy is explicit rather than left to chance.

---

## Installed-skill handoff

IJFW does not try to own every job. It notices the other skills you already have installed and hands off to them at the phase where they earn their keep.

If you have a dedicated design skill (`frontend-design`, a UX/UI skill), IJFW hands the design phase to it instead of doing a worse job inline. Code-review, testing, feature-dev, domain libraries (any skill on your machine) get picked up at the matching point in the workflow. The handoff is offered as one line and confirmed with one word; there are no registries to maintain and no configuration. The skill you already paid for gets used where it's strongest, and IJFW orchestrates around it.

This keeps IJFW honest about its own scope: it's the connective tissue and the discipline, not a replacement for tools you already trust.

---

## Visual companion for software builds

Design happens before build, not after. For Deep-mode software projects, IJFW offers a live visual companion the moment the brief locks: Mermaid diagrams for architecture, component boundaries, the data model, the API surface, and the security posture.

The visual is written to `.ijfw/visual/`, refreshed at every phase audit, and diff-reviewed at ship, so the picture tracks the code rather than rotting into a stale snapshot. If you have a dedicated design skill installed (`frontend-design`, UX/UI), IJFW hands the visual off to it so you get real mockups rather than just shapes: the installed-skill handoff applied to design.

---

## See also

- [Workflow & cross-audit](judgment.md): the workflow engine that dispatches teams and runs the phases these skills implement.
- [../README.md](../README.md): the engine summary this page expands on.
