---
name: ijfw-verify
description: "Use when about to claim completion: 'done', 'fix complete', 'tests pass', 'build succeeded', 'shipped', 'no regressions', 'ready to merge', 'ready to ship'. Iron Law gate requiring fresh verification evidence in the same message as the claim; wires into runtime (verification-gate.js + the ijfw_state MCP tool subagent.post-done verb)."
---

# IJFW Verify -- The Iron Law

## The Iron Law

> **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.**

If you haven't run the verification command in *this* message, you cannot claim it passes. "Earlier" doesn't count. "Should pass" doesn't count. "The code looks right" doesn't count.

**Violating the letter of this rule is violating the spirit of this rule.**

## Why this exists

IJFW v1.4.x shipped at least four times with "done" claims that later turned out to be false: a v1.4.0 milestone declared "shipped" without verifying the GitHub mirror push had landed; v1.4.3 declared Windows CI "promoted to required" before the workflow file change had been merged; v1.4.4 had three of six parallel subagents return DONE without their checkpoints being written; and the Trident cross-audit at r13 reported PASS while one auditor (codex) was UNREACHABLE. Every one of those was an Iron-Law violation -- a claim without same-message evidence -- and every one cost a recovery wave.

This skill is the gate that catches it.

## The 5-Step Gate Function

Before emitting any completion claim (verbal or structured):

1. **IDENTIFY** -- What command, in this repo, proves the claim true?
2. **RUN** -- Execute the FULL command via Bash tool, *in the same message as the claim*. Not summarised. Not paraphrased. The actual command, fresh.
3. **READ** -- Read the full output. Check the exit code. Count failures. Do not skim.
4. **VERIFY** -- Does the output literally confirm the claim?
   - If NO: state the actual status with the evidence. Do not claim completion.
   - If YES: state the claim *with the output excerpted inline*.
5. **ONLY THEN** -- emit the claim.

Skip any step = lying, not verifying.

## Common Failures -- claim vs required evidence

