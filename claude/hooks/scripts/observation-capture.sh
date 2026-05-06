#!/usr/bin/env bash
# IJFW observation-capture.sh -- called ASYNC from post-tool-use.sh.
# Passes the PostToolUse or UserPromptSubmit JSON envelope to capture.js.
# Must complete fast and silently; never writes to stdout (that belongs to hook).
#
# Called as: observation-capture.sh <json_payload_as_arg>
# OR reads from ~/.ijfw/.last-hook-input when arg omitted.
#
# Invariant: this script runs after the trim envelope is emitted by
# post-tool-use.sh, so stdout order is guaranteed safe.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

REPO_ROOT="${IJFW_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
CAPTURE="$REPO_ROOT/scripts/observation/capture.js"
[ -f "$CAPTURE" ] || exit 0

# Payload is passed via arg 1 or stdin
if [ -n "${1:-}" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  # NOTE: do NOT add `</dev/null` here. The pipe IS node's stdin;
  # `</dev/null` would override it and node would receive an empty stream.
  printf '%s' "$1" | node "$CAPTURE" >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
  disown $! 2>/dev/null || true
else
  # no-op: stdin already consumed by parent; captured payload must come via arg
  exit 0
fi

exit 0
