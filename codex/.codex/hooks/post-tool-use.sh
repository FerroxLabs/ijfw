#!/usr/bin/env bash
# IJFW PostToolUse (Codex) -- trim tool output noise, capture error signals.
#
# Codex hook JSON in/out:
#   stdin:  { "event": "PostToolUse", "tool": "...", "tool_input": {...},
#             "tool_response": "...", "session_id": "..." }
#   stdout: nothing (exit 0 = pass through)
#
# PostToolUse in Codex also supports decision:"block" to abort tool calls,
# but IJFW does not block -- observation and trimming only.
#
# No set -e -- hooks must never crash Codex.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

mkdir -p "$HOME/.ijfw/logs" 2>/dev/null

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

command -v node >/dev/null 2>&1 || exit 0

# Extract tool_response text via node.
RESPONSE_TEXT=$(node -e '
  try {
    const p = JSON.parse(process.argv[1] || "{}");
    const r = p && p.tool_response;
    if (!r) { process.stdout.write(""); process.exit(0); }
    if (typeof r === "string") { process.stdout.write(r); process.exit(0); }
    const parts = [];
    for (const k of ["output", "stdout", "stderr", "text", "content", "result"]) {
      if (r[k] == null) continue;
      parts.push(typeof r[k] === "string" ? r[k] : JSON.stringify(r[k]));
    }
    process.stdout.write(parts.join("\n"));
  } catch { process.stdout.write(""); }
' -- "$INPUT")
[ -z "$RESPONSE_TEXT" ] && exit 0

# Signal capture -- error/failure detection, scoped to tool_response only.
mkdir -p .ijfw 2>/dev/null
FIRST_ERR=$(printf '%s' "$RESPONSE_TEXT" | grep -iE '^(ERROR|FATAL|CRITICAL)|(^|[[:space:]])(Error|Exception|Traceback)[[:space:]:]' 2>/dev/null | head -1 | cut -c1-200)
FIRST_FAIL=$(printf '%s' "$RESPONSE_TEXT" | grep -iE '\b(test(s)? failed|failed with|assertion (failed|error))\b' 2>/dev/null | head -1 | cut -c1-200)
if [ -n "$FIRST_ERR" ] || [ -n "$FIRST_FAIL" ]; then
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || TZ=UTC date +"%Y-%m-%dT%H:%M:%SZ")
  node -e '
    const fs = require("fs");
    const rec = { ts: process.argv[1], error: process.argv[2] || null, fail: process.argv[3] || null, platform: "codex" };
    try { fs.appendFileSync(".ijfw/.session-signals.jsonl", JSON.stringify(rec) + "\n"); } catch {}
  ' -- "$TS" "$FIRST_ERR" "$FIRST_FAIL" 2>/dev/null
fi

# Trim noise from tool_response.
# AWK_RC: pipeline is printf[0]|sed[1]|awk[2]|sed[3]; PIPESTATUS inside $() is
# not accessible outside, so redirect pipeline output to a temp file instead.
_CLEAN_TMP=$(mktemp 2>/dev/null || printf '/tmp/ijfw-clean.%s' "$$")
printf '%s' "$RESPONSE_TEXT" | sed -E '
  s/'"$(printf '\033')"'\[[0-9;]*[a-zA-Z]//g
  s/[[:space:]]+$//
' | awk '
  /^$/ { if (blank) next; blank=1; print; next }
  { blank=0; print }
' | sed -E '
  /^[[:space:]]*(PASS )/d
  /^[[:space:]]*\.\.\.\./d
  /^collecting/d
  /^[[:space:]]*npm (warn|notice)/d
  /^added [0-9]+ packages/d
  /^Requirement already satisfied/d
  /^Downloading /d
  /^Installing collected/d
' > "$_CLEAN_TMP"
AWK_RC="${PIPESTATUS[2]:-0}"
[ "$AWK_RC" != "0" ] && printf '%s [codex-post-tool-use] awk failed: rc=%s\n' "$(date -u +%FT%TZ)" "$AWK_RC" >>"$HOME/.ijfw/logs/codex-post-tool-use.log" 2>/dev/null
CLEANED=$(cat "$_CLEAN_TMP" 2>/dev/null)
rm -f "$_CLEAN_TMP" 2>/dev/null

LINE_COUNT=$(printf '%s\n' "$CLEANED" | wc -l | tr -d ' ')
if [ "${LINE_COUNT:-0}" -gt 500 ]; then
  HEAD_PART=$(printf '%s\n' "$CLEANED" | head -250)
  TAIL_PART=$(printf '%s\n' "$CLEANED" | tail -50)
  CLEANED=$(printf '[ijfw] trimmed %s lines -> head 250 + tail 50\n\n%s\n\n%s\n' \
    "$LINE_COUNT" "$HEAD_PART" "$TAIL_PART")
fi

# Dispatch observation capture ASYNC before emitting the terminal envelope.
# Invariant: envelope must be the TERMINAL stdout line.
_OBS_CAPTURE="$(dirname "$0")/observation-capture.sh"
if [ -f "$_OBS_CAPTURE" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  printf '%s' "$INPUT" | bash "$_OBS_CAPTURE" \
    >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# Codex renders PostToolUse stdout as injected hook context/warnings. Stay
# silent: the agent already receives the original tool output, while IJFW keeps
# local observation + failure signals above.
exit 0
