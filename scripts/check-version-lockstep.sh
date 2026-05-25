#!/usr/bin/env bash
# scripts/check-version-lockstep.sh
#
# F4.4 + Wave 2 Lens 3 (F-C-5, F-C-7): assert installer / mcp-server /
# codex plugin versions match. Codex doctor's "plugin metadata" check trusts
# this invariant -- half-bumped release silently breaks the doctor for users.
#
# Provides IJFW-styled error surface (no raw Node stack traces) and a
# "likely target" hint when drift is detected.

set -euo pipefail
REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

read_ver () {
  local label="$1" pkg="$2"
  if [ ! -f "$pkg" ]; then
    echo "[version-lockstep] $label manifest MISSING: $pkg" >&2
    exit 1
  fi
  local v
  v=$(node -p "require('$REPO_ROOT/$pkg').version" 2>/dev/null) || {
    echo "[version-lockstep] $label manifest UNPARSEABLE: $pkg" >&2
    exit 1
  }
  printf '%s' "$v"
}

installer=$(read_ver "installer"      "installer/package.json")
mcp=$(read_ver       "mcp-server"     "mcp-server/package.json")
codex=$(read_ver     "codex plugin"   "codex/.codex-plugin/plugin.json")

if [ "$installer" != "$mcp" ] || [ "$installer" != "$codex" ]; then
  echo "[version-lockstep] DRIFT detected:" >&2
  echo "  installer/package.json:            $installer" >&2
  echo "  mcp-server/package.json:           $mcp" >&2
  echo "  codex/.codex-plugin/plugin.json:   $codex" >&2
  echo "" >&2
  target=$(printf '%s\n%s\n%s\n' "$installer" "$mcp" "$codex" | sort -V | tail -1)
  echo "  likely target (highest semver): $target" >&2
  echo "" >&2
  echo "Fix: bump all three to the same version before publishing." >&2
  exit 1
fi
echo "[version-lockstep] OK: all three at $installer"
