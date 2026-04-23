---
name: ijfw-audit
description: "Run the IJFW audit gate for the current workflow phase. Usage: /ijfw-audit [phase name]"
---

Run the audit gate for the current (or named) phase of the active IJFW workflow.
Every IJFW workflow phase has a built-in audit checklist -- this command fires it
explicitly without advancing to the next phase.

**Phase audit gates available:**

- **DISCOVER AUDIT** -- scope boundaries, success criteria, no hidden assumptions
- **RESEARCH AUDIT** -- findings validated, red flags surfaced, brief updated if needed
- **PLAN AUDIT** -- every requirement has a task, no scope drops, dependencies ordered
- **TASK MICRO-AUDIT** -- per-task: success criteria met, nothing outside scope changed
- **PHASE AUDIT** -- all phase tasks complete, brief still accurate, memory updated
- **SHIP GATE** -- original brief re-read, what was built matches what was asked

Run the gate, fix any failures, then continue. IJFW tracks gate outcomes in
`audit-log.md` for the active project.

**Natural triggers:** "audit this phase", "run the gate", "check before we move on",
"audit checkpoint", "gate check."

If you name a phase explicitly (e.g. `/ijfw-audit plan`), that gate runs regardless
of the current workflow position. Omit the argument and the current phase gate runs.

**GATE:** Each audit gate is a hard stop -- fix failures before the next phase
begins. Gate outcomes are recorded in `audit-log.md` for the active project.

**Confidence declaration (required per finding):** Every audit finding is tagged
VERIFIED / LIKELY / GUESSING / ISSUE:
- **VERIFIED** -- command run, raw output shown, reproducible.
- **LIKELY** -- code read, docs consulted, reasoning given, not externally verified.
- **GUESSING** -- insufficient information, best guess only.
- **ISSUE** -- blocker or bug; document and halt.

Gate outcomes with any GUESSING or ISSUE finding do not auto-advance. This is the
scoped adoption of Damir Zorcic's "Declare Confidence" law at audit boundaries.
