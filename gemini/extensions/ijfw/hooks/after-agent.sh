#!/usr/bin/env bash
# IJFW AfterAgent (Gemini) -- post-agent cleanup.
# Flushes signal files, updates session state after a subagent completes.
#
# Gemini hook JSON in/out:
#   stdin:  { "event": "AfterAgent", "session_id": "...", "cwd": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }
#
# No set -e -- hooks must never crash Gemini CLI.

[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

IJFW_DIR=".ijfw"

# Flush any pending signal files from the subagent's run.
# These accumulate during execution and are consumed by session-end.
# Nothing to actively flush -- files are append-only; just ensure dirs exist.
mkdir -p "$IJFW_DIR/sessions" "$IJFW_DIR/memory" 2>/dev/null

# 1.1.6 cross-platform status card -- one-line update nudge after each agent
# turn. Best-effort: silent on any failure; never breaks the response.
# (Context % omitted on Gemini -- the AfterAgent payload doesn't expose it.)
STATUS_CARD=""
if command -v node >/dev/null 2>&1; then
  STATUS_CARD_JS="$HOME/.ijfw/mcp-server/src/lib/status-card.js"
  if [ -f "$STATUS_CARD_JS" ]; then
    STATUS_CARD=$(node -e '
      try {
        const { composeStatusCard } = await import(process.argv[1]);
        const card = composeStatusCard();
        if (card) process.stdout.write(card);
      } catch {}
    ' "$STATUS_CARD_JS" 2>/dev/null)
  fi
fi

if [ -n "$STATUS_CARD" ]; then
  printf '{"decision":"allow","additionalContext":"%s"}\n' "$STATUS_CARD"
else
  printf '{"decision":"allow"}\n'
fi
exit 0
