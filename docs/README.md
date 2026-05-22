# IJFW -- "It Just Fucking Works"
### AI Efficiency Framework by Sean Donahoe

One install. Zero config. Makes your AI coding agent smarter, more efficient, and gives it persistent memory across sessions and platforms.

**What it does:**
- **Smarter output** -- no filler, no preamble, no narration. Lead with the answer.
- **Smart routing** -- right model for the right task. Haiku for reads, Sonnet for code, Opus for architecture.
- **Persistent memory** -- remembers decisions, patterns, and context across sessions and platforms.
- **Auto-configuration** -- detects your environment, fixes bad defaults, optimizes project context.
- **Context discipline** -- targeted reads, input stripping, smart compaction, session handoff.
- **Cross-platform** -- one MCP memory server shared across Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Copilot.
- **Unified cockpit** -- local dashboard at 127.0.0.1:37891: live spend counter, savings hero bar (cache + memory + terse savings), memory search rail, per-file recall stats, insights panel with cache hit rate, top tools, daily cost sparkline, and 30-day projection. Zero deps, no build step.

---

## Install

```bash
npm install -g @ijfw/install && ijfw-install
```

Detects your agents, configures everything, done.

<details>
<summary>Manual install (Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot)</summary>

### Claude Code (Full Plugin -- Recommended)

```bash
# From the plugin marketplace
/plugin marketplace add therealseandonahoe/ijfw
/plugin install ijfw

# Or manually
git clone https://gitlab.com/therealseandonahoe/ijfw.git
cd ijfw/claude
claude plugin install .
```

### Codex CLI

```bash
bash scripts/install.sh codex
```

### Gemini CLI

```bash
bash scripts/install.sh gemini
```

### Cursor

```bash
bash scripts/install.sh cursor
```

### Windsurf

```bash
bash scripts/install.sh windsurf
```

### Copilot (VS Code)

```bash
bash scripts/install.sh copilot
```

### Any Other Agent

Paste the contents of `universal/ijfw-rules.md` into your agent's system prompt or rules file. 20 lines. Works everywhere.

</details>

---

## Usage

IJFW works automatically after install. No configuration needed.

### Modes

| Mode | What it does |
|------|-------------|
| **smart** (default) | Auto-routes models, effort, verbosity by task type |
| **fast** | Maximum efficiency -- cheapest models, ultra-terse |
| **deep** | Maximum quality -- best models, self-verification, plan-then-execute |
| **manual** | All automation off -- you control everything |

Switch: `/mode fast` or just say "go fast" / "think deeper"

### Commands

| Command | What it does |
|---------|-------------|
| `/mode` | Switch between smart/fast/deep/manual |
| `/compress <file>` | Compress a file into terse form (per-artifact measured savings reported per run) |
| `/ijfw-status` | Show current mode, routing, memory, context health |
| `/handoff` | Create or resume a session handoff |
| `/consolidate` | Run memory dream cycle (promote, prune, reconcile) |

### Memory

IJFW remembers automatically. Decisions, patterns, handoffs -- all captured and injected without you doing anything. Memory persists across sessions and works across platforms via the MCP server.

---

## How It Works

### Startup

On session start, IJFW silently:
1. Detects your environment (OpenRouter, Ollama, local models)
2. Loads project memory and last session handoff
3. Checks and optimizes settings (effort level, project context)
4. Shows a clean, positive startup summary

### Preflight

Before you ship, run the 11-gate quality pipeline:

```bash
ijfw preflight
```

Checks secrets, lint, tests, bundle size, and more. Gates are parallel where possible. Fix anything flagged, then ship.

### Dashboard

Local observability cockpit at [127.0.0.1:37891](http://127.0.0.1:37891):

```bash
ijfw dashboard start
```

Live spend counter, cache savings hero bar, memory search rail, per-file recall stats, daily cost sparkline, and 30-day projection. Zero deps. No account needed.

### Per Turn

The always-on core skill ensures:
- Terse, efficient output
- Smart agent delegation
- Context discipline
- Quality gates on destructive actions

### Session End

Hooks automatically:
- Compress the session into a journal entry
- Generate a structured handoff for next session
- Flag when memory consolidation is due

---

## Architecture

```
ijfw/
├── claude/          Claude Code plugin (full featured)
├── codex/           Codex CLI config + instructions
├── gemini/          Gemini CLI config + GEMINI.md
├── cursor/          Cursor MCP + .cursorrules
├── windsurf/        Windsurf MCP + rules
├── copilot/         Copilot MCP + instructions
├── universal/       20-line paste-anywhere rules
├── mcp-server/      Cross-platform MCP memory server
└── docs/            Documentation
```

---

## Credits / Prior Art

IJFW builds on the work of:
- **caveman** by JuliusBrussee -- proved terse output works
- **claude-mem** by thedotmack -- pioneered persistent memory injected at session start; IJFW extends the pattern to hot/warm/cold tiers with per-file recall tracking and BM25 search
- **claude-router** by 0xrdan -- proved model routing saves costs
- **Memorix** by AVIDS2 -- cross-agent memory concept
- **MemPalace** by Milla Jovovich & Ben Sigman -- structured memory metaphor

IJFW dashboard's cost tracking is adapted from approaches pioneered by
[CodeBurn](https://github.com/AgentSeal/codeburn) (MIT). CodeBurn is the
gold standard for detailed TUI-based token analysis; IJFW integrates the
same data sources into a unified web cockpit alongside memory search,
observations, and cross-audit history. Run both.

IJFW's design companion feature is informed by
[ui-ux-pro-max](https://github.com/Bharatxox/ui-ux-pro-max) -- structured design
review patterns adapted for AI-driven mockup workflows.

Also informed by [ccusage](https://github.com/ryoppippi/ccusage) (MIT, 12.9k stars)
and [tokscale](https://github.com/junhoyeo/tokscale) (MIT) for multi-CLI session
file path maps and pricing formulas. IJFW fixes the ccusage 1h-cache pricing
bug (issue #899) from day one.

IJFW is the first framework to coordinate all layers into a single, zero-config system.

---

**By Sean Donahoe** | "It Just Fucking Works"
