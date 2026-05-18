<!-- IJFW: narration-not-applicable -->
---
name: ijfw-writing-skills
description: "Authoring discipline for new IJFW skills. Use when creating a new skill, writing a skill, making a skill that does X, or asked to add a skill. Trigger: create a new skill, write a skill, new skill, make me a skill, skill that does, /ijfw-writing-skills"
since: "1.5.0"
---

# IJFW Writing Skills -- author a new skill correctly

A skill is a thin loadable trigger surface. The `description:` is what Claude reads to decide whether to hot-load the body. Get the description wrong and the skill never fires; get the body wrong and the skill misfires when it does fire. This file teaches you to do both right on the first try.

**Iron rule:** a skill IS its trigger. If the description does not match the words a user would naturally say, the skill does not exist -- it is documentation no one reads.

---

## 1. Discovery -- the description is the trigger surface (CSO)

The `description:` field is the only thing Claude sees at routing time. Treat it like a search-engine snippet, not like a definition.

**Shape:** start with "Use when ...", end with `Trigger: <verbatim phrases>, /<command-name>`.

**Forbidden words** (enforced by `scripts/lint/check-skill-descriptions.sh`, case-insensitive whole-word): `step`, `steps`, `phase`, `phases`, `mode`, `modes`, `workflow`, `stage`, `process`, `sub-skill`, `skill-name`. These signal "the description summarises the body" and cause Claude to skip the body and follow the description shortcut.

**Hard cap:** 1024 characters. Aim for under 300.

```yaml
# BAD -- defines the topic, uses forbidden word "process"
description: "Skill for the code review process. Reviews PRs."

# BAD -- workflow summary, uses "phases" and "steps"
description: "Use when reviewing code -- runs three phases, fifteen steps, two passes."

# GOOD -- triggers only, verbatim phrases, slash-command alias
description: "One-line code review comments. Trigger: review, code review, PR review, /ijfw-review"

# GOOD -- "Use when X" + trigger list
description: "Authoring discipline for new IJFW skills. Use when creating a new skill, writing a skill. Trigger: create a new skill, new skill, /ijfw-writing-skills"
```

---

## 2. Frontmatter -- the loadable contract

Required:
- `name:` -- letters, digits, hyphens only. Must match the directory name. Prefix with `ijfw-` for IJFW skills.
- `description:` -- see section 1.

Optional but recommended:
- `since: "1.5.0"` -- required for all v1.5.0+ skills so version filters can target them.
- `allowed-tools:` -- explicit tool list. Omit only when the skill truly needs every tool. Be explicit when you can.
- `model:` -- only when the skill must pin a specific model (rare).
- `argument-hint:` -- shown after the slash command in the picker.

First line above frontmatter: `<!-- IJFW: narration-not-applicable -->` (or `narration-applicable`) -- declares how the skill interacts with the narration hook.

---

## 3. Shape -- terse vs structured

| Skill kind | Shape | Length | Example |
|------------|-------|--------|---------|
| One-shot trigger (single output) | Terse: frontmatter + 5-30 line body | <60 lines | `ijfw-review` (43 lines), `ijfw-debug` (52 lines) |
| Multi-move discipline | Structured: numbered moves with green-light gates | 80-180 lines | `ijfw-tdd` (104 lines), this file |
| Reference / API doc | Structured + `references/` files | header in SKILL.md, weight in `references/` | offload heavy content |

Hot-load on trigger, unload when done. Nothing in the body should pretend to be always-loaded -- the user will only see it when the trigger fires.

---

## 4. Anti-patterns -- do not ship these

1. **Description-as-definition.** "Skill for the code review process" tells Claude what the skill IS. Claude needs to know WHEN to load it. Rewrite as "Use when reviewing code. Trigger: review, /ijfw-review".
2. **Forbidden workflow keywords in description.** `step`, `phase`, `mode`, `workflow`, `stage`, `process`, `sub-skill`, `skill-name` -- the lint will FAIL the build. Use trigger phrases instead.
3. **Overlap with existing skills.** Before writing, list `claude/skills/` and read any neighbour whose name or trigger overlaps. Extend an existing skill rather than fragmenting the trigger surface.
4. **Embedded prompts for the user to paste.** The skill IS the prompt. The user just speaks the trigger -- they should never see "copy this and paste into chat".
5. **Undeclared tool dependencies.** If the skill calls `Bash`, `Edit`, or an MCP tool, either declare them in `allowed-tools:` or accept inherit-everything. Do not silently assume tools exist.
6. **Documentation about the topic.** A skill explains how to DO a thing, not how the thing works in the abstract. If you want to teach concepts, write a reference file under `references/` and link from a skill that DOES something with the concept.
7. **Skill that is really an agent.** If the work needs an isolated context window or a different model, write an agent (`claude/agents/<name>.md`) and dispatch via the Agent tool. Skills are for in-context discipline; agents are for delegated work.

