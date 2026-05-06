#!/usr/bin/env bash
# IJFW observation-capture.sh (Codex) -- captures PostToolUse observations async.
# Called by post-tool-use.sh before emitting the terminal envelope.
# Never writes to stdout. Errors to stderr only.
#
# Usage: printf '%s' "$PAYLOAD" | observation-capture.sh
# Platform tag: "codex"

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

REPO_ROOT="${IJFW_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
CAPTURE="$REPO_ROOT/scripts/observation/capture.js"
[ -f "$CAPTURE" ] || exit 0

INPUT=$(head -c 262144 2>/dev/null)
[ -z "$INPUT" ] && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
export IJFW_PLATFORM=codex
printf '%s' "$INPUT" | node "$CAPTURE" >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
disown $! 2>/dev/null || true

exit 0
