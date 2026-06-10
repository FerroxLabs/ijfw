# Workflow & cross-audit

How IJFW turns a single AI session into a disciplined process: a plan-before-build workflow, a multi-model cross-audit that puts a second training lineage in the room, and a preflight gate that runs before you ship. This is the deep-dive behind the README's "It has judgment" pillar. ([back to README](../README.md))

---

## The workflow engine

IJFW ships an opinionated brainstorm → plan → execute → verify → ship spine. The point is not ceremony; it is that the plan exists, is visible, and is signed off before any code is written. Two modes, auto-picked from your prompt. Every phase is conversational (one question per turn, no monologues), and every artifact is summarized in chat before it is written to disk.

You enter it by describing project-level intent ("build", "plan this", "new project", "design", "launch") or via the `ijfw-workflow` skill / `ijfw workflow` command. The skill body decides Quick vs Deep from the shape of the request.

### Quick mode: 5 moves (3–5 min)

For features, fixes, and ideas. Five moves, each with a single input slot:

1. **FRAME**: what are we doing, in one line.
2. **WHY**: the reason this matters; kills scope creep early.
3. **SHAPE**: the AI proposes three approaches so you never face a blank page.
4. **STRESS**: a pre-mortem flash that surfaces the risk you hadn't considered.
5. **LOCK**: one word freezes the brief.

### Deep mode: 6 modules (20–45 min)

For new projects, major refactors, and launches. Six required modules plus three optional ones (mini PR/FAQ for external-facing briefs, an explicit anti-scope "what we will not do", and a Trident cross-critique before the brief is finalized):

1. **FRAME**: Socratic arc: problem → users → constraints → scope. Drafts `.ijfw/memory/brief-draft.md` (≤30 lines).
2. **RECON**: codebase and context recall.
3. **HMW**: 2–3 "How Might We" reframings; you pick, reject, or edit. The chosen one anchors the next step.
4. **DIVERGE**: generate multiple candidate approaches.
5. **CONVERGE**: narrow to one, and emit the Wave Table (below).
6. **LOCK**: paste the full brief (goal / HMW / approach / metrics / risks / mitigations); on `lock` the draft is promoted to `brief.md` and routed to PLAN.

You can move between modes mid-flow: `go deeper` re-enters Deep at the equivalent module; `just quick` collapses the remaining Deep modules into a single LOCK.

### Plan before build, and phase gates

After LOCK the brief drives every downstream phase. PLAN produces a plan that gets its own audit (`ijfw plan-check` or an inline checklist, shown, not silent) and **user confirmation before EXECUTE**. There is no auto-advance: EXECUTE will not roll into VERIFY until you confirm every task is done. Gates are user-facing checklists, not silent passes; you never get a "plan complete, 25 tasks ready to dispatch" surprise.

The phase ribbon stays visible throughout, e.g.:

```
IJFW > PLAN (Deep mode, module 3 of 6)
IJFW > EXECUTE (Wave 2 of 4)
```

Phase audits run at wave and milestone boundaries. After VERIFY (and your confirmation) the orchestrator auto-fires a Trident cross-audit before any ship action (see below).

### The Wave Table: parallel dispatch by design

