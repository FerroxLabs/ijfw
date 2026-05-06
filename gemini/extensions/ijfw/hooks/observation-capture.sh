#!/usr/bin/env bash
# IJFW observation-capture.sh (Gemini) -- captures AfterTool observations async.
# Called by after-tool.sh before emitting the terminal decision envelope.
# Never writes to stdout (Gemini reads stdout for decision JSON). Errors to stderr only.
#
# Gemini AfterTool stdin shape:
#   { "event": "AfterTool", "tool_name": "...", "tool_input": {...},
#     "tool_response": "...", "session_id": "...", "timestamp": "..." }
#
# Platform tag: "gemini"
# Invariant: decision:"allow" is ALWAYS from after-tool.sh; this script
# must never emit stdout (it runs in a detached bg process).

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0

REPO_ROOT="${IJFW_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../../.." && pwd)}"
CAPTURE="$REPO_ROOT/scripts/observation/capture.js"
[ -f "$CAPTURE" ] || exit 0

INPUT=$(head -c 1048576 2>/dev/null)  # 1MB cap -- matches user-prompt-submit-capture.sh
[ -z "$INPUT" ] && exit 0

# Normalize Gemini's "tool_name" field to match capture.js expectation.
# Gemini uses tool_name; Claude uses tool_name too -- no adapter needed.
mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
export IJFW_PLATFORM=gemini
# NOTE: do NOT add `</dev/null` here. The pipe IS node's stdin;
# `</dev/null` would override it and node would receive an empty stream.
printf '%s' "$INPUT" | node "$CAPTURE" >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
disown $! 2>/dev/null || true

exit 0
