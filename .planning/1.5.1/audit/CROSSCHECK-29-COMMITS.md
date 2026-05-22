# v1.5.1 Cross-Check — all 29 commits

Auditor: verification pass on branch `v1.5.1-staging` HEAD `8d4aa92`.
Method: every commit claim re-verified against CURRENT HEAD code (not just the
commit diff), accounting for later commits that may have altered earlier work.

## Summary

- **VERIFIED: 27 / 29**
- **DISCREPANCY: 2 / 29** (both documentation-only; no code-path defects)
- **Test surface:** `npm run test:full` → **2480 tests, 2477 pass, 2 fail, 1 skip**
  - The 2 failures are pre-existing/environmental, explicitly acknowledged by
    commit `8d4aa92`'s own message ("2 pre-existing failures … both
    environmental, unrelated to v1.5.1"). Failures observed this run:
    `codex: doctor works from a non-IJFW project directory` (the codex doctor
    legitimately flags `~/.codex/config.toml` MCP state — environment, not
    code) and `ijfw design start launches live companion URL` (25s network
    port-bind TimeoutError flake). Neither is a v1.5.1 regression.
- All registry-, team-, swarm-, and wiring-related test suites pass:
  command-registry parity 16/16, W2.followup snapshots 75/75, W1.5/W3
  team+specialist+platform suites 66/66.

## Per-commit verification

### cee76c5 plan(v1.5.1): handoff + audit findings + npm test fix (W0)  →  VERIFIED
Planning/handoff commit. `.planning/1.5.1/` artifacts present; not a code claim.

### 90df79d feat(v1.5.1 W1.A): ijfw.js help restructure + off bug + drop 15 pointer-stubs  →  VERIFIED
- `node installer/dist/ijfw.js --help` → tiered GET STARTED / USE IT / EXPLORE
  layout, leads with `demo` + `cross`. Confirmed dist==src for help output.
- `ijfw commands` → full PRIMARY / COORDINATION / PLUMBING surface, exit 0.
- `ijfw off` → routes to uninstall, exit 0, "IJFW uninstalled" message.
- The W1.A diff genuinely removed the 15 pointer-stubs from the literal
  `ORCHESTRATOR_COMMANDS` Set in `installer/src/ijfw.js`.
- NOTE (not a discrepancy): a later commit (W3.A, `b0136a7`) replaced that
  literal Set with `ORCHESTRATOR_COMMAND_NAMES` derived from
  `command-registry.js`, which DELIBERATELY re-includes the 15 stubs as
  `tier:'pointer-stub' status:'deprecated'` entries — "keep them as silent
  redirects … removal is a breaking change" (registry comment, lines 285-290).
  So `ijfw workflow` / `ijfw metrics` still delegate and print a clean
  "use the X skill" redirect (exit 0) — NOT an error. End state is coherent
  and intentional; W1.A's commit-message phrasing "drop 15 pointer-stubs" is
  superseded by W3.A's "deprecate, don't delete" decision. CLI is not broken.

### 839b252 refactor(v1.5.1 W3.B): kill search.js MEMORY_MIGRATIONS dual-registry  →  VERIFIED
`mcp-server/src/memory/search.js:63` — `const MEMORY_MIGRATIONS = await
loadMigrations();` imported from `./migration-runner.js` (readdirSync discovery
over `./migrations/`). No hardcoded migration list remains. `migration-runner.js`
exists (4.7K).

### b0136a7 feat(v1.5.1 W3.A.1): introduce command-registry.js as single source of truth  →  VERIFIED
`installer/src/command-registry.js` (14.3K) exists, exports a frozen
`COMMAND_REGISTRY` (43 entries: 11 primary + 9 coordination + 8 plumbing +
15 pointer-stub) plus `ORCHESTRATOR_COMMAND_NAMES`, `INSTALLER_DIRECT_
COMMAND_NAMES`, `ALL_COMMAND_NAMES`, `primaryCommands()`, `commandsByTier()`,
`findCommand()`. Verified by direct require.

### 888bfe8 fix(v1.5.1 W3.C): expand platform-capabilities.json to all 14 deployed platforms  →  VERIFIED
`platform-capabilities.json` has 16 keys: 14 platforms claimed by W3.C +
`shared` (correctly tier `shared`) + `antigravity` (correctly added later by
`3a364cd`). Every platform entry carries `tier` + `mcp`. Tier classification
matches commit message.

### 7792ca2 fix(v1.5.1 W1.5.C): populate empty research + business T26 domain-templates  →  VERIFIED
- `claude/agents/ijfw-research-lead.md`, `ijfw-method-reviewer.md`,
  `ijfw-strategy-lead.md`, `ijfw-risk-reviewer.md` all exist on disk (5.4-6.5K).
