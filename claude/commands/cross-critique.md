---
description: "Adversarial multi-angle critique. All three auditors fire in parallel (codex=technical, gemini=strategic, claude=ux). Counter-args ranked by rebuttal survival score, not raw severity. Usage: /cross-critique [--with <id> | list | compare] <target>"
allowed-tools: ["Read", "Write", "Bash", "Grep"]
---

Stress-test any target against three adversarial perspectives simultaneously.
Solves "a single reviewer's blind spots." Unlike cross-audit (which reviews for
correctness/security/ops/maint), cross-critique hunts for the hardest counter-arguments
to your position -- then ranks them by how likely each argument is to survive a
rebuttal. High-survival counter-args are the ones worth acting on first.

## Subcommands

| Form | Behavior |
|------|----------|
| `/cross-critique`                     | **Zero-arg auto-pick.** Detect target from git state (staged → unstaged → last commit). Fire all three angles in parallel. |
| `/cross-critique <target>`            | Named target, same parallel fan-out. |
| `/cross-critique --with <id> [target]` | Override one auditor slot: `codex`, `gemini`, `opencode`, `aider`, `copilot`, `claude`. Target optional. |
| `/cross-critique list`                | Show roster with self marker. No requests generated. |
| `/cross-critique compare`             | Read all response files, score by rebuttal survival, render ranked table, archive. |

## Smart target auto-detection (bare `/cross-critique`)

When invoked without a target, run this detection cascade and use the first
non-empty result:

1. **Staged changes** -- `git diff --cached --name-only`
2. **Unstaged changes** -- `git diff --name-only`
3. **Last commit** -- `git diff HEAD~1 --name-only`
4. If all empty: print the roster and ask "what would you like critiqued?"

Report which step succeeded:

```
Cross-critique target auto-detected: 1 staged file(s)
  claude/commands/cross-critique.md
(Override with /cross-critique <path> or /cross-critique --with <id> <path>.)
```

If >5 files, group in request body but list all paths. If a single file >2000 lines,
use the diff hunks rather than the full file.

The natural-language phrase **"challenge this from every angle"** / **"adversarial
critique"** fires the intent router (`mcp-server/src/intent-router.js`), which
nudges Claude to invoke `/cross-critique` automatically -- same auto-detect flow runs.

## Default flow -- Donahoe Trident (don't make me think)

Caller holds one perspective (UX/adoption lens). Two external auditors cover the
other two angles (technical and strategic) independently, in parallel, so no
reviewer anchors on another's findings. All three streams merge into a single
ranked table.

When invoked, do this in order:

1. **Probe roster.** Call `pickAuditors({ count: 2, env: process.env })` from
   `audit-roster.js`. Returns `{ picks, missing, note }`.

2. **Show a TODO surface** in chat:

   ```
   Cross-critique plan
     [ ] Step A.1: Generate requests (codex=technical, gemini=strategic, claude=ux)
     [ ] Step A.2: Fire all three in background (parallel)
     [ ] Wave A (caller leg): Collect in-session specialist findings
     [ ] Wait for all completions
     [ ] Step B.1: Score by rebuttal survival
     [ ] Step B.2: Render ranked counter-arg table
     [ ] Step B.3: Archive all requests + responses + merge
   ```

3. **Ask the user once** which combo to run:

   ```
   Auditors detected and ready: codex, gemini.
   Run cross-critique:
     [A] codex only (technical angle)
     [B] gemini only (strategic angle)
     [C] Both + claude ux -- recommended (Donahoe Trident)
     [D] Cancel / pick custom

   Default: [C] All three -- press enter to confirm.
   ```

   Default suggestion: **C (All three)** when >=2 external auditors installed.

4. **If only one external auditor installed:**

   > "Only `<id>` is installed locally. The full Trident covers technical,
   > strategic, and UX angles in one pass -- install one more auditor
   > (opencode, aider, etc.) to unlock complete angle coverage."

   Then offer to run the partial two-angle flow (external + claude ux).

5. **Fire all three in background** simultaneously (see Parallel fan-out section).

6. **Collect caller's in-session findings** (see Caller perspective section).

7. **Score, merge, and render** ranked table (see Compare section).

8. **Archive** all files to `.ijfw/cross-audit/archive/<ts>-critique/`.

## Auditor picking

```bash
node --input-type=module -e "import('./mcp-server/src/audit-roster.js').then(m => console.log(m.formatRoster()))"
```

Default pick order (first non-self): `codex → gemini → opencode → aider → copilot → claude`.

