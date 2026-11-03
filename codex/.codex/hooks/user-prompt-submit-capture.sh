#!/usr/bin/env bash
# IJFW user-prompt-submit-capture.sh (Codex) -- captures session-request observations
# from UserPromptSubmit hook events. Reads hook JSON from stdin, fires capture.js async.
# Never blocks, never writes to stdout.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

# Locate the IJFW checkout that holds capture.js. Order: IJFW_PLUGIN_ROOT
# (explicit), the installer-written .ijfw-root marker next to this script,
# IJFW_HOME, then ~/.ijfw. No ../../.. traversal: from an installed hook dir
# that lands OUTSIDE IJFW (on macOS ~/.codex/hooks/../../.. is /Users), and a
# look-alike scripts/observation/capture.js there must never be executed.
# A candidate counts only if it carries both capture.js and the shared
# redactor capture.js imports. Quoted throughout: paths may contain spaces.
_ijfw_root_ok() { [ -n "$1" ] && [ -f "$1/scripts/observation/capture.js" ] && [ -f "$1/mcp-server/src/redactor.js" ]; }
_IJFW_MARKER="$(dirname "$0")/.ijfw-root"
_IJFW_MARKED=""
[ -f "$_IJFW_MARKER" ] && _IJFW_MARKED=$(head -n 1 "$_IJFW_MARKER" 2>/dev/null)
REPO_ROOT=""
for _cand in "${IJFW_PLUGIN_ROOT:-}" "$_IJFW_MARKED" "${IJFW_HOME:-}" "$HOME/.ijfw"; do
  if _ijfw_root_ok "$_cand"; then REPO_ROOT="$_cand"; break; fi
done
[ -n "$REPO_ROOT" ] || exit 0
CAPTURE="$REPO_ROOT/scripts/observation/capture.js"

INPUT=$(head -c 262144 2>/dev/null)
[ -z "$INPUT" ] && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
export IJFW_PLATFORM=codex
printf '%s' "$INPUT" | node "$CAPTURE" >>"$HOME/.ijfw/logs/user-prompt-submit.log" 2>&1 &
disown $! 2>/dev/null || true

exit 0
