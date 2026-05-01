#!/usr/bin/env bash
# E4 -- universal disable switch.
[ "${IJFW_DISABLE:-}" = "1" ] && exit 0
# IJFW PreToolUse -- nudges Claude to use ijfw_run instead of Bash for
# commands known to produce large output that would flood the context window.
#
# Advisory only -- never blocks execution. Fires on Bash tool only.
# Matches against tool_input.command embedded in the PreToolUse JSON payload.

INPUT=$(head -c 1048576)
[ -z "$INPUT" ] && exit 0

# Only fire on Bash tool invocations
if ! echo "$INPUT" | grep -q '"tool_name"[[:space:]]*:[[:space:]]*"Bash"' 2>/dev/null; then
  exit 0
fi

MATCHED=""

# Test runners
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bnpm[[:space:]]+test\b' 2>/dev/null; then
  MATCHED="npm test"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bjest\b' 2>/dev/null; then
  MATCHED="jest"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bvitest\b' 2>/dev/null; then
  MATCHED="vitest"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bpytest\b' 2>/dev/null; then
  MATCHED="pytest"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bgo[[:space:]]+test\b' 2>/dev/null; then
  MATCHED="go test"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bnode[[:space:]]+--test\b' 2>/dev/null; then
  MATCHED="node --test"
fi

# Build tools
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bcargo[[:space:]]+(build|test)\b' 2>/dev/null; then
  MATCHED="cargo build/test"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bmake\b' 2>/dev/null; then
  MATCHED="make"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bgradle\b' 2>/dev/null; then
  MATCHED="gradle"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bmvn\b' 2>/dev/null; then
  MATCHED="mvn"
fi

# Bundlers / type-checkers
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\btsc[[:space:]]+--' 2>/dev/null; then
  MATCHED="tsc"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bwebpack\b' 2>/dev/null; then
  MATCHED="webpack"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bvite[[:space:]]+build\b' 2>/dev/null; then
  MATCHED="vite build"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\brollup\b' 2>/dev/null; then
  MATCHED="rollup"
fi

# Filesystem search -- grep -r and find from filesystem root only
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bgrep[[:space:]]+-[a-zA-Z]*r\b' 2>/dev/null; then
  MATCHED="grep -r"
fi
if echo "$INPUT" | grep -Eiq '"command"[[:space:]]*:[[:space:]]*"[^"]*\bfind[[:space:]]+/' 2>/dev/null; then
  MATCHED="find /"
fi

if [ -n "$MATCHED" ]; then
  cat <<EOF
<ijfw-sandbox-nudge>
Large output likely ($MATCHED). Consider using ijfw_run instead of Bash for this command to sandbox output and save context tokens.
</ijfw-sandbox-nudge>
EOF
fi

exit 0
