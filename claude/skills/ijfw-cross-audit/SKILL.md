---
name: ijfw-cross-audit
description: "Generate a cross-platform multi-model audit (Trident) on a diff, brief, or artifact. Trigger: 'cross audit', 'Trident', 'second opinion', 'check with other models', 'cross-check this', 'get another perspective', /cross-audit"
---

## Execution

1. **Detect artifact.** Accept: diff, file path, brief text, or `HEAD~1..HEAD`.
   If none provided, ask once: `What should I audit? (diff, file, or paste text)`

2. **Detect auditors.** Check PATH for `codex` and `gemini`.
   Default: one OpenAI-family + one Google-family, excluding caller's family.
   Cap at 4 auditors total.

3. **Dispatch in parallel via background bash** -- never hand off to user.
   Prompt each: security findings, logic issues, reliability concerns, test gaps.
   ```bash
   codex "Review for security, logic, reliability, test gaps: <artifact>" &
   gemini "Review for security, logic, reliability, test gaps: <artifact>" &
   wait
   ```

4. **Reconcile.** Deduplicate. Classify:
   - CONSENSUS -- flagged by 2+ auditors
   - CONTESTED -- flagged by 1 auditor only
   - PASS -- no issues

5. **Emit report** using the format below.

## Report format rule (all cross-audit outputs)

Any reconciliation report presenting multiple paths MUST use this structure:

```
VERDICT
  <one-line converged recommendation>

OPTIONS
  A -- <short-name>: <one-line what it is>
  B -- <short-name>: <one-line what it is>

REVIEWER CONVERGENCE
  <reviewer>:  <letter>  <score>  "<their call>"  => Option <letter> -- <name>

RECOMMENDATION
  Option <X> -- <name> because <one-sentence why>.

NEXT ACTION
  <exact command or step>
```

Never write "Option A" or "Option B" without "-- name" immediately after it on the same line.
