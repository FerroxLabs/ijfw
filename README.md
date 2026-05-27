[![npm version](https://img.shields.io/npm/v/@ijfw/install.svg)](https://www.npmjs.com/package/@ijfw/install)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@ijfw/install.svg)](package.json)

# IJFW — It Just F*cking Works

> Ferrox Labs · Local-first infrastructure for AI coding agents

IJFW is Ferrox Labs' internal development infrastructure for AI coding agents. We use it on every project we ship. v1.5.5 closed 60 audit findings in a single milestone — most of them surfaced by IJFW auditing itself with three different AI models in parallel. We open-sourced it because the discipline travels; the moat doesn't.

If your AI codes, IJFW already runs there.

## Table of contents

- [What it does](#what-it-does)
- [Install](#install)
- [Architecture](#architecture)
- [Platform support](#platform-support)
- [MCP tools](#mcp-tools)
- [Built at Ferrox Labs](#built-at-ferrox-labs)
- [Contributing](#contributing)
- [License](#license)

## What it does

Real output from the v1.5.5 deep-dive audit on this repository:

```
$ ijfw cross feat/v1.5.5-deep-dive
  Dispatching 10 adversarial lenses in parallel...
    Track A (lying-state)          → 8 findings
    Track B (fail-open)            → 7 findings
    Track C (exit-code-trust)      → 5 findings
    Track D (install-bootstrap)    → 7 findings
    Track E (path-containment)     → 8 findings
    Track F (lock-order)           → 7 findings
    Track G (deprecated-paths)     → 4 findings
    Track H (windows-portability)  → 9 findings
    Track I (append-without-dedup) → 9 findings
    Track J (mcp-input-validation) → 6 findings

  Trident converge — Claude · Codex · Gemini
    raw:       70
    deduped:   60   (3 BLOCKER · 14 HIGH · 23 MED · 17 LOW · 3 INFO)
    clusters:  15

$ ijfw preflight
  8 gates · 11/11 checks PASS
  upgrade-smoke · lint · mcp-cap · doctor · receipt-shape ✓

$ ijfw demo
  Trident tour saved to ./trident-demo.svg
```

Three commercial AI APIs run against every audit-worthy diff. It costs real money per release. We run it anyway, because the bug a model misses is the one its competitor catches.

## Install

```bash
npm install -g @ijfw/install
ijfw install
ijfw demo
```

One command. Every AI coding agent on your machine, configured. Local-first, zero config. If you have no AI agents installed yet, install Claude Code or Codex first, then re-run.

## Architecture

### Audited by three models, not one

Every audit-worthy diff goes past Claude, Codex, and Gemini in parallel — three different model lineages, three different blind spots. Findings get reconciled, then counter-arguments ranked by rebuttal survival rather than raw severity. v1.5.5 ran four Trident rounds before ship.

### Shared memory across every CLI

Every project and every CLI talks to the same persistent layer at `~/.ijfw/memory/`. Plain markdown hot, SQLite FTS5 warm, optional vectors cold. Shared memory eliminates the restate-context overhead between sessions — for benchmark methodology see [`docs/MEMORY-BENCHMARK.md`](docs/MEMORY-BENCHMARK.md).

### Routing by scope, verified by diff

Multi-model dispatch routes work to the right tier: Opus for architecture and cross-file refactors, Sonnet for spec-complete builds, Haiku for read-only investigation. Trust-but-verify on every subagent — empty diffs are treated as failed dispatches, not completed work.

### A workflow with no skip button

Think → build → ship gates. Brainstorm before planning, plan before building, verify before shipping. No deferments, no half-shipping, no skipping audit rounds. The workflow is the same one Ferrox Labs uses internally on production work.

## Platform support

**Claude Code · Codex · Gemini · Cursor · Windsurf · Copilot · OpenCode · Qwen · Kimi · OpenClaw · Wayland · Hermes · Cline · Antigravity**

Plus **Aider** via rules-only tier — 15 agents supported total, 14 with full MCP integration.

Wayland is Ferrox Labs' own CLI; it's a first-class target, not an afterthought.

## MCP tools

13 active tools — 8 memory · 3 admin/update/metrics · 1 brain · 1 cross-audit converge. Full manifest and cap policy live in [`mcp-server/TOOLS.md`](mcp-server/TOOLS.md). Machine-checkable via `scripts/check-mcp.sh`.

## Built at Ferrox Labs

IJFW is Ferrox Labs' shared development infrastructure — the workflow, the memory layer, the audit gates. We ship AI infrastructure for teams that need their tooling to outlive a single LLM generation. Built at Ferrox Labs, open to contributors. MIT-licensed because the moat is the discipline, not the code.

## Contributing

See [`docs/CONTRIBUTING-AUDITORS.md`](docs/CONTRIBUTING-AUDITORS.md). Source, issues, and discussion at [github.com/FerroxLabs/ijfw](https://github.com/FerroxLabs/ijfw).

## License

MIT — see [LICENSE](LICENSE).
