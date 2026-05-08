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

# --- AGENTS.md cross-platform merge (Phase 2 / A1) ---
# Block-aware merge via lock.sh, content via shared build-blocks.sh (P2-M1).
# Single lock cycle for both blocks (P2-M2). Frontmatter hoist (P2-B2) is
# silent-skip until A3 writes .ijfw/project.type.
# P2-M3: repo-local fallback comes first so dev runs and partial installs
# still refresh AGENTS.md.
_AGENTS_LOCK=""
_AGENTS_BUILD=""
_AGENTS_HOIST=""
for _cand in \
    "./claude/skills/ijfw-agents-md/scripts" \
    "$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts"; do
  if [ -f "$_cand/lock.sh" ] && [ -f "$_cand/build-blocks.sh" ]; then
    _AGENTS_LOCK="$_cand/lock.sh"
    _AGENTS_BUILD="$_cand/build-blocks.sh"
    _AGENTS_HOIST="$_cand/hoist-frontmatter.sh"
    break
  fi
done
if [ -n "$_AGENTS_LOCK" ] && [ -n "$_AGENTS_BUILD" ]; then
  _AGENTS_TARGET="$(pwd -P 2>/dev/null)/AGENTS.md"
  _AGENTS_PROJECT_ROOT="$(pwd -P 2>/dev/null)"
  {
    _IJFW_BUILD_TMP="$(mktemp -d -t ijfw-agents-md-build.XXXXXX 2>/dev/null || printf '%s' "$IJFW_DIR/.tmp-build-$$")"
    mkdir -p "$_IJFW_BUILD_TMP" 2>/dev/null || true
    _IJFW_PATHS="$(bash "$_AGENTS_BUILD" "$_AGENTS_PROJECT_ROOT" "files:$_IJFW_BUILD_TMP" 2>/dev/null || true)"
    _IJFW_MEM_FILE="$(printf '%s\n' "$_IJFW_PATHS" | sed -n '1p')"
    _IJFW_AG_FILE="$(printf '%s\n' "$_IJFW_PATHS" | sed -n '2p')"
    if [ -n "$_IJFW_MEM_FILE" ] && [ -n "$_IJFW_AG_FILE" ]; then
      bash "$_AGENTS_LOCK" "$_AGENTS_TARGET" \
        "MEMORY:$_IJFW_MEM_FILE" "AGENTS:$_IJFW_AG_FILE" >/dev/null 2>&1 || true
    fi
    if [ -n "$_AGENTS_HOIST" ] && [ -f "$_AGENTS_HOIST" ]; then
      bash "$_AGENTS_HOIST" "$_AGENTS_TARGET" >/dev/null 2>&1 || true
    fi
    rm -rf "$_IJFW_BUILD_TMP" 2>/dev/null || true
  } </dev/null >>"$HOME/.ijfw/logs/agents-md.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# P3-B1: A3 cold-scan trigger -- shared helper, fire-and-forget detached
# spawn that lands .ijfw/project.type for the next session.
_COLD_SCAN_TRIGGER=""
for _cand in \
    "./claude/skills/ijfw-agents-md/scripts/cold-scan-trigger.sh" \
    "$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts/cold-scan-trigger.sh"; do
  if [ -f "$_cand" ]; then _COLD_SCAN_TRIGGER="$_cand"; break; fi
done
if [ -n "$_COLD_SCAN_TRIGGER" ]; then
  bash "$_COLD_SCAN_TRIGGER" "$(pwd -P 2>/dev/null)" >/dev/null 2>&1 || true
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
