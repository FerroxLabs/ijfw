# @ijfw/install

One-command installer for [IJFW](https://gitlab.com/therealseandonahoe/ijfw) -- the AI
efficiency layer for 15 AI coding agents: Claude Code, Codex, Gemini, Cursor, Windsurf, Copilot, Hermes, Wayland, OpenCode, Qwen Code, Cline, Kimi Code, OpenClaw, Antigravity, and Aider.

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

## Extension CLI

IJFW ships a full extension system for installing and sandboxing third-party skills.

```bash
# Publisher key management
ijfw extension keygen <author>              # Generate an Ed25519 publisher keypair
ijfw extension trust <keyId> <publicKey>   # Add a publisher to your trusted store
ijfw extension trust-registry [<url>]      # Pull + apply the hosted publisher registry
ijfw extension untrust <keyId>             # Remove a publisher from your trusted store
ijfw extension trusted                     # List all trusted publishers

# Extension lifecycle
ijfw extension add <source> [flags]        # Install an extension (npm name, local path, or https git URL)
  --allow-unsigned                         #   Accept extensions with no signature
  --accept-untrusted                       #   Accept extensions signed by an untrusted publisher (prompts on TTY)
  --activate                               #   Auto-activate after install
ijfw extension activate <name>             # Activate an installed extension (enforces declared permissions)
ijfw extension deactivate                  # Deactivate the current extension

# Admin / registry maintainer (rare)
ijfw extension rotate-keys <oldKeyId> <newKeyId>   # Produce a signed rotation token
ijfw extension keygen-meta <author>                # Generate the registry meta-keypair
ijfw extension sign-registry <path>                # Sign a registry JSON file in place
ijfw extension verify-registry <path>              # Verify a registry JSON signature
ijfw extension registry-status                     # Show registry cache age + signature status
```

The rotation flow and registry maintainer docs live in `docs/REGISTRY-MAINTAINER.md`.

## Build (contributors)

```bash
cd installer
npm install
npm run build   # outputs dist/install.js + dist/uninstall.js
npm test
npm run pack:check
```

Tarball target: **<100 KB**.