- `domain-templates/research.json` `agent_ids` = [ijfw-research-lead,
  ijfw-method-reviewer]; `business.json` = [ijfw-strategy-lead,
  ijfw-risk-reviewer]. Both non-empty.

### ad67dcb docs(v1.5.1 W1.F): GUIDE.md interim cleanup — kill lies, defer rewrite  →  VERIFIED
`docs/GUIDE.md` has the staleness banner at the top ("This guide is being
rewritten for v1.5.x in milestone v1.5.1 W5"). No references to non-existent
`ijfw memory store/recall` commands (only an image alt-text matched). No
pointer-stub command references.

### bcdd3d4 fix(v1.5.1 W1.B): remove dead ijfw_memory_status references  →  DISCREPANCY
The 8 SKILL.md files under `claude/skills/`, `codex/skills/`,
`gemini/extensions/ijfw/skills/` WERE fixed, and server.js dead handler was
removed — those parts hold. BUT the commit claims "zero remaining references
in source dirs" and that is FALSE. `ijfw_memory_status` still appears in:
  - `gemini/extensions/ijfw/IJFW.md:71`  (shipped Gemini context doc)
  - `codex/.codex/IJFW.md:87`            (shipped Codex context doc)
  - `docs/DESIGN.md:174`                 (shipped design doc)
  - `.codex/skills/ijfw-status/SKILL.md:22`            (deployed snapshot)
  - `installer/.codex/skills/ijfw-status/SKILL.md:22`  (installer-bundled copy)
The commit explicitly deferred README/GUIDE to a "separate agent" — those two
are now clean — but the IJFW.md / DESIGN.md / `.codex` snapshots were never
swept. See discrepancy list #1.

### da3383d fix(v1.5.1 W1.5.D): swarm-config bench fixes — kill phantoms, fix mis-mappings  →  VERIFIED
`mcp-server/src/swarm-config.js`: the 5 phantom constants
(STORY_ARCHITECT/PROSE_STYLIST/COPY_EDITOR/DATA_ANALYST/bogus CONTINUITY_EDITOR)
are gone. `DESIGN_BENCH`, `BUSINESS_BENCH`, `MIXED_BENCH` built from
T26-verified agents. `ARCHETYPE_BENCH` maps design→DESIGN_BENCH,
business→BUSINESS_BENCH, mixed→MIXED_BENCH (mis-mappings fixed, annotated
inline). All non-software-domain bench `agent_type`s resolve to on-disk
`claude/agents/<id>.md`. The only unresolved `agent_type`s are the BASE/TESTS/
TYPES specialists (`code-reviewer`, `pr-test-analyzer`, `silent-failure-hunter`,
`type-design-analyzer`) — these are peer-skill subagents, pre-date W1.5.D, and
were not in its scope.

### d6a0bca fix(v1.5.1 W3.A.2-3): wire installer help+delegation to command-registry  →  VERIFIED
Parity test asserts: printHelp()/printCommands() do not inline literal command
names; installer no longer contains a literal `ORCHESTRATOR_COMMANDS` Set;
every orchestrator-owned command resolves through `ORCHESTRATOR_COMMAND_NAMES`.
All pass.

### ad38957 fix(v1.5.1 W1.D+E): cross-orchestrator memory namespace + clean unknown-cmd  →  VERIFIED
`node installer/dist/ijfw.js memory --help` prints the subcommand list
(checkpoint, recover, related) and exits 0 — no longer "Unknown command".

### 60d6111 refactor(v1.5.1 W3.A.4): wire orchestrator usage + alias help to registry  →  VERIFIED
Parity test: "every parsed.cmd literal in orchestrator maps to a registry
entry" and "every pointer-stub entry has a deprecatedReason used by
COMMAND_ALIAS_HELP" both pass.

### 66b4ffa fix(v1.5.1 W1.5.E finish): align remaining 5 fixture rosters to ijfw- prefix  →  VERIFIED
See adec637.

### 8c9566c test(v1.5.1 W3.A.5): add command-registry parity test  →  VERIFIED
`mcp-server/test-command-registry-parity.js` runs: **16/16 assertions pass**.

### adec637 fix(v1.5.1 W1.5.E book+content): align book + content fixture rosters  →  VERIFIED
All 7 `mcp-server/fixtures/team/*.json` have every `charter.roles[].name`
prefixed `ijfw-`: book (ijfw-line-editor, ijfw-narrative-continuity-checker),
business, content, design, mixed (ijfw-app-engineer/ux-designer/launch-editor),
research, software. No non-prefixed role found in any fixture.

### c647a4c fix(v1.5.1 W1.5.B): wire generator.js to T26 domain-templates + cross-validate  →  VERIFIED
`mcp-server/src/team/generator.js`: imports domain-templates dir,
`crossValidateAgainstDomainTemplate(normalized, bundle)` is CALLED at line 323.
`loadTeamTemplate('research')` and `('business')` both execute end-to-end
without throwing — cross-validation passes for the two newly-populated domains.

### 08a41a5 docs(v1.5.1 W1.C): README count drift fixes + dead tool refs + honest tiers  →  VERIFIED
README consistently says "15 platforms" and "13 MCP tools" (matches CLAUDE.md
13/13 cap and Antigravity as platform #15). The 14 non-Claude platforms are
enumerated. No `ijfw_memory_status` in README. Honest Cursor/Windsurf/Copilot
MCP+rules footnote present.

### 1b692ff fix(v1.5.1 W2.A): wire uispec-intake into ui-review-runner  →  VERIFIED
`mcp-server/src/lib/ui-review-runner.js:43` —
`import { fromImage, fromFigma } from './uispec-intake.js'`. Both functions
CALLED (lines 422-432) when `--from-image`/`--from-figma` supplied; result
attached as `intake` on the output (line 500). `uispec-intake.js` exists.

### 4fdca42 fix(v1.5.1 W2.F): wire evaluator-checkpoint-contract into subagent-telemetry  →  VERIFIED
`mcp-server/src/orchestrator/subagent-telemetry.js:33` imports
`evaluateCheckpointContract`; CALLED at line 136 inside the checkpoint-emission
path — throws LOUD on contract violation. Production path, genuinely wired.
(`bc0d74b` is the companion follow-up commit referenced in the W2.F set.)

### 5dc4b7f fix(v1.5.1 W2.C): wire debug-trident into gate-failure handler  →  VERIFIED
`mcp-server/src/orchestrator/post-done-runner.js:54` imports `runDebugCampaign`
+ `DEBUG_OUTCOMES`; CALLED at line 262 in the gate-failure branch, result
stored as `debugTridentAnnotation`. NOTE: by deliberate design (commit message
+ code comment) it only fires when a `debugTridentDispatch` function is
injected by the caller — "default off". No production caller injects it today,
so it never fires in the default path. The wiring (import + call site +
fail-safe try/catch) is genuine and matches the commit's stated opt-in design;
not a discrepancy.

### f38d310 fix(v1.5.1 W2.D): wire gate-result-formatter into server.js cross_audit  →  VERIFIED
`mcp-server/src/server.js:1988` — `const { appendGateResult } = await
import('./gate-result-formatter.js')`; used to emit the canonical gate-result
block in the cross-audit-converge MCP path (lines 1985-2004+).

### b74f295 fix(v1.5.1 W2.B+E): wire truncation.js + worktree-guards.js into runtime-loop  →  VERIFIED
`mcp-server/src/orchestrator/runtime-loop.js`:
  - W2.B: imports `detectTruncation`, `measureTruncationRate` etc. from
    `../recovery/truncation.js` (line 42-46); callers `handleTruncation`
    (line 304, calls `detectTruncation` at 315), `recoverAndRouteTruncation`
    (375), `measureAndPersistTruncationRate` (414).
  - W2.E: imports `assertNoCwdDrift`, `captureSpawnToplevel`,
    `assertPathWithinToplevel`, `assertNotProtectedRef` from
    `../lib/worktree-guards.js` (line 51-56); all 4 guards CALLED inside
    `dispatchSubagentGuarded` (lines 619-625) before `dispatchSubagent`.
Both modules exist on disk. Both imports + callers genuinely present.

### 89f7c99 docs(v1.5.1 W2.I): correct ijfw-memorize docstring — not a half-feature  →  VERIFIED
`mcp-server/bin/ijfw-memorize` exists (11.3K, NOT deleted). Docstring rewritten:
no "TODO marker" language; explicitly documents the deterministic 1:1
promotion path + the deliberate `{pending:true}` deferred-queue design.

### 89e8dcd chore(v1.5.1 W2.J): remove 3 orphan claude/agents  →  VERIFIED
`claude/agents/architect.md`, `builder.md`, `scout.md` all absent (ls → "No
such file or directory").

### 69ed257 fix(v1.5.1 W2.followup): stale codex-agents snapshots + last ijfw_memory_status refs  →  DISCREPANCY (partial)
- The runtime-mediator part HOLDS: 0 `ijfw_memory_status` refs in
  `mcp-server/src/runtime-mediator.js` and `test-runtime-mediator.js`.
- The snapshot-test part HOLDS: `test-codex-agents.js`, `test-team-generator.js`,
  `test-runtime-mediator.js` run 75/75 pass.
- BUT the commit message says "last ijfw_memory_status refs" / "Remove last 2
  … refs" — and 5 refs survive elsewhere (the same set listed under W1.B
  discrepancy). The claim of being "the last" refs is false. Same root issue
  as #1; counted once in the discrepancy list.

### a5f037e fix(v1.5.1 W2.G): wire extension-registry-ws gate at MCP server startup  →  VERIFIED
This was an `--allow-empty` provenance commit; the actual 21-line server.js
insertion landed in `f38d310`. Verified the wiring IS in HEAD:
`mcp-server/src/server.js:2197` — `const { initWsClient } = await
import('./extension-registry-ws.js')`, `initWsClient()` CALLED at line 2198,
inside an `IJFW_REGISTRY_WS_URL`/`_SOURCE` env-gated startup block (lines
2194-2206). `extension-registry-ws.js` exists (12.2K). Genuinely wired.

### 78c2b64 fix(v1.5.1 W2.H): wire memory/benchmark into ijfw metrics --benchmark  →  VERIFIED
`mcp-server/src/cross-orchestrator-cli.js:66` imports `runBenchmark` from
`./memory/benchmark.js`; dispatched when `name==='metrics' &&
args.includes('--benchmark')` (line 279) → `metrics-benchmark` handler
(line 2395). `docs/MEMORY-BENCHMARK.md` exists (6.9K).

### 3a364cd feat(v1.5.1): add Antigravity as platform #15  →  VERIFIED
`antigravity/` repo dir exists (AGENTS.md + mcp_config.json).
`installer/src/install-targets-8-14.js:287` defines `installAntigravity(ctx)`
(deploys two surfaces: `~/.gemini/antigravity/mcp_config.json` IDE +
`~/.antigravity/mcp_config.json` CLI). Wired into install-flow + install-helpers.
`platform-capabilities.json` has the `antigravity` entry. Platform count is 15
across README/GUIDE/CLAUDE.md. NOTE: `installer/dist/install.js` is a
gitignored esbuild artifact (root `.gitignore:37` `dist/`); a stale local copy
lacked Antigravity, but `cd installer && node scripts/build.js` correctly
regenerates a dist with all 10 Antigravity references. The publish flow
(`prepublishOnly`/`preflight`) rebuilds dist, so the shipped package is fine.

### 8d4aa92 test(v1.5.1): update 11 stale test assertions post-W1.5 rename + Antigravity  →  VERIFIED
Touches 5 test files only (no `src/`). Full surface this run: 2480 tests,
2477 pass, 2 fail — exactly matching the numbers the commit message itself
states ("2480 tests, 2477 pass, 2 pre-existing failures … both environmental").
The W1.5/W3-affected suites (cross-platform-smoke, orchestrator-specialists ×2,
swarm-planner, swarm-review) all pass 66/66.

## Discrepancies requiring fix

1. **`ijfw_memory_status` references survive in 5 shipped/bundled files**
   (commits `bcdd3d4` W1.B and `69ed257` W2.followup both claimed zero/last
   refs remain — false). Remaining occurrences:
   - `gemini/extensions/ijfw/IJFW.md:71`
   - `codex/.codex/IJFW.md:87`
   - `docs/DESIGN.md:174`
   - `.codex/skills/ijfw-status/SKILL.md:22`
   - `installer/.codex/skills/ijfw-status/SKILL.md:22`
   The first three are genuine source docs that ship; the last two are
   deployed-snapshot / installer-bundled copies that should track the fixed
   `codex/skills/` source. Fix: replace each `ijfw_memory_status` reference
   with `ijfw_metrics` (health-probe) consistent with the W1.B SKILL.md
   remediation, and regenerate the `.codex` snapshots.

2. **Commit-message overstatement, no code defect (FYI, not a code fix):**
   `90df79d` W1.A's "drop 15 pointer-stubs" is superseded by W3.A's deliberate
   "deprecate as silent redirects, don't delete" decision — the 15 stubs still
   delegate and print redirect text. The HEAD behaviour is coherent and
   intentional; only the W1.A commit narrative is now slightly inaccurate. No
   action required unless the milestone wants the commit history annotated.

No wiring claim was found hollow: every "wired" commit (W2.A/B/C/D/E/F/G/H)
has both the import AND a real call site verified in HEAD. W2.C is wired but
opt-in/default-off by explicit design; W2.G's empty-commit code is genuinely
present in HEAD.
