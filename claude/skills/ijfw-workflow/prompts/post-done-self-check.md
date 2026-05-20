# Self-Check Protocol — Pre-DONE Verification

**Before reporting `Status: DONE`, run this self-check.** It catches the "I committed it" / "the file's there" lies the model tells itself.

## Step 1: verify every claimed FILE exists

For every file you claim to have created or modified in your SUMMARY:

```bash
[ -f "<path>" ] && echo "FOUND: <path>" || echo "MISSING: <path>"
```

If ANY file shows MISSING → do NOT report DONE. Either re-do the write or update SUMMARY to remove the false claim.

## Step 2: verify every claimed COMMIT exists

For every commit SHA you claim to have made:

```bash
git log --oneline --all | grep -q "<sha-prefix>" && echo "FOUND: <sha>" || echo "MISSING: <sha>"
```

Plus verify the commit ACTUALLY TOUCHES the files you claimed (a commit existing isn't enough):

```bash
git show --stat <sha> | grep -E "<file pattern>" || echo "WRONG-COMMIT: <sha> doesn't touch <file>"
```

If any commit is MISSING or WRONG-COMMIT → do NOT report DONE.

## Step 3: append the result to SUMMARY

Add this block to the END of any SUMMARY.md you wrote:

```markdown
## Self-Check
- Files claimed: N
- Files verified present: M
- Commits claimed: K
- Commits verified present + touching claimed files: J
- Self-Check verdict: PASSED / FAILED
```

## Step 4: route on result

- Self-Check PASSED → report `Status: DONE` + commit + branch + tests as usual
- Self-Check FAILED → report `Status: DONE_WITH_CONCERNS` with `Concerns: <list of mismatches>` OR `Status: BLOCKED` if you can't reconcile

## Why this protocol exists

We've observed implementer agents claiming `Status: DONE` with commit SHAs that didn't exist, files that weren't written, and tests that weren't run. The pattern is honest-mistake (agent's internal world model diverged from disk reality) but the cost is real. Self-check converts the divergence into an automatic FAIL before it reaches the reviewer.

This skill is invoked automatically by the orchestrator-LLM via the `ijfw_state` MCP tool's `subagent.post-done` verb (v1.5.0-major S02 / v1.5.0 T13 — single state-SDK MCP face) before passing to the two-stage review. Implementer agents should also run it manually before emitting DONE.
