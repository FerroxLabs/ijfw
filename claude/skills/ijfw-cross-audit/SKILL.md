---
name: ijfw-cross-audit
description: "Generate a cross-platform multi-model audit (Trident) on a diff, brief, or artifact. Trigger: 'cross audit', 'Trident', 'second opinion', 'check with other models', 'check with other AIs', 'cross-check this', 'get another perspective', /cross-audit"
---

## Execution

1. **Detect artifact.** Accept: diff, file path, brief text, or `HEAD~1..HEAD`.
   If none provided, ask once: `What should I audit? (diff, file, or paste text)`

2. **Detect auditors.** Roster covers six independent training lineages:
   - `codex`     (openai family)   -- OpenAI CLI
   - `gemini`    (google family)   -- Gemini CLI
   - `claude`    (anthropic family) -- Claude Code (fresh session)
   - `deepseek`  (oss / cn lineage) -- DeepSeek API
   - `qwen`      (oss / cn lineage) -- Qwen Code CLI
   - `kimi`      (oss / cn lineage) -- Moonshot Kimi
   - `opencode`, `aider`, `copilot` (additional oss / openai-family auditors)

   Default selection: diversity strategy picks one openai-family + one
   google-family + caller, excluding the caller's own family. Reachability =
   CLI on PATH OR API key in env. The Donahoe Trident principle says: at least
   three lenses, three lineages.

3. **Override roster with `--with`.** Pass `--with <id>[,<id>]` to pin the
   exact auditors fired. Self-audit is rejected (same-lineage = single source).
   Example: `cross-audit --with codex,gemini,deepseek <target>`.

4. **Dispatch in parallel.** Every lens runs concurrently; the orchestrator
   short-circuits stragglers once `minResponses` productive results land. Per-
   provider timeouts (codex 120s, gemini 90s, default 90s) plus
   `IJFW_AUDIT_TIMEOUT_SEC` override.

5. **Reconcile.** Lexical-signature clustering (issue + location):
   - **CONSENSUS** -- flagged by ≥2 lenses (`consensus: true`, `consensusCount`, `consensusLenses`)
   - **CONTESTED / single-lens** -- flagged by exactly 1 lens
   - **PASS** -- no findings
   Output ranks CONSENSUS findings first, then single-lens findings, each
   ordered by canonical severity (critical → low).

6. **Emit report** using the report format rule below.

## Budget controls

- `IJFW_AUDIT_BUDGET_USD` (default `$2.00`) -- per-session aggregate cap.
  Post-flight accumulation; first call is always allowed, subsequent calls are
  rejected when `accumulated + estimate > budget`. Raise to continue.
- `IJFW_AUDIT_BUDGET_USD_PER_LENS` -- granular cap on a single lens's spend
  across one convergence cycle. Useful for "spend at most $0.50 per gemini
  call" guardrails on long-running converge loops.
- `IJFW_AUDIT_TIMEOUT_SEC` -- per-auditor budget (clamped to [1, 3600]).
- `IJFW_AUDIT_CONCURRENCY` -- parallel-fire cap (default 3).

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

## Severity / disposition vocabulary

Two axes, never mixed:

- **Finding severity** (sortable, per-item): `critical | high | medium | low`.
- **Audit disposition** (status of the whole audit): `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

The merger coerces stray disposition values (`warn`, `flag`, etc.) on a per-
finding `severity` field into the canonical severity scale (`warn→medium`,
`flag→high`, `fail→critical`) so nothing sinks to the unranked bottom.

## Output contract

Emit a `gate-result` block as the **LAST** content of your output. Nothing
after it. Use `gate="cross-audit"`. Statuses: `PASS | CONDITIONAL | WARN | FLAG | FAIL`.

Format:

```gate-result
{
  "schema_version": "1.0",
  "gate": "cross-audit",
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
