#!/usr/bin/env bash
# Quick MCP server health probe -- initialize handshake + ping. Exits 0 healthy,
# 1 if the launcher won't run, 2 if the protocol handshake fails.
# Used by doctor.sh to surface a positive "Memory ready" line OR a
# Donahoe-P7 actionable green path when the server can't start.

LAUNCHER="${1:-}"
[ -z "$LAUNCHER" ] && LAUNCHER="$(dirname "$0")/../mcp-server/bin/ijfw-memory"

if [ ! -x "$LAUNCHER" ]; then
  exit 1
fi

# Pipe an initialize request and a ping; expect two valid responses on stdout.
# 1.5s timeout -- generous given normal startup is sub-100ms. The timeout is a
# pure-bash watchdog (portable: macOS has no coreutils `timeout`) that kills
# the launcher pid directly, so a server that wedges before responding -- or
# answers but never exits on stdin EOF -- cannot hang this probe (or doctor.sh)
# forever. Output goes to a temp file, not a command substitution, so nothing
# blocks on a pipe held open by a stuck process.
TMP_OUT="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/ijfw-mcp-probe.$$")"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}'
  sleep 0.3
} | "$LAUNCHER" > "$TMP_OUT" 2>/dev/null &
SERVER_PID=$!   # $! after a backgrounded pipeline = the last member (the launcher)
(
  sleep 1.5
  kill "$SERVER_PID" 2>/dev/null
  sleep 0.3
  kill -9 "$SERVER_PID" 2>/dev/null
) >/dev/null 2>&1 &
WATCHDOG_PID=$!
{ wait "$SERVER_PID"; } 2>/dev/null
kill "$WATCHDOG_PID" 2>/dev/null
{ wait "$WATCHDOG_PID"; } 2>/dev/null   # reap quietly (no "Terminated" notice)

RESULT="$(head -2 "$TMP_OUT" 2>/dev/null)"
rm -f "$TMP_OUT"

if printf '%s' "$RESULT" | grep -q '"id":1' && printf '%s' "$RESULT" | grep -q '"id":2'; then
  exit 0
fi
exit 2
