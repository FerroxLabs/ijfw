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
#     T11: sentinel written via `ijfw state:event.emit` (SDK route) rather than
#     a direct bash redirect. The local file check is a fast read-only guard;
#     the authoritative idempotency key is the SDK dedupKey.
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

# T11: Resolve the cli-run.js shim path (same candidates as session-start.sh).
# Fail-open: if node or the shim is absent, fall back to the legacy direct write.
_NODE=""
if command -v node >/dev/null 2>&1; then
  _NODE="$(command -v node)"
else
  for _nc in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node"/*/bin/node "$HOME/.volta/bin/node" /usr/bin/node; do
    for _nr in $_nc; do [ -x "$_nr" ] && { _NODE="$_nr"; break 2; }; done
  done
fi
_IJFW_CLI_RUN=""
_HOOK_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
for _cand in \
    "${GEMINI_PLUGIN_ROOT:-}/mcp-server/src/cli-run.js" \
    "$HOME/.ijfw/mcp-server/src/cli-run.js" \
    "$_HOOK_DIR/../../../../mcp-server/src/cli-run.js"; do
  if [ -f "$_cand" ]; then _IJFW_CLI_RUN="$_cand"; break; fi
done

# Mark state via SDK route (event.emit, dedupKey = per-session idempotency key).
# Fail-open on every step: the hook MUST NOT crash Gemini CLI.
if [ -n "$_NODE" ] && [ -n "$_IJFW_CLI_RUN" ]; then
  _DEDUP_KEY="compute-nudge:${SESSION_ID}"
  _PROJECT_ROOT="${IJFW_PROJECT_DIR:-$(pwd -P 2>/dev/null || echo .)}"
  _PAYLOAD="{\"subagentId\":\"compute-nudge\",\"waveId\":\"hooks\",\"eventType\":\"compute-nudge\",\"data\":{\"session\":\"${SESSION_ID}\",\"match\":\"${MATCHED}\",\"tool\":\"${TOOL_NAME}\"},\"dedupKey\":\"${_DEDUP_KEY}\"}"
  if "$_NODE" "$_IJFW_CLI_RUN" "state:event.emit" "$_PAYLOAD" \
      --project-root "$_PROJECT_ROOT" >/dev/null 2>&1; then
    # SDK write succeeded: create the local sentinel for fast-path reads.
    mkdir -p "$STATE_DIR" 2>/dev/null
    ( set -C; : > "$STATE_FILE" ) 2>/dev/null || true
  else
    # SDK unavailable or errored: fall back to direct sentinel write.
    mkdir -p "$STATE_DIR" 2>/dev/null
    if ! ( set -C; : > "$STATE_FILE" ) 2>/dev/null; then
      printf '{"decision":"allow"}\n'
      exit 0
    fi
  fi
else
  # No node / no shim: legacy direct sentinel write (fail-open fallback).
  mkdir -p "$STATE_DIR" 2>/dev/null
  if ! ( set -C; : > "$STATE_FILE" ) 2>/dev/null; then
    printf '{"decision":"allow"}\n'
    exit 0
  fi
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
