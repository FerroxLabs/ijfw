# Trident Audit Target — Team / Swarm / Domain-Template Subsystem

**Audit ask:** v1.5.0 ships an "on-the-fly team + agent generator" as a flagship multi-domain feature. The marketing claim is "no more force-fitting a novel outline into a src/ folder — all domains first-class." Operator review surfaced that this subsystem has cross-file drift causing end-to-end failure for non-software domains. We need codex + gemini to independently audit this subsystem.

## Context — design intent (operator's words verbatim)

> "The whole point of that swarm config was it was meant to generate those specific agents on the fly. That's the whole point of this. It creates team members and agents on demand. We were talking about book stuff just as an example, but the whole point is that the swarm, once you have your team, is meant to create all those on the fucking fly."

So the architecture is:
1. User runs `ijfw team init --brief "<text>" [--archetype <domain>]`
2. Generator detects archetype from brief (or uses --archetype)
3. Generator reads a domain template
4. Generator writes per-project agent .md files into `.ijfw/agents/` (and mirrors to `.codex/agents/` etc.)
5. User runs `ijfw swarm plan` / `ijfw swarm prepare`
6. Swarm dispatcher reads the generated agents AND its own benchspec to plan parallel work
7. Wave dispatch runs the agents (via subagent_type in Claude, via codex hook in Codex)

If any link in chain 1→7 breaks for a non-software archetype, the multi-domain claim is false.

## Empirical state (verified 2026-05-22)

✓ `ijfw team init --brief "A noir thriller novel" --archetype book` runs without error
✓ It produces `.ijfw/agents/chapter-writer.md`, `.ijfw/agents/continuity-editor.md`, charter.json, workflow.json
✓ It produces `.codex/agents/<mirrors>` via `syncCodexAgents`
✗ The generated agent names do NOT match `swarm-config.js BOOK_BENCH`
✗ There are three disagreeing template files for the book domain

## Subsystem files (full source below)

### File 1: `mcp-server/src/team/generator.js` (the generator entry point)

(Full file 395 lines — focal points: line 21 FIXTURE_DIR, line 273 loadTeamTemplate, line 279 createTeamAssembly. Read directly from disk: `/Users/seandonahoe/dev/ijfw/mcp-server/src/team/generator.js`)

Key facts:
- Line 21: `FIXTURE_DIR = resolve(fileURLToPath(new URL('../../fixtures/team/', import.meta.url)))` — generator reads from `mcp-server/fixtures/team/` ONLY.
- Line 273: `loadTeamTemplate(archetype)` reads `<FIXTURE_DIR>/<archetype>.json` — never touches `src/team/domain-templates/`.
- Line 309-313: iterates `bundle.charter.roles` and writes each as `<role.name>.md` — agent names come from `role.name` in the fixture.
- Line 14-15: imports `DOMAIN_SPECIALIST_AGENT_IDS` from `./schemas.js` — those IDs are the "T25 G7-gen" promise, returned in `domainSpecialistAgentIds` on line 328 BUT NEVER USED to create files. They're advertised, not realized.

### File 2: `mcp-server/fixtures/team/book.json` (what generator actually uses)

```json
{
  "charter": {
    "schema_version": "team-charter/v1",
    "team_name": "book-development-team",
    "project_archetypes": ["book"],
    "roles": [
      { "name": "chapter-writer", "role_type": "book", ... },
      { "name": "continuity-editor", "role_type": "review", ... }
    ]
  },
  "workflow": { ... },
  "blackboard": { ... }
}
```

**Agent names produced: `chapter-writer`, `continuity-editor` (no `ijfw-` prefix, 2 agents).**

### File 3: `mcp-server/src/team/domain-templates/book.json` (T26 claim, UNUSED by generator)

