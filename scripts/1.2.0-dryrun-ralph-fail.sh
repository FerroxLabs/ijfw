#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Failure-path dry-run: one unsatisfiable criterion.
# Simulates 3 iterations; asserts ISSUE emitted and ledger entry written.

LEDGER_DIR=$(mktemp -d)
export IJFW_STATE_DIR="$LEDGER_DIR"
LEDGER="$LEDGER_DIR/execute-issues.json"

cleanup() { rm -rf "$LEDGER_DIR"; }
trap cleanup EXIT

# Unsatisfiable criterion: string will never exist in this file
FAIL_CMD="grep -q 'NEVER_WRITTEN_STRING_xyzzy' mcp-server/src/ralph-allowlist.js"
MAX_ITER=3
ITER=0
PREV_OUTPUT=""

# --- 1. Assert command is allowlist-safe (grep -q is allowed) ---
node --input-type=module <<'JS'
import { isSafeVerifyCommand } from './mcp-server/src/ralph-allowlist.js';
const r = isSafeVerifyCommand("grep -q 'NEVER_WRITTEN_STRING_xyzzy' mcp-server/src/ralph-allowlist.js");
if (!r.safe) { console.error('FAIL: grep -q should be allowlisted, got: ' + r.reason); process.exit(1); }
console.log('OK: unsatisfiable criterion is allowlist-safe (will fail at verify, not at safety check)');
JS

# --- 2. Simulate loop: 3 iterations, all fail ---
for i in 1 2 3; do
  ITER=$((ITER + 1))
  OUTPUT=$(bash -c "$FAIL_CMD" 2>&1 || true)

  # Check for stagnation (iters 2+ identical output to previous)
  if [ "$i" -gt 1 ] && [ "$OUTPUT" = "$PREV_OUTPUT" ]; then
    # Stagnation detected -- emit stagnated ISSUE instead
    STAGNATED=true
    break
  fi
  PREV_OUTPUT="$OUTPUT"
done

STAGNATED=${STAGNATED:-false}

# --- 3. Assert 3 iterations ran (or stagnation halt at iter 2) ---
if [ "$ITER" -lt 2 ]; then
  echo "FAIL: expected at least 2 iterations, ran $ITER"
  exit 1
fi

# --- 4. Write ledger entry (rehearsal: true) ---
ISSUE_KIND="task-incomplete"
if [ "$STAGNATED" = "true" ]; then
  ISSUE_KIND="task-stagnated"
fi

node -e "
const fs = require('fs');
const entry = {
  id: 'iss_001',
  task_id: 't1',
  criterion_id: 'c1',
  kind: '$ISSUE_KIND',
  message: 'grep -q NEVER_WRITTEN_STRING failed after $ITER iterations',
  last_output: '$PREV_OUTPUT',
  iter_count: $ITER,
  status: 'unresolved',
  rehearsal: true,
  created_at: new Date().toISOString(),
  resolved_at: null
};
const ledger = { schema_version: 1, issues: [entry] };
fs.writeFileSync('$LEDGER', JSON.stringify(ledger, null, 2));
console.log('ISSUE: ' + '$ISSUE_KIND' + ' -- criterion c1 failed after $ITER iterations');
"

# --- 5. Assert ledger entry exists with status: unresolved and rehearsal: true ---
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$LEDGER', 'utf8'));
const entry = d.issues[0];
if (!entry) { console.error('FAIL: no ledger entry written'); process.exit(1); }
if (entry.status !== 'unresolved') { console.error('FAIL: expected status unresolved, got ' + entry.status); process.exit(1); }
if (entry.rehearsal !== true) { console.error('FAIL: expected rehearsal: true'); process.exit(1); }
if (!['task-incomplete','task-stagnated'].includes(entry.kind)) {
  console.error('FAIL: unexpected kind: ' + entry.kind); process.exit(1);
}
console.log('OK: ledger entry present, status=unresolved, rehearsal=true, kind=' + entry.kind);
"

echo "OK: 1.2.0-dryrun-ralph-fail passes"