Critique role assignment is mode-aware via `assignRoles('critique', roster, self)` in
`cross-dispatcher.js`:
- `codex` → `technical` angle (implementation weaknesses, edge cases, failure modes)
- `gemini` → `strategic` angle (market, adoption, sustainability, risk)
- `claude` (fresh session via `claude -p`) → `ux` angle (cognitive load, onboarding, discoverability)
- Caller's own perspective is collected in-session and merged at the end -- the
  caller does NOT occupy one of the three external slots.

---

## Wave A -- Parallel fan-out -- all three angles at once

### Step A.1 -- Generate requests via the dispatcher

Run one node call per auditor:

```bash
node --input-type=module -e "
import('./mcp-server/src/cross-dispatcher.js').then(m =>
  process.stdout.write(m.buildRequest('critique', '<target>', 'codex', 'technical'))
)" > .ijfw/cross-audit/request-critique-codex.md
```

```bash
node --input-type=module -e "
import('./mcp-server/src/cross-dispatcher.js').then(m =>
  process.stdout.write(m.buildRequest('critique', '<target>', 'gemini', 'strategic'))
)" > .ijfw/cross-audit/request-critique-gemini.md
```

```bash
node --input-type=module -e "
import('./mcp-server/src/cross-dispatcher.js').then(m =>
  process.stdout.write(m.buildRequest('critique', '<target>', 'claude', 'ux'))
)" > .ijfw/cross-audit/request-critique-claude.md
```

> **Note:** `buildRequest` is synchronous and returns a string -- do NOT `.then()` it. Wrap it in `process.stdout.write(...)` directly.

Replace `<target>` with the detected or specified target string.

### Step A.2 -- Fire all three auditors in background

**Auto-fire is required.** Do NOT stop at "request written -- paste it into Codex."
Only fall back to human paste when `command -v <auditor>` fails AND the roster
probe returns the auditor as missing.

Fire each in background via Bash tool with `run_in_background:true`:

```bash
cat .ijfw/cross-audit/request-critique-codex.md | codex exec --skip-git-repo-check --sandbox read-only -c approval_policy="never" -c mcp_servers.ijfw-memory.enabled=false - > .ijfw/cross-audit/response-critique-codex.md
```

```bash
cat .ijfw/cross-audit/request-critique-gemini.md | gemini - > .ijfw/cross-audit/response-critique-gemini.md
```

```bash
cat .ijfw/cross-audit/request-critique-claude.md | claude -p > .ijfw/cross-audit/response-critique-claude.md
```

All three run simultaneously -- there is no staged dependency between them. Wait for
all three completion notifications before running `compare`. Update the TODO surface
to `in_progress` then `completed` per auditor.

**Missing auditor fallback (positive framing only):**
If `command -v codex` (or `gemini`) fails, surface:

> "Codex isn't installed locally -- paste `request-critique-codex.md` into
> https://platform.openai.com/playground and save the response as
> `.ijfw/cross-audit/response-critique-codex.md`, then re-run
> `/cross-critique compare`."

---

## Wave A (caller leg) -- Collect in-session perspective

**Caller-side = specialist swarm, not single opinion.** The Trident's third
leg is a parallel dispatch of in-session specialist subagents -- code-review,
silent-failure hunting, test coverage, type design, etc. -- each contributing
their findings. Claude's unique affordance over Codex/Gemini is parallel
agent dispatch; the runbook leans into it.

Fire these in parallel via the `Agent` tool (all independent, same target):

| Specialist | Dispatched via | Angle |
|------------|---------------|-------|
| Code reviewer specialist | `Agent` tool | correctness/style/convention |
| Silent-failure hunter specialist | `Agent` tool | error-swallowing, inadequate fallbacks |
| Test-coverage analyst specialist | `Agent` tool | coverage gaps |
| Type-design analyst specialist | `Agent` tool (typed codebase only) | invariants + encapsulation |

Pick the subset relevant to the project -- for a Node/Bash plugin the baseline
is code-reviewer + silent-failure-hunter + pr-test-analyzer. Send all agents
in a single message (multiple Agent tool uses in one block) so they run
concurrently.

Merge their structured findings into ONE composite JSON array matching the
critique schema `{counterArg, conditions, mitigation, severity}`, write to:

```
.ijfw/cross-audit/response-critique-caller.md
```

This file joins `response-critique-codex.md`, `response-critique-gemini.md`,
and the fresh-Claude `response-critique-claude.md` in the final merge. The
swarm IS the caller's leg of the Trident -- not a solo in-session take.

If no specialist surfaces anything, say so explicitly in the caller file;
don't fabricate findings to fill the slot.

---

