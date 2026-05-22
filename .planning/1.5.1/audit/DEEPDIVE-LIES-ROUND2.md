# v1.5.1 Deep-Dive Round 2 — surface honesty (current HEAD)

HEAD: `8d4aa92` (v1.5.1-staging) · audited 2026-05-22

## Summary

The 29-commit swing genuinely fixed the CLI surface: `ijfw --help` and
`ijfw commands` are now registry-driven, the W3.A parity test is real
(16 assertions, all dispatch-backed, runs clean), and every command in
`ijfw commands` actually executes. The orchestrator dispatch ↔ registry
mapping is sound.

BUT the swing left — and in two cases *introduced* — surface lies:

1. **`mcp-server/package.json` still says "10 MCP tools"** — should be 13.
   Flagged in the audit brief; still not fixed at HEAD.
2. **`installer/README.md` + `installer/docs/GUIDE.md` still say "14 platforms"**
   and omit Antigravity. These ship inside the `@ijfw/install` npm package.
   The Antigravity commit (`3a364cd`) updated the *root* README/GUIDE but
   not the installer copies.
3. **`ijfw_memory_status` — a dead MCP tool** — is still listed as a real,
   available tool in 3 shippable files. The W2.followup commit `69ed257`
   message claims it removed "last ijfw_memory_status refs" but only
   touched test files. NEW over-claim baked into a commit message.
4. **`claude/skills/ijfw-preflight/SKILL.md` lies about gate count** —
   frontmatter "12 gates", body lists 13 numbered gates; the actual runner
   (`installer/src/preflight.js`) runs **11**. W1.D claimed to align
   claude vs codex preflight skills — it did not; they still disagree
   (11 / 12 / 13 — three different numbers).
5. Widespread "13 platforms" / "14 platforms" drift in non-installer
   shippable surfaces (CLAUDE.md, universal rules, codex/gemini plugin
   descriptions, claude command landing page, UPDATE-FLOW.md).

The stale-count preflight gate only greps for the literal `"8 platforms"`,
so every 13/14 drift sailed straight through it.

---

## HIGH — active lies (docs/help/skills claim something untrue)

### H1 — `mcp-server/package.json` advertises "10 MCP tools" (actual: 13)
`mcp-server/package.json:4` description:
`"...10 MCP tools (memory + admin/update)..."`. The server registers 13
(`ijfw_cross_audit_converge`, `_cross_project_search`, `_memory_facts`,
`_memory_prelude`, `_memory_recall`, `_memory_search`, `_memory_store`,
`_metrics`, `_prompt_check`, `_run`, `_state`, `_update_apply`,
`_update_check`). This is the npm package description.

### H2 — `ijfw_memory_status` listed as a real MCP tool in 3 shippable files
`ijfw_memory_status` is NOT defined anywhere in `mcp-server/src/`
(confirmed — not in the 13-tool set). Still listed as available:
- `codex/.codex/IJFW.md:87` — `` `ijfw_memory_status` -- memory health check ``
- `gemini/extensions/ijfw/IJFW.md:71` — `` | `ijfw_memory_status` | Show memory tier health | ``
- `docs/DESIGN.md:174` — `` | `ijfw_memory_status` | ~200-token wake-up injection. | ``
W1.B (`bcdd3d4`) claimed "remove dead ijfw_memory_status references" and
W2.followup (`69ed257`) claimed "last ijfw_memory_status refs" — both
missed these three user-facing docs. A user on Codex or Gemini reading
their own IJFW.md will try to call a tool that does not exist.

