---
name: ijfw-team
description: "Generate project-specific agent teams during workflow Discovery. Trigger: 'set up a team', 'create agents for', or auto-triggered by ijfw-workflow deep mode after Discovery."
context: fork
model: sonnet
---

# IJFW Team Generator

Creates specialised agents for your specific project. Not generic templates --
agents tailored to your project's domain, stack, and needs.

Generated agents are saved to `.ijfw/agents/` (portable across platforms).
Any IJFW-compatible agent reads from this directory.

---

## How It Works

1. Receive project brief from Discovery stage (or ask for context)
2. Identify the domain and key roles needed
3. Generate agent markdown files with proper frontmatter
4. Present the proposed team for approval
5. Save approved agents to `.ijfw/agents/`

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
- Roles requiring deep reasoning, strategy, or high-stakes decisions → opus
- Roles doing the primary creation/implementation work → sonnet
- Roles doing reference checks, lookups, or routine tasks → haiku

Examples of non-standard teams:
- **Game dev**: game-designer, level-designer, systems-programmer, qa-tester, narrative-writer
- **Scientific research**: principal-investigator, literature-reviewer, data-analyst, methodology-reviewer
- **Music production**: producer, songwriter, mixing-engineer, mastering-engineer
- **Event planning**: event-director, logistics-coordinator, vendor-manager, creative-designer
- **Education**: curriculum-designer, subject-expert, assessment-writer, accessibility-reviewer

The templates above are starting points. Every team is customized to the specific project.

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

## Team Presentation

After generating, present the team as:

```
Project team ready:

  architect (opus)  -- system design, security model, API surface
  senior-dev (sonnet) -- auth flow, payment integration, complex features  
  dev (sonnet) -- CRUD endpoints, tests, UI components
  qa (sonnet) -- test strategy, edge cases, regression suite
  security (opus) -- threat model, auth audit, data protection

Agents saved to .ijfw/agents/
Adjust with: "swap qa for a dedicated performance engineer"
```

Positive framing. Team is "ready" not "generated." Feels like hiring, not configuring.

---

## Execution Integration

During workflow Execute stage, tasks are dispatched to the appropriate team agent:
- Match task type to agent specialty
- Agents run as subagents (isolated context)
- Parallel execution where tasks are independent
- Sequential where dependencies exist
- Cross-agent review: security audits architect's work, editor reviews writer's work

---

## Custom Agent Requests

User can always:
- "Add a performance engineer to the team"
- "I need a lore master who specialises in cyberpunk tech"
- "Swap the junior dev for a frontend specialist"
- "Remove the SEO specialist, I don't need that"

Modifications update `.ijfw/agents/` immediately.

---

## Portability

Agents in `.ijfw/agents/` work with any platform that reads agent markdown:
- Claude Code reads from `.claude/agents/` -- symlink or copy
- Codex reads agent definitions from its skills system
- Other platforms: agents are referenced in the workflow skill context

If `.forge/` directory exists, IJFW also reads agents from there.
`.ijfw/` and `.forge/` are treated as compatible project directories.

## AGENTS.md Mirror (Phase 2 / A1)

After saving agents to `.ijfw/agents/`, also mirror the team into the
project's `AGENTS.md` (open spec at https://agents.md/). Use the IJFW
block-aware merger so user-authored content stays untouched:

```bash
LOCK="$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts/lock.sh"
[ -f "$LOCK" ] || LOCK="$(pwd)/claude/skills/ijfw-agents-md/scripts/lock.sh"
# Build the agents block from .ijfw/agents/*.md (one bullet per role).
BLOCK=""
for f in .ijfw/agents/*.md; do
  name=$(basename "$f" .md)
  desc=$(grep -m1 '^description:' "$f" | sed 's/^description:[[:space:]]*//')
  BLOCK="${BLOCK}- **${name}** -- ${desc}\n"
done
bash "$LOCK" "$(pwd)/AGENTS.md" AGENTS "$(printf '%b' "$BLOCK")"
```

Two writes total: one to `.ijfw/agents/` (existing portable surface) and
one to `AGENTS.md` (canonical cross-platform surface). Session-start hooks
also keep AGENTS.md fresh on every new session, so this step is "as soon
as the team is approved", not a hard dependency.
