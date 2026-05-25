#!/usr/bin/env bash
# check-mcp-count.sh — verify the MCP tool count claim in TOOLS.md matches
# the actual TOOLS array in mcp-server/src/server.js.
#
# Catches the v1.5.2 regression class: tools dropped from the TOOLS array
# during a refactor while TOOLS.md (and CHANGELOG, and CLAUDE.md) continued
# to advertise them. CI invokes this alongside check-mcp.sh (the launch
# health probe).
#
# Counts tools by:
#   1. Lines starting with "    name: 'ijfw_" inside the TOOLS array block.
#   2. Lines starting with "  UPPER_SNAKE_TOOL," inside the same block.
# Both forms are valid TOOLS-array entries.
#
# Exit code 0 = match; non-zero = drift.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_JS="$REPO_ROOT/mcp-server/src/server.js"
TOOLS_MD="$REPO_ROOT/mcp-server/TOOLS.md"

if [ ! -f "$SERVER_JS" ]; then
  echo "FAIL: $SERVER_JS not found" >&2
  exit 1
fi
if [ ! -f "$TOOLS_MD" ]; then
  echo "FAIL: $TOOLS_MD not found" >&2
  exit 1
fi

# Count entries in the TOOLS array (between `const TOOLS = [` and the closing `];`).
# Two forms: inline objects with `    name: 'ijfw_...'` and named imports like
# `  UPDATE_CHECK_TOOL,` / `  UPDATE_APPLY_TOOL,`.
ACTUAL_COUNT=$(awk '
  /^const TOOLS = \[/ { inside=1; next }
  inside && /^\];/    { inside=0 }
  inside && /^    name: '\''ijfw_/   { count++ }
  inside && /^  [A-Z][A-Z0-9_]*_TOOL,$/ { count++ }
  END { print count+0 }
' "$SERVER_JS")

# Extract the claimed count from TOOLS.md (e.g. "## Active tools (14/14)").
CLAIMED_COUNT=$(grep -oE 'Active tools \([0-9]+/[0-9]+\)' "$TOOLS_MD" | head -1 | grep -oE '[0-9]+' | head -1 || true)

if [ -z "${CLAIMED_COUNT:-}" ]; then
  echo "FAIL: TOOLS.md does not contain 'Active tools (N/M)' header" >&2
  exit 1
fi

if [ "$ACTUAL_COUNT" -ne "$CLAIMED_COUNT" ]; then
  echo "FAIL: TOOLS.md claims $CLAIMED_COUNT active tools, server.js TOOLS array has $ACTUAL_COUNT" >&2
  echo "      Either update mcp-server/src/server.js to register the missing tools" >&2
  echo "      OR update mcp-server/TOOLS.md to reflect the actual count." >&2
  exit 1
fi

# Also assert against the cap.
CAP=$(grep -oE 'Cap:\*\* ≤[0-9]+' "$TOOLS_MD" | head -1 | grep -oE '[0-9]+' | head -1 || true)
if [ -z "${CAP:-}" ]; then
  echo "WARN: TOOLS.md does not contain a 'Cap: ≤N' header — skipping cap assertion" >&2
elif [ "$ACTUAL_COUNT" -gt "$CAP" ]; then
  echo "FAIL: server.js TOOLS array has $ACTUAL_COUNT entries — exceeds the cap ≤$CAP from TOOLS.md" >&2
  exit 1
fi

echo "OK: MCP tools match — server.js advertises $ACTUAL_COUNT, TOOLS.md claims $CLAIMED_COUNT (cap ≤${CAP:-unknown})"
