# @ijfw/install — One-command installer for IJFW

> Ferrox Labs · Local-first infrastructure for AI coding agents

IJFW is Ferrox Labs' shared development infrastructure for AI-driven teams — shared memory across projects, smart model routing, cross-AI adversarial audits (Trident: Claude + Codex + Gemini in parallel), and a disciplined think-build-ship workflow. v1.5.5 closed 60 audit findings in a single milestone. This package wires it onto every AI coding agent on your machine.

Full docs: [github.com/FerroxLabs/ijfw](https://github.com/FerroxLabs/ijfw)

## Table of contents

- [Install](#install)
- [What it does](#what-it-does)
- [Options](#options)
- [Uninstall](#uninstall)
- [Links](#links)

## Install

```bash
npm install -g @ijfw/install
ijfw install
```

If no AI agents are detected, install Claude Code or Codex first, then re-run.

## What it does

- Installs the IJFW source tree at `~/.ijfw/`
- Wires the MCP server into 14 platforms via their config files
- Adds Aider as a rules-only tier — 15 agents supported total
- Sets up shared memory at `~/.ijfw/memory/` (plain markdown hot, SQLite FTS5 warm, optional vectors cold)
- Runs an 8-gate preflight before declaring done

## Options

| Flag | Default | Notes |
|------|---------|-------|
| `--dir <path>` | `$IJFW_HOME` or `~/.ijfw` | Install location |
| `--branch <name>` | latest released tag | Git branch or tag |
| `--no-marketplace` | enabled | Skip settings.json edits |
| `--yes` | interactive | Non-interactive run |

## Uninstall

```bash
ijfw uninstall          # preserves ~/.ijfw/memory/
ijfw uninstall --purge  # removes memory too
```

If `ijfw` is no longer on your PATH, invoke the bin directly:

```bash
npx -p @ijfw/install ijfw-uninstall
```

## Links

- Source, issues, and docs: [github.com/FerroxLabs/ijfw](https://github.com/FerroxLabs/ijfw)
- npm package: [@ijfw/install](https://www.npmjs.com/package/@ijfw/install)
- License: MIT
