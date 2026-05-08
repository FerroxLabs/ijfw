#!/usr/bin/env bash
# IJFW v1.3.0 alpha -- Gemini BeforeTool compute-nudge.
#
# Spec: .planning/1.3.0/PLAN-alpha.md (Phase 1, W1C). Mirrors
# claude/hooks/scripts/compute-nudge.sh but emits Gemini's hook envelope.
#
# Gemini hook JSON in/out:
#   stdin:  { "event": "BeforeTool", "tool_name": "...", "tool_input": {...},
#             "session_id": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }
#       OR  { "decision": "allow", "additionalContext": "..." }
#
# Discipline:
#   - Async non-blocking; ASCII only; positive framing; <=50ms wall-clock.
#   - Heavy work (logging) runs in a detached subprocess.
#   - One nudge per session; state file at ~/.ijfw/state/<session_id>.compute-nudged.
#   - Silent on errors -- hook MUST NEVER crash Gemini CLI.
#
# Universal disable switch (matches sibling Gemini hooks).
[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

INPUT=$(head -c 1048576 2>/dev/null)
[ -z "$INPUT" ] && printf '{"decision":"allow"}\n' && exit 0

SESSION_ID=$(printf '%s' "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
  | head -1 \
  | sed -E 's/.*"([^"]+)"$/\1/' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="anon-$$"

# Canonicalize HOME (feedback_home_symlink_gotcha).
HOME_REAL=$(cd -P "$HOME" 2>/dev/null && pwd)
[ -z "$HOME_REAL" ] && HOME_REAL="$HOME"
STATE_DIR="$HOME_REAL/.ijfw/state"
STATE_FILE="$STATE_DIR/${SESSION_ID}.compute-nudged"

# Already nudged -- silent allow.
if [ -f "$STATE_FILE" ]; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

TOOL_NAME=$(printf '%s' "$INPUT" \
  | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
  | head -1 \
  | sed -E 's/.*"([^"]+)"$/\1/' 2>/dev/null)

MATCHED=""

case "$TOOL_NAME" in
  read_file|read_many_files)
    if printf '%s' "$INPUT" \
        | grep -Eiq '"(absolute_path|path|file_path)"[[:space:]]*:[[:space:]]*"[^"]*\.(log|csv|jsonl|ndjson|tsv|parquet)"' 2>/dev/null; then
      MATCHED="reading a data file"
    fi
    ;;
  run_shell_command)
    if printf '%s' "$INPUT" \
        | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\b(find[[:space:]]+\.[[:space:]]+-name|grep[[:space:]]+-r|cat[[:space:]]+[^"]*\*\.log|tail[[:space:]]+-f)\b' 2>/dev/null; then
      MATCHED="scanning files"
    fi
    ;;
esac

if [ -z "$MATCHED" ]; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

# M7: atomic CAS via noclobber. Closes the read-then-write TOCTOU window
# between [-f $STATE_FILE] above and this write. If another concurrent fire
# claims the file first, fall through to a plain allow.
mkdir -p "$STATE_DIR" 2>/dev/null
if ! ( set -C; : > "$STATE_FILE" ) 2>/dev/null; then
  printf '{"decision":"allow"}\n'
  exit 0
fi

# M4: emit the static envelope via printf -- no node spawn -> <10ms cold start.
# JSON is hand-encoded (single-line, ASCII-only) so escaping stays correct.
# Backticks and newlines in additionalContext are encoded as \n + literal.
printf '%s\n' '{"decision":"allow","additionalContext":"<ijfw-compute-nudge>\nHeads-up: this looks like data processing. Consider `ijfw_run compute:python` (sandboxed, output indexed in FTS5) so you can search results later instead of replaying the read.\n</ijfw-compute-nudge>"}'

# Detached background log.
{
  mkdir -p "$HOME_REAL/.ijfw/logs" 2>/dev/null
  printf '%s session=%s match=%s tool=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)" \
    "$SESSION_ID" "$MATCHED" "$TOOL_NAME" \
    >> "$HOME_REAL/.ijfw/logs/compute-nudge.log" 2>/dev/null
} </dev/null >/dev/null 2>&1 &
disown $! 2>/dev/null || true

exit 0
