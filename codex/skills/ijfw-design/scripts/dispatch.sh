#!/usr/bin/env bash
# ijfw-design/scripts/dispatch.sh
# Detect best available design skill and route query to it.
# Appends IJFW layer regardless of which skill runs.
#
# Usage:
#   bash dispatch.sh "<query>" [--design-system] [-p "Project"] [--explain]
#   IJFW_PREFER_INTERNAL=1 bash dispatch.sh "<query>" --design-system
#
# Exit codes: 0 = ok, 1 = missing query

set -euo pipefail

QUERY="${1:-}"
if [ -z "$QUERY" ]; then
  echo "Usage: bash dispatch.sh \"<query>\" [--design-system] [-p \"Project\"]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEARCH_JS="$SCRIPT_DIR/search.js"

# Shift past the query arg; pass remaining args to search.js
shift || true
EXTRA_ARGS=("$@")

# ---------------------------------------------------------------------------
# Detect installed design skills
# ---------------------------------------------------------------------------
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
UX_PRO_MAX_INSTALLED=0
FRONTEND_DESIGN_INSTALLED=0
SUPERPOWERS_INSTALLED=0

if [ -f "$CLAUDE_SETTINGS" ]; then
  if grep -q '"ui-ux-pro-max@' "$CLAUDE_SETTINGS" 2>/dev/null; then
    UX_PRO_MAX_INSTALLED=1
  fi
  if grep -q '"frontend-design@' "$CLAUDE_SETTINGS" 2>/dev/null; then
    FRONTEND_DESIGN_INSTALLED=1
  fi
  if grep -q '"superpowers@' "$CLAUDE_SETTINGS" 2>/dev/null; then
    SUPERPOWERS_INSTALLED=1
  fi
fi

PREFER_INTERNAL="${IJFW_PREFER_INTERNAL:-0}"

# ---------------------------------------------------------------------------
# Route decision
# ---------------------------------------------------------------------------
ROUTE="internal"
EXTERNAL_SKILL=""

if [ "$PREFER_INTERNAL" = "1" ]; then
  ROUTE="internal"
elif [ "$UX_PRO_MAX_INSTALLED" = "1" ]; then
  ROUTE="ui-ux-pro-max"
  EXTERNAL_SKILL="ui-ux-pro-max"
elif [ "$FRONTEND_DESIGN_INSTALLED" = "1" ]; then
  ROUTE="frontend-design"
  EXTERNAL_SKILL="frontend-design"
elif [ "$SUPERPOWERS_INSTALLED" = "1" ]; then
  ROUTE="superpowers"
  EXTERNAL_SKILL="superpowers"
fi

# ---------------------------------------------------------------------------
# Run internal search.js (always used in non-Claude / fallback contexts)
# ---------------------------------------------------------------------------
run_internal() {
  if command -v node >/dev/null 2>&1; then
    node "$SEARCH_JS" "$QUERY" "${EXTRA_ARGS[@]}"
  else
    echo "IJFW design search needs Node.js. Install it to unlock this feature." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
echo "ijfw-design dispatch: route=$ROUTE"
echo ""

if [ "$ROUTE" = "internal" ]; then
  if [ "$UX_PRO_MAX_INSTALLED" = "0" ] && [ "$FRONTEND_DESIGN_INSTALLED" = "0" ]; then
    echo "Tip: For richer output install ui-ux-pro-max (claude plugin install ui-ux-pro-max-skill). Using internal heuristics."
    echo ""
  fi
  run_internal
else
  echo "External skill detected: $EXTERNAL_SKILL"
  echo "Invoke $EXTERNAL_SKILL with query: $QUERY"
  echo "(In Claude Code the $EXTERNAL_SKILL Skill handles this query natively.)"
  echo ""
fi

# ---------------------------------------------------------------------------
# Always append IJFW layer
# ---------------------------------------------------------------------------
echo ""
echo "-- IJFW LAYER (always applied) --"
echo "Zero runtime deps: use system font stacks; self-host webfonts only"
echo "Positive framing: no 'error' headers; no 'not found'; no 'broken'"
echo "Platform segregation: Claude/Codex/Gemini output areas must be color-coded"
echo "WCAG AA: 4.5:1 contrast minimum; 44px touch targets"
echo "ASCII-only source: no unicode in code or config files"

# Detect current platform config
IJFW_CONFIG="${HOME}/.ijfw/config.json"
if [ -f "$IJFW_CONFIG" ]; then
  PLATFORM_TIER=$(node -e "try{const c=require('$IJFW_CONFIG');console.log(c.platform||'unknown')}catch(e){console.log('unknown')}" 2>/dev/null || echo "unknown")
  echo "Platform tier (from ~/.ijfw/config.json): $PLATFORM_TIER"
fi

echo ""
echo "Skill route: $ROUTE"
if [ -n "$EXTERNAL_SKILL" ]; then
  echo "External skill used: $EXTERNAL_SKILL (IJFW layer appended)"
fi