```json
{
  "schema_version": "domain-template/v1",
  "domain": "book",
  "agent_ids": [
    "ijfw-narrative-continuity-checker",
    "ijfw-line-editor",
    "ijfw-lore-keeper"
  ],
  "agent_id_source": "domain-specialist",
  "workflow_phases": ["outline", "draft", "revise", "review"],
  "brief_fields": [ ... ]
}
```

**Agent names claimed: `ijfw-narrative-continuity-checker`, `ijfw-line-editor`, `ijfw-lore-keeper` (`ijfw-` prefix, 3 agents). This file is referenced by the CHANGELOG T26 entry and by `schemas.js` `DOMAIN_SPECIALIST_AGENT_IDS` — but is NEVER LOADED by the generator at runtime.**

### File 4: `mcp-server/src/swarm-config.js BOOK_BENCH` (what swarm dispatcher uses)

```js
const STORY_ARCHITECT     = { id: 'story-architect',    role: 'Plot + structure architecture', agent_type: 'ijfw-story-architect',    since: '1.5.0' };
const CONTINUITY_EDITOR   = { id: 'continuity-editor',  role: 'Timeline + voice continuity',   agent_type: 'ijfw-continuity-editor',  since: '1.5.0' };
const PROSE_STYLIST       = { id: 'prose-stylist',      role: 'Sentence-level voice + pacing', agent_type: 'ijfw-prose-stylist',      since: '1.5.0' };

const BOOK_BENCH = [STORY_ARCHITECT, CONTINUITY_EDITOR, PROSE_STYLIST, DOC_VERIFIER, NYQUIST_AUDITOR];
```

**Agent names expected: `ijfw-story-architect`, `ijfw-continuity-editor`, `ijfw-prose-stylist`, `ijfw-doc-verifier`, `ijfw-nyquist-auditor` (`ijfw-` prefix, 5 agents).**

## The cross-file drift summary

For the BOOK domain alone, here are the three rosters side-by-side:

| | Generator OUTPUT (real, on-disk) | T26 domain-template (claimed) | Swarm BENCH (dispatch expects) |
|---|---|---|---|
| Convention | no prefix | ijfw- prefix | ijfw- prefix |
| Count | 2 | 3 | 5 |
| Agent 1 | chapter-writer | ijfw-narrative-continuity-checker | ijfw-story-architect |
| Agent 2 | continuity-editor | ijfw-line-editor | ijfw-continuity-editor |
| Agent 3 | — | ijfw-lore-keeper | ijfw-prose-stylist |
| Agent 4 | — | — | ijfw-doc-verifier |
| Agent 5 | — | — | ijfw-nyquist-auditor |

**Zero name overlap. Three completely independent rosters. Same domain. Shipped together in v1.5.0.**

Same triple-disagreement pattern likely holds for the CONTENT, RESEARCH, DESIGN, BUSINESS archetypes — please verify.

## Trident — please audit for

1. **Root cause:** Is the on-the-fly generator design intent (operator quote above) actually realized by the v1.5.0 implementation? If not, where is the architectural gap?
2. **Naming convention drift:** Which convention is right — `ijfw-` prefix or no prefix? What does the dispatcher actually call agents by?
3. **Triple-source-of-truth:** Should the generator be reading from `src/team/domain-templates/` (the T26 file) instead of `fixtures/team/` (the legacy)? Or should the swarm benches be derived from the same template the generator uses?
4. **Other archetypes:** Same triple-disagreement for content/research/design/business? Verify each.
5. **End-to-end failure modes:** If a user does `team init --archetype book` then `swarm plan` then dispatches, what actually happens? Trace it.
6. **CHANGELOG honesty:** v1.5.0 CHANGELOG T25/T26 claims and the "MULTI-DOMAIN-PROVEN, 0 HIGH" RT3 verification gate — what level of "proven" is this if the dispatcher can't find the generator's output?
7. **Anything else stupid like this** in the team/swarm/agent dispatch subsystem.

Severity-tag every finding as HIGH / MED / LOW with file:line citations.
