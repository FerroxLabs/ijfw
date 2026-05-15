---
name: ijfw-team
description: "Generate project-specific agent teams during workflow Discovery. Trigger: 'set up a team', 'create agents for', or auto-triggered by ijfw-workflow deep mode after Discovery."
context: fork
model: sonnet
---

# IJFW Team Assembly

Assembles a project-specific operating team. Team Assembly is
project-agnostic: it works for software, books, content, design, research,
business strategy, education, operations, and mixed projects.

Do not treat every team as a code-generation swarm. Generate the agents plus
the operating contracts that let those agents coordinate around artifacts,
claims, reviews, and handoffs.

CLI entry point: `ijfw team init [--archetype <type>] [--name <team-name>]`.
`ijfw team` is the skill/workflow trigger; `ijfw team init` is the concrete
command that writes `.ijfw/team/`, `.ijfw/agents/`, and Codex agent files.

---

## How It Works

1. Receive project brief from Discovery stage (or ask for context)
2. Infer one or more project archetypes and artifact types
3. Identify the roles needed for creation, review, integration, and verification
4. Generate portable agent markdown files with proper frontmatter
5. Generate Codex custom-agent TOML when the Codex surface is present
6. Generate the team charter and workflow manifest
7. Present the proposed team and operating model for approval
8. Save approved outputs to `.ijfw/agents/`, `.codex/agents/`, and `.ijfw/team/` as applicable

---

## Operating Outputs

Team Assembly 2.0 produces three coordinated surfaces:

- `.ijfw/agents/*.md` -- portable human/platform-readable agent definitions
- `.codex/agents/*.toml` -- Codex custom agents generated from the same role contracts when Codex is installed or `ijfw codex sync-agents` is run
- `.ijfw/team/charter.json` -- team roster, role contracts, phase scope, owned artifacts, reviewed artifacts, conflict rules, handoff requirements, verification responsibilities
- `.ijfw/team/workflow.json` -- project work manifest: archetypes, artifacts, owners, dependencies, waves, review graph, verification commands or rubrics

Keep `.ijfw/agents/*.md` lightweight and role-focused. Put machine-readable
ownership, dependency, review, and coordination details in the charter and
workflow manifest.

Codex TOML agents are platform-native projections, not a separate source of
truth. Regenerate them with `ijfw codex sync-agents` after changing the team
charter, and check the local Codex install with `ijfw codex doctor`.

---

## Project Archetypes

Infer archetypes from the brief, repository signals, existing files, and user
corrections. Support mixed projects instead of forcing one label.

Common archetypes:

- **software** -- modules, APIs, tests, config, docs
- **design** -- screens, flows, tokens, components, prototypes
- **content** -- briefs, articles, landing copy, scripts, social posts
- **book** -- chapters, outline, continuity bible, timeline, notes
- **research** -- questions, corpus, methods, evidence table, synthesis
- **business** -- strategy docs, operating plans, models, risk register
- **education** -- curriculum, lessons, assessments, rubrics
- **operations** -- SOPs, workflows, runbooks, checklists
- **mixed** -- any project-specific combination

---

## Domain Templates (starting points -- always customize to the project)

### Software Development
- **product-lead** (sonnet) -- requirements, user stories, acceptance criteria
- **architect** (opus, high effort) -- system design, security, data model, API design
- **senior-dev** (sonnet) -- complex implementation, patterns, code review
- **dev** (sonnet) -- feature implementation, tests, bug fixes
- **qa** (sonnet) -- test strategy, edge cases, regression testing
- **security** (opus, high effort) -- threat model, auth, data protection, pen testing
- **devops** (haiku) -- CI/CD, deployment, infrastructure, monitoring
- **docs** (haiku) -- documentation, API docs, READMEs, guides

### Book / Long-Form Writing
- **story-architect** (opus, high effort) -- plot structure, pacing, arcs, tension
- **world-builder** (sonnet) -- settings, environments, atmosphere, sensory detail
- **lore-master** (haiku) -- continuity bible, rules, history, faction tracking
- **prose-stylist** (sonnet) -- voice, tone, sentence craft, genre conventions
- **continuity-editor** (haiku) -- cross-chapter consistency, timeline, character tracking
- **beta-reader** (sonnet) -- fresh-eyes review, plot holes, reader experience

### Content / Marketing
- **strategist** (opus, high effort) -- campaign strategy, audience, positioning
- **copywriter** (sonnet) -- headlines, body copy, CTAs, tone of voice
- **seo-specialist** (haiku) -- keywords, structure, meta, search intent
- **editor** (sonnet) -- clarity, grammar, consistency, brand voice
- **social-media** (haiku) -- platform adaptation, hooks, engagement