| Claim | Required evidence (same message) |
|---|---|
| "all tests pass" | Output of `npm test` (or the project's test command), exit 0, failure count = 0 |
| "build succeeded" | Output of the build command, exit 0 |
| "fixed the bug" | Reproduction output *before* + *after* the fix |
| "deployment complete" | Deployed URL + health-check (`curl -fsS <url>`) output |
| "implementation done" | Output proving the new behaviour (run the new code) |
| "no regressions" | Baseline test output + post-change test output |
| "all subagents DONE" | `cat .ijfw/wave-*/subagent-*.checkpoint.json` showing each checkpoint written |
| "wave complete" | `node scripts/wave-status.js` showing all subs DONE *and* commits resolved |
| "Trident r<N> PASS" | All three auditor reports written *and* readable; no UNREACHABLE |
| "shipped to npm" | `npm view <pkg> version` returning the new version |
| "pushed to GitLab/GitHub" | `git ls-remote <remote> <tag>` returning the tag SHA |
| "ledger clean" | `cat .ijfw/state/execute-issues.json` showing zero unresolved entries |

If your claim is not in this table, the table is **not exhaustive** -- derive the required evidence from the *spirit* of the rule (see "Spirit over letter" below).

## Rationalization Prevention -- the lies you tell yourself

| Rationalization | Counter |
|---|---|
| "I'm in a hurry" | The hurry is exactly when evidence matters most. Hurry shipped v1.4.0 with a missing mirror. |
| "The code looks right" | Code reading proves nothing. Running it does. |
| "Tests should pass" | Run them. "Should" is not evidence. |
| "I already verified earlier" | Verify in the SAME message as the claim. State drifts; context windows lie. |
| "The subagent reported DONE" | Subagent reports are unverified by definition. Check the checkpoint file *and* the commit SHA. |
| "Trust the workflow state" | `.ijfw/state/workflow.json` records what was *claimed*, not what *happened*. Verify the artefact. |
| "I'm confident" | Confidence is not evidence. Three v1.4.x ships had confident authors. |
| "It worked last time" | Last time is not this time. Run it. |
| "The diff looks plausible" | "Plausibility is not correctness." (Verify-command preamble exists *because* people were shipping plausible diffs.) |
| "I'm tired" | Exhaustion is not an excuse. Stop and rest, or run the command. |
| "Just this once" | There is no "just this once". Every Iron-Law violation in IJFW history was a "just this once". |
| "Different words so the rule doesn't apply" | Spirit over letter. Paraphrased success is still a success claim. |

## Red flags -- STOP and run the gate

- About to type "should", "probably", "looks like", "seems to"
- About to type "Great!", "Perfect!", "Done!", "Shipped!"
- About to commit, push, tag, or open a PR
- About to mark a workflow phase complete
- About to emit `Status: DONE` in a subagent handoff
- About to trust a subagent / auditor / hook success report without re-checking the artefact

## Integration with the runtime gate

This skill is the **author-time** half of IJFW's verification contract. The **runtime** half lives in `mcp-server/src/orchestrator/verification-gate.js::checkVerificationGate` (originally shipped in v1.4.4 as N5 as an advisory check) and is now invoked automatically by `mcp-server/src/orchestrator/post-done-runner.js` whenever the `ijfw_state` MCP tool's `subagent.post-done` verb fires after a subagent emits `Status: DONE` (v1.5.0-major / v1.5.0 T13 — single state-SDK MCP face).

What that means in practice:

- If you skip the Iron Law and emit `Status: DONE` anyway, the post-done runner will run `checkVerificationGate` against your checkpoint + commit + test output and downgrade the status to `DONE_WITH_CONCERNS` (or `BLOCKED`) when it detects an unsupported claim.
- The runtime gate is the safety net. **It is not the gate.** This skill is the gate. The runtime gate exists because skills are advisory and humans (and LLMs) sometimes lie; do not treat the runtime check as permission to skip the author-time check.
- If you find yourself thinking "the runtime gate will catch it" -- that thought *is* the Iron-Law violation. Run the command.

## Existing IJFW Verify-phase ledger gate (still applies)

Before emitting `VERIFY PASS` for a workflow phase, the existing ledger check still runs:

```bash
read_issues() {
  local f=".ijfw/state/execute-issues.json"
  [ -f "$f" ] || { printf '{"issues":[]}'; return; }
  cat "$f"
}
```

Any entry with `status: unresolved` (`task-incomplete`, `task-stagnated`, `unsafe-verify`, `plan-review`) blocks VERIFY PASS. Missing file = zero issues (day-1 fresh-install protection). This skill *adds* the Iron Law on top; it does not replace the ledger gate.

## Confidence declaration (still required at end of Verify)

Every Verify finding is tagged:

- **VERIFIED** -- command was run *in this message*, raw output is excerpted, anyone can reproduce.
- **LIKELY** -- reasoning provided (code read, docs consulted), not externally verified this session. Requires user acknowledgement to advance.
- **GUESSING** -- insufficient information; best guess only. Blocks advance.
- **ISSUE** -- blocker or bug surfaced; halt and document.

Only VERIFIED findings clear the ship gate unattended. The Iron Law is what *earns* the VERIFIED tag -- a finding is not VERIFIED unless the verification command + output appears in the same message.

## Spirit over letter -- anti-loophole clause

Evidence patterns in the tables above are **examples, not exhaustive**. The rule is:

> Every completion claim in this message must be falsifiable from the tool calls in this message.

If a clever workaround would still leave a future reader unable to independently verify the claim from the message contents, the workaround is not allowed. Examples of disallowed workarounds:

- Citing an exit code without showing the command that produced it.
- Pointing at a previous message's output ("see above"); copy it inline or re-run.
- Trusting an agent/auditor/hook report without checking the underlying artefact (commit SHA, file contents, npm registry, remote tag).
- Asserting "tests pass" because the test file exists and was edited.
- Asserting "shipped" because a tag was created locally without `git push` verification.
- Asserting "Trident PASS" because the synthesis file exists, without checking each auditor's input file is non-empty and reports PASS.

## Iron-Law discipline -- the four boundaries

The runtime gate fires at four enumerated W3 boundaries -- the verbs that advance state ABOVE you:

- **`phase.complete`** -- post-phase verdict; `enforceVerificationGate` refuses on red.
- **`phase.plan-check`** -- pre-execute plan validation; any HIGH-tier finding refuses dispatch.
- **`subagent.post-done`** -- subagent completion; `runSelfCheck` refuses when claimed files/commits aren't on disk.
- **`wave.advance` (hard gate)** -- mid-wave checkpoint-completeness; a wave that declares `hard_gate: true` refuses to advance while any registered subagent lacks a checkpoint.

Discipline rule: collect verification evidence *after* the change, in the same message as the claim, *before* the boundary verb fires. The gate is the floor, not the ceiling -- pre-empting it is the job.

## The bottom line

**No shortcuts for verification.**

Run the command. Read the output. *Then* claim the result.

This is non-negotiable.
