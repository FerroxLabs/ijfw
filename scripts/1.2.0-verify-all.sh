#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0
run() {
  echo "--- $1 ---"
  if bash "$1"; then echo "PASS"; else echo "FAIL"; FAIL=1; fi
}

run scripts/preflight-stale-count.sh
run scripts/1.2.0-dryrun-temporal.sh
run scripts/1.2.0-dryrun-fourmode.sh
run scripts/1.2.0-dryrun-score.sh
run scripts/1.2.0-dryrun-ralph-happy.sh
run scripts/1.2.0-dryrun-ralph-fail.sh
run scripts/1.2.0-dryrun-ralph-unsafe.sh
run scripts/1.2.0-dryrun-ralph-multifile.sh

# Rehearsal cleanup per 4.4 discipline (idempotent, OK if ledger missing)
LEDGER=".ijfw/state/execute-issues.json"
if [ -f "$LEDGER" ] && command -v jq >/dev/null 2>&1; then
  jq '.issues |= map(select(.rehearsal != true))' "$LEDGER" > "${LEDGER}.tmp" && mv "${LEDGER}.tmp" "$LEDGER"
  echo "Rehearsal entries flushed from ledger."
fi

if [ $FAIL -eq 0 ]; then
  echo "OK: all 1.2.0 dry-runs pass"
  exit 0
else
  echo "ISSUE: one or more dry-runs failed"
  exit 1
fi
