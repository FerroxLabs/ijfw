#!/usr/bin/env bash
# IJFW SessionStart (Codex) -- initialize state, emit banner, register project.
# Codex hook JSON in/out: reads JSON payload on stdin, writes JSON response on stdout.
# Payload: { "event": "SessionStart", "session_id": "...", "cwd": "..." }
# Response: { "continue": true, "systemMessage": "..." }  (optional)
#
# No set -e -- hooks must never crash Codex.

[ "${IJFW_DISABLE:-}" = "1" ] && exit 0

IJFW_DIR=".ijfw"
IJFW_GLOBAL="$HOME/.ijfw"

# 1.1.6: cross-platform parity -- fire detached background update-check.
# Reuses the Claude-tree script (same logic across platforms). Wrapped in
# fire-and-forget so Codex's session-start ceiling stays clean.
mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
IJFW_CHECK_UPDATE_SH="$HOME/.ijfw/claude/hooks/scripts/ijfw-check-update.sh"
if [ -x "$IJFW_CHECK_UPDATE_SH" ]; then
  "$IJFW_CHECK_UPDATE_SH" </dev/null >>"$HOME/.ijfw/logs/update-check.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# Read stdin payload (best-effort).
HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi

# Pre-flight: .ijfw must be a directory if it exists.
if [ -e "$IJFW_DIR" ] && [ ! -d "$IJFW_DIR" ]; then
  printf '{"continue":true,"systemMessage":"[ijfw] .ijfw is a file here -- IJFW needs it as a directory. Rename or remove it, then start a new session."}\n'
  exit 0
fi

mkdir -p "$IJFW_DIR/memory" "$IJFW_DIR/sessions" "$IJFW_DIR/index" 2>/dev/null
mkdir -p "$IJFW_GLOBAL/memory" 2>/dev/null

# Project registry -- append on first sight.
REGISTRY_FILE="$IJFW_GLOBAL/registry.md"
PROJECT_PATH=$(pwd -P 2>/dev/null)
if [ -n "$PROJECT_PATH" ]; then
  if [ ! -f "$REGISTRY_FILE" ] || ! grep -qF "$PROJECT_PATH |" "$REGISTRY_FILE" 2>/dev/null; then
    REG_HASH=$(printf '%s' "$PROJECT_PATH" | shasum 2>/dev/null | cut -c1-12)
    REG_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || TZ=UTC date +%Y-%m-%dT%H:%M:%SZ)
    if [ -n "$REG_HASH" ] && [ -n "$REG_ISO" ]; then
      printf '%s | %s | %s\n' "$PROJECT_PATH" "$REG_HASH" "$REG_ISO" >> "$REGISTRY_FILE" 2>/dev/null
    fi
  fi
fi

# Reset session-scoped state.
: > "$IJFW_DIR/.startup-flags" 2>/dev/null
: > "$IJFW_DIR/.migration-msgs" 2>/dev/null
: > "$IJFW_DIR/.detection" 2>/dev/null

MODE="${IJFW_MODE:-smart}"

# Count memory entries for banner.
MEMORY_COUNT=0
if [ -f "$IJFW_DIR/memory/project-journal.md" ]; then
  MEMORY_COUNT=$(grep -c '^- \[' "$IJFW_DIR/memory/project-journal.md" 2>/dev/null || true)
  [ -z "$MEMORY_COUNT" ] && MEMORY_COUNT=0
fi

# Startup flags (for use by other hooks this session).
printf 'IJFW_MODE=%s\n' "$MODE" >> "$IJFW_DIR/.startup-flags" 2>/dev/null

# Check for startup flags from prior session (consolidate trigger, etc.).
CONSOLIDATE_HINT=""
if grep -q "IJFW_NEEDS_CONSOLIDATE=1" "$IJFW_DIR/.startup-flags" 2>/dev/null; then
  CONSOLIDATE_HINT="1"
fi

# Build warm banner matching Claude format. No diagnostics, no routing label.
BANNER="$(printf '[ijfw] %s mode' "$(printf '%s' "$MODE" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')")"
if [ "$MEMORY_COUNT" -gt 0 ]; then
  BANNER="$BANNER
[ijfw] Memory loaded ($MEMORY_COUNT things remembered)"
fi
if [ -n "$CONSOLIDATE_HINT" ]; then
  BANNER="$BANNER
[ijfw] Run: ijfw consolidate"
fi
BANNER="$BANNER
[ijfw] Ready. Memory loaded. Dashboard at http://localhost:37891"

# Render dashboard async (does not block or affect stdout envelope).
_DASH_SCRIPT="$(dirname "$0")/session-start-dashboard.sh"
if [ -f "$_DASH_SCRIPT" ]; then
  bash "$_DASH_SCRIPT" >>"$HOME/.ijfw/logs/dashboard.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# Build memory context for injection (D-F4: mirrors Gemini approach).
MEM_CONTEXT=""
KB_FILE="$IJFW_DIR/memory/knowledge.md"
HANDOFF_FILE="$IJFW_DIR/memory/handoff.md"
if [ -s "$KB_FILE" ] || [ -s "$HANDOFF_FILE" ]; then
  MEM_CONTEXT="<ijfw-memory>
Project memory at .ijfw/memory/. Call \`ijfw_memory_prelude\` for full context."
  if [ -s "$HANDOFF_FILE" ]; then
    LAST_HANDOFF=$(grep -v '^<!-- ijfw' "$HANDOFF_FILE" | grep -v '^$' | head -2)
    [ -n "$LAST_HANDOFF" ] && MEM_CONTEXT="$MEM_CONTEXT

Last handoff: $LAST_HANDOFF"
  fi
  MEM_CONTEXT="$MEM_CONTEXT
</ijfw-memory>"
fi

# Emit Codex-format JSON response.
command -v node >/dev/null 2>&1 || { printf '{"continue":true,"systemMessage":"%s"}\n' "$BANNER"; exit 0; }
node -e '
  const banner = process.argv[1] || "[ijfw] Ready";
  const mem = process.argv[2] || "";
  const out = { "continue": true, "systemMessage": banner };
  if (mem) out.additionalContext = mem;
  process.stdout.write(JSON.stringify(out) + "\n");
' "$BANNER" "$MEM_CONTEXT" 2>/dev/null || printf '{"continue":true,"systemMessage":"%s"}\n' "$BANNER"

exit 0
