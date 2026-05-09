#!/usr/bin/env bash
# IJFW source-install convenience wrapper.
#
# As of v1.3.0 the installer is Node-native (installer/src/install-flow.js)
# so it runs identically on every platform with no bash dependency. This
# script exists so muscle memory `bash scripts/install.sh` keeps working
# from a fresh git clone on POSIX hosts.
#
# Usage:
#   bash scripts/install.sh                # installs every detected platform
#   bash scripts/install.sh claude codex   # only listed platforms
#
# On Windows, run instead:
#   node installer\src\install.js          # canonical, no bash needed
#   .\installer\src\install.ps1            # PowerShell bootstrap
set -e

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "IJFW needs Node 18+. Install from https://nodejs.org and rerun." >&2
  exit 1
fi

# Hand off to the Node entry. install.js delegates to install-flow.js which
# orchestrates preflight, state seed, statusline, plugin link, MCP-sibling
# link, and the per-target loop across all 14 platforms.
exec node "$REPO_ROOT/installer/src/install.js" "$@"
