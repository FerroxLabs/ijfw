#!/usr/bin/env bash
# lock.sh -- PID-lockfile + atomic merger wrapper for AGENTS.md (V3-F12).
#
# Two invocation forms (mirrors merge-block-aware.sh):
#   Single-pair (legacy):
#     lock.sh <target> <BLOCK> <content>
#   Multi-pair (P2-M2 -- one lock cycle, one transaction):
#     lock.sh <target> <BLOCK1>:<file1> [<BLOCK2>:<file2> ...]
#
# Lock file: <target-dir>/.AGENTS.md.lock containing PID + epoch ts.
# Stale-lock detection:
#   - lock-PID has no live process, OR
#   - lock is older than 60s
# Either condition reclaims the lock.
#
# Atomic rename: delegated to merge-block-aware.sh (which writes to a tmp
# file then renames).
#
# Usage from session-start hooks (Fleet-mode safe):
#   bash lock.sh "$PWD/AGENTS.md" MEMORY "<pointer-block-content>"
#   bash lock.sh "$PWD/AGENTS.md" MEMORY:/tmp/m.md AGENTS:/tmp/a.md
#
# ASCII only. No emojis.

set -euo pipefail
export LC_ALL=C

if [ "$#" -lt 2 ]; then
  printf '[ijfw-agents-md] usage: lock.sh <target> <BLOCK> <content>\n' >&2
  printf '                or: lock.sh <target> <BLOCK1>:<file1> [<BLOCK2>:<file2> ...]\n' >&2
  exit 2
fi

TARGET="$1"
shift

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
MERGER="$SCRIPT_DIR/merge-block-aware.sh"

if [ ! -f "$MERGER" ]; then
  printf '[ijfw-agents-md] merger missing at %s\n' "$MERGER" >&2
  exit 3
fi

TARGET_DIR_RAW="$(dirname "$TARGET")"
mkdir -p "$TARGET_DIR_RAW" 2>/dev/null || true
# Canonicalize the target dir for stable lock placement (HOME symlink gotcha
# memo: cd -P resolves /var to /private/var on macOS).
TARGET_DIR="$(cd -P "$TARGET_DIR_RAW" 2>/dev/null && pwd)"
TARGET_BASE="$(basename "$TARGET")"
LOCK_FILE="$TARGET_DIR/.${TARGET_BASE}.lock"

# Stale-lock detection knobs.
STALE_AGE_SECONDS=60

now_epoch() {
  date -u +%s 2>/dev/null || printf '0'
}

is_pid_alive() {
  # `kill -0 PID` returns 0 if the process exists and we have permission to
  # signal it. POSIX-portable.
  [ -n "$1" ] && kill -0 "$1" 2>/dev/null
}

reclaim_if_stale() {
  if [ ! -f "$LOCK_FILE" ]; then
    return 0
  fi
  local pid ts age now
  pid="$(awk 'NR==1{print $1}' "$LOCK_FILE" 2>/dev/null || true)"
  ts="$(awk 'NR==2{print $1}' "$LOCK_FILE" 2>/dev/null || true)"
  now="$(now_epoch)"
  if [ -n "$ts" ] && [ "$now" -gt 0 ]; then
    age=$(( now - ts ))
  else
    age=0
  fi
  if ! is_pid_alive "$pid"; then
    rm -f "$LOCK_FILE" 2>/dev/null || true
    return 0
  fi
  if [ "$age" -gt "$STALE_AGE_SECONDS" ]; then
    rm -f "$LOCK_FILE" 2>/dev/null || true
    return 0
  fi
}

# Acquire lock with bounded retry. POSIX `set -C` (noclobber) makes redirect
# atomic across writers.
ACQUIRED=0
ATTEMPTS=0
MAX_ATTEMPTS=120  # 120 * 50ms = 6s ceiling
while [ "$ATTEMPTS" -lt "$MAX_ATTEMPTS" ]; do
  reclaim_if_stale
  if ( set -C; printf '%s\n%s\n' "$$" "$(now_epoch)" > "$LOCK_FILE" ) 2>/dev/null; then
    ACQUIRED=1
    break
  fi
  ATTEMPTS=$(( ATTEMPTS + 1 ))
  sleep 0.05 2>/dev/null || sleep 1
done

if [ "$ACQUIRED" -ne 1 ]; then
  printf '[ijfw-agents-md] lock contention on %s; merge skipped\n' "$LOCK_FILE" >&2
  exit 5
fi

# Always release on exit (even if merger fails).
trap 'rm -f "$LOCK_FILE" 2>/dev/null || true' EXIT INT TERM

bash "$MERGER" "$TARGET" "$@"
RC=$?

# Trap will release the lock.
exit "$RC"
