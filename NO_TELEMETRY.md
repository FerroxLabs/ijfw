# IJFW Privacy Posture -- No Telemetry

**Short version:** IJFW doesn't phone home. Every byte of memory, every
metric, every auto-extracted lesson stays on your machine unless you
explicitly ask for it to go somewhere else.

## What IJFW stores, and where

| Data | Location | Leaves your machine? |
|------|----------|----------------------|
| Project memory | `.ijfw/memory/` in each project | No |
| Global memory | `~/.ijfw/memory/` (faceted markdown) | No |
| Session transcripts | Not stored by IJFW -- Claude Code / your platform handles these | N/A |
| Metrics (tokens, cost, routing) | `.ijfw/metrics/sessions.jsonl` | No |
| Handoffs | `.ijfw/memory/handoff.md` | No |
| Benchmark runs | `core/benchmarks/runs/*.jsonl` | No |
| Auto-extracted lessons (Wave 3) | `~/.ijfw/memory/` with `source: auto-memorize` tag | No |

IJFW ships zero analytics SDKs, zero phone-home endpoints, zero
"anonymous usage reporting." There is nothing to toggle off because
nothing is on.

## What IJFW writes into your project files, and how to control it

To unify memory + routing across every agent, IJFW injects a small managed
block into the files each platform reads. It edits **only** the region between
its own markers (`<!-- IJFW-MEMORY-START -->` ... `<!-- IJFW-MEMORY-END -->`,
plus `<ijfw-routing>` / `<!-- IJFW-AGENTS -->` / `<!-- IJFW-BLACKBOARD -->`);
everything outside the markers is yours and is never touched.

| File | When | Scope |
|------|------|-------|
| `CLAUDE.md` (project root) | every session, only if the block changed | this project only |
| `AGENTS.md` (project root) | every session, only if the block changed | this project only |
| `.cursor/rules/ijfw.mdc`, `.windsurfrules`, `.github/copilot-instructions.md` | at install | this project only |

IJFW **never** writes a global `~/CLAUDE.md` / `~/AGENTS.md`. A project-root
guard refuses any write whose target resolves to your home directory, and a
one-time cleanup strips stray global blocks left by older versions.

**Platform tiers.** Six platforms (Claude, Gemini, OpenCode, Qwen, Cline,
Kimi/OpenClaw) can receive memory transiently via MCP/hooks; nine (Codex,
Wayland, Hermes, Cursor, Windsurf, Copilot, Aider, Antigravity, Pi) only read a
static file, so a project-scoped file is the only way to reach them.

**Opt-out knobs** (injection is on by default — these turn parts off per project):

| Knob | Effect |
|------|--------|
| `touch .ijfw/no-inject` (or `IJFW_NO_INJECT=1`) | Stop writing the CLAUDE.md / AGENTS.md managed blocks for this project. |
| `touch .ijfw/no-registry` (or `IJFW_NO_REGISTRY=1`) | Keep this project out of the cross-project registry, so it never appears in another project's `scope:'all'` search. |
| `echo company-a > .ijfw/tenant` (or `IJFW_TENANT=company-a`) | Tenant isolation: cross-project search only surfaces projects with the **same** tenant. Run different companies in separate tenants and their memory never crosses. |
| `touch .ijfw/no-import` (or `IJFW_NO_IMPORT=1`) | Decline the one-time first-run auto-import of other tools' memory (claude-mem / memsearch / memorix) into this project. Reversible. |

The first time IJFW injects into a project it surfaces a one-line heads-up naming
the managed block and the `.ijfw/no-inject` opt-out. `npx @ijfw/install uninstall`
removes every managed block from every project it touched (your content
preserved) and keeps `~/.ijfw/memory/` unless you pass `--purge`.

## What calls out to the network, and why

| Action | Why | Your control |
|--------|-----|--------------|
| `npx @ijfw/install` clones from `github.com/FerroxLabs/ijfw` | You asked it to install | Don't run the installer |
| `git ls-remote --tags` during install to resolve latest release | Pins to a tagged version instead of moving `main` | `--branch main` bypasses |
| `@xenova/transformers` downloads `all-MiniLM-L6-v2` (~23 MB) first time vectors run (Wave 3) | Enable semantic recall | `IJFW_VECTORS=off` skips it entirely |
| Auto-memorize LLM synthesizer (Wave 3) | Structured session lessons via a chat model | `IJFW_AUTOMEM_MODEL=off` disables; defaults to local if a local model is configured |

**Nothing else hits the network during normal operation.** Hooks are
deterministic bash scripts. The MCP server speaks JSON-RPC over stdio
and never opens a socket. Skill files are markdown read by Claude Code.

## How to verify

```bash
# No outbound connections from the MCP server -- it's stdio only.
lsof -i -p $(pgrep -f ijfw-memory)   # expect: empty

# Audit what got auto-stored (Wave 3 onward).
/ijfw memory audit

# Tear down anything IJFW created without losing memory.
npx @ijfw/install uninstall           # preserves ~/.ijfw/memory/
npx @ijfw/install uninstall --purge   # removes memory too
```

## Enterprise / team posture

- **No cloud account required.** Ever.
- **Team memory** (`.ijfw/team/`) is plain markdown in your repo -- shared via git, not a service.
- **No account creation**, no SSO, no API keys stored by IJFW itself. Model API keys (Anthropic, OpenAI) are yours, set in your shell, never read by IJFW unless you run auto-memorize with an API model.
- **Auditable source.** Every hook is bash, every MCP tool is <100 lines of dependency-free Node.

## Model routing (Wave 3, opt-in)

Wave 3 adds `ijfw-auto-memorize` which optionally calls a chat model at
session end to synthesize structured lessons. You control the model:

| `IJFW_AUTOMEM_MODEL` value | Effect |
|---------------------------|--------|
| unset or `off` | No LLM call. Deterministic signals only. |
| `claude-haiku-4-5-20251001` | Synthesize via Anthropic Haiku (~$0.001/session). |
| `ollama:<model>` | Synthesize via local Ollama. Fully offline. |

Default in Wave 3 ship is `off`. First run prompts once for consent.

## Questions

Filed as a GitHub issue or check the source. If you see any pattern in
IJFW that looks like telemetry, open an issue. We'd rather rip the
pattern out than have the doubt persist.
