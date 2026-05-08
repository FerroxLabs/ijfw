#!/usr/bin/env bash
# detect-type.sh -- A3 CLI wrapper for non-Claude CLIs.
#
# Reads cached <project>/.ijfw/project.type when present (the common case),
# emits the JSON to stdout. When absent, optionally fires a synchronous
# detection run. Hook callers should pass --bg to spawn a background runner
# instead of blocking.
#
# Args:
#   $1  project root (defaults to current directory)
#   $2  optional: --bg | --sync | --read-only (default --read-only)
#
# Exit codes:
#   0  -- emitted JSON or silently skipped (no cache, --read-only)
#   2  -- usage error
#
# ASCII only. LC_ALL=C for predictable byte handling.

set -eu
export LC_ALL=C

ROOT_RAW="${1:-.}"
MODE="${2:---read-only}"

if [ "$ROOT_RAW" = "--help" ] || [ "$ROOT_RAW" = "-h" ]; then
  printf 'usage: detect-type.sh <project-root> [--bg|--sync|--read-only]\n' >&2
  exit 2
fi

ROOT="$(cd -P "$ROOT_RAW" 2>/dev/null && pwd)" || ROOT="$ROOT_RAW"
TYPE_FILE="$ROOT/.ijfw/project.type"

# Cached read -- the 99% path. Hooks must always read cached only so the 50ms
# hook budget stays clean. Spawn a background scan elsewhere.
if [ -f "$TYPE_FILE" ]; then
  cat "$TYPE_FILE"
  exit 0
fi

if [ "$MODE" = "--read-only" ]; then
  exit 0
fi

# --bg / --sync paths require node + the runner. Resolve node.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  for cand in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$cand" ] && { NODE_BIN="$cand"; break; }
  done
fi
if [ -z "$NODE_BIN" ]; then
  exit 0
fi

# Resolve the runner script -- ships under mcp-server/src/.
SCRIPT_DIR="$(cd -P "$(dirname "$0")" 2>/dev/null && pwd)"
RUNNER=""
for cand in \
    "$SCRIPT_DIR/../../../../mcp-server/src/cold-scan-runner.mjs" \
    "$HOME/.ijfw/mcp-server/src/cold-scan-runner.mjs" \
    "$(pwd)/mcp-server/src/cold-scan-runner.mjs"; do
  if [ -f "$cand" ]; then RUNNER="$cand"; break; fi
done
if [ -z "$RUNNER" ]; then
  exit 0
fi

if [ "$MODE" = "--bg" ]; then
  "$NODE_BIN" "$RUNNER" --project-root "$ROOT" </dev/null >/dev/null 2>&1 &
  disown $! 2>/dev/null || true
  exit 0
fi

if [ "$MODE" = "--sync" ]; then
  "$NODE_BIN" "$RUNNER" --project-root "$ROOT" </dev/null >/dev/null 2>&1 || true
  if [ -f "$TYPE_FILE" ]; then
    cat "$TYPE_FILE"
  fi
  exit 0
fi

exit 2
