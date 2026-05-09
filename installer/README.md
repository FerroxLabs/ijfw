# @ijfw/install

One-command installer for [IJFW](https://gitlab.com/therealseandonahoe/ijfw) -- the AI
efficiency layer for 14 AI coding agents: Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot, Hermes, Wayland, OpenCode, Qwen Code, Cline, Kimi Code, OpenClaw, and Aider.

## Install

```bash
npm install -g @ijfw/install
ijfw demo
```

IJFW configures every agent on your machine. The options below let you customize the install location, branch, or skip specific steps -- all are optional.

### Options

| Flag | Default | Notes |
|------|---------|-------|
| `--dir <path>` | `$IJFW_HOME` or `~/.ijfw` | Install location |
| `--branch <name>` | latest released tag | Git branch or tag |
| `--no-marketplace` | off | Skip settings.json edits |
| `--yes` | off | Non-interactive |

### Uninstall

```bash
ijfw uninstall          # preserves ~/.ijfw/memory/
ijfw uninstall --purge  # removes memory too
```

If `ijfw` isn't on your PATH (e.g. you uninstalled the global `@ijfw/install`
package already), invoke the bin directly:

```bash
npx -p @ijfw/install ijfw-uninstall
```

Memory is preserved across re-runs by default.

## Preflight

Requires `node >=18` and `git` (used for the initial repo clone). The
installer is Node-native end to end -- no bash, no WSL, no Git for Windows
shell. On native Windows use the PowerShell installer (PS 5.1+), which
delegates to Node directly:

```powershell
iwr https://gitlab.com/therealseandonahoe/ijfw/-/raw/main/installer/src/install.ps1 -OutFile install.ps1
.\install.ps1 -Dir $env:USERPROFILE\.ijfw
```

## Build (contributors)

```bash
cd installer
npm install
npm run build   # outputs dist/install.js + dist/uninstall.js
npm test
npm run pack:check
```

Tarball target: **<100 KB**.