### Business / Strategy
- **ceo** (opus, high effort) -- vision, strategy, decision-making, priorities
- **cto** (opus, high effort) -- technical strategy, architecture, build-vs-buy
- **analyst** (sonnet) -- research, data analysis, market assessment
- **operations** (sonnet) -- process design, workflows, efficiency
- **finance** (haiku) -- budgets, projections, cost analysis

### Design / Creative
- **creative-director** (opus, high effort) -- vision, aesthetic direction, brand
- **ux-designer** (sonnet) -- user flows, wireframes, usability, accessibility
- **ui-designer** (sonnet) -- visual design, components, responsive layout
- **researcher** (haiku) -- user research, competitive analysis, testing

### Any Other Domain

If the project doesn't match a template above, ask:
"What roles would you need on a team to build this well?"

Then generate agents from the user's description. Map each role to a model tier:
- Roles requiring deep reasoning, strategy, or high-stakes decisions -> opus
- Roles doing the primary creation/implementation work -> sonnet
- Roles doing reference checks, lookups, or routine tasks -> haiku

Examples of non-standard teams:
- **Game dev**: game-designer, level-designer, systems-programmer, qa-tester, narrative-writer
- **Scientific research**: principal-investigator, literature-reviewer, data-analyst, methodology-reviewer
- **Music production**: producer, songwriter, mixing-engineer, mastering-engineer
- **Event planning**: event-director, logistics-coordinator, vendor-manager, creative-designer
- **Education**: curriculum-designer, subject-expert, assessment-writer, accessibility-reviewer

The templates above are starting points. Every team is customized to the specific project.

---

## Role Contract Guidance

Every role should have a contract in `.ijfw/team/charter.json` with:

- `name`, `role_type`, `model`, and `effort`
- `phase_scope` such as discovery, shape, execute, review, integrate
- `owns` entries for artifact types and path globs or non-file artifact IDs
- `reviews` entries with review criteria
- `handoff` format and required sections
- `coordination` rules including claim requirements and conflict boundaries
- `verification` responsibility: commands for code, rubrics for non-code work

Example contract shape:

```json
{
  "name": "ux-researcher",
  "role_type": "research",
  "model": "sonnet",
  "effort": "medium",
  "phase_scope": ["discovery", "shape", "review"],
  "owns": [
    {"artifact_type": "user_flow", "paths": ["design/flows/**"]}
  ],
  "reviews": [
    {"artifact_type": "screen", "criteria": ["usability", "accessibility"]}
  ],
  "handoff": {
    "format": "markdown",
    "required_sections": ["findings", "risks", "recommendations", "changed_artifacts"]
  },
  "coordination": {
    "parallel_safe": true,
    "conflicts_with": ["ui-designer when editing design/tokens/**"],
    "claim_required": true
  }
}
```

---

## Workflow Manifest Guidance

The workflow manifest describes work in domain terms. It is not just a file
list and must not assume code-only verification.

Each artifact entry should include:

- stable `id`
- domain `type`
- `paths` where file-backed, or a non-file artifact reference
- `owner`
- `reviewers`
- `depends_on`
- `verification` as commands, checks, rubrics, or acceptance criteria

Each wave should include:

- `id`
- `mode`: `parallel`, `sequential`, or `review`
- `artifact_ids`
- dependency rationale when work cannot run in parallel

Example manifest shape:

```json
{
  "project_archetypes": ["software", "design"],
  "artifacts": [
    {
      "id": "design-preview-flow",
      "type": "prototype",
      "paths": [".planning/brainstorm/*.html"],
      "owner": "ui-designer",
      "reviewers": ["ux-designer", "accessibility-reviewer"],
      "depends_on": [],
      "verification": ["ijfw design push .planning/brainstorm/*.html"]
    }
  ],
  "waves": [
    {
      "id": "w1",
      "mode": "parallel",
      "artifact_ids": ["schema-foundation", "design-command-docs"]
    }
  ]
}
```

---

## Agent File Format

Each generated agent follows this structure:

```markdown
---
name: <role-name>
model: <haiku|sonnet|opus>
effort: <low|medium|high>
description: <when to use this agent -- 1-2 lines>
allowed-tools: <relevant tools for this role>
---

<Role-specific instructions for this project>

Context from project brief:
<Relevant details from the brief that this agent needs>

Rules:
<Role-specific rules>
```

---

## Codex Custom Agent Format

When Codex is available, Team Assembly also writes `.codex/agents/*.toml` from
the same role contracts. If `.codex/` is absent, unwritable, or intentionally
out of scope for the project, keep `.ijfw/team/charter.json` as canonical,
write `.ijfw/agents/` markdown role files, and tell the user to run
`ijfw codex sync-agents` later from a writable Codex-enabled checkout. Each
Codex TOML file includes:

