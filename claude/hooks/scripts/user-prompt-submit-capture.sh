#!/usr/bin/env bash
# IJFW user-prompt-submit-capture.sh -- captures session-request observations
# from UserPromptSubmit hook events.
# Reads hook JSON from stdin, fires capture.js async.
# Never blocks, never writes to stdout (Claude sees stdout as hook output).

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

INPUT=$(head -c 65536 2>/dev/null)
[ -z "$INPUT" ] && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
printf '%s' "$INPUT" | node "$CAPTURE" 2>>"$HOME/.ijfw/logs/obs-capture.log" &
disown $! 2>/dev/null || true

exit 0
