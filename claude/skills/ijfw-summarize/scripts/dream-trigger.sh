#!/usr/bin/env bash
# dream-trigger.sh -- shared D3 dream-cycle trigger (V3-F3 / D3 inline).
#
# Fired from every platform's session-end hook. Replaces the legacy
# `SESSION_NUM % 5 == 0` startup-flag mechanism with INLINE detached
# spawn at SessionEnd. Mirrors cold-scan-trigger.sh contract verbatim:
#   - 50ms hook-latency budget enforced via fork+disown
#   - 4-hour cooldown via .ijfw/.dream-state.json (read by runner)
#   - Silent skip when node is missing, runner is missing, cooldown
#     active, or another dream cycle is in progress
#   - IJFW_DREAM_LEGACY=1 env reverts to the old startup-flag path
#     (rollback for the 1.3.0 alpha window)
#
# Usage:
#   bash dream-trigger.sh <project_root> [host] [session_id]
#
# Discipline:
#   - LC_ALL=C, ASCII only.
#   - No `set -e` -- the trigger must NEVER crash a session-end hook.
#   - Silent skip paths are intentional, not negative.
#
# Returns 0 always. Honest framing: this is a fire-and-forget; success
# of the actual dream cycle is observed via .ijfw/.dream-state.json
# updating + .ijfw/logs/dream-*.log appearing.

export LC_ALL=C

PROJECT_ROOT="${1:-}"
HOST="${2:-unknown}"
SESSION_ID="${3:-${IJFW_SESSION_ID:-}}"

[ -z "$PROJECT_ROOT" ] && exit 0
[ -d "$PROJECT_ROOT" ] || exit 0

IJFW_DIR="$PROJECT_ROOT/.ijfw"
TRIGGER_LOCK="$IJFW_DIR/.dream-trigger.lock"
STATE_FILE="$IJFW_DIR/.dream-state.json"

# IJFW_DREAM_LEGACY=1 -- rollback path. Restore the legacy 5-session
# deferral + .startup-flags write so the user can revert without a
# config swap. The legacy mechanism is documented in
# claude/commands/consolidate.md.
if [ "${IJFW_DREAM_LEGACY:-0}" = "1" ]; then
  mkdir -p "$IJFW_DIR" 2>/dev/null
  COUNTER="$IJFW_DIR/.session-counter"
  CUR=$(cat "$COUNTER" 2>/dev/null || echo 0)
  if [ "$CUR" -gt 0 ] && [ $(( CUR % 5 )) -eq 0 ]; then
    echo "IJFW_NEEDS_CONSOLIDATE=1" >> "$IJFW_DIR/.startup-flags" 2>/dev/null
  fi
  exit 0
fi

# Cheap cooldown pre-check. The runner re-checks via cooldown.js
# (authoritative read), but skipping here saves a wasted spawn when
# we already know the answer.
if [ -f "$STATE_FILE" ] && command -v node >/dev/null 2>&1; then
  ON_CD=$(node -e '
    (() => {
      try {
        const fs = require("fs");
        const raw = fs.readFileSync(process.argv[1], "utf8");
        const obj = JSON.parse(raw);
        const t = Date.parse(obj.last_run_at || "");
        if (!Number.isFinite(t)) { process.stdout.write("0"); return; }
        const ms = Number(process.env.IJFW_DREAM_COOLDOWN_MS) || (4 * 3600 * 1000);
        const age = Date.now() - t;
        process.stdout.write(age >= 0 && age < ms ? "1" : "0");
      } catch { process.stdout.write("0"); }
    })();
  ' "$STATE_FILE" 2>/dev/null)
  [ "$ON_CD" = "1" ] && exit 0
fi

# Resolve node binary -- avoid PATH ambiguity on macOS launchd shells.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \
              "$HOME/.nvm/versions/node"/*/bin/node "$HOME/.volta/bin/node"; do
    for nr in $cand; do [ -x "$nr" ] && { NODE_BIN="$nr"; break 2; }; done
  done
fi
[ -z "$NODE_BIN" ] && exit 0

# Resolve the runner -- candidate layouts mirror cold-scan-trigger.sh.
RUNNER=""
for cand in \
    "$HOME/.ijfw/mcp-server/src/dream/runner.mjs" \
    "${IJFW_HOME:-}/mcp-server/src/dream/runner.mjs" \
    "$PROJECT_ROOT/mcp-server/src/dream/runner.mjs" \
    "$(dirname "$0")/../../../../mcp-server/src/dream/runner.mjs"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { RUNNER="$cand"; break; }
done
[ -z "$RUNNER" ] && exit 0

# Atomic mkdir lock -- prevents two parallel session-end hooks from
# spawning two runners. The runner itself takes a deeper cooldown
# check on .dream-state.json, but cheap exclusion here saves spawn.
mkdir -p "$IJFW_DIR" 2>/dev/null
if ! mkdir "$TRIGGER_LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$TRIGGER_LOCK" 2>/dev/null || true' EXIT INT TERM

# Detached + disowned. Logs land in .ijfw/logs/dream-<ts>.log per
# runner.mjs convention.
mkdir -p "$IJFW_DIR/logs" 2>/dev/null
ARGS="--project-root $PROJECT_ROOT --host $HOST --reason session_end"
[ -n "$SESSION_ID" ] && ARGS="$ARGS --session-id $SESSION_ID"
# shellcheck disable=SC2086 -- intentional word splitting on ARGS
"$NODE_BIN" "$RUNNER" $ARGS \
  </dev/null >>"$IJFW_DIR/logs/dream-trigger.log" 2>&1 &
disown $! 2>/dev/null || true

exit 0
