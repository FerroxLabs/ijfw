#!/usr/bin/env bash
# IJFW PreToolUse (Codex) -- scans the about-to-run command for destructive patterns.
# Injects a verification reminder via hook-specific additionalContext. Never blocks execution.
#
# Codex hook JSON in/out:
#   stdin:  { "event": "PreToolUse", "tool": "...", "tool_input": {...}, "session_id": "..." }
#   stdout: { "continue": true,
#             "hookSpecificOutput": { "hookEventName": "PreToolUse",
#                                     "additionalContext": "..." } }
#            OR nothing (exit 0 with no output = pass through)
#
# No set -e -- hooks must never crash Codex.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

DETECTED=""

# Destructive filesystem.
if echo "$INPUT" | grep -Eiq '\brm[[:space:]]+(-[rRf]+[[:space:]]+)+(/|\$|~)' 2>/dev/null; then
  DETECTED="${DETECTED}Recursive delete at a top-level path. Verify target before confirming. | "
fi
if echo "$INPUT" | grep -Eiq '\brm[[:space:]]+-rf[[:space:]]+\*' 2>/dev/null; then
  DETECTED="${DETECTED}Glob-wildcard recursive delete. Confirm scope. | "
fi

# Git dangers.
if echo "$INPUT" | grep -Eiq '\bgit[[:space:]]+push[[:space:]]+(-[a-zA-Z]*f|--force|-f[[:space:]])' 2>/dev/null; then
  DETECTED="${DETECTED}Force push detected. Confirm branch and remote before proceeding. | "
fi
if echo "$INPUT" | grep -Eiq '\bgit[[:space:]]+reset[[:space:]]+--hard' 2>/dev/null; then
  DETECTED="${DETECTED}Hard reset will discard uncommitted changes. Confirm HEAD target. | "
fi
if echo "$INPUT" | grep -Eiq '\bgit[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fdx]' 2>/dev/null; then
  DETECTED="${DETECTED}git clean removes untracked files permanently. Confirm list first with -n. | "
fi

# Database dangers.
if echo "$INPUT" | grep -Eiq '\b(drop|truncate)[[:space:]]+(table|database|schema)\b' 2>/dev/null; then
  DETECTED="${DETECTED}Destructive DB operation (DROP/TRUNCATE). Confirm target and backup. | "
fi
if echo "$INPUT" | grep -Eiq '\bdelete[[:space:]]+from[[:space:]]+[a-z_]+[[:space:]]*(;|$)' 2>/dev/null; then
  DETECTED="${DETECTED}DELETE without WHERE clause. Confirm this is intended. | "
fi

# Shell dangers.
if echo "$INPUT" | grep -Eiq ':\(\)\{.*;:\|:&\};:' 2>/dev/null; then
  DETECTED="${DETECTED}Fork bomb pattern. Do not execute. | "
fi
if echo "$INPUT" | grep -Eiq '\bchmod[[:space:]]+-R[[:space:]]+777' 2>/dev/null; then
  DETECTED="${DETECTED}chmod -R 777 grants world write. Use tighter permissions. | "
fi

# Package/dependency danger.
if echo "$INPUT" | grep -Eiq '\bnpm[[:space:]]+publish\b' 2>/dev/null; then
  DETECTED="${DETECTED}npm publish goes to the registry. Confirm version bump and scope. | "
fi

if [ -n "$DETECTED" ]; then
  MSG="[ijfw] Confirm before proceeding: ${DETECTED% | }"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const msg = process.argv[1] || "";
      process.stdout.write(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: msg
        }
      }) + "\n");
    ' -- "$MSG" 2>/dev/null
  fi
fi

exit 0
