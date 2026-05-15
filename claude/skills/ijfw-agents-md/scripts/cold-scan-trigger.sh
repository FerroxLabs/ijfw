#!/usr/bin/env bash
# cold-scan-trigger.sh -- shared A3 cold-scan trigger (V3-F3, P3-B1).
#
# Fired from every platform's session-start hook. When the project has not
# yet been classified (no .ijfw/project.type) AND no other scan is currently
# in progress (no live scan-state.json owner), spawns
#   node <runner>/cold-scan-runner.mjs --project-root <pwd>
# detached + disowned. The trigger itself returns within ~50ms; the actual
# scan runs in the background and lands .ijfw/project.type when done.
#
# Usage:
#   bash cold-scan-trigger.sh <project_root>
#
# Discipline:
#   - LC_ALL=C, ASCII only.
#   - No `set -e` -- the trigger must NEVER crash a session-start hook.
#   - Silent skip if node is missing, runner is missing, or a scan is
#     already in progress. Each skip path is intentional, not negative.
#
# Returns 0 always. Honest framing: this is a fire-and-forget; success of
# the actual scan is observed via .ijfw/project.type appearing later.

export LC_ALL=C

PROJECT_ROOT="${1:-}"
[ -z "$PROJECT_ROOT" ] && exit 0
if [ ! -d "$PROJECT_ROOT" ] && command -v cygpath >/dev/null 2>&1; then
  _IJFW_PROJECT_ROOT_UNIX="$(cygpath -u "$PROJECT_ROOT" 2>/dev/null || true)"
  [ -n "$_IJFW_PROJECT_ROOT_UNIX" ] && PROJECT_ROOT="$_IJFW_PROJECT_ROOT_UNIX"
fi
[ -d "$PROJECT_ROOT" ] || exit 0

IJFW_HOME_UNIX="${IJFW_HOME:-}"
if [ -n "$IJFW_HOME_UNIX" ] && [ ! -d "$IJFW_HOME_UNIX" ] && command -v cygpath >/dev/null 2>&1; then
  _IJFW_HOME_UNIX="$(cygpath -u "$IJFW_HOME_UNIX" 2>/dev/null || true)"
  [ -n "$_IJFW_HOME_UNIX" ] && IJFW_HOME_UNIX="$_IJFW_HOME_UNIX"
fi

IJFW_DIR="$PROJECT_ROOT/.ijfw"
PROJECT_TYPE_FILE="$IJFW_DIR/project.type"
SCAN_STATE_FILE="$IJFW_DIR/scan-state.json"
TRIGGER_LOCK="$IJFW_DIR/.cold-scan-trigger.lock"

# Already classified -- nothing to do. The detector's own cache invalidation
# (P3-H2) decides when to re-detect; we never force it from here.
[ -f "$PROJECT_TYPE_FILE" ] && exit 0

# Another scan is already in progress (state file present and recent).
# Skip rather than racing two walks against each other; P3-M6 file lock
# inside scan-resume.js is the deeper guard, this is the cheap pre-check.
if [ -f "$SCAN_STATE_FILE" ]; then
  exit 0
fi

# Resolve node binary -- must avoid PATH ambiguity on macOS launchd shells.
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

# Resolve the runner -- search candidate layouts.
RUNNER=""
for cand in \
    "$HOME/.ijfw/mcp-server/src/cold-scan-runner.mjs" \
    "${IJFW_HOME_UNIX:-}/mcp-server/src/cold-scan-runner.mjs" \
    "$PROJECT_ROOT/mcp-server/src/cold-scan-runner.mjs" \
    "$(dirname "$0")/../../../../mcp-server/src/cold-scan-runner.mjs"; do
  [ -n "$cand" ] && [ -f "$cand" ] && { RUNNER="$cand"; break; }
done
[ -z "$RUNNER" ] && exit 0

# Atomic mkdir lock -- prevents two parallel session-start hooks from
# spawning two runners. The runner itself takes the deeper P3-M6 lock on
# scan-state, but cheap exclusion here saves a wasted spawn.
mkdir -p "$IJFW_DIR" 2>/dev/null
if ! mkdir "$TRIGGER_LOCK" 2>/dev/null; then
  exit 0
fi
# Release the trigger-lock when the spawn returns; the runner has its
# own scan-state lock for the actual work.
trap 'rmdir "$TRIGGER_LOCK" 2>/dev/null || true' EXIT INT TERM

# Detached + disowned. Logs to ~/.ijfw/logs/cold-scan.log so a real failure
# surfaces in /ijfw doctor without polluting the session-start hook stdout.
mkdir -p "$HOME/.ijfw/logs" 2>/dev/null
"$NODE_BIN" "$RUNNER" --project-root "$PROJECT_ROOT" \
  </dev/null >>"$HOME/.ijfw/logs/cold-scan.log" 2>&1 &
disown $! 2>/dev/null || true

exit 0
