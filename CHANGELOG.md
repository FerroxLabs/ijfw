# Changelog

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
- Fixed pre-existing `isMainModule` bug in `cross-orchestrator-cli.js` -- macOS `/tmp` to `/private/tmp` symlink resolution now canonicalised on both sides so direct `node cli.js --version` works in any install path.
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
- Reported by @shawnvink. 9 new unit tests cover real file, topic, git range, directory, oversize, relative path, and the regression case directly.

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
