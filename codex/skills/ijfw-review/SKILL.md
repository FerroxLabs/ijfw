---
name: ijfw-review
description: "One-line code review comments. Trigger: review, code review, PR review, /ijfw-review"
---


Review code changes. One-line comments per finding.

Format: L<line>: <severity> <problem>. <fix>.

Severity: [bug] | [warn] | [suggest] | [nice]

Rules:
- Lead with bugs. Then warnings. Then suggestions.
- No praise for meeting baseline expectations.
- If no issues: "Clean. Reviewed N lines across bug/warn/suggest/nice gates. No findings."
- Max 10 findings unless asked for exhaustive review.
- Check: null handling, error paths, security boundaries, test coverage.

## Output contract

Emit a `gate-result` block as the **LAST** content of your output. Nothing
after it. Use `gate="swarm-review"`. Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

Format:

```gate-result
{
  "schema_version": "1.0",
  "gate": "swarm-review",
  "status": "<STATUS>",
  "project_type": "<from project-type-detector>",
  "lenses": [],
  "affected_artifacts": [],
  "accounting": {"duration_ms": 0, "lenses_invoked": 0, "cost_usd": null},
  "remediation": [],
  "receipts_ref": null,
  "supersedes": null,
  "gate_id": "<gate-with-colons-replaced-by-dashes>-<ts>-<rand4>",
  "emitted_at": "<ISO-8601>"
}
```