## Wave B -- Compare -- score, rank, render

Run compare automatically once all auditor completion notifications arrive, or
when the user runs `/cross-critique compare` explicitly.

### Step B.1 -- Score each counter-arg via `scoreRebuttalSurvival`

```bash
node --input-type=module -e "
import('./mcp-server/src/cross-dispatcher.js').then(async m => {
  const fs = await import('fs');
  const ids = ['codex','gemini','claude','caller'].filter(id => {
    try { fs.readFileSync(\`.ijfw/cross-audit/response-critique-\${id}.md\`); return true; }
    catch { return false; }
  });
  // mergeResponses expects parsed { items } objects, not raw strings.
  const parsed = ids.map(id => {
    const raw = fs.readFileSync(\`.ijfw/cross-audit/response-critique-\${id}.md\`,'utf8');
    return m.parseResponse('critique', raw);
  });
  const merged = m.mergeResponses('critique', parsed);
  process.stdout.write(JSON.stringify(merged, null, 2));
})"
```

`mergeResponses` calls `scoreRebuttalSurvival` on each counter-arg and returns the
list sorted descending by score (1=low, 5=high). The rubric is deterministic:
condition specificity, mitigation existence, evidence link, severity, independence
from caller context.

### Step B.2 -- Render ranked counter-arg table

First identify the actionable response options (e.g., "proceed", "mitigate", "rework").
Assign each a letter with a short dash-separated name. Then emit the self-contained
reconciliation report using this exact structure:

```
VERDICT
  <one-line: what the combined critique converges on>

OPTIONS
  A -- <short-name>: <one-line description>
  B -- <short-name>: <one-line description>
  [add C only if a genuinely distinct third path exists]

REVIEWER CONVERGENCE
  codex (technical):   <letter>  survival:<N>/5  "<top counter-arg in quotes>"  => Option <letter> -- <name>
  gemini (strategic):  <letter>  survival:<N>/5  "<top counter-arg in quotes>"  => Option <letter> -- <name>
  claude/fresh (ux):   <letter>  survival:<N>/5  "<top counter-arg in quotes>"  => Option <letter> -- <name>
  caller:              <letter>  survival:<N>/5  "<top counter-arg in quotes>"  => Option <letter> -- <name>

RECOMMENDATION
  Option <X> -- <name> because <one-sentence why>.

NEXT ACTION
  <exact command / step>
```

Rules:
- Never reference "Option A" or "Option B" without the "-- name" immediately after it.
- The OPTIONS block must appear before REVIEWER CONVERGENCE.
- Each reviewer row ends with "=> Option X -- name" so the user sees consensus at a glance.

Ranked counter-arg table (follows the structured header):

```
## Cross-critique findings -- <target>
Auditors: codex (technical) -- gemini (strategic) -- claude/fresh (ux) -- caller

Survival score: weighted across 5 rebuttal dimensions -- condition specificity,
mitigation existence, evidence link, severity, and independence from caller context.
See scoreRebuttalSurvival in cross-dispatcher.js for the exact weights.

| Rank | Counter-argument | Angle | Survival | Conditions | Mitigation |
|------|-----------------|-------|----------|------------|------------|
|  1   | <summary>       | technical | 5/5  | <specific> | <action>   |
|  2   | <summary>       | strategic | 4/5  | <specific> | <action>   |
| ...  | ...             | ...   | ...      | ...        | ...        |

<N> counter-args total. Act on survival >=4 first.
```

Survival score 5 = survives most rebuttals under realistic conditions.
Survival score 1 = dissolves under the first reasonable objection.

### Step B.3 -- Archive

Move all request, response, and merge files to:

```
.ijfw/cross-audit/archive/<YYYY-MM-DDTHHMM>-critique/
  request-critique-codex.md
  request-critique-gemini.md
  request-critique-claude.md
  response-critique-codex.md
  response-critique-gemini.md
  response-critique-claude.md
  response-critique-caller.md   (if present)
  merge.json
```

## Notes

- All three external auditors fire in parallel -- there is no Phase A / Phase B
  staging. The caller's own perspective is always collected in-session, not via
  background bash.
- Output is ranked by rebuttal survival score, not raw severity. A high-severity
  counter-arg with an easy rebuttal ranks below a medium-severity one that survives
  scrutiny.
- The fresh `claude -p` session for the UX angle prevents the caller's in-session
  context from influencing the external critique.
- `audit-roster.js` detection is conservative: if the caller cannot be identified,
  all options are shown rather than guessing.
- Positive framing throughout: no "missing auditor error" -- "install to unlock the
  full Trident."