CONVERGE emits an explicit **Wave Table**: every wave labeled `PARALLEL` or `SEQUENTIAL` with a one-line dependency justification. EXECUTE reads that table directly for deterministic agent dispatch: parallel waves fire together, sequential waves wait on their dependency. There is no re-inference from prose and no ambiguity about what runs when. (Worktree-isolated agents are briefed to `npm install` first, since worktrees don't inherit a populated `node_modules`.)

---

## Multi-AI cross-audit (Trident)

One model's blind spot is a single point of failure. The cross-audit (the craft name is **Trident**) puts a second and third *training lineage* in the room: one OpenAI-lineage reviewer, one Google-lineage reviewer, and a Claude reviewer, all examining the same target in parallel. Disagreement is signal; consensus is a green light. The caller is one of the three, so IJFW fingerprints who is running and excludes them, then picks reviewers from *different* lineages so blind spots don't compound.

### Invoking it

```bash
ijfw cross audit src/auth.js        # second-opinion review of a file or diff
ijfw cross critique <target>        # adversarial challenge to a position/plan
```

In Claude Code, the `/cross-audit` command and natural language ("cross-audit this file", "get a second opinion", "check this with the other models") do the same thing: IJFW picks up the file, diff, or range from your current context. It also fires automatically as Phase E of the workflow, after VERIFY and before SHIP. You can `skip cross-audit` or `force cross-audit` at any step.

### The roster

The roster lives in `mcp-server/src/audit-roster.js` and spans several independent training lineages so the panel is genuinely diverse, not three flavors of the same model:

| ID | Lineage | Non-interactive invoke (real, verified) |
|----|---------|------------------------------------------|
| `codex` | OpenAI | `codex exec --skip-git-repo-check --sandbox read-only ... -` (prompt on stdin) |
| `gemini` | Google | `gemini --skip-trust -e none` (prompt on stdin) |
| `qwen` | Alibaba (OSS) | `qwen --bare --yolo` |
| `kimi` | Moonshot (OSS) | `kimi --print --quiet` |
| `deepseek` | DeepSeek (OSS) | API path (no canonical first-party CLI) |
| `opencode` | OSS / local | `opencode run` |
| `aider` | OSS / local | `aider --message` |
| `copilot` | OpenAI | Copilot CLI |

Each CLI is probed for reachability before it's dispatched; if a CLI isn't installed, the entry falls back to its API path where one exists (an `apiFallback` with the live model id resolved at call time), or is skipped. The exact invoke flags matter and drift as the upstream CLIs change their non-interactive contracts; many of the flags above exist specifically to bypass trusted-directory gates or to suppress a recursive IJFW-MCP autostart that would otherwise hang the audit. The roster is re-verified against the live CLIs each release; adding your own auditor is roughly a ten-line entry.

### Reading the output

Findings are reconciled into a consolidated table and tagged:

- **consensus**: both lineages agree. High priority; treat as real.
- **contested**: they disagree. Your judgment call; the disagreement itself is the useful artifact.

Every run appends a receipt to `.ijfw/receipts/cross-runs.jsonl` with duration, tokens, and finding counts, so the scrutiny is auditable after the fact rather than a claim.

### Cost cap

Cross-audit is budgeted. The dispatcher enforces a default **$2.00** cap per the `IJFW_AUDIT_BUDGET_USD` env var (`mcp-server/src/cross-dispatcher.js`): it refuses to start the next call once accumulated receipts plus the next estimate would exceed the cap, and tells you to raise the limit to continue. The first call can't be pre-estimated, so the guard enforces from the second call onward. Background dispatch is the default, so you keep working while the audit runs.

### Honest limits

Cross-audit is a tool for catching blind spots, not an oracle. Three models can share a wrong prior, agree on a false positive, or all miss the same subtle bug, and reviewers do produce false positives that you (or the consolidation step) have to reject. Treat consensus as strong evidence, not proof, and contested findings as prompts to think rather than answers. The value is structural: a second lineage in the room makes the *common* failure (one model's confident blind spot reaching production unchallenged) much less likely.

---

## `ijfw preflight`: the ship gate

Run this before any publish or production deploy. `ijfw preflight` executes an **11-gate** quality pipeline and exits 0 only when every *blocking* gate passes. It is not on the install path, so the fast-install promise holds; it's a deliberate, separate step.

```bash
ijfw preflight
```

The gates, in execution order (`installer/src/preflight.js`):

| # | Gate | Blocks? | Catches |
|---|------|---------|---------|
| 1 | shellcheck | yes | Unbound vars, POSIX violations in hook scripts |
| 2 | oxlint | yes | Unused imports, dead variables in JS/TS |
| 3 | eslint-security | advisory | Injection sinks, non-literal fs paths |
| 4 | psscriptanalyzer | advisory on macOS | PowerShell lint (blocking in Windows CI) |
| 5 | publint | yes | package.json bin/exports integrity |
| 6 | gitleaks | yes | Plaintext secrets and credentials |
| 7 | audit-ci | yes | npm audit: high/critical vulnerabilities |
| 8 | knip | advisory | Unused exports and dead code |
| 9 | license-check | advisory | Production dependency license compatibility |
| 10 | pack-smoke | yes | `npm pack` → temp install → `ijfw --help` exits 0 |
| 11 | upgrade-smoke | yes | Plugin-key wiring survives an upgrade from the floor version |

Each gate runs via `npx --yes <tool>@<pinned-version>` (versions tracked in `preflight-versions.json`); missing tools are reported as `skipped` with an install hint rather than failing the run. The summary line carries an SLO: **≤90s on a warm cache, ≤240s cold**, both printed so you can see which you hit.

```
PASS 8  WARN 2  SKIP 1  FAIL 0
Time: 7s  within warm-cache SLO (<=90s)

All blocking gates passed.
```

---

Together these three surfaces are what "it has judgment" means in practice: the workflow stops a session from drifting, the cross-audit stops one model from being the only voice, and preflight stops anything from shipping that can't survive a mechanical gate. Back to the [README](../README.md).
