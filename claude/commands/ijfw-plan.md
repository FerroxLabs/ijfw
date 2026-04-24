---
name: ijfw-plan
description: "Jump directly to the IJFW workflow Plan phase (Deep D3 / Quick Q2). Usage: /ijfw-plan [brief description of what to plan]"
---

Jump straight into the IJFW workflow Plan phase without walking through Discovery
and Research first. Use this when you already know what you're building and want
to move into structured planning now.

**Quick mode (Q2):** Draft a focused plan of up to 10 tasks, each with a clear
deliverable and success criteria. Present it for approval, then execute.

**Deep mode (D3):** Break the work into phases → milestones → tasks. Each task
gets a deliverable, success criteria, file list, dependencies, and blast radius.
Output lands in `.ijfw/memory/plan.md` (fallback: `.planning/**/PLAN.md`). The
full PLAN AUDIT gate runs before execution begins.

This command invokes `ijfw-workflow` at the Plan phase directly. IJFW owns the
full loop from here: plan → audit → execute → verify → ship. No external plugin
hand-off.

**Natural triggers:** "let's plan this", "make a plan", "planning phase",
"I know what to build, let's plan it."

If you have an existing `brief.md`, this command reads it as context automatically.
If not, it asks one clarifying question to establish scope before drafting.

**GATE:** Plan phase ends at the PLAN AUDIT gate -- every requirement has a task,
no scope drops, dependencies ordered. Gate must pass before execution begins.
