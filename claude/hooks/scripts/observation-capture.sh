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

# Locate the IJFW checkout that holds capture.js: IJFW_PLUGIN_ROOT, the
# checkout this plugin lives in (~/.ijfw/claude/hooks/scripts/../../..),
# IJFW_HOME, then ~/.ijfw. Each candidate must be a real IJFW checkout
# (capture.js + the redactor it imports) -- a plugin-cache copy outside
# ~/.ijfw falls through to ~/.ijfw instead of silently skipping capture.
_ijfw_root_ok() { [ -n "$1" ] && [ -f "$1/scripts/observation/capture.js" ] && [ -f "$1/mcp-server/src/redactor.js" ]; }
REPO_ROOT=""
for _cand in "${IJFW_PLUGIN_ROOT:-}" "$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)" "${IJFW_HOME:-}" "$HOME/.ijfw"; do
  if _ijfw_root_ok "$_cand"; then REPO_ROOT="$_cand"; break; fi
done
[ -n "$REPO_ROOT" ] || exit 0
CAPTURE="$REPO_ROOT/scripts/observation/capture.js"

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
