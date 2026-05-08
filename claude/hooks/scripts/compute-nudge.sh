#!/usr/bin/env bash
# IJFW v1.3.0 alpha -- Claude PreToolUse compute-nudge.
#
# Spec: .planning/1.3.0/PLAN-alpha.md (Phase 1, W1C).
#
# Advisory only -- never blocks execution. Once per session, when the agent is
# about to read a likely-large file or run a data-processing shell command,
# emit a one-line suggestion to consider `ijfw_run compute:python` instead.
#
# Discipline:
#   - Async non-blocking; ASCII only; positive framing; <=50ms wall-clock.
#   - Heavy work (FTS5 lookups, logging) lives in a detached subprocess.
#   - One nudge per session: state file at ~/.ijfw/state/<session_id>.compute-nudged.
#   - Silent on errors -- hook MUST NOT crash Claude Code.
#
# Universal disable switch (matches sibling hooks).
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

# Read at most 1 MiB from stdin to keep wall-clock bounded.
INPUT=$(head -c 1048576 2>/dev/null)
[ -z "$INPUT" ] && exit 0

# Resolve session id (Claude Code includes it in PreToolUse payload). Fall
# back to a stable per-process token so we still nudge once per cold run.
SESSION_ID=$(printf '%s' "$INPUT" \
  | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' \
  | head -1 \
  | sed -E 's/.*"([^"]+)"$/\1/' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="anon-$$"

# Per-feedback_home_symlink_gotcha: canonicalize HOME via cd -P so the state
# file path equality works on macOS where /var symlinks to /private/var.
HOME_REAL=$(cd -P "$HOME" 2>/dev/null && pwd)
[ -z "$HOME_REAL" ] && HOME_REAL="$HOME"
STATE_DIR="$HOME_REAL/.ijfw/state"
STATE_FILE="$STATE_DIR/${SESSION_ID}.compute-nudged"

# Already nudged this session -- silent allow.
[ -f "$STATE_FILE" ] && exit 0

# --- Detection (regex-only, single-pass per probe; cheap) ---
TOOL_NAME=$(printf '%s' "$INPUT" \
  | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
  | head -1 \
  | sed -E 's/.*"([^"]+)"$/\1/' 2>/dev/null)

MATCHED=""

case "$TOOL_NAME" in
  Read)
    # Likely-large file extensions in the file_path.
    if printf '%s' "$INPUT" \
        | grep -Eiq '"file_path"[[:space:]]*:[[:space:]]*"[^"]*\.(log|csv|jsonl|ndjson|tsv|parquet)"' 2>/dev/null; then
      MATCHED="reading a data file"
    fi
    ;;
  Bash)
    # Patterns known to flood context with grep/find/cat/tail loops.
    if printf '%s' "$INPUT" \
        | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\b(find[[:space:]]+\.[[:space:]]+-name|grep[[:space:]]+-r|cat[[:space:]]+[^"]*\*\.log|tail[[:space:]]+-f)\b' 2>/dev/null; then
      MATCHED="scanning files"
    fi
    ;;
esac

# Nothing matched -- silent allow.
[ -z "$MATCHED" ] && exit 0

# Mark state synchronously so a fast follow-up tool call cannot double-fire.
# M7: atomic CAS via noclobber. (set -C; : > "$STATE_FILE") is create-or-fail
# at the kernel level, closing the read-then-write TOCTOU window where two
# near-simultaneous PreToolUse fires could both pass the [-f $STATE_FILE]
# guard. If create fails, another fire claimed it -- silent allow.
mkdir -p "$STATE_DIR" 2>/dev/null
if ! ( set -C; : > "$STATE_FILE" ) 2>/dev/null; then
  printf '{}\n'
  exit 0
fi

# Emit hookSpecificOutput JSON envelope -- additive, never blocks.
# Positive framing per Sutherland; ASCII only.
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<ijfw-compute-nudge>\nHeads-up: this looks like data processing. Consider `ijfw_run compute:python` (sandboxed, output indexed in FTS5) so you can search results later instead of replaying the read.\n</ijfw-compute-nudge>"}}
EOF

# Detached background log -- crashes surface in ~/.ijfw/logs/compute-nudge.log,
# nothing here can block stdout closure.
{
  mkdir -p "$HOME_REAL/.ijfw/logs" 2>/dev/null
  printf '%s session=%s match=%s tool=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)" \
    "$SESSION_ID" "$MATCHED" "$TOOL_NAME" \
    >> "$HOME_REAL/.ijfw/logs/compute-nudge.log" 2>/dev/null
} </dev/null >/dev/null 2>&1 &
disown $! 2>/dev/null || true

exit 0
