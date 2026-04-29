# Changelog

## [1.2.4] -- 2026-04-29

**Trident lineage diversity + Windows Git Bash parity + auditor reachability sharpening.** Three substantive improvements: a new third foundation-model lineage in the cross-audit roster, end-to-end Windows Git Bash support for the `ijfw` CLI itself (companion to 1.2.3's Windows MCP-spawn parity), and a set of polish improvements to how IJFW detects and surfaces auditor availability. Two community contributions land in this release. No breaking changes.

### Qwen 3 Coder joins the Trident as a third lineage

The cross-audit roster gains **qwen-code** (Qwen 3 Coder, Alibaba, Apache-2.0) alongside codex (openai) and gemini (google). The CLI is a maintained fork of gemini-cli (`npm install -g @qwen-code/qwen-code`), so the invocation pattern is already compatible with the existing dispatcher contract. ~67% SWE-Bench Verified per Qwen3-Coder-480B-A35B's published numbers, comparable to Kimi K2 with a smaller activated model.

Strategic value: when the caller itself is in the openai or google family, the diversity strategy now has a real third lineage to draw from instead of falling back to opencode/aider (which most users don't have installed). Apache-licensed weights also enable a locally-runnable backbone via Ollama for zero-API-cost auditing. Authentication supports `qwen-oauth` (free Coding Plan tier) plus openai/anthropic/gemini auth-types via `qwen auth`.

The roster entry sits between gemini and opencode by deliberate priority placement — qwen has both a maintained CLI and a working API fallback, so it wins backfill ahead of opencode's weaker SWE-Bench numbers.

Files: `mcp-server/src/audit-roster.js`, `mcp-server/test-audit-roster.js`. Contributed by [@carrmjw](https://github.com/carrmjw) (PR #11).

### Windows Git Bash CLI now works end-to-end

Companion to 1.2.3's MCP-spawn parity. The `ijfw` CLI itself now operates correctly on Windows 11 + Git Bash + MINGW64.

Two issues fixed: the `isMainModule` check at the bottom of `cross-orchestrator-cli.js` previously compared `import.meta.url` against `` `file://${process.argv[1]}` `` directly. On Git Bash, `process.argv[1]` arrives as `/c/Users/.../cli.js` while `import.meta.url` arrives as `file:///C:/Users/.../cli.js` — neither branch of the comparison matched, the dispatch block was skipped, and Node exited 0 with no output for every subcommand. Replaced with `pathToFileURL(process.argv[1]).href`, which normalizes both Windows drive paths and MSYS-style paths into the same `file:///C:/...` form. Realpath fallback retained so macOS `/tmp -> /private/tmp` symlink hops still resolve. The new behavior verifies live: `ijfw doctor`, `ijfw --help`, and `ijfw status` all produce expected output on a fresh Git Bash session.

Second: `scripts/install.sh`'s symlink wiring at `~/.local/bin` previously trusted `ln -s`'s exit code. On Windows MINGW64 without admin or Developer Mode, `ln -s` silently falls back to a file copy and still returns 0, so the installer printed "5 commands linked" while the launcher's `readlink` walk later failed at runtime. The installer now follows up with a `[ -L "$dst" ]` check, removes copy-fallbacks, and surfaces a yellow hint listing three concrete fixes (Developer Mode, Admin shell, `MSYS=winsymlinks:nativestrict`) plus the PATH-edit fallback. Zero behavior change on macOS or Linux where `ln -s` always produces real symlinks.

Files: `mcp-server/src/cross-orchestrator-cli.js`, `scripts/install.sh`. Contributed by [@BrewsterNZ](https://github.com/BrewsterNZ) (PR #7).

### Auditor reachability sharpening

Reviewing the qwen contribution led us to improve several other things in the surrounding code:

- **Codex now actually participates as the OpenAI leg of the Trident more often.** `detectSelf` previously matched both `CODEX_SESSION_ID` (an active-session marker) AND `CODEX_HOME` (a config-path env var that's set whenever codex is *installed*). On any machine that had codex installed alongside another agent, codex was being silently excluded from every Trident run as if it were the active caller. Self-detection now keys off `CODEX_SESSION_ID` only, so the openai-lineage leg is genuinely available whenever the caller is Claude Code, Cursor, Gemini CLI, or anything non-codex.
- **OpenAI-compatible provider in `api-client.js`.** `buildOpenAI` accepts an optional endpoint parameter, and `runViaApi` now recognizes `provider: "openai-compat"`. Any chat-completions-shaped backend (Qwen via DashScope, Together, Groq, etc.) can serve as an API fallback without bespoke plumbing — directly enables qwen's DashScope path added in this release, and keeps the door open for future openai-compatible auditors.
- **`defaultAuditor` respects reachability.** Previously returned the first non-self entry even when neither its CLI nor its API key was available, so callers got a misleading "ready" pick that fell over on first invoke. Now returns the highest-priority reachable entry.
- **`formatRoster` reflects API-only reachability.** A user with `OPENAI_API_KEY` set but no codex binary on PATH used to see `install` in the roster output, missing that the API path was already configured. The role label is now `ready` whenever the auditor is reachable via either CLI or API.
- **`pickAuditors({only:"<self>"})` skips self-audit explicitly.** Requesting the caller's own ID via `--with` collapses the Trident to a single source. The orchestrator now surfaces a clear note explaining the skip instead of silently degrading.

Files: `mcp-server/src/audit-roster.js`, `mcp-server/src/api-client.js`, `mcp-server/test-audit-roster.js`, `mcp-server/test-api-client.js`.

### Verification

522/522 unit tests across the mcp-server pass at 1.2.4 (six new tests covering the auditor-reachability improvements and the openai-compat provider). The full e2e smoke harness (60+ gates including isolated-HOME install, every platform's config schema, live `opencode/qwen/kimi/openclaw mcp list` handshakes, MCP server initialize+tools/list handshake) all pass on macOS at 1.2.4.

## [1.2.3] -- 2026-04-28

**Cross-platform parity + Trident transparency patch.** Three improvements: Windows now reaches the same MCP-spawn quality as macOS and Linux across every supported platform, gemini-cli auth precedence honors `GEMINI_API_KEY` deterministically, and the Trident no longer fails silently when an auditor returns no findings. No new features, no breaking changes.

### Every platform's MCP config now uses cross-platform `node + server.js` invocation

`scripts/install.sh` now writes `command: "node", args: [<absolute-path-to-server.js>]` for every MCP-aware platform -- the same shape Claude Code already used. Previously the Gemini, Cursor, Windsurf, Copilot, OpenCode, Qwen Code, Kimi Code, OpenClaw, Cline, Codex, Hermes, and Wayland configs received a path to the bash launcher script (`mcp-server/bin/ijfw-memory`). That works on macOS and Linux but Windows clients cannot directly spawn a `#!/usr/bin/env bash` file from a JSON command field, which is why MCP loading silently no-op'd on Windows after a successful install. The bash launcher remains in the repo as a manual-invocation tool; it is no longer baked into MCP configs.

`cygpath -w` converts the server.js path to Windows-native form when the installer runs under Git Bash (Windows path-aware MCP clients need backslashes / drive letters, not POSIX `/c/Users/...` paths). Verified live: a fresh install on Windows 11 produces `command: ["node", "C:\\Users\\<you>\\.ijfw\\mcp-server\\src\\server.js"]` and `opencode mcp list` reports `ijfw-memory` connected against that exact node binary. macOS and Linux continue to work unchanged via the cross-platform `node` resolution.

Files: `scripts/install.sh` (six merge functions: `merge_json`, `merge_toml`, `merge_yaml_mcp`, `opencode_merge`, `openclaw_merge`, `cline_merge` plus the Claude branch and the `openclaw mcp set` CLI invocation).

### Gemini auditor honors `GEMINI_API_KEY` precedence deterministically

When the cross-audit dispatcher invokes `gemini-cli` and `GEMINI_API_KEY` is set in the environment, the spawn now strips `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, and `CLOUDSDK_CORE_PROJECT` from the child process env before exec. This pins gemini-cli's auth to the explicit IJFW key and prevents it from picking up an unrelated active gcloud project for billing. When `GEMINI_API_KEY` is not set, gcloud creds remain intact -- legitimate gcloud-auth users are unaffected. The scrub is gemini-only; codex, opencode, aider, copilot, and claude auditors keep the full inherited environment.

Files: `mcp-server/src/cross-orchestrator.js` (new `buildSpawnEnv` helper threaded through `spawnCli`), `mcp-server/test-cross-orchestrator.js` (three new unit tests covering scrub on/off and non-gemini passthrough).

### Trident degraded-auditor visibility

Every cross-audit / cross-critique / cross-research run now surfaces a "Heads up -- one or more auditors did not contribute this run" line when at least one auditor's leg failed, timed out, or produced no parseable findings alongside non-empty stderr. The line names the auditor id and a one-line reason (first 80 characters of stderr or exit code), then explicitly states that lineage diversity is reduced for the result and points to `--with <id>` for forcing a different combination on a re-run. Previously the merged-findings output displayed regardless of leg health, so a Trident run with one auditor crashed read identically to a Trident run with all three auditors clean. The "second-lineage" promise no longer breaks silently.

A defense-in-depth prompt change reinforces the auditor role: every dispatcher request now carries an "Operating constraints (mandatory)" block instructing the auditor not to shell out, not to invoke other CLIs, and not to attempt to convene additional auditors -- the orchestrator already runs them in parallel. Verified live on Codex 0.122.0: with the new prompt, codex obeys the directive and produces findings inline rather than attempting to spawn `gemini` or other CLIs.

The Codex sandbox semantics were also re-verified empirically against Codex 0.122.0 and the audit-roster.js note has been corrected. `--sandbox read-only` blocks file *writes* on the host (`echo > /tmp/x` returns `operation not permitted`) but does NOT block shell exec or subprocess launching -- a `read-only` sandbox can still run `ls`, `curl`, or `gemini`. The load-bearing control against codex going meta is the prompt-layer "Operating constraints" block plus the visibility surface; the sandbox flag is layered file-write protection, not exec containment.

Files: `mcp-server/src/cross-dispatcher.js` (`buildRequest`), `mcp-server/src/cross-orchestrator-cli.js` (degraded-auditor warning surface in `cmdCross`), `mcp-server/src/audit-roster.js` (corrected sandbox-semantics note).

### Verification

515/515 unit tests across the mcp-server pass, including three new gemini-env-scrub tests. The full e2e smoke harness (60+ gates -- preflight, isolated-HOME install, every platform's config schema, Aider rules, live `opencode/qwen/kimi/openclaw mcp list` handshakes, MCP server initialize+tools/list handshake, atomic state-write invariants) all pass on macOS. Issue #8 was independently verified live on Windows 11: `opencode mcp list` reports `ijfw-memory` connected on a fresh install.

## [1.2.2] -- 2026-04-27

**Reliability + accuracy patch.** Six improvements to dashboard truthfulness, hook efficiency, CLI scriptability, the in-band update flow, install-time state seeding, and Codex hooks resolution. No new features, no breaking changes.

### Cost dashboard distinguishes Max vs API spend

The session-end metrics, the transcript summarizer, and the MCP cost aggregator now all carry an explicit `billing_mode` field on every row. Claude Max sessions report `cost_usd: 0` paid alongside a new `theoretical_cost_usd` showing the value captured by the subscription -- so Max users see the real $0 they pay next to the equivalent paid-API cost they would have spent. Paid-API sessions retain `cost_usd` as before. Detection: `ANTHROPIC_API_KEY` present in env -> `api`; otherwise -> `max` (Claude Code OAuth, including macOS Keychain installs). Override with `IJFW_BILLING_MODE=max|api`.

The MCP cost aggregator response gains two top-level fields: `theoreticalCost` (sum across all turns) and `valueCaptured` (`theoreticalCost - totalCost`). The breakdown and daily-series endpoints carry `theoretical_cost_usd` per group. Legacy callers reading `cost`/`totalCost` continue to work and now reflect what the user actually pays. The MCP reader preserves per-session billing mode via `~/.ijfw/transcript-summary.json`, so historical Claude turns keep their original mode across env-mode switches.

Schema: session-end metrics line bumps to `v: 4`. Old readers tolerate the new fields (`cost_usd` retained as primary).

Files: `claude/hooks/scripts/session-end.sh`, `scripts/dashboard/parse-transcripts.js`, `mcp-server/src/cost/readers/claude.js`, `mcp-server/src/cost/aggregator.js`.

### Transcript summarizer is single-process, time-budgeted, and skippable

`scripts/dashboard/parse-transcripts.js` now holds an atomic `O_CREAT|O_EXCL` PID-file lock at `~/.ijfw/.parse-transcripts.pid` so concurrent Claude Code session-starts cannot stack copies. The lock self-releases on clean exit and on SIGINT/SIGTERM; a stale lock from a dead PID is reclaimed on the next start. `claude/hooks/scripts/session-start.sh` checks the same lock pre-spawn as defense in depth.

A 30-second wall-clock budget (override with `IJFW_PARSE_BUDGET_MS=N`) caps any single run. The work queue is sorted by mtime ASC so partial runs make forward progress -- each completed file advances the watermark, and the next run picks up where this one left off. Push-time deduplication preserves first-parse `billingMode` across re-parses. Set `IJFW_SKIP_PARSE=1` per shell to skip the summarizer entirely for that session.

Files: `scripts/dashboard/parse-transcripts.js`, `claude/hooks/scripts/session-start.sh`.

### `ijfw` CLI emits JSON on non-TTY

`ijfw status` and `ijfw doctor` now follow the gh-CLI convention: when stdout is piped or otherwise non-interactive, output is JSON; on a TTY, output stays human-formatted as before. Sub-agents that shell out via bash get a clean parseable response without flag plumbing. Add `--json` to force JSON regardless of TTY. `ijfw --version` keeps its one-line shell-script contract on pipe and only switches to JSON when `--json` is explicit.

Files: `mcp-server/src/cross-orchestrator-cli.js`.

### In-band update flow streamlined

`ijfw_update_check` now writes the pending sentinel atomically when it issues a confirmation token, so the user can run `ijfw update --confirm <token>` in one step. The terminal command remains the air-gap (the model still cannot execute the update); collapsing issuance and sentinel-write into one MCP call delivers a one-MCP-call, one-terminal-command flow with no intermediate ceremony, and preserves the security model. `_check` re-reads the sentinel post-write so concurrent callers receive the token that the sentinel actually carries. `ijfw_update_apply` stays for back-compat and is idempotent against the sentinel that `_check` already wrote. The `ijfw-update` skill across all four shipping trees (Claude, Codex, shared, Gemini) is updated to match the streamlined flow.

Files: `mcp-server/src/update-check.js`, `mcp-server/src/update-apply.js`, `claude/skills/ijfw-update/SKILL.md` + three mirrors.

### Install-time state seeding now covers every install path

`scripts/install.sh` writes `~/.ijfw/state.json` on every install method, including custom-dir installs (`--dir`, `IJFW_HOME`, npm-global with non-canonical paths). The state.json + settings.json + `install-method` writes now run on the unconditional path so the MCP version-detection layer reads an accurate `installed_version` regardless of where the install lives; statusline detection (which touches Claude Code's own settings) stays canonical-only. Custom-dir users get correct version detection on first install with no extra steps.

Files: `scripts/install.sh`.

### Codex hooks resolve to the right location

`scripts/install.sh` now writes `~/.codex/hooks.json` entries that point at `~/.codex/hooks/<script>.sh` -- the same directory where the install step physically copies each hook script. Codex SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop hooks fire `Completed` cleanly on every audit invocation, including the cross-audit safe-flag combo. The hooks.json merge is idempotent against prior IJFW matcher-groups (`_ijfw: true`), so existing installs get repaired automatically on the next `bash scripts/install.sh` or `ijfw update`. Hook command paths are shell-quoted so `$HOME` values containing spaces or other shell-special characters work end-to-end (Codex shell-parses the command value; verified empirically against codex-cli 0.118 with a spaced HOME). Pre-existing hooks.json files in legacy shapes (bare arrays, or `hooks` as an array) are snapshot to `~/.codex/hooks.json.legacy.bak.<timestamp>` before the migration so user data is always recoverable.

Files: `scripts/install.sh`.

### Files changed

`.github/workflows/publish.yml`, `claude/hooks/scripts/session-end.sh`, `claude/hooks/scripts/session-start.sh`, `claude/skills/ijfw-update/SKILL.md` (+ 3 mirrors), `mcp-server/src/cost/aggregator.js`, `mcp-server/src/cost/readers/claude.js`, `mcp-server/src/cross-orchestrator-cli.js`, `mcp-server/src/update-apply.js`, `mcp-server/src/update-check.js`, `scripts/dashboard/parse-transcripts.js`, `scripts/install.sh`, `installer/package.json` + `mcp-server/package.json` (1.2.1 -> 1.2.2), `README.md`, `CLAUDE.md`.

## [1.2.1] -- 2026-04-26

**Ship-discipline patch.** Six items closing the honest-disclosures from 1.2.0 plus two production hardenings surfaced during a remote-host cross-audit diagnostic. No new features, no breaking changes.

### Codex cross-audit invocation flags

**Closes the user-reported "Codex cross-audit doesn't work on Linux"** observed on a remote Ubuntu 24.04 host (RTX PRO 6000, codex-cli 0.118.0). Four findings from live diagnostic + Trident audit close:

1. **Trusted-directory gate**: codex-cli 0.118.0 added a guard that refuses to run outside a git repo unless `--skip-git-repo-check` is passed. IJFW's documented `codex exec -` invocation tripped this on every audit run launched from `/tmp` or any non-repo dir.
2. **MCP-call auto-cancellation**: in `codex exec` non-interactive mode, MCP tool calls are auto-cancelled under any non-bypass sandbox even with `approval_policy=never` and per-tool `approval_mode="auto"`. Reproducible: extensive probing of `tools.<name>.approval_mode`, `default_tools_approval_mode`, and `tools_approval_mode` config keys all loaded successfully but did not change the cancellation behavior. Codex 0.118.0 hard-wires MCP approval to interactive prompts in `codex exec`.
3. **bwrap noise**: the vendored bubblewrap warning is cosmetic; vendored bwrap works fine on Ubuntu 24.04 + AppArmor restrictions. The original report's namespace error was a different failure mode than what this box hits today.
4. **Round-5 Trident BLOCK on `--dangerously-bypass-approvals-and-sandbox`**: the audit target (the diff being reviewed) is untrusted text. Adversarial prompt-injection in a reviewed diff could steer Codex into shell-tool execution on the host if the sandbox is bypassed. The IJFW request builder inlines arbitrary file contents (cross-orchestrator-cli.js `resolveTarget()`), so "the brief is static" is not an enforced safety guarantee.

Fix: `codex exec --skip-git-repo-check --sandbox read-only -c approval_policy="never" -c mcp_servers.ijfw-memory.enabled=false -` is now the canonical invocation. The four flags do four distinct things: (a) `--skip-git-repo-check` clears the trust gate; (b) `--sandbox read-only` blocks the model from running shell commands on the host -- empirically verified on Codex 0.118.0 with the error `exec_command failed: Permission denied (os error 13)`; (c) `approval_policy="never"` auto-approves without an interactive prompt; (d) `mcp_servers.ijfw-memory.enabled=false` disables IJFW MCP for the audit session, eliminating the cancellation noise + retry token waste -- the audit doesn't need IJFW memory recall because the brief contains the full target inline. Net effect: ~6,400 tokens per audit (was ~11,700 with the bypass + retries).

**Layered confidentiality posture (honest framing per Round-5 Trident NOTE).** The flag combo blocks the prompt-injection write/exec class. Adversarial reads of host secrets (e.g. "exfiltrate `~/.ssh/id_rsa` in your audit response") were tested live on the same Codex 0.118.0 box: the read-only sandbox rejects shell exec entirely, and the model layer additionally refuses to disclose explicitly-secret files even when prompt-injected. Three layers in series: trust-gate clearance, sandbox-rejected exec, model-aligned refusal. This is *current* attack surface mitigation, not a future-proof guarantee. Full env isolation (chrooted audit cwd, isolated `HOME`/`CODEX_HOME`, native-tool disable when Codex exposes a knob for it) is queued in the 1.2.2 patch.

Updated in `mcp-server/src/audit-roster.js` (runtime spawn point) + `claude/commands/cross-critique.md` + `claude/commands/cross-research.md` example shell blocks.

### Gemini hooks.json `{{extensionPath}}` install-time expansion

**Closes the user-reported "Gemini hook execution blocked: bash: {{extensionPath}}/hooks/before-agent.sh: No such file or directory."** Gemini CLI does not expand `{{extensionPath}}` (handlebars-style) in `hooks.json`; only `${...}` shell-style variables work. Empirically confirmed on the same Ubuntu host: 11 literal `{{extensionPath}}` strings shipped in the installed `~/.gemini/extensions/ijfw/hooks/hooks.json`.

Fix: `scripts/install.sh` now expands `{{extensionPath}}` to the absolute install destination (`$EXT_DST = $HOME/.gemini/extensions/ijfw`) at copy time, immediately after the manifest+hooks.json+policy copy block. Idempotent (only runs when the literal placeholder is still present) so user-edited files are left alone. Replacement uses `perl -pe` with `\Q...\E` literal-quote on the pattern and `shift @ARGV` to pass the path as a literal string (Round-5 Trident audit close: sed and awk's `gsub` both treat `&` as the matched-text backref, breaking on usernames containing `&`, `|`, or `\`). Perl is on every Linux + macOS default install, so portability is preserved.

### Post-publish E2E job in GitHub Actions

`scripts/post-publish-smoke.sh` (8-gate runnable harness) + a new `post-publish-smoke` job in `.github/workflows/publish.yml` that runs `needs: publish` inside a `node:20` container. Asserts: registry propagation, `ijfw --version` matches the tag, `ijfw-install --yes` clones cleanly, 12 templates ship, MCP `design_template` catalog returns 12 names, MCP `design_template:swiss-minimal` body contains the marker, MCP prelude includes the Design picker block. Replaces the manual mktemp E2E that 1.2.0 needed because no docker was available locally. Lands with `continue-on-error: true` so a flaky first run cannot retroactively fail a successful publish; flip after two consecutive greens.

### eslint-plugin-security `non-literal-fs-filename` triage

10 warnings from the 1.2.0 publish run silenced with cited reasons. Per-line audit of `installer/src/ijfw.js`:

- 9 are internal-path constructions (repo-internal traversal, install-root constants, derived from `repoRoot()` / `homedir()`) -- per-call `// eslint-disable-next-line security/detect-non-literal-fs-filename -- <reason>` with the reason naming why the path is not user-controllable.
- 1 (line 178, `existsSync(abs)` where `abs = resolve(argv[4])` for `ijfw design push <file>`) takes user CLI argv but the destination uses `basename(abs)` so writes are confined to `~/.ijfw/design-companion/content/`. Disabled with a reason that names the path-traversal mitigation.

End state: zero `detect-non-literal-fs-filename` warnings on the next Release run. Every disable is auditable.

### README template-order normalization (cosmetic)

`README.md` line 311 12-template list reordered alphabetical to match `DESIGN_TEMPLATE_CATALOG` in `mcp-server/src/server.js`. Same 12 items, no behavior change. Closes the deferred R4 NOTE from 1.2.0's Trident audit.

### Files changed

`mcp-server/src/audit-roster.js`, `claude/commands/cross-critique.md`, `claude/commands/cross-research.md`, `scripts/install.sh`, `installer/src/ijfw.js`, `scripts/post-publish-smoke.sh` (new), `.github/workflows/publish.yml`, `README.md`, `installer/package.json` + `mcp-server/package.json` (1.2.0 -> 1.2.1).

### Diagnostic credit

Live SSH session on the user's remote Ubuntu 24.04 + RTX PRO 6000 box. Phase 1-4 environment fingerprint + Codex sandbox-mode probing identified the trusted-directory gate and the MCP-cancellation behavior. Round-5 adversarial probing (live prompt-injection attempts targeting `~/.ssh/id_rsa` and `~/.codex/auth.json`) verified the layered defense holds against the threat the Trident BLOCK was concerned about. Diagnostic key revoked at end of session.

## [1.2.0] -- 2026-04-24

**Workflow intelligence release.** Four improvements to how IJFW plans and executes work, plus the platform-count cleanup closing a three-release drift. Every change landed under Donahoe Loop discipline -- three rounds of codex + gemini cross-audit closed 33 findings (6 BLOCK, 16 FLAG, 6 NOTE, 6 execution warnings) before any code was written.

### Wave 0 -- foundation primitives

Three load-bearing primitives landed first, so feature phases could assume they exist.

- **Canonical plan artifact path: `.ijfw/memory/plan.md`.** Three surfaces had disagreed; now unified. `claude/commands/ijfw-plan.md` corrected, workflow `SKILL.md` carries the invariant.
- **Structured metrics block in `ijfw-plan-check` output.** Downstream consumers now read machine-readable counters (`tasks_total`, `budget_overrun`, `dep_inversions`, `under_specified_pct`, `goal_alignment_fail`, `scope_leaks`, `verdict`) instead of parsing prose. Emitted as an HTML-comment block after the verdict text.
- **Verify-command allowlist primitive.** `mcp-server/src/ralph-allowlist.js` exports `ALLOWLIST`, `FORBID_LIST`, and `isSafeVerifyCommand(cmd)`. Zero deps, ESM, matches mcp-server's flat-test convention at `mcp-server/test-ralph-allowlist.js`. Used by Phase 4's Ralph loop to gate verify commands before execution. 27/27 tests green.

### Phase 0 -- stale "8 platforms" hunt + drift gate

Five shippable surfaces (installer banner + uninstall comment + UPDATE-FLOW docs + `/ijfw` command description) corrected from `8 platforms` to `13 platforms`. Historical files (CHANGELOGs, archived `.planning/` docs) left frozen. The `installer/dist/install.js` bundle regenerates via `prepublishOnly` from `installer/src/install.js`.

**The real fix is the gate, not the strings.** `scripts/preflight-stale-count.sh` scans shippable surfaces for bare `8 platforms` strings, excludes CHANGELOGs + `.planning/` + the gate's own self-references, and exits 1 on any hit. Wired into `scripts/e2e-smoke.sh` canonical-install mode; documented in `claude/skills/ijfw-preflight/SKILL.md` as the 12th gate. No more three-release drift.

### Phase 1 -- Temporal Interrogation (Deep-mode plan pre-flight)

**Closes "Claude plans for the ambitious case regardless of time budget."** Before drafting the plan body, Deep-mode `/ijfw-plan` asks a time-budget question:

```
How much time can you give this?
- HOUR 1       -- Smallest shippable slice: one commit, one verify
- HOUR 2-3     -- One coherent feature: small task set, no migration
- HOUR 4-5     -- Multi-task: dependency ordering matters, real risk surface
- HOUR 6+      -- Phased: rollback plan, incremental ship path
```

No `(Recommended)` tag. Time budget is the user's fact, not a judgment call with basis. Selection persists to `.ijfw/memory/plan.md` frontmatter as `time_budget: <bucket>` before the plan body drafts, so Phase 2's four-mode review can read it deterministically.

Ceilings (advisory to the planner, enforced by plan-check via the `budget_overrun` metric):

| Bucket | Max tasks | Max waves | Risk depth | Rollback |
|---|---|---|---|---|
| HOUR_1 | 3 | 1 | none | no |
| HOUR_2_3 | 7 | 2 | surface | no |
| HOUR_4_5 | 12 | 3 | deep | recommended |
| HOUR_6_PLUS | unlimited | unlimited | deep | yes |

Quick and Express tiers unaffected.

### Phase 3 -- Completeness score on `AskUserQuestion` (gstack rule)

**Credit: Garry Tan's gstack (`garrytan/gstack`) for the pattern.**

When `AskUserQuestion` options vary by DEGREE (measurable dimension -- coverage %, risk level, time-to-ship, scope breadth), each option's description now prefixes a score: `"[Coverage: 80%] ..."`, `"[Severity: HIGH] ..."`. When options vary by KIND (categorical -- framework A vs B, style X vs Y), no score. A score on a categorical choice is false precision.

Rule landed in `claude/skills/ijfw-core/SKILL.md` (under the 55-line hard cap at 54 lines via Verbosity-section compaction; all four original rules preserved in denser form). Workflow `SKILL.md` INVARIANTS carries the reminder. `references/think-phase.md` ships worked examples for SHAPE (CSS framework unscored + coverage strategy scored) and STRESS (risk severity scored). New `references/score-examples.md` canonicalizes 3 scored + 3 unscored + 1 "Deceptive degree" counter-example (options that LOOK scored but lack a measurable dimension).

### Phase 2 -- Four-mode plan review (Deep-mode `/ijfw-plan`)

**Credit: Garry Tan's gstack for the four-mode pattern.**

After `ijfw-plan-check` emits verdict, Deep mode now offers four ways forward instead of binary proceed/don't. Fires only for FLAG or PASS verdicts (BLOCK skips -- rework needed, not a review mode).

- **SCOPE EXPANSION** -- brief has acceptance criteria with no matching tasks (>20%). Surface gaps; user adds to brief; re-plan.
- **SELECTIVE** -- plan is right but too big for session. Pick top N tasks; rest go to backlog.
- **HOLD** -- too many unknowns (`under_specified_pct > 30` or `dep_inversions > 0`). Return to Discovery/Research. Writes `.ijfw/state/plan-hold.md` with timestamp + reason + unresolved gaps. New `/ijfw-plan resume` sub-command (4-step algorithm in `claude/commands/ijfw-plan.md`) so HOLD doesn't dead-end.
- **REDUCTION** -- `budget_overrun: true`. Cut to smallest viable slice; defer rest.

Default selection reads Wave 0's metrics block deterministically. `(Recommended)` tag cites its basis ("budget overrun: 14 tasks vs HOUR_2_3 ceiling 7").

The four modes are KIND-varying (no score per Phase 3 rule).

### Phase 4 -- Ralph-style completion loop in `/ijfw-execute`

**Closes "Claude stops mid-task at 60%."** Deep-mode `/ijfw-execute` now runs tasks under completion contracts with `max_iterations=3` and halt-as-ISSUE discipline. Credit: Ralph Loop research for the completion-contract pattern.

Each task ships with a YAML contract inline in `.ijfw/memory/plan.md`:

```yaml
task_id: t1
contract:
  completion_criteria:
    - id: c1
      type: shell           # shell | model-verify | manual
      description: "..."
      verify: "<command>"   # type:shell passes through Wave 0's isSafeVerifyCommand
  max_iterations: 3
  halt_rule: "Emit ISSUE with failed criterion ids after iter 3"
```

**Three criterion types** cover real verify needs:
- `shell` -- allowlisted command (8 primitives, 19 explicit forbid items from Wave 0 F.3).
- `model-verify` -- semantic check by model. Bounded; used sparingly.
- `manual` -- user confirms pass/fail. Task pauses.

**Loop protocol** with stagnation halt (cost saver): if iter N results are byte-identical to iter N-1, halt early with `ISSUE(task-stagnated)` instead of burning tokens on iters 2-3.

**Unified ISSUE ledger** at `.ijfw/state/execute-issues.json` discriminated by `kind` field:
- `task-incomplete` -- failed after `max_iterations`
- `task-stagnated` -- identical iter outputs (early halt)
- `unsafe-verify` -- command rejected by allowlist before run
- `plan-review` -- Phase 2 routing gap

**Gate consumers** (real repo surfaces, path-verified): `claude/commands/ijfw-verify.md`, `claude/commands/ijfw-audit.md`, `claude/skills/ijfw-preflight/SKILL.md`, `claude/commands/ijfw-ship.md` -- each reads the ledger at start and refuses to advance with any `status: unresolved` entry. Day-1 fresh-install protection: missing file treated as zero issues, not a crash.

**Resolution** via new `/ijfw-execute resolve <iss_id> <note>` sub-command (4-step algorithm), or automatically when the same `task_id` next executes successfully.

Four dry-run scripts ship as ship-blockers: happy-path (3 criteria pass iter 1), fail-path (stagnation halt fires), unsafe-verify (task halts BEFORE rm -rf runs), multi-file refactor (iter 1 mis-edit caught + iter 2 verifies). All four + preflight-stale-count + three earlier phase dry-runs aggregate in `scripts/1.2.0-verify-all.sh`, which also flushes `rehearsal: true` ledger entries after the run (cleanup discipline).

### Phase 5 -- DESIGN picker extension to 5 new platforms

**Closes the README 1.2.0 promise** that the DESIGN picker + 12 curated templates "reach OpenCode, Qwen Code, Kimi Code, OpenClaw, and Aider." Those five platforms lack a Claude-style skills tree (MCP-only) or lack MCP entirely (Aider rules-only) -- the only cross-cutting delivery channel was the MCP server itself. Zero new MCP tools (10-tool cap held per CLAUDE.md policy); the catalog and the template bodies ride on `ijfw_memory_recall` via colon-syntax on `context_hint`.

- **`context_hint: "design_template"`** returns the 12-name catalog with one-line descriptions and an invocation footer. Ordered alphabetically, self-contained, no external index.
- **`context_hint: "design_template:<name>"`** returns the verbatim body of `mcp-server/templates/design/<name>.md`. Name validator is `/^[a-z][a-z0-9-]{0,40}$/` plus a resolved-path-contains check so `../etc/passwd` and oversized inputs never reach the filesystem.
- **Prelude surfacing** -- `ijfw_memory_prelude` now appends a compact `## Design picker` block (5 lines) when the project cwd has no `DESIGN.md`. Placed after the update nudge and before team knowledge so Codex / Gemini / Cursor / Windsurf / OpenCode / Qwen / Kimi / OpenClaw see it on first-turn recall without drowning the more important team-memory surface.
- **Aider carries the picker too** -- `aider/CONVENTIONS.md` gains a tight three-step "DESIGN picker (via IJFW MCP)" section. Aider itself has no MCP, but users invoke the picker from any MCP-capable sibling CLI, write the body to `DESIGN.md`, and Aider reads it natively on the next turn.
- **Skill mirrors** -- `shared/skills/ijfw-design/SKILL.md` + the `claude/` and `codex/` mirrors each add one pre-list note so the three-option picker narrative stays intact while naming the MCP fallback for platforms without a skills tree.
- **Templates are self-contained** in `mcp-server/templates/design/` so the MCP server ships the picker without path assumptions about sibling `claude/` / `codex/` trees. 12 files present; gated against drift via the new prelude+catalog test (all 12 names asserted present).

Files changed: `mcp-server/src/server.js` (+79 lines: `handleDesignTemplate` helper, `DESIGN_TEMPLATE_CATALOG` constant, handleRecall + handlePrelude branches, one-line tool-description append), `mcp-server/test.js` (+13 assertions covering catalog / body / unknown-name / path-traversal / prelude present / prelude absent / PROJECT_DIR-not-cwd guard / symlink-escape guard), `aider/CONVENTIONS.md` (rewritten picker section, ~15 lines), `shared/skills/ijfw-design/SKILL.md` + `claude/skills/ijfw-design/SKILL.md` + `codex/skills/ijfw-design/SKILL.md` (+1 line each). 99/99 MCP tests green.

### Donahoe Loop audit trail

Three rounds of codex + gemini cross-audit, all findings closed in the plan before execution. Round 1: codex BLOCK + gemini FLAG + self FLAG across 17 findings. Round 2: codex FLAG (3 new) + gemini PASS + gemini NOTE. Round 3: codex PATCH (4 FLAGs) + 4 codex execution warnings + gemini READY/GO (2 NOTEs + 2 warnings). Plan artifact at `.planning/1.2.0/PLAN.md` (801 lines) + full reconciliation at `.planning/1.2.0/AUDIT.md`.

**Round 4 (ship-prep closing audit on Phase 5 + README + em-dash sweep):** codex FLAG (2) + gemini BLOCK (2). Consensus on `handlePrelude` using `process.cwd()` instead of `PROJECT_DIR` -- closed by keying the `DESIGN.md` existence check off `PROJECT_DIR`. Consensus on symlink escape inside `templates/design/` slipping past the lexical `resolve()+startsWith()` guard -- closed by switching to `realpathSync.native()` on base + target with exact-match comparison. Gemini-only BLOCK on `aider/CONVENTIONS.md` instructing Aider to call an MCP tool it has no client for -- closed by rewriting the picker section to instruct Aider to ask the user to run `ijfw_memory_recall` in a sibling MCP-capable CLI and paste the body back. Gemini FLAG on `inputSchema.properties.context_hint.description` not reflecting the colon-syntax -- closed by extending the property description. NOTE on 12-name order drift between `DESIGN_TEMPLATE_CATALOG` (alphabetical) and README line 311 (thematic) -- benign, same 12 items, deferred. Artifacts at `.ijfw/cross-audit/1.2.0-ship-prep/{codex,gemini}.md`.

### Sean Donahoe notes

Each phase shipped via isolated-context subagent (context discipline: the main planning conversation never saw the implementation bytes). Every commit atomic and gated by per-phase structural dry-runs plus the aggregate `scripts/1.2.0-verify-all.sh` harness. No push until explicit authorization per `feedback_no_push_without_authorization.md` -- the commits are local; v1.2.0 tag does not exist yet.

### Credits

- **Garry Tan** -- gstack (`garrytan/gstack`) for the Completeness score pattern + four-mode plan review pattern.
- **Ralph Loop research** -- completion-contract pattern with max-iter + halt-as-ISSUE discipline.

## [1.1.9] -- 2026-04-24

**Cline back in default TARGETS -- now 13 live platforms with no deferrals.** Discipline adoption pass from Damir Zorcic absorbed into the framework. One marketing receipt ("craft mode by design") added to the README.

### Cline re-enabled

Cline returns to the default install list after live-verified round-trip through its MCP hub inside VS Code 1.117 + Cline 3.80.0. Evidence: our test session saw Cline's ToolCallProcessor fire the `ijfw_memory_prelude` native tool call against the `ijfw-memory` MCP server -- not just "listed," actual round-tripped data (log marker: `DEBUG [ToolCallProcessor] Native Tool Called: c04RcW0mcp0ijfw_memory_prelude`). Schema confirmed stable: `mcpServers.<name>.{type:"stdio", command, args, disabled, autoApprove, timeout}` at VS Code globalStorage (platform-branched macOS / Linux / Windows). Opt-in via explicit `bash scripts/install.sh cline` flag removed; Cline is default again, matching the other twelve live-verified platforms.

Re-instated the 1.1.9 structural e2e gate covering globalStorage path + type:"stdio" schema. Sits alongside the four live CLI-invocation gates introduced in 1.1.8 (OpenCode, Qwen, Kimi, OpenClaw) -- five platforms now have an automated "platform accepts our config" check, two have no CLI to invoke and rely on structural gates plus user runtime verification (Cline + Aider rules-only).

### Discipline adoption pass

Four rules from **Damir Zorcic's "Five Laws"** suggestion absorbed into the IJFW framework at the scopes where they earn their weight. Not a schema or platform change; tightens the behaviour IJFW ships on every surface.

**Credit:** Damir Zorcic for the Five Laws suggestion. Three of the five rules adopted verbatim into universal rules; one adopted scoped to verify/ship/audit workflow gates; the remaining two were either already shipping at the right scope or explicitly rejected as anti-patterns (a mandatory 5-section output format would break IJFW's output-discipline engine).

### Universal rules (`universal/ijfw-rules.md`)

Three new lines, each paste-anywhere across any AI agent's system prompt:

- **Antisycophancy** (Damir's Law 6, promoted): "Match the user's accuracy, never their energy. Don't mirror enthusiasm to fake agreement or mirror frustration to fake empathy. Sycophancy is a failure mode, not a feature." Tightest one-line antidote to default LLM flattery.
- **Unknown is valid** (Damir's Law 1): "'I don't know' is a valid answer. Uncertainty is data. Never confabulate facts, paths, commits, or sources to fill silence. If ambiguous, ask -- don't guess." Legitimizes epistemic honesty as a first-class primitive.
- **Push back on irreversible actions** (Damir's Law 3, umbrella-ified): "Push back on irreversible actions (push, publish, deploy, tag, rm -rf, git reset --hard, drop table, ship design -> code, rewrite user copy). State the conflict, stop, and wait for an explicit go ('push it' / 'ship it' / 'yes, delete') before proceeding. 'Plan and execute' is NOT authorization to publish." Consolidates several domain-specific feedback memories under one rule.

### Confidence declaration scoped to verify/ship/audit (Damir's Law 4)

New required gate behaviour inside `claude/commands/ijfw-verify.md`, `ijfw-ship.md`, and `ijfw-audit.md`. Every finding is tagged with one of **VERIFIED** (command run, raw output available), **LIKELY** (reasoning given, not externally verified), **GUESSING** (insufficient info), or **ISSUE** (blocker; halt). Ship-gate does not auto-advance with any GUESSING or ISSUE finding. Scoped deliberately -- this rigor earns its weight at the ship boundary, not on every conversational turn (where it would break the output-discipline engine).

### Feedback memories added

- `feedback_antisycophancy.md` -- match accuracy never energy.
- `feedback_unknown_is_valid.md` -- "I don't know" as first-class answer.
- `feedback_push_back_on_irreversible.md` -- umbrella for stop-and-wait protocol before irreversible actions.

### Rejected wholesale

- **Mandatory 5-section output format** (What I Did / Proof / What I Could NOT Verify / Potential Problems / Confidence). Adopting this as a universal response template would structurally break IJFW engine #1's output-discipline rule (lead with answer, no monologues, strip 20-40% padding). Kept as an optional template pattern inside specific audit/ship workflows where the accountability weight earns the verbosity; never applied to conversational or design surfaces.
- **Universal verify-and-prove** (raw terminal output on every response). Already shipping at the correct scope (ships, audits, e2e-smoke); universalizing it = bloat for zero marginal value outside ship contexts.

### Sean Donahoe notes

Damir's framework is "defensive SRE" -- the posture you want when you've been burned by hallucinating LLMs in production. IJFW's posture is "calm confidence with receipts" -- discipline that doesn't *look* disciplined. Stealing the sharpest rules without the mandatory output template preserves IJFW's lean register while closing the epistemic-honesty gap the framework surfaced.

### Stale count in `universal/ijfw-rules.md`

While in the file: the "IJFW currently targets 8 platforms" line was stale (1.1.7 added five, Cline deferred in 1.1.8). Updated to "13 platforms" with the full list, matching the README parity matrix.

### README: "craft mode by design" positioning line

One marketing line added to the README "What this isn't" section, reframing IJFW's architectural discipline against the factory-mode-vs-craft-mode distinction that's surfaced in the wider 2026 Claude Code discourse (see claudecodecamp.com's "Boiling the Ocean" piece). IJFW is already craft mode by design -- single memory core, audit gates, receipts, $2 Trident budget cap, 99 ms hook floor. The line makes that implicit positioning explicit for the senior-engineer audience who parse the distinction.

### Credits

- **Damir Zorcic** -- Five Laws suggestion (discipline adoption).
- **David Steel** -- correction-propagation durability question that refined IJFW's pattern/decision/preference/observation taxonomy thinking (agents-md#1).
- **Garry Tan** -- gstack (`garrytan/gstack`) for the Completeness score pattern + four-mode plan review pattern feeding 1.2.0.

## [1.1.8] -- 2026-04-23

**Four AI coding CLIs now live-verified end-to-end.** `opencode mcp list`, `qwen mcp list`, `kimi mcp list`, `openclaw mcp list` -- each platform's own CLI independently reports `ijfw-memory` connected against the real binary. Shipping IJFW support no longer means "JSON validates"; it means the platform's own CLI says "connected". Every new platform integration clears this bar going forward.

### Platform parity, live-verified against real CLIs

- **OpenCode** (opencode-ai 1.14.20): wired to OpenCode's native `mcp.<name>.{type:"local", command:[...]}` shape via a new `opencode_merge` helper. `opencode mcp list` reports `[OK] ijfw-memory connected`.
- **OpenClaw** (openclaw 2026.4.21): config lives at `~/.openclaw/openclaw.json` under `mcp.servers.<name>`. The installer prefers `openclaw mcp set ijfw-memory` when the CLI is on PATH (runs OpenClaw's own zod validator -- fails fast if anything drifts) and file-merges when it's not. New `openclaw_merge` helper. `openclaw mcp list` reports `- ijfw-memory`.
- **Qwen Code** (qwen-code 0.15.1): live-verified this ship. `qwen mcp list` reports `[OK] ijfw-memory ... (stdio) - Connected`.
- **Kimi Code** (kimi-cli 1.38.0): live-verified this ship. `kimi mcp list` reports `ijfw-memory (stdio): ...`. Installer detects the uv-managed binary at `~/.local/bin/kimi`.

### New e2e gate class: CLI invocation

`scripts/e2e-smoke.sh` now invokes each platform's own CLI and asserts `ijfw-memory` in the output. When the CLI isn't on PATH the gate skips and notes. This closes the "JSON validates but the platform rejects it" class of divergence at the harness level -- not just this release, every future release.

### Hook hot-path: 32% faster

`post-tool-use.sh` consolidated from 2-3 node cold-starts to one via new `post-tool-use.js` (ESM, behaviour-identical: ANSI strip, signal capture into `.session-signals.jsonl`, noise-line drop, >500-line error-aware truncation, detached observation-capture dispatch, envelope emit). **Measured: 99 ms median, 98 ms min, 105 ms p95** (down from 145 ms). Floor is Node's cold-start (~50-70 ms on macOS); going lower would trade the zero-runtime-deps invariant.

### Bounded observation-ledger retention

`scripts/observation/ledger.js` gains `MAX_ARCHIVES=10` (tunable via `IJFW_LEDGER_ARCHIVES`; set `0` to keep everything). `gcArchives()` runs on every rotation, unlinks archives older than the cap by mtime. Worst-case disk footprint lands at ~110 MB (1 live file + 10 archives of 10 MB each). Live-tested: 11 MB ledger + 15 fake archives -> rotation fires -> 10 newest retained, live ledger fresh.

### Plugin-routing, user-respected

When IJFW and a peer brainstorming skill both expose a workflow entry point, the session-start hook now emits an `<ijfw-routing>` block framed as a user preference (the user opted into IJFW via install; prefer `ijfw:ijfw-workflow`) rather than a global override directive. Same treatment in the pre-prompt intent router and the repo `CLAUDE.md`. Targeted scoping preserved (fires only when a peer is detected); phrasing softens to respect plugin-author consent.

### README accuracy pass

- 12 stale platform-count references brought to current spec (12 MCP-integrated + 1 rules-only = 13 platforms).
- Dashboard screenshot caption reframed as explicit dogfood receipt: one machine (the author's), 30-day window. `ijfw dashboard start` surfaces the reader's own traffic; the published numbers are not an averaged benchmark.
- PostToolUse overhead line updated to the measured median (99 ms) with the consolidation note.
- DESIGN.md section clarified: picker + 12 templates + brand atlas reach the eight full-skill-tree platforms (Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot, Hermes, Wayland) today; OpenCode / Qwen Code / Kimi Code / OpenClaw / Aider read project-root `DESIGN.md` via their native rules surfaces, picker extension reaches them in 1.2.0.

### Cline: opt-in today, default in 1.1.9

Cline is a VS Code extension without a shell CLI, so the "platform's own CLI says connected" gate can't be cleared from the harness. The full helper is in place: cross-platform VS Code per-extension globalStorage path resolution (macOS / Linux / Windows), `type:"stdio"` schema, verified against Cline source (`src/services/mcp/schemas.ts`, `src/core/storage/disk.ts`, `src/extension.ts`). Cline returns to the default TARGETS list in 1.1.9 after the VS Code runtime receipt lands. Opt in today: `bash scripts/install.sh cline`.

### Feedback rules captured

- `feedback_no_push_without_authorization.md`: "build / execute / implement" mean build + verify + commit locally and stop. Only "push / ship / go / tag" trigger actual push. Tag pushes are publish operations (Trusted Publishing fires on `v*`).
- `feedback_copywriting_hooks_stay.md`: deliberate marketing register (README hero, taglines) is user-owned. Audit critiques about tone/register on copy surfaces need explicit sign-off, not a blanket rewrite.

### Back-compat

- 1.1.8 reinstall refreshes the 1.1.7 platform configs to apply the latest schema. `.bak.<timestamp>` backups preserved as usual. Users on 1.1.7 should run `ijfw update` (or `npm i -g @ijfw/install@1.1.8 && ijfw-install`) to pick up the improvements.

## [1.1.7] -- 2026-04-23

### Five new platform install targets + Aider rules-only

- **OpenCode** (opencode.ai by SST): MCP registered in `~/.config/opencode/opencode.json` `mcpServers` block.
- **Qwen Code** (Alibaba): MCP registered in `~/.qwen/settings.json` `mcpServers` block (Gemini-CLI fork shape).
- **Cline** (VS Code extension, fka Claude Dev): MCP registered in `~/.cline/data/settings/cline_mcp_settings.json`.
- **Kimi Code** (Moonshot AI): MCP registered in `~/.kimi/mcp.json` (matches the format `kimi mcp add` writes).
- **OpenClaw** (Steinberger): MCP written to `~/.openclaw/config.json`; also `openclaw mcp set ijfw-memory '...'` invoked when the CLI is on PATH.
- **Aider** (rules-only, Tier 3): Aider has no native MCP client. Ships `~/.aider.conf.yml` (auto-loads CONVENTIONS.md, sane defaults) + `~/CONVENTIONS.md` (terse IJFW workflow rules adapted for Aider's chat-only architecture). Memory + cross-audit not available inside Aider sessions.

Platform count: **8 install targets -> 13 MCP-integrated + 1 rules-only**. Same `merge_json` primitive as Cursor/Copilot/Windsurf -- same atomic-backup-then-write semantics; existing user MCP servers preserved.

### Reliability + hygiene

- Hardcoded "1.1.6" version assertion in `scripts/e2e-smoke.sh` replaced with auto-detect from `installer/package.json`. Future bumps don't require sed.
- 7 new e2e gates (one per new platform + 2 for Aider rules) -- all green in isolated-HOME mode.
- Each new platform install block honors the same `IJFW_CUSTOM_DIR=1` and `IS_IJFW_SOURCE=1` guards as Cursor/Copilot, so e2e + dogfood runs don't pollute real user configs.

## [1.1.6] -- 2026-04-22

### Update notification + safe self-update

- New `~/.ijfw/state.json` (durable facts, installer-owned) and `~/.ijfw/settings.json` (user preferences). State ownership cleanly separated across settings / state / cache / run / logs. JSON-Schema-validated. Atomic writes via new `mcp-server/src/lib/atomic-io.js` (cross-platform POSIX + Windows NTFS).
- New `ijfw update` family: `--check`, `--yes`, `--verify`, `--changelog`, `--confirm <token>`, `--auto on|off|ask`. Provenance verified via `npm audit signatures` + GitHub release asset shasum cross-check. `state.json.last_applied_version` sentinel suppresses re-entrancy nudges after a successful upgrade.
- New `ijfw --version` (pure: `@ijfw/install@1.1.6`) + `--verbose` (install method, last applied, kill-switches, ijfw-home).
- New `ijfw insight` alias for `ijfw dashboard start` (context-mode parity).
- New SessionStart background update-check hook (detached, dedupe-marker, negative-cache, monotonic last-latest-seen). Cache lives at `~/.ijfw/cache/update-check.json`. Logs rotate at 1 MB / keep 2 generations.
- Two new MCP tools (cap raised 8 -> 10 with retirement-review policy): `ijfw_update_check` issues a 5-min crypto-random confirmation token; `ijfw_update_apply` writes a pending sentinel and instructs the user to type `ijfw update --confirm <token>` in their terminal. The model **cannot** execute the update -- this air-gaps prompt injection from code execution. Threat model documented in `docs/SECURITY.md`.
- Provenance publishing wired in `.github/workflows/publish.yml` (OIDC + `--provenance` on `v*` tag) plus `installer/package.json publishConfig.provenance: true`.

### statusLine + context bar (Claude Code)

- New `claude/hooks/scripts/ijfw-statusline.js` -- sync, <50ms hot-path, fail-open. Reads pre-validated cache; no hashing/stat/chmod/subprocess in hot path. Renders `^ <ver> available  |  ###....... 57% left` with autocompact-aware (16.5% buffer) usable-percentage math. Settings: `context_bar.style = left|runway|classic`.
- New `claude/hooks/scripts/ijfw-context-monitor.js` -- PostToolUse, debounced every 5 calls, writes per-session bridge file in `~/.ijfw/run/<sid>/`.
- New `ijfw statusline --install|--compose|--disable|--status|--recompute` family. Path allowlist (`/.claude/`, `/.gsd/`, `/.ijfw/claude/`, `/.cursor/`) for safe compose with existing tools (e.g. GSD).
- Install-time behaviour: silent compose when GSD-like statusLine detected in allowlisted path; off by default on fresh installs (respects minimalists per audit).

### Documentation

- New `docs/SECURITY.md` -- trust boundaries, provenance trust model, OOB confirmation flow, re-entrancy guard, permissions.
- New `docs/SETTINGS.md` -- state ownership model, schema reference, env overrides.
- New `docs/UPDATE-FLOW.md` -- detection / notification / action surfaces, full CLI flag table, cross-platform reach.
- `shared/skills/ijfw-update/SKILL.md` rewritten and mirrored across all four trees (claude, codex, gemini, hermes/wayland via shared). Skill explicitly forbids the model from running update commands directly -- it must surface the terminal command for the user.
- `CLAUDE.md` MCP cap raised 8 -> 10 with explicit "future growth triggers retirement review, not another cap raise" policy.

### Cross-platform parity (Codex + Gemini status card)

- New `mcp-server/src/lib/status-card.js` -- one composer for the per-turn `[ijfw] context: 47% left | update: 1.1.6 available` line. Same re-entrancy guard everywhere.
- Codex `Stop` hook (`codex/.codex/hooks/session-end.sh`) now appends the status card to its receipt `systemMessage` -- context % derived from the existing input/output token totals + 200K context window estimate.
- Gemini `AfterAgent` hook (`gemini/extensions/ijfw/hooks/after-agent.sh`) now emits the status card via `additionalContext` (update-only; payload doesn't expose context %).
- Codex `SessionStart` hook also fires the same detached background update-check as Claude's session-start, so Codex users get fresh nudges without manual polling.
- Memory prelude (`ijfw_memory_prelude` MCP tool) surfaces the update nudge -- so Codex / Gemini / Cursor / Windsurf / Copilot / Hermes / Wayland all get update notification on first turn via the same MCP path. Re-entrancy guarded.

### Reliability + hygiene

- 36 new Wave-1 unit tests + 15 new Wave-2 unit tests (status-card composer + statusline + hot-path budget + compose-safety). All green.
- 23 new E2E gates in `scripts/e2e-smoke.sh` covering: state file presence, settings seed, atomic-write roundtrip, MCP tools registered, version reporting, re-entrancy suppression (statusline + prelude + status card), provenance workflow contract, skill cross-tree consistency, statusline behaviour + fail-open invariant, prelude update-nudge surfacing, Codex bg update-check wiring, Codex `Stop` + Gemini `AfterAgent` status-card emission.
- Hardened pre-existing `isMainModule` resolution in `cross-orchestrator-cli.js` -- macOS `/tmp` to `/private/tmp` symlinks now canonicalised on both sides so direct `node cli.js --version` works in any install path.
- Existing `mcp-server/test.js` updated to assert exactly 10 tools.

## [1.1.5] -- 2026-04-22

### ijfw-design -- three-option picker, cross-platform

- Reads `DESIGN.md` from project root first. If present, it becomes the design contract and the picker is skipped.
- When absent, presents three options: (1) reference a brand (smart suggestions from brand-atlas, auto-detected from project domain), (2) pick a style (12 curated templates), (3) blank slate (progressive brainstorm).
- 12 curated DESIGN.md templates in `templates/design/`: swiss-minimal, editorial-warm, terminal-native, cinematic-dark, glassmorphic, brutalist-luxe, maximalist-vibrant, neo-swiss-tech, data-dense-dashboard, warm-organic, bento-grid, magazine-editorial. Each follows the canonical 9-section DESIGN.md spec and is compatible with Claude Design (claude.ai/design).
- New `brand-atlas.json` -- 12 domains x 3-5 brand suggestions each, with keyword-based domain auto-detection.
- Cross-platform parity: Claude, Codex, Gemini, Hermes, Wayland all receive the updated SKILL.md + brand-atlas + 12 templates on install. 15 new E2E gates assert picker resources land on every platform.
- Paths in SKILL.md now skill-relative so the same source works on any install layout.

### Dashboard -- dollar-saved ledger

- Replaces the old 25% efficiency tile with a six-lever ledger: "This week: $X.XX spent / ~$Y.YY without IJFW / $Z.ZZ saved (N%)".
- Baseline estimated via three multipliers: cache hit rate (vs 25% no-IJFW baseline, since natural conversation has some cache reuse), model routing (Haiku fraction vs all-Sonnet baseline), output discipline (30% fixed midpoint of measured 20-40% range). Composite capped at 5x for defensibility.
- Inline methodology toggle cites every number's source (Anthropic cache pricing, measured output reduction). Skeptics can trace the math.
- Graceful handling of zero-data, missing-cache, 100%-Haiku, and negative-cost edge cases (9 cases verified).
- `memorySaves: 0` row hidden when empty to reduce noise on fresh installs.
- `journalEntries` (parsed from project-journal.md) now surfaces in `/api/data`.

### ijfw-workflow -- time ranges

- Tier echo line now reads "Deep (20-45 min)/Quick (3-5 min)/Express (<1 min)" for consistency with the README and launch post. Tier detection logic unchanged.

### Fix #6 -- cross audit/critique sends file contents, not path

- `ijfw cross audit <file>` previously sent only the path string to auditors, who hallucinated findings from the filename/extension. Fixed via new `resolveTarget()` helper in `mcp-server/src/cross-orchestrator-cli.js`: if the argument resolves to a regular file on disk, substitutes `File: <path>\n\n<contents>` (64 KB size cap with truncation marker). Topics, git ranges, and non-existent paths pass through unchanged.
- Reported by @shawnvink. 9 new unit tests cover real file, topic, git range, directory, oversize, relative path, and the guard case directly.

### Reliability + hygiene

- Cleaned up 3 long-standing TypeScript 6133 diagnostics (unused vars in `server.js` and `cross-orchestrator-cli.js`).
- Banned-char sweep extended to catch U+2013 (en-dash), U+00B7 (middle dot), U+00E8 (`é` in `Hermès`), and other Unicode dividers that slipped past the U+2014 check. Sanitized across all 1.1.4 + 1.1.5 surfaces.
- E2E smoke added gates for Cursor + Copilot install paths (previously uncovered).
- New `isMainModule` guard at the CLI entry so `cross-orchestrator-cli.js` can be safely imported by tests.

## [1.1.0] -- 2026-04-16

### Preflight pipeline

- `ijfw preflight` -- 11-gate quality pipeline covering shell lint, JS lint, security scan, secret detection, npm audit, dead-code detection, license check, pack-smoke, and upgrade-smoke.
- Blocking vs advisory distinction: exit 0 when all blocking gates pass even if advisory warnings exist. Exit 1 on any blocking failure.
- Each gate uses `npx --yes <tool>@<pinned-version>`. Pinned versions in `preflight-versions.json`. Missing tools report "skipped" with a positive install hint, not a failure.
- Warm-cache SLO: <=90s. Cold-cache: <=240s. Both printed in the summary line.
- `prepublishOnly` in `installer/package.json` now runs preflight before every publish so no tag can ship with a blocking gate open.

### Observation ledger

- `~/.ijfw/observations.jsonl` -- append-only JSONL ledger. One record per PostToolUse event on Claude, Codex, and Gemini.
- Heuristic classifier assigns type: `bugfix`, `feature`, `refactor`, `change`, `discovery`, `decision`. Deterministic -- zero LLM cost.
- Atomic mkdir-lock serializes concurrent appenders. Rotation at 10 MB (plain rename, archived files kept for audit).
- SessionEnd summary writes one JSON line to `~/.ijfw/session_summaries.jsonl` with request, investigated, learned, completed, and next_steps keys.
- 36 unit tests: classifier (15), capture atomic correctness (4), summarizer (7), titleizer (10).

### Local observability dashboard

- `ijfw dashboard start` -- spawns detached Node process on 127.0.0.1:37891 (walks to 37900 on conflict). Writes `~/.ijfw/dashboard.pid` and `~/.ijfw/dashboard.port`.
- `ijfw dashboard stop` -- sends `event: close` SSE, graceful shutdown, cleans PID + port files.
- `ijfw dashboard status` -- shows port and live observation count.
- Single-file HTML viewer (`dashboard-client.html`): inline CSS + JS, no React, no build step, no CDN references.
- SSE `/stream` endpoint delivers new observations within ~150ms of ledger append (50ms debounce + watcher). `Last-Event-ID` replay on reconnect. `event: close` on shutdown.
- `/api/observations` supports `?platform=`, `?since=`, `?backfill=` query params.
- `/api/health` returns `{ok, status, version, uptime, ledgerPath, obsCount}`.
- `Content-Security-Policy: default-src 'self'; ...` on every response. All DOM mutation via `textContent` or `createElement` -- no `innerHTML` with observation data.
- Localhost guard: non-loopback requests receive 403. Server bound to 127.0.0.1 only.
- Zero runtime dependencies. `npm ls --production`: 0 entries.
- 10 unit tests: health, HTML, CSP, port walk, /api/observations filters, SSE backfill, SSE live event, XSS safe-render.

### GitHub Actions CI/CD

- `.github/workflows/ci.yml` -- runs `npm run preflight` on ubuntu-latest Node 18 + 22 matrix. Preflight gate blocks merge on any blocking failure.
- `.github/workflows/release.yml` -- on `push: tags: v*`, re-runs preflight then `npm publish --provenance --access public` with `id-token: write` via npm Trusted Publishing. No `NPM_TOKEN` in repo secrets.
- `.github/workflows/cross-audit.yml` -- manual or `trident`-label-triggered Trident on PRs.
- `.github/dependabot.yml` -- weekly dev-dep updates.

### Cross-platform parity

- Observation capture and dashboard on Codex (PostToolUse hook) and Gemini (AfterTool hook).
- Per-platform `session-start-dashboard.sh` banner: prints dashboard URL + live observation count. Async, never blocks session start.
- `shared/skills/ijfw-preflight/SKILL.md` and `shared/skills/ijfw-dashboard/SKILL.md` canonical skills copied to Claude, Codex, and Gemini.
- Gemini TOML slash commands `ijfw-preflight.toml` and `ijfw-dashboard.toml`.
- Envelope invariant proven for all three platforms: PostToolUse/AfterTool JSON envelope is always the terminal stdout line, even when observation capture runs async in the background.

### Integrated cost tracking + savings cockpit (Wave H)

- Hero bar: live Today / 7d spend counter + savings bubble (cache + memory + terse + trident savings).
- `/api/cost/today`, `/api/cost/period?days=N`, `/api/cost/history?days=N`, `/api/cost/by?dim=platform|tool`, `/api/cost/block`, `/api/prices` -- all localhost-guarded, JSON, zero-dep.
- Cache hit rate insight panel with fill bar and dollar savings vs fresh-read baseline.
- Top-tools breakdown table (by token and cost).
- Daily cost sparkline (30-day canvas chart) + monthly projection.
- Credit: cost data sourced using approaches pioneered by CodeBurn (AgentSeal, MIT) and ccusage (ryoppippi, MIT).

### Memory search + insights rail (Wave I)

- Left memory rail: lists all `.ijfw/memory/` files with title, preview, last-modified, and recall count badges (all-time + this week).
- In-dashboard search: BM25-ranked full-text search across memory files; highlights matched snippets.
- `/api/memory`, `/api/memory/search?q=<query>`, `/api/memory/recall-stats` -- all localhost-guarded.
- Path traversal fix: `/api/memory/file` guard now uses `resolve()` before prefix check, defeating `../` sequences.

### Tests

- Total: 392 passing. No failing tests.
  - mcp-server suite: 392 (includes cost + memory module tests added in waves H + I)

## [1.0.0] -- 2026-04-17

First stable release of IJFW. One install configures a native-depth IJFW plugin
across three AI coding agents (Claude Code, Codex CLI, Gemini CLI) plus a
rules-and-memory baseline across three more (Cursor, Windsurf, Copilot). All
six platforms share the same skills, the same memory, and the same Trident
cross-audit -- each using its own native format.

### Native-depth platform bundles

- **Claude Code plugin**: 16 skills, full hooks, agents, slash commands, MCP.
  Auto-registered by the installer -- no manual `/plugin install` step.
- **Codex native plugin** (`codex/.codex-plugin/plugin.json` manifest, 16
  skills under `codex/skills/`, `codex/.codex/hooks.json` with 6 hook events:
  SessionStart, Stop, UserPromptSubmit, PreToolUse, PostToolUse, AfterAgent).
  Marketplace-ready with `codex/.agents/plugins/marketplace.json`.
- **Gemini native extension** (`gemini/extensions/ijfw/gemini-extension.json`
  manifest, 16 skills, 16 TOML slash commands with `{{args}}` interpolation,
  `hooks/hooks.json` with 11 hook events covering all Gemini lifecycle points).
- **Gemini bonuses**: native policy engine (`policies/ijfw.toml`) enforcing safe
  defaults for destructive operations; BeforeModel hook for first-turn memory
  injection; PreCompress hook mirroring Claude PreCompact; AfterModel
  auto-memorize trigger; hub-and-spoke agent files.
- **Baseline coverage** for Cursor, Windsurf, Copilot: MCP + native rules file
  with the same core discipline.

### Skills

- 16 canonical skills in `shared/skills/` used verbatim across all three
  native platforms: workflow, handoff, commit, cross-audit, recall, compress,
  team, debug, review, critique, memory-audit, summarize, status, doctor,
  update, plan-check.
- **ijfw-plan-check**: Donahoe Loop pre-execution audit gate. Checks goal
  alignment, scope leaks, risk surface, and dependency ordering. Returns a
  decisive PASS / FLAG / BLOCK verdict. Owns audit-plan, check-plan, and
  before-we-build intents.
- Dual-mode workflow skill: Quick mode (fast brainstorm, ~5 min) or Deep mode
  (full plan with audits, ~30 min). Auto-picks based on task size.

### Memory and MCP

- Cross-platform MCP memory server (zero npm dependencies) with 8 tools:
  recall, store, search, status, prelude, prompt_check, metrics,
  cross_project_search.
- Three memory tiers (working, project, global), faceted per-topic global
  files, BM25 keyword search with hybrid rerank path.
- Session auto-memorize with consent flow; corruption recovery.

### Installer

- `bash scripts/install.sh` drops all six platform configs with per-platform
  auto-detection, graceful fallbacks, and positive-framed summary.
- Deep-merges existing platform configs rather than overwriting. Backs up
  originals with `.bak.<timestamp>`. Idempotent -- safe to re-run.
- Auto-registers Claude Code plugin directly to `~/.claude/settings.json` +
  `known_marketplaces.json` -- no manual `/plugin install` required.
- Codex installer enables `codex_hooks = true` in config.toml and merges
  IJFW hooks with absolute paths; skills copied to `~/.codex/skills/`.
- Windows-native installer (`installer/src/install.ps1`) with PS 5.1+
  compatibility, explicit Git Bash resolution, state-machine JSONC parser.
- Visual redesign: ANSI-colored boxed banner, Live-now / Standing-by section
  summary, full-log redirection, `--verbose` / `-v` tee-to-console mode.
- Node.js 18+ validation at install time with positive-framed action message.
- `.ijfw-source` dev-tree guard (PWD-based) so user clones install cleanly.
- `ijfw doctor` reports integration depth per platform.

### CLI

- `ijfw import <tool>` with importers for claude-mem (SQLite via Node's
  built-in `node:sqlite` on Node 22.5+) and RTK (metrics-only, opt-in).
  Idempotent by default; `--dry-run` previews; `--force` overwrites.
- `ijfw cross project-audit <rule-file>` walks every registered IJFW project
  on the machine and aggregates findings into a portfolio doc.
- `ijfw demo` shows a complete IJFW session without requiring API keys.

### Trident cross-audit

- Three-way review: Claude specialist swarm (security, code-review,
  reliability, tests) + Codex + Gemini, merged into a single response.
- 2-second auto-fire default via background bash -- no manual paste.
- Perspective diversity guaranteed: picks one OpenAI-family and one
  Google-family auditor so blind spots never share a lineage.
- `/cross-research` and `/cross-critique` slash commands on a shared
  dispatcher.

### Quality

- 352-test suite: unit, installer, smoke tests for Codex and Gemini bundles.
- CI-guard (`scripts/check-all.sh`) enforces banned-char, positive-framing,
  foreign-plugin-verb, narration-pattern rules on every run.
- Atomic session-counter with `mkdir`-based lock -- no race on concurrent
  session end.
- Pre-release security audit: code-injection and TOML-injection fixes
  through all installer and hook paths.

---

## P10 -- Polish for Publish

**Theme:** Crystal clear, professionally polished, publish-ready.

- Eliminates section-sign chars, box-drawing dividers, and emoji from every user-facing surface; adopts a plain Phase/Wave/Step hierarchy throughout.
- Rewrites narration cadence across workflow, commit, handoff, and cross-audit skills so every transition tells the user where they are.
- Adds a static guard (`scripts/check-all.sh` rules) that enforces banned characters, narration patterns, and foreign-plugin verb constraints on every CI run.
- Extends `/ijfw-status` to show the current Phase, Wave, and Step at a glance.
- Hardens `install.sh` with a self-run guard: running the installer from inside the IJFW source repo exits cleanly with a positive message instead of silently corrupting state.

---

## P9 -- Robust for Strangers

**Theme:** First-run reliability -- IJFW works correctly the first time, on any machine, for anyone.

- Adds graceful API fallback and per-provider timeouts so a slow or unavailable Codex or Gemini endpoint does not block the session.
- Publishes a parity matrix showing which capabilities are available on each of the seven supported platforms.
- Ships a demo mode (`ijfw demo`) so new users see a complete IJFW session without needing API keys configured.
- Closes five dogfood findings from internal testing: edge cases around memory schema migration, hook ordering, and installer idempotency.

---

## P8 -- Trident Enforced, Visible, Everywhere

**Theme:** Cross-AI critique is automatic, visible, and owns its own execution loop.

- IJFW narration is now clean of foreign-plugin names: every surface uses its own verbs so the mental model stays coherent.
- Cross-audit is now a terminal command (`bin/ijfw`): invoke the Trident from the command line without opening a chat session.
- Every cross-audit session now leaves a receipt -- duration, consensus findings, cache hits -- auto-archived and prunable with `ijfw cross purge`.
- The Trident now auto-fires on a 2-second default: external auditors run via background bash, no manual paste or prompt required.
- Perspective diversity is now guaranteed: the default Trident always picks one OpenAI-family and one Google-family auditor so blind spots never share a lineage.

---

## P7 -- Cross-Research and Cross-Critique

**Theme:** Two AIs are smarter than one -- IJFW makes that the default, not an afterthought.

- Introduces `/cross-research` and `/cross-critique` slash commands backed by a shared cross-dispatcher module.
- Upgrades the Trident to a true three-way review: Claude specialist swarm (security, code-review, reliability, tests) + Codex + Gemini, results merged into a single response.
- Adds intent-router entries so phrases like "get a second opinion" or "cross-check this" auto-fire the right cross mode.
- Runs cross-critique on its own runbooks during Phase 7, catching and closing three critical findings before shipping.

---

## P6 -- Audit Hardening

**Theme:** Close every finding the cross-audit surfaces -- no carryovers.

- Closes all eleven Codex and Gemini cross-audit findings from Phase 5's first external review pass.
- Fixes hook event semantics: `PreToolUse` warns on `tool_input`; `PostToolUse` trims and emits a structured JSON envelope -- invariant baked into the hook scripts.
- Closes eight additional round-2 findings surfaced after the first fix batch, including output-format regressions and memory sanitizer gaps.

---

## P5 -- Adaptive Memory and Cross-Audit

**Theme:** Memory that learns, and a second model always watching.

- Ships the complete adaptive memory loop: BM25 keyword search, auto-memorize synthesis at session end (with user consent), and a hybrid rerank path for high-recall lookups.
- Delivers `/cross-audit` as a structured prompt generator for Gemini and Codex review, with a comparison renderer for the response.
- Adds a `--skill-variant` benchmark flag so users can A/B test custom skill files against the baseline.
- Publishes a tag-gated npm release workflow (`.github/workflows/publish.yml`) and a Windows PowerShell installer stub.
- Ships a self-aware cross-audit roster so IJFW knows which platforms are installed and offers only reachable auditors.

---

## P4 -- Intelligent and Visible

**Theme:** IJFW becomes smart about what you mean and honest about what it costs.

- Adds a deterministic intent router: saying "brainstorm" or "ship this" fires the right IJFW skill automatically, no LLM guess needed.
- Introduces `/mode brutal` -- a caveman-mode output discipline that cuts every response to the minimum tokens.
- Ships lazy prelude loading: the session-context summary loads only when the conversation needs it, not on every turn.
- Adds an error-aware output trimmer that reduces hook noise when nothing went wrong.
- Delivers BM25 memory search, a vectors scaffold, auto-memorize with consent flow, and corruption recovery for the memory store.
- Ships the `@ijfw/install` npx installer, a first-run welcome surface, a privacy posture statement, and an opinionated `.claudeignore` template.
- Adds `/ijfw doctor` -- a user-facing health check that shows ok or action-needed per service with install hints.

---

## P3 -- Intelligence Layer

**Theme:** Memory that persists, prompts that improve, and a first real benchmark.

- Ships cross-project memory search: a registry of known IJFW project directories lets you recall context from a different project without leaving the current one.
- Delivers the deterministic prompt-check hook: vague prompts (bare verbs, unqualified demonstratives) are caught before the agent guesses, saving turns.
- Adds a team memory tier (`.ijfw/team/`) so shared facts are available to every team member who installs IJFW on the project.
- Ships a token-usage dashboard (`/ijfw-metrics`) backed by a JSONL v2 schema with reserved fields for future prompt-check metrics.
- Delivers a three-arm benchmark harness scaffold with a hard cost cap, enabling measurable skill A/B comparisons.
- Publishes `@ijfw/install` as an npx-runnable installer so new users are one command away from a configured environment.

---

## P2 -- Platform Parity and Hardened Memory

**Theme:** Every platform gets the same intelligence; memory becomes a first-class citizen.

- Splits global memory into faceted per-topic files, making recall faster and keeping individual files human-readable.
- Adds `ijfw_memory_prelude` as the fifth MCP tool so Gemini, Codex, and Cursor get the same first-turn context recall that Claude gets via CLAUDE.md.
- Rewrites `scripts/install.sh` to parse and merge existing platform configs rather than overwriting them -- safe to run on any existing setup.
- Hardens all seven platform packages with the same core rules, adapted for each platform's native format.
- Introduces the cross-audit UX: a graduated offer at every workflow gate, dismissible in one keystroke.
- Adds a `PostToolUse` hook that trims verbose tool output and emits a structured JSON envelope for downstream tooling.

---

## P1 -- Foundation

**Theme:** One install, it just works.

- Ships the Claude Code plugin with full skills, hooks, agents, and slash commands.
- Delivers the cross-platform MCP memory server (zero npm dependencies) with `recall`, `store`, `search`, `status`, and `prelude` tools.
- Provides platform packages for six additional agents: Codex, Gemini, Cursor, Windsurf, Copilot, and a universal 15-line paste-anywhere rules file.
- Installs a session-start hook that loads project context and a session-end hook that captures signal for future auto-memorize.
- Ships the `ijfw-core` skill as the efficiency layer: smart defaults, terse output, and the positive-framing invariant baked in from day one.

---

## P0 -- Concept and Architecture

**Theme:** Define the problem, choose the constraints, commit to the design.

- Establishes the no-proxy principle: IJFW configures agent behavior, never intercepts network traffic.
- Locks the plugin architecture: one canonical source per platform, shipped as native packages the platform already understands.
- Defines the three design principles: Sutherland (smarter, not cheaper), Krug (zero config, smart defaults), Donahoe (one install, it just works).
- Sets the memory storage contract: plain markdown for hot recall, SQLite FTS5 for warm search, optional vectors for cold semantic lookup.
- Defines the hard cap: `ijfw-core` skill stays at or under 55 lines -- the single source of truth for every agent session.
