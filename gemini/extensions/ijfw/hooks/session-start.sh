#!/usr/bin/env bash
# IJFW SessionStart (Gemini) -- initialize state, emit banner, register project.
# Gemini hook JSON in/out:
#   stdin:  { "event": "SessionStart", "session_id": "...", "cwd": "...", "timestamp": "..." }
#   stdout: { "decision": "allow" }  (optional -- absence = allow)
#
# No set -e -- hooks must never crash Gemini CLI.

[ "${IJFW_DISABLE:-}" = "1" ] && printf '{"decision":"allow"}\n' && exit 0

IJFW_DIR=".ijfw"
IJFW_GLOBAL="$HOME/.ijfw"

HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN=$(cat 2>/dev/null || true)
fi

# Pre-flight: .ijfw must be a directory if it exists.
if [ -e "$IJFW_DIR" ] && [ ! -d "$IJFW_DIR" ]; then
  printf '{"decision":"allow","systemMessage":"[ijfw] .ijfw is a file here -- IJFW needs it as a directory. Rename or remove it, then start a new session."}\n'
  exit 0
fi

mkdir -p "$IJFW_DIR/memory" "$IJFW_DIR/sessions" "$IJFW_DIR/index" 2>/dev/null
mkdir -p "$IJFW_GLOBAL/memory" 2>/dev/null

# Gemini CLI 0.41+ renders systemMessage twice (welcome panel + chat info).
# Dedup by session_id so the second invocation emits empty and exits early.
SESSION_ID=""
if command -v node >/dev/null 2>&1 && [ -n "$HOOK_STDIN" ]; then
  SESSION_ID=$(printf '%s' "$HOOK_STDIN" | node -e '
    let buf = "";
    process.stdin.on("data", c => buf += c);
    process.stdin.on("end", () => {
      try { const j = JSON.parse(buf); process.stdout.write(j.session_id || ""); } catch {}
    });
  ' 2>/dev/null || true)
fi

if [ -n "$SESSION_ID" ]; then
  LOCK_DIR="$IJFW_DIR/.banner-shown.${SESSION_ID}.lock"
  # Atomic mkdir -- only one invocation wins; the other exits early.
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '{"decision":"allow"}\n'
    exit 0
  fi
  # Purge stale lock dirs older than 24h.
  find "$IJFW_DIR" -maxdepth 1 -name '.banner-shown.*.lock' -mtime +1 -type d -exec rmdir {} + 2>/dev/null || true
fi

# Project registry.
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
# Track turn count for BeforeModel first-turn injection.
printf '0' > "$IJFW_DIR/.turn-count" 2>/dev/null

MODE="${IJFW_MODE:-smart}"

# Count memory for banner.
SESSION_COUNT=$(ls "$IJFW_DIR/sessions/" 2>/dev/null | wc -l | tr -d ' ')
[ -z "$SESSION_COUNT" ] && SESSION_COUNT=0
DECISION_COUNT=0
if [ -f "$IJFW_DIR/memory/project-journal.md" ]; then
  DECISION_COUNT=$(grep -c '^- \[' "$IJFW_DIR/memory/project-journal.md" 2>/dev/null || true)
  [ -z "$DECISION_COUNT" ] && DECISION_COUNT=0
fi

# Build warm banner matching Claude format. No routing label, no raw counts.
BANNER="[ijfw] $(printf '%s' "$MODE" | awk '{print toupper(substr($0,1,1)) substr($0,2)}') mode"

if [ "$SESSION_COUNT" -gt 0 ] || [ "$DECISION_COUNT" -gt 0 ]; then
  BANNER="$BANNER
[ijfw] Memory loaded ($DECISION_COUNT things remembered)"
fi

if [ -f "$IJFW_DIR/memory/handoff.md" ]; then
  LAST_STATUS=$(grep -A1 "### Status" "$IJFW_DIR/memory/handoff.md" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//')
  NEXT_STEP=$(grep -A1 "### Next Steps" "$IJFW_DIR/memory/handoff.md" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//;s/^[0-9]*\. //')
  BANNER="$BANNER
[ijfw] Welcome back -- picking up where you left off."
  [ -n "$LAST_STATUS" ] && BANNER="$BANNER
[ijfw] Last session: $LAST_STATUS"
  [ -n "$NEXT_STEP" ] && BANNER="$BANNER
[ijfw] Next up: $NEXT_STEP"
fi

BANNER="$BANNER
[ijfw] Ready."

# Render dashboard async fire-and-forget (D-F3: non-blocking, matches Claude approach).
_DASH_SCRIPT="$(dirname "$0")/session-start-dashboard.sh"
if [ -f "$_DASH_SCRIPT" ]; then
  mkdir -p "$HOME/.ijfw/logs" 2>/dev/null || true
  bash "$_DASH_SCRIPT" >>"$HOME/.ijfw/logs/dashboard.log" 2>&1 &
  disown $! 2>/dev/null || true
fi

# --- AGENTS.md cross-platform merge (Phase 2 / A1) ---
# Block-aware merge via lock.sh, content via shared build-blocks.sh (P2-M1).
# Single lock cycle for both blocks (P2-M2). Frontmatter hoist (P2-B2)
# degrades gracefully until A3 lands.
_AGENTS_LOCK=""
_AGENTS_BUILD=""
_AGENTS_HOIST=""
for _cand in \
    "$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts" \
    "$(dirname "$0")/../../../../claude/skills/ijfw-agents-md/scripts"; do
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
    "$HOME/.ijfw/claude/skills/ijfw-agents-md/scripts/cold-scan-trigger.sh" \
    "$(dirname "$0")/../../../../claude/skills/ijfw-agents-md/scripts/cold-scan-trigger.sh"; do
  if [ -f "$_cand" ]; then _COLD_SCAN_TRIGGER="$_cand"; break; fi
done
if [ -n "$_COLD_SCAN_TRIGGER" ]; then
  bash "$_COLD_SCAN_TRIGGER" "$(pwd -P 2>/dev/null)" >/dev/null 2>&1 || true
fi

# Build memory context for Gemini's additionalContext field.
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

# Emit JSON response with systemMessage (banner) and additionalContext (memory).
command -v node >/dev/null 2>&1 || { printf '{"decision":"allow"}\n'; exit 0; }
node -e '
  const banner = process.argv[1] || "";
  const mem = process.argv[2] || "";
  const out = { decision: "allow" };
  if (banner) out.systemMessage = banner;
  if (mem) out.additionalContext = mem;
  process.stdout.write(JSON.stringify(out) + "\n");
' "$BANNER" "$MEM_CONTEXT" 2>/dev/null || printf '{"decision":"allow"}\n'

exit 0