- `name` -- stable role identifier
- `description` -- when to use the agent
- `developer_instructions` -- project-specific role contract, artifact scope,
  blackboard discipline, verification, handoff format, and non-revert rules

Optional Codex-only model fields are included only when the role explicitly
defines them. Keep the canonical role contract in `.ijfw/team/charter.json`;
use `ijfw codex sync-agents` to refresh TOML files after team edits.

Codex runtime caveat: some tool-backed sessions expose a generic `spawn_agent`
without named custom-agent invocation. In that case, use the generated TOML as
durable role documentation and paste `ijfw swarm prompt <task-id> --codex` into
the built-in worker or explorer agent. The prompt is designed to carry the full
artifact scope and blackboard contract even without named custom-agent routing.

---

## Team Presentation

After generating, present the team and operating outputs as:

```
Project team ready:

  architect (opus)  -- system design, security model, API surface
  senior-dev (sonnet) -- auth flow, payment integration, complex features
  dev (sonnet) -- CRUD endpoints, tests, UI components
  qa (sonnet) -- test strategy, edge cases, regression suite
  security (opus) -- threat model, auth audit, data protection

Agents saved to .ijfw/agents/
Codex agents saved to .codex/agents/ when Codex agent sync is available; otherwise .ijfw/team/charter.json remains canonical
Charter saved to .ijfw/team/charter.json
Workflow saved to .ijfw/team/workflow.json
Codex health check: ijfw codex doctor
Adjust with: "swap qa for a dedicated performance engineer"
```

Positive framing. Team is "ready" not "generated." Feels like hiring, not configuring.

---

## Execution Model

During workflow Execute stage, tasks are dispatched through the workflow
manifest and charter:

- Match each task to an owner, artifact IDs, allowed paths or artifact scope, completion criteria, and verification method
- Require blackboard claims before an agent edits or owns an artifact during parallel work
- Use parallel waves only when artifact claims and dependencies do not conflict
- Use sequential waves where dependencies, claims, or integration order require it
- Generate review tasks from the review graph, not as informal suggestions
- Record findings, decisions, blockers, claims, and handoffs in `.ijfw/blackboard/`
- Treat review findings as integration gates when severity or criteria require it

Review examples:

- security reviews auth and data-handling artifacts
- editor reviews brand and clarity for content artifacts
- continuity-editor reviews timeline and character artifacts
- methodology-reviewer audits evidence and research methods
- operations reviews SOP failure modes and dry-run readiness

---

## Blackboard Coordination

Team Assembly should prepare agents to coordinate through the project
blackboard when execution begins:

- `.ijfw/blackboard/tasks.json` tracks task graph and statuses
- `.ijfw/blackboard/claims.json` tracks active artifact ownership
- `.ijfw/blackboard/findings.jsonl` records review notes and issues
- `.ijfw/blackboard/decisions.jsonl` records runtime decisions
- `.ijfw/blackboard/blockers.jsonl` records blocked work
- `.ijfw/blackboard/handoff.md` summarizes active swarm state

Claims are artifact-aware. A claim can be a file glob, chapter, design token
set, research corpus, strategy model, lesson plan, or any project-specific
artifact. Agents must release or hand off claims when their task completes.

---

## Worktree Policy

Worktrees are optional and only for code-heavy projects or code-heavy portions
of mixed projects.

Use git worktrees when:

- multiple software agents need to edit overlapping repository areas in parallel
- the user explicitly requests swarm execution with isolated code edits
- task verification can run independently before integration

Do not require worktrees for:

- writing, editing, research, strategy, operations, education, or design-only work
- mixed projects where only non-code artifacts are being changed
- dirty worktrees with unrelated user changes unless the user approves the isolation plan

For non-code and mixed non-code work, use blackboard claims, artifact-scoped
output paths, and staged review gates instead.

---

## Custom Agent Requests

User can always:
- "Add a performance engineer to the team"
- "I need a lore master who specialises in cyberpunk tech"
- "Swap the junior dev for a frontend specialist"
- "Remove the SEO specialist, I don't need that"

Modifications update `.ijfw/agents/` immediately. AGENTS.md remains the
canonical cross-platform instruction surface; after team changes, update only
the `IJFW-AGENTS` managed region with the current role names, owned artifacts,
and agent file paths. Preserve all content outside IJFW markers. If the
block-aware AGENTS merger is available, use it; otherwise record a checkpoint
and state exactly which AGENTS region still needs mirroring.

---

## Portability

Agents in `.ijfw/agents/` work with any platform that reads agent markdown.
If `.forge/` directory exists, IJFW also reads agents from there.
`.ijfw/` and `.forge/` are treated as compatible project directories.
