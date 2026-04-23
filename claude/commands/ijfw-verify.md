---
name: ijfw-verify
description: "Run the IJFW workflow Verify phase (Deep D5). Full audit against the original brief. Usage: /ijfw-verify"
---

**Plausibility is not correctness.** Run the full Verify phase of the IJFW workflow. This is the quality gate before shipping -- a structured audit of everything built against the original brief. Every claim must trace to a command output, a test pass, or a manual verification you actually performed; never report "done" based on a plausible-looking diff alone.

**What runs:**

- Functional checks: all tests pass, startup verified, offline behavior tested
- Behavior diff against `main`: when relevant, run the same scenario on `main` and on the working tree, compare outputs side by side. Catches silent regressions that pass tests but change observable behavior. Skip for purely additive changes (new files, new endpoints) where there is no `main` baseline to diff against.
- UX audit: first impression, no "feel stupid" moments, every error has a recovery path
- Security and quality: auth on every endpoint, parameterised queries, no leaked secrets,
  accessibility, linter clean
- Brief alignment: every success criterion from Discovery is checked explicitly

**Multi-AI Quality Trident (Donahoe P9):** For critical work, Verify also prepares
a cross-audit document summarizing what was built and key risk areas, ready for
review in Gemini, Codex, or another AI session. Use `/cross-audit` to generate it
explicitly.

This command invokes `ijfw-workflow` at the D5 Verify phase directly. IJFW owns
the audit loop end-to-end.

**Natural triggers:** "verify the work", "run the audit", "check everything",
"quality gate", "are we ready to ship?"

If gaps are found, Verify stays open until they're resolved -- it does not
auto-advance to Ship on a partial pass.

**GATE:** Verify phase ends at the SHIP GATE -- original brief re-read, what was
built matches what was asked. All items pass before advancing to Ship.

**Confidence declaration (required at end of Verify):** Every Verify finding is
tagged with one of:
- **VERIFIED** -- command was run, raw output is available, anyone can reproduce it.
- **LIKELY** -- reasoning provided (code read, docs consulted), not externally
  verified this session.
- **GUESSING** -- insufficient information, best guess only.
- **ISSUE** -- blocker or bug surfaced; stop and document rather than advance.

Verify does not auto-advance to Ship with any finding tagged GUESSING or ISSUE.
VERIFIED findings clear the gate; LIKELY findings require user acknowledgement.
This is the scoped adoption of Damir Zorcic's "Declare Confidence" law, applied
at ship-gate boundaries where the rigor earns its weight.
