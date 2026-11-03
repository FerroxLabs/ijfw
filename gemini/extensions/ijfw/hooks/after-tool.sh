#!/usr/bin/env bash
# IJFW AfterTool (Gemini) -- maps Claude's PostToolUse / post-tool-use.sh.
# Trims tool output noise, captures ERROR/FAIL signals into
# .ijfw/.session-signals.jsonl, emits cleaned output as additionalContext.
#
# Gemini hook JSON in/out:
#   stdin:  { "event": "AfterTool", "tool_name": "...", "tool_input": {...},
#             "tool_response": "...", "session_id": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }  OR  { "decision": "allow", "additionalContext": "..." }
#
# No set -e -- hooks must never crash Gemini CLI.

[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

IJFW_DIR=".ijfw"
FLAGS_FILE="$IJFW_DIR/.startup-flags"

if [ -f "$FLAGS_FILE" ]; then
  grep -q "IJFW_RTK_ACTIVE=1" "$FLAGS_FILE" 2>/dev/null && printf '{"decision":"allow"}\n' && exit 0
  grep -q "IJFW_CONTEXT_MODE_ACTIVE=1" "$FLAGS_FILE" 2>/dev/null && printf '{"decision":"allow"}\n' && exit 0
fi

INPUT=$(head -c 1048576 2>/dev/null)
[ -z "$INPUT" ] && printf '{"decision":"allow"}\n' && exit 0

command -v node >/dev/null 2>&1 || { printf '{"decision":"allow"}\n'; exit 0; }

# Extract tool_response text.
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
' "$INPUT")
[ -z "$RESPONSE_TEXT" ] && printf '{"decision":"allow"}\n' && exit 0

# Signal capture.
mkdir -p .ijfw 2>/dev/null
FIRST_ERR=$(printf '%s' "$RESPONSE_TEXT" | grep -iE '^(ERROR|FATAL|CRITICAL)|(^|[[:space:]])(Error|Exception|Traceback)[[:space:]:]' 2>/dev/null | head -1 | cut -c1-200)
FIRST_FAIL=$(printf '%s' "$RESPONSE_TEXT" | grep -iE '\b(test(s)? failed|failed with|assertion (failed|error))\b' 2>/dev/null | head -1 | cut -c1-200)
if [ -n "$FIRST_ERR" ] || [ -n "$FIRST_FAIL" ]; then
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || TZ=UTC date +"%Y-%m-%dT%H:%M:%SZ")
  # Redact tool-output snippets (FerroxLabs/ijfw#31); fail closed.
  _REDACTOR=""
  for _cand in "${IJFW_PLUGIN_ROOT:-}" "$( [ -f "$(dirname "$0")/.ijfw-root" ] && head -n 1 "$(dirname "$0")/.ijfw-root" 2>/dev/null)" "${IJFW_HOME:-}" "$HOME/.ijfw"; do
    if [ -n "$_cand" ] && [ -f "$_cand/scripts/observation/redact.js" ]; then _REDACTOR="$_cand/scripts/observation/redact.js"; break; fi
  done
  node --input-type=module -e '
    import { appendFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const [ts, err, fail, redactorPath] = process.argv.slice(1);
    let R = null;
    try { if (redactorPath) R = (await import(pathToFileURL(redactorPath).href)).redactObservationText; } catch {}
    const clean = (v) => (!v ? null : (R ? R(v) : "[redacted: redactor unavailable]"));
    const rec = { ts, error: clean(err), fail: clean(fail) };
    try { appendFileSync(".ijfw/.session-signals.jsonl", JSON.stringify(rec) + "\n", { mode: 0o600 }); } catch {}
  ' "$TS" "$FIRST_ERR" "$FIRST_FAIL" "$_REDACTOR" 2>/dev/null
fi

# Trim noise.
CLEANED=$(printf '%s' "$RESPONSE_TEXT" | sed -E '
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
')

LINE_COUNT=$(printf '%s\n' "$CLEANED" | wc -l | tr -d ' ')
if [ "${LINE_COUNT:-0}" -gt 500 ]; then
  HEAD_PART=$(printf '%s\n' "$CLEANED" | head -250)
  TAIL_PART=$(printf '%s\n' "$CLEANED" | tail -50)
  CLEANED=$(printf '[ijfw] trimmed %s lines -> head 250 + tail 50\n\n%s\n\n%s\n' \
    "$LINE_COUNT" "$HEAD_PART" "$TAIL_PART")
fi

# Dispatch observation capture ASYNC before emitting the terminal decision envelope.
# Invariant: decision:"allow" must be the TERMINAL stdout line.
# Never emit decision:"deny" from observation capture -- it would block the tool call.
_OBS_CAPTURE="$(dirname "$0")/observation-capture.sh"
if [ -f "$_OBS_CAPTURE" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
  printf '%s' "$INPUT" | bash "$_OBS_CAPTURE" \
    >>"$HOME/.ijfw/logs/obs-capture.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

node -e '
  const out = process.argv[1] || "";
  process.stdout.write(JSON.stringify({ decision: "allow", additionalContext: out }) + "\n");
' "$CLEANED" 2>/dev/null || printf '{"decision":"allow"}\n'

exit 0