---

## 5. Validation flow -- always run, always pass

After writing the file:

```bash
# 1. Lint CSO discipline. Must show PASS for your new skill, no new FAILs.
bash scripts/lint/check-skill-descriptions.sh 2>&1 | grep -E "<your-skill-name>|FAIL"

# 2. Trigger-test in a fresh Claude session. Open a new conversation and say
#    one of the verbatim trigger phrases from your description. Confirm the
#    skill loads and runs as expected. If it does not fire, your description
#    does not match how users actually speak -- rewrite and re-test.
```

A skill that lints PASS but does not fire on its own trigger is broken. Both checks must pass before commit.

---

## 6. Multi-domain consideration

IJFW skills should work across software, books, campaigns, and design wherever the discipline transfers. TDD applies to code AND book continuity AND campaign metrics; review applies to PRs AND chapter drafts AND landing-page copy. Write skills domain-neutral by default.

Domain-specific is rare and must be justified: e.g. `ijfw-ui-spec` is intentionally frontend-only because UI contracts have no analogue in book writing. When you go domain-specific, name it in the description so the trigger surface stays honest: "Use when designing a frontend feature".

---

## 7. Where skills live -- canonical layout

```
claude/skills/<skill-name>/
  SKILL.md                # required, ~140-180 lines max for structured skills
  references/             # heavy reference material the skill links to
    <topic>.md
  prompts/                # reusable prompt fragments the skill renders
    <name>.txt
  templates/              # boilerplate the skill emits
    <name>.template.md
```

Cross-platform skills also land at `codex/skills/<name>/SKILL.md`, `gemini/extensions/ijfw/skills/<name>/SKILL.md`, `hermes/skills/<name>/SKILL.md`, `wayland/skills/<name>/SKILL.md`. The lint script checks every present platform.

---

## 8. When NOT to write a new skill

| You want to ... | Do this instead |
|-----------------|-----------------|
| Extend behaviour of an existing trigger | Edit the existing skill. Adding a second skill for the same trigger fragments routing. |
| Run heavy work in an isolated context | Write an agent at `claude/agents/<name>.md` with `model:` + `allowed-tools:` + a body that gets dispatched via the Agent tool. |
| Enforce a mechanical rule | Write a hook (`claude/hooks/`) or a lint script (`scripts/lint/`). Hooks are deterministic; skills are judgment calls. |
| Document a concept users should read | Add a doc under `docs/`. Skills are loaded on trigger, not for browsing. |
| Pin a project convention | Add it to `CLAUDE.md` or `AGENTS.md`. Skills are reusable across projects; conventions are local. |

---

## Done When

- [ ] `claude/skills/<name>/SKILL.md` exists with correct frontmatter (name, description, `since:` if v1.5.0+).
- [ ] Description starts with "Use when" and lists verbatim trigger phrases plus the `/slash-command` alias.
- [ ] Description contains NO forbidden words (`step`, `phase`, `mode`, `workflow`, `stage`, `process`, `sub-skill`, `skill-name`).
- [ ] Description under 1024 chars.
- [ ] `bash scripts/lint/check-skill-descriptions.sh` shows your skill as PASS and introduces no new FAILs.
- [ ] Trigger-tested in a fresh Claude session -- the skill actually fires when a user speaks a trigger phrase.
- [ ] Shape matches purpose: terse (<60 lines) for one-shot, structured (80-180 lines) for multi-move discipline.
- [ ] No overlap with an existing skill (or the existing skill was extended instead).
- [ ] If declared `since: "1.5.0"`, picked up by version filters.

## References

- Lint: `scripts/lint/check-skill-descriptions.sh` -- the authoritative CSO rules.
- Terse skill format: `claude/skills/ijfw-review/SKILL.md`.
- Structured discipline format: `claude/skills/ijfw-tdd/SKILL.md`, `claude/skills/ijfw-debug/SKILL.md`.
- Agent format (when a skill is not the right shape): `claude/agents/*.md`.
