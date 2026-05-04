#!/usr/bin/env bash
# perf-hook.sh -- measure median latency of a Claude hook script.
# Usage: perf-hook.sh <hook-script> [budget-ms]
# Exits 0 if median < budget, 1 otherwise.
# Prints: perf: <hook> median <N>ms budget <B>ms <PASS|FAIL>

set -euo pipefail

HOOK_PATH="${1:-}"
BUDGET="${2:-120}"
FIXTURE="$(cd "$(dirname "$0")" && pwd)/fixtures/sample-hook-event.json"

if [ -z "$HOOK_PATH" ]; then
  printf 'Usage: perf-hook.sh <hook-script> [budget-ms]\n' >&2
  exit 2
fi

if [ ! -f "$HOOK_PATH" ]; then
  printf 'perf-hook: hook not found: %s\n' "$HOOK_PATH" >&2
  exit 2
fi

if [ ! -f "$FIXTURE" ]; then
  printf 'perf-hook: fixture not found: %s\n' "$FIXTURE" >&2
  exit 2
fi

HOOK_NAME="$(basename "$HOOK_PATH")"
RUNS=5
TIMES_FILE="$(mktemp)"
trap 'rm -f "$TIMES_FILE"' EXIT

for i in $(seq 1 $RUNS); do
  # Use bash builtin time with TIMEFORMAT to get real ms.
  # TIMEFORMAT outputs to stderr in the form %R (seconds with decimals).
  MS=$( { TIMEFORMAT='%R'; time bash "$HOOK_PATH" < "$FIXTURE" >/dev/null 2>/dev/null; } 2>&1 | \
        awk '{ printf "%d\n", $1 * 1000 }' )
  printf '%s\n' "$MS" >> "$TIMES_FILE"
done

# Sort and pick middle element (index 2 for 5 runs, 0-indexed).
MEDIAN=$(sort -n "$TIMES_FILE" | awk 'NR==3{print}')
[ -z "$MEDIAN" ] && MEDIAN=0

if [ "$MEDIAN" -lt "$BUDGET" ]; then
  VERDICT="PASS"
  RC=0
else
  VERDICT="FAIL"
  RC=1
fi

printf 'perf: %s median %dms budget %dms %s\n' "$HOOK_NAME" "$MEDIAN" "$BUDGET" "$VERDICT"
exit $RC
