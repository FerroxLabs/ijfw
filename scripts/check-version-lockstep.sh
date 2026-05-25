#!/usr/bin/env bash
# scripts/check-version-lockstep.sh
#
# F4.4: enforce installer / mcp-server / codex plugin versions match.
# Codex doctor's "plugin metadata" check trusts this invariant; without lint,
# a half-bumped release silently breaks the doctor for end users.

set -euo pipefail
REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

installer=$(node -p 'require("./installer/package.json").version')
mcp=$(node -p 'require("./mcp-server/package.json").version')
codex=$(node -p 'require("./codex/.codex-plugin/plugin.json").version')

if [ "$installer" != "$mcp" ] || [ "$installer" != "$codex" ]; then
  echo "[version-lockstep] DRIFT detected:" >&2
  echo "  installer/package.json:            $installer" >&2
  echo "  mcp-server/package.json:           $mcp" >&2
  echo "  codex/.codex-plugin/plugin.json:   $codex" >&2
  echo "" >&2
  echo "Fix: bump all three to the same version before publishing." >&2
  exit 1
fi
echo "[version-lockstep] OK: all three at $installer"
