#!/usr/bin/env bash
# E4 -- universal disable switch.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
# IJFW PostToolUse -- thin wrapper around post-tool-use.js.
# Prior version spawned node 2-3x per invocation (~145ms median). Consolidated
# to a single node process (~60-80ms target). See post-tool-use.js for the
# full pipeline: JSON parse, signal capture, trim, truncation, detached obs
# dispatch, envelope emit. All behaviour-preserving from the shell version.

IJFW_DIR=".ijfw"
FLAGS_FILE="$IJFW_DIR/.startup-flags"

# If RTK or context-mode is active, they handle stripping -- we skip.
if [ -f "$FLAGS_FILE" ]; then
  if grep -q "IJFW_RTK_ACTIVE=1" "$FLAGS_FILE" 2>/dev/null; then
    printf '%s [post-tool-use] suppressed: RTK active\n' "$(date -u +%FT%TZ)" >>"$HOME/.ijfw/logs/post-tool-use.log" 2>/dev/null
    exit 0
  fi
  if grep -q "IJFW_CONTEXT_MODE_ACTIVE=1" "$FLAGS_FILE" 2>/dev/null; then
    printf '%s [post-tool-use] suppressed: context-mode active\n' "$(date -u +%FT%TZ)" >>"$HOME/.ijfw/logs/post-tool-use.log" 2>/dev/null
    exit 0
  fi
fi

# Require node -- fail open if unavailable, but leave a breadcrumb.
command -v node >/dev/null 2>&1 || { printf '%s [post-tool-use] node not on PATH\n' "$(date -u +%FT%TZ)" >>"$HOME/.ijfw/logs/post-tool-use.log" 2>/dev/null; exit 0; }

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
HOOK_JS="$SCRIPT_DIR/post-tool-use.js"
[ -f "$HOOK_JS" ] || exit 0

# Resolve the observation-capture script path so the JS hook can dispatch
# the detached child. Mirrors the lookup the old shell version used.
_OBS_SCRIPT="${IJFW_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)}/scripts/observation/capture.js"

exec node "$HOOK_JS" "$_OBS_SCRIPT"
