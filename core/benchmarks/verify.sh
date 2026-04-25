#!/usr/bin/env bash
# Dispatcher - runs a task's verify.sh.
set -euo pipefail
task="${1:-}"
if [ -z "$task" ]; then
  echo "usage: verify.sh <task-id>" >&2; exit 2
fi
here="$(cd "$(dirname "$0")" && pwd)"
tdir="$here/tasks/$task"
if [ ! -x "$tdir/verify.sh" ]; then
  echo "verify.sh missing or not executable: $tdir/verify.sh" >&2; exit 2
fi
exec "$tdir/verify.sh"
