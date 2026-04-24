#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Happy-path dry-run: 3 criteria all pass on iter 1.
# Simulates the Ralph loop against isSafeVerifyCommand + a synthetic ledger.

LEDGER_DIR=$(mktemp -d)
export IJFW_STATE_DIR="$LEDGER_DIR"
LEDGER="$LEDGER_DIR/execute-issues.json"

cleanup() { rm -rf "$LEDGER_DIR"; }
trap cleanup EXIT

# --- 1. Verify allowlist accepts all three commands ---
node --input-type=module <<'JS'
import { isSafeVerifyCommand } from './mcp-server/src/ralph-allowlist.js';

const criteria = [
  { id: 'c1', verify: "test -f mcp-server/src/ralph-allowlist.js" },
  { id: 'c2', verify: "grep -q 'FORBID_LIST' mcp-server/src/ralph-allowlist.js" },
  { id: 'c3', verify: "grep -q 'ALLOWLIST' mcp-server/src/ralph-allowlist.js" },
];

let allSafe = true;
for (const c of criteria) {
  const result = isSafeVerifyCommand(c.verify);
  if (!result.safe) {
    console.error(`FAIL: criterion ${c.id} rejected: ${result.reason}`);
    allSafe = false;
  }
}
if (!allSafe) process.exit(1);
console.log('OK: all 3 shell criteria pass isSafeVerifyCommand');
JS

# --- 2. Simulate loop: run each criterion, collect results ---
PASS_COUNT=0
for CMD in \
  "test -f mcp-server/src/ralph-allowlist.js" \
  "grep -q 'FORBID_LIST' mcp-server/src/ralph-allowlist.js" \
  "grep -q 'ALLOWLIST' mcp-server/src/ralph-allowlist.js"; do
  if bash -c "$CMD" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: criterion command failed: $CMD"
    exit 1
  fi
done

if [ "$PASS_COUNT" -ne 3 ]; then
  echo "FAIL: expected 3 passing criteria, got $PASS_COUNT"
  exit 1
fi

# --- 3. Assert VERIFIED emitted (simulated: no ledger entries written on happy path) ---
# Happy path writes no unresolved entries. Ledger file should not exist or be empty.
if [ -f "$LEDGER" ]; then
  UNRESOLVED=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$LEDGER', 'utf8'));
    console.log(d.issues.filter(i => i.status === 'unresolved').length);
  ")
  if [ "$UNRESOLVED" -ne 0 ]; then
    echo "FAIL: expected 0 unresolved issues on happy path, got $UNRESOLVED"
    exit 1
  fi
fi

echo "VERIFIED: task t1 -- all 3 criteria passed iter 1"
echo "OK: 1.2.0-dryrun-ralph-happy passes"
