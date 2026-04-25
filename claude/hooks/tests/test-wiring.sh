#!/usr/bin/env bash
# Assert each hook event's command points to the matching script name.
set -euo pipefail
cd "$(dirname "$0")/../../.."

FAILED=0
assert_event() {
  local event="$1" want_script="$2"
  local got
  got=$(node -e "
    const h = JSON.parse(require('fs').readFileSync('claude/hooks/hooks.json','utf8'));
    const entry = (h.hooks['$event']||[])[0]?.hooks?.[0]?.command || '';
    const m = entry.match(/scripts\/([a-z0-9.-]+\.sh)/);
    process.stdout.write(m ? m[1] : '');
  ")
  if [ "$got" != "$want_script" ]; then
    echo "  ✗ $event → expected scripts/$want_script, got scripts/${got:-<none>}" >&2
    FAILED=$((FAILED+1))
  else
    echo "  [ok] $event → scripts/$got"
  fi
}

echo "=== Hook wiring ==="
assert_event "SessionStart"     "session-start.sh"
assert_event "PreCompact"       "pre-compact.sh"
assert_event "Stop"             "session-end.sh"
assert_event "PreToolUse"       "pre-tool-use.sh"
assert_event "PostToolUse"      "post-tool-use.sh"
assert_event "UserPromptSubmit" "pre-prompt.sh"

[ $FAILED -eq 0 ]