### H3 — `installer/README.md` says "14 AI coding agents", omits Antigravity
`installer/README.md:3-4`: `"...the AI efficiency layer for 14 AI coding
agents: Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot, Hermes,
Wayland, OpenCode, Qwen Code, Cline, Kimi Code, OpenClaw, and Aider."`
This is the README rendered on the npm package page for `@ijfw/install`.
Antigravity (platform #15) is missing. Root `README.md` correctly says 15.

### H4 — `installer/docs/GUIDE.md` is the stale pre-Antigravity GUIDE
`installer/docs/GUIDE.md` diverges from root `docs/GUIDE.md`:
- line 352: "configures **14** AI coding agents" (root says 15)
- the Antigravity platform-table row is **absent**
- "...to reach **14** total" (root says 15)
This GUIDE is what ships in the npm tarball and what `ijfw help` falls
back to from the installed `~/.ijfw/` path. The Antigravity commit only
patched the root copy.

### H5 — `claude/skills/ijfw-preflight/SKILL.md` lies about gate count
- frontmatter `description`: "Run the IJFW preflight pipeline (**12 gates**...)"
- body: 13 numbered gates (adds #12 "stale platform count" and
  #13 "unresolved execute-issues")
- actual runner `installer/src/preflight.js` lines 100-112: **11 gates**
  (shellcheck, oxlint, eslint-security, psscriptanalyzer, publint,
  gitleaks, audit-ci, knip, license-check, pack-smoke, upgrade-smoke).
Gates 12 and 13 are not wired into `preflight.js` or `preflight/runner.js`
at all. `scripts/preflight-stale-count.sh` exists but is not invoked by
the preflight pipeline. Three numbers in one skill file, none = 11.
The codex copy (`codex/skills/ijfw-preflight/SKILL.md`) correctly says 11
in both frontmatter and body. **W1.D's claim to align claude vs codex
preflight skills is false** — they still disagree.

---

## MED — count drift, stale examples

### M1 — "13 platforms" drift in shippable surfaces
- `claude/commands/ijfw.md:8` — "IJFW -- one interface, **13 platforms**"
- `docs/UPDATE-FLOW.md:23,24` — "all **13 platforms**" (×2)
- `codex/.codex-plugin/plugin.json:4` — "across **13 AI** coding platforms"
- `gemini/extensions/ijfw/gemini-extension.json:4` — "across **13 AI** coding platforms"
All should say 15.

### M2 — "14 platforms" drift in shippable surfaces
- `universal/ijfw-rules.md:4` — "IJFW currently targets **14 platforms**:"
  then lists 14 names, Antigravity missing. (Universal rules = paste-anywhere
  file; high visibility.)
- `mcp-server/package.json:4` — "Works with **14 MCP-using platforms**
  (...Antigravity) plus Aider" — lists 14 names *including* Antigravity,
  Aider separate = 15 total, but the literal "14" is wrong framing
  (should be "15 platforms: 14 MCP + 1 rules-only" or just 15).

### M3 — README claims wrong Claude skill count
`README.md:483` — "Claude Code | ... **22 on-demand skills**". Actual:
**34** skill directories with `SKILL.md` (`platform-capabilities.json`
correctly records `claude: skills 34`). README undersells by 12.
`README.md:484` Codex "19 skills" is correct (19 dirs).

### M4 — README hook-scripts count unverifiable / likely wrong
`README.md:413,483` — "6 hook events / **12 scripts**". `hooks.json` wires
6 events (correct) but references only **9** scripts directly;
`claude/hooks/scripts/` contains **18** files total. "12" matches neither.
Either reconcile to a defined number or drop the script count.

### M5 — `CLAUDE.md` (repo root) still says "8 AI coding agents"
`CLAUDE.md:4` — "ships platform-native packages for **8 AI coding agents**".
Stale by two milestones (should be 15). Note: `scripts/preflight-stale-count.sh`
does NOT scan `CLAUDE.md` (only `claude/ universal/ docs/ installer/src/
mcp-server/ scripts/`), so the gate can't catch this even for "8 platforms".

### M6 — `import` command help vs registry description mismatch
`command-registry.js` describes `import` as "Pull memory in from another
tool (**claude-mem, cursor-rules**)". Actual `ijfw import` help lists
"Tools: **claude-mem, rtk**" — `cursor-rules` is not a supported tool;
`rtk` is. Registry description is stale.

### M7 — `metrics --benchmark` is a real subcommand but invisible in `ijfw commands`
`ijfw metrics` is a pointer-stub (redirects to dashboard). But
`ijfw metrics --benchmark` runs a real memory benchmark (verified — emits
the documented JSON). It appears nowhere in `ijfw commands` or `--help`.
`docs/MEMORY-BENCHMARK.md` documents `ijfw metrics --benchmark` accurately
(flags `--json`/`--no-write`, artifact path all match), but a user reading
only the CLI surface would never discover it. Surface/docs mismatch.

### M8 — benchmark artifact reports wrong version
`ijfw metrics --benchmark` output: `"ijfw_version": "1.5.0"`. Branch is
v1.5.1. Sourced from `installer/package.json` (still 1.5.0) /
`mcp-server/package.json` (still 1.5.0). Consistent with held version bump,
but the benchmark JSON will mis-stamp every artifact run on this branch.

---

## LOW — cosmetic

### L1 — `install-targets-8-14.js` filename now misleading
`installer/src/install-targets-8-14.js` handles platforms 8 through **15**
(Antigravity added). Internal-only; filename is now wrong. Cosmetic.

### L2 — plugin/extension version drift
`claude/.claude-plugin/plugin.json` 1.5.0, `codex/.codex-plugin/plugin.json`
1.3.2, `gemini-extension.json` 1.3.1. Inconsistent, but version bumps are
held until ship (same policy as `installer/package.json` at 1.5.0 and the
CHANGELOG). Bump all in lockstep at ship time.

### L3 — `codex` doctor reports plugin "version 1.3.2"
`ijfw codex` doctor prints `plugin metadata -- version 1.3.2` (reads
`codex/.codex-plugin/plugin.json`). Truthful to the file, but the file is
stale (see L2).

### L4 — `ijfw config` self-describes a feature as "queued for a later release"
`ijfw config` usage: `--audit Show the active configuration resolution
hierarchy (queued for a later release)`. The flag *works* today (verified).
The "queued for a later release" parenthetical is itself now stale/misleading.

---

## Count-consistency matrix

Truth: **15 platforms** (claude, codex, gemini, cursor, windsurf, copilot,
hermes, wayland, opencode, qwen, cline, kimi, openclaw, aider, antigravity —
confirmed against `platform-capabilities.json`, which has 16 keys incl. the
non-platform `shared`). **13 MCP tools.**

| File | Platform count | Tool count | Verdict |
|------|---------------|-----------|---------|
| `README.md` | 15 ✅ | 13 ✅ | OK |
| `docs/GUIDE.md` | 15 ✅ | 13 ✅ | OK |
| `installer/docs/GUIDE.md` | **14 ❌** | 13 ✅ | STALE — H4 |
| `installer/README.md` | **14 ❌** | n/a | STALE — H3 |
| `CLAUDE.md` (root) | **8 ❌** | 13 ✅ | STALE — M5 |
| `mcp-server/CLAUDE.md` | n/a | 13 ✅ | OK |
| `mcp-server/package.json` | **14** (framing ❌) | **10 ❌** | STALE — H1, M2 |
| `universal/ijfw-rules.md` | **14 ❌** | — | STALE — M2 |
| `claude/commands/ijfw.md` | **13 ❌** | — | STALE — M1 |
| `docs/UPDATE-FLOW.md` | **13 ❌** ×2 | 13 ✅ | STALE — M1 |
| `codex/.codex-plugin/plugin.json` | **13 ❌** | — | STALE — M1 |
| `gemini/extensions/ijfw/gemini-extension.json` | **13 ❌** | — | STALE — M1 |
| `command-registry.js` | n/a | n/a | OK |
| `platform-capabilities.json` | 15 ✅ (16 incl. `shared`) | — | OK — source of truth |

MCP tool count: only `mcp-server/package.json` is wrong (says 10).
Everything else that names a tool count says 13.

Skill counts: `platform-capabilities.json` (claude 34, codex 19, gemini 19,
hermes 19, wayland 19) matches disk. `README.md:483` "22 on-demand skills"
for Claude is wrong (M3). Codex/Gemini "19 skills" claims are correct.

---

## NEW lies introduced by the swing

### N1 — W2.followup commit `69ed257` over-claims "last ijfw_memory_status refs"
Message: "stale codex-agents snapshots + **last ijfw_memory_status refs**".
The commit touched only `runtime-mediator.js`, `test-codex-agents.js`,
`test-runtime-mediator.js`, `test-team-generator.js`. The 3 *shippable*
docs in H2 (`codex/.codex/IJFW.md`, `gemini/.../IJFW.md`, `docs/DESIGN.md`)
were never touched. The commit message asserts completion that did not
happen — a lie now baked into git history and trusted by the next reader.

### N2 — Antigravity commit `3a364cd` claimed platform #15 but only half-wired the docs
`3a364cd "feat(v1.5.1): add Antigravity as platform #15"` updated root
`README.md` and root `docs/GUIDE.md` to 15, and added the installer target.
It did NOT update `installer/README.md`, `installer/docs/GUIDE.md`,
`universal/ijfw-rules.md`, `mcp-server/package.json`, `claude/commands/ijfw.md`,
`docs/UPDATE-FLOW.md`, or the codex/gemini plugin descriptions. The commit
title "platform #15" implies a complete count bump; the user-facing npm
package surface still says 14.

### N3 — claude `ijfw-preflight` SKILL.md gates 12 & 13 describe non-existent gates
Whichever swing commit edited `claude/skills/ijfw-preflight/SKILL.md` to add
gate 12 ("stale platform count") and gate 13 ("unresolved execute-issues")
documented gates the runner does not run (`preflight.js` runs 11). This is
a fabricated capability claim — and it contradicts the file's own
frontmatter ("12 gates"). W1.D's stated goal (align claude vs codex) was
not met; the edit made claude *less* accurate, not more.

### N4 — W1.D "stale-count" gate exists but is toothless against the real drift
`scripts/preflight-stale-count.sh` only matches the literal `8 platforms`.
The swing's actual drift is `13 platforms` / `14 platforms`. The gate gives
false confidence — preflight will pass green while the count lies in M1/M2
ship. The gate should match a regex for any wrong count, or assert against
`platform-capabilities.json`.
